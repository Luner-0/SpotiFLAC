// In-app musical key + BPM estimation from a local audio file or stream.
//
// This is a DSP estimate (no ML), so it is NOT as reliable as a dedicated tool
// like rekordbox — results are flagged as "estimated" in the UI. It improves on a
// naive chromagram with: spectral peak-picking (reduces smearing), global tuning
// estimation (handles tracks not tuned to A440), per-frame normalized chroma, and
// a spectral-flux onset envelope with interpolated autocorrelation + octave
// correction for tempo.

import { DecodeAudioForAnalysis } from "@/../wailsjs/go/main/App";
import { pcm16MonoArrayBufferToFloat32Samples, analyzeSpectrumFromSamples } from "@/lib/flac-analysis";
import type { SpectrumData } from "@/types/api";

export interface KeyAnalysisResult {
    key: string; // e.g. "Am", "F#"
    camelot: string; // e.g. "8A"
    bpm: number; // 0 if undetermined
}

// Krumhansl-Kessler key profiles (tonic-relative).
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Camelot codes indexed by pitch class (C=0 … B=11) — matches backend/getsongbpm.go.
const MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const PEAK_FLOOR_DB = -80; // ignore spectrum below this (noise floor is -120)
const CHROMA_MIN_HZ = 65; // ~C2 — skip sub-bass rumble
const CHROMA_MAX_HZ = 2000; // skip very high partials that confuse pitch class

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function pearson(a: number[], b: number[]): number {
    const n = a.length;
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < n; i++) {
        sa += a[i];
        sb += b[i];
    }
    const ma = sa / n;
    const mb = sb / n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
        const xa = a[i] - ma;
        const xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
    }
    const denom = Math.sqrt(da * db);
    return denom > 0 ? num / denom : 0;
}

// Build a tuning-corrected, peak-picked, per-frame-normalized chromagram.
function buildChroma(spectrum: SpectrumData): number[] {
    const sr = spectrum.sample_rate;
    const bins = spectrum.freq_bins;
    const fftSize = (bins - 1) * 2;
    const minBin = Math.max(2, Math.floor((CHROMA_MIN_HZ * fftSize) / sr));
    const maxBin = Math.min(bins - 2, Math.ceil((CHROMA_MAX_HZ * fftSize) / sr));

    // MIDI number for each in-range bin.
    const midiOf = new Float64Array(bins);
    for (let j = minBin; j <= maxBin; j++) {
        midiOf[j] = 69 + 12 * Math.log2((j * sr) / fftSize / 440);
    }

    // Pass 1: estimate global tuning offset (in semitones, -0.5..0.5) as the
    // circular mean of each peak's deviation from the nearest equal-tempered note.
    let tSin = 0;
    let tCos = 0;
    for (const slice of spectrum.time_slices) {
        const mags = slice.magnitudes;
        for (let j = minBin; j <= maxBin; j++) {
            const db = mags[j];
            if (db <= PEAK_FLOOR_DB) continue;
            if (mags[j] < mags[j - 1] || mags[j] < mags[j + 1]) continue; // local max only
            const lin = Math.pow(10, db / 10);
            const frac = midiOf[j] - Math.round(midiOf[j]); // [-0.5, 0.5]
            const ang = 2 * Math.PI * frac;
            tSin += lin * Math.sin(ang);
            tCos += lin * Math.cos(ang);
        }
    }
    const tuning = tSin !== 0 || tCos !== 0 ? Math.atan2(tSin, tCos) / (2 * Math.PI) : 0;

    // Pass 2: accumulate a per-frame-normalized chroma using tuning-corrected peaks.
    const chroma = new Array(12).fill(0);
    const frame = new Array(12);
    for (const slice of spectrum.time_slices) {
        const mags = slice.magnitudes;
        for (let k = 0; k < 12; k++) frame[k] = 0;
        for (let j = minBin; j <= maxBin; j++) {
            const db = mags[j];
            if (db <= PEAK_FLOOR_DB) continue;
            if (mags[j] < mags[j - 1] || mags[j] < mags[j + 1]) continue;
            const lin = Math.pow(10, db / 10);
            let pc = Math.round(midiOf[j] - tuning) % 12;
            pc = ((pc % 12) + 12) % 12;
            frame[pc] += lin;
        }
        let sum = 0;
        for (let k = 0; k < 12; k++) sum += frame[k];
        if (sum > 0) for (let k = 0; k < 12; k++) chroma[k] += frame[k] / sum;
    }
    return chroma;
}

function detectKey(chroma: number[]): { pc: number; minor: boolean } {
    let best = { score: -Infinity, pc: 0, minor: false };
    for (let r = 0; r < 12; r++) {
        const major = new Array(12);
        const minor = new Array(12);
        for (let i = 0; i < 12; i++) {
            major[i] = KK_MAJOR[(((i - r) % 12) + 12) % 12];
            minor[i] = KK_MINOR[(((i - r) % 12) + 12) % 12];
        }
        const majScore = pearson(chroma, major);
        const minScore = pearson(chroma, minor);
        if (majScore > best.score) best = { score: majScore, pc: r, minor: false };
        if (minScore > best.score) best = { score: minScore, pc: r, minor: true };
    }
    return { pc: best.pc, minor: best.minor };
}

// Tempo from a spectral-flux onset envelope + interpolated autocorrelation, with
// octave correction so half/double-time picks land in a sensible BPM range.
function estimateBpm(spectrum: SpectrumData): number {
    const slices = spectrum.time_slices;
    const n = slices.length;
    if (n < 16) return 0;
    const bins = spectrum.freq_bins;

    // Spectral flux: sum of positive amplitude increases between frames.
    const flux = new Float64Array(n);
    let prev = slices[0].magnitudes;
    for (let i = 1; i < n; i++) {
        const cur = slices[i].magnitudes;
        let f = 0;
        for (let j = 1; j < bins; j++) {
            const a = Math.pow(10, cur[j] / 20);
            const b = Math.pow(10, prev[j] / 20);
            const d = a - b;
            if (d > 0) f += d;
        }
        flux[i] = f;
        prev = cur;
    }

    // Frames-per-second from slice timestamps.
    let dt = 0;
    let cnt = 0;
    for (let i = 1; i < n; i++) {
        const d = slices[i].time - slices[i - 1].time;
        if (d > 0) {
            dt += d;
            cnt++;
        }
    }
    if (cnt === 0) return 0;
    const fps = cnt / dt;

    // High-pass the envelope (remove the slow mean) and rectify.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += flux[i];
    mean /= n;
    const env = new Float64Array(n);
    for (let i = 0; i < n; i++) env[i] = Math.max(0, flux[i] - mean);

    let bestBpm = 0;
    let bestScore = -1;
    for (let bpm = 60; bpm <= 200; bpm += 0.5) {
        const lag = (60 / bpm) * fps; // fractional frames
        if (lag < 2 || lag >= n - 1) continue;
        const li = Math.floor(lag);
        const fr = lag - li;
        let s = 0;
        for (let i = 0; i + li + 1 < n; i++) {
            const shifted = env[i + li] * (1 - fr) + env[i + li + 1] * fr;
            s += env[i] * shifted;
        }
        if (s > bestScore) {
            bestScore = s;
            bestBpm = bpm;
        }
    }
    if (bestBpm === 0) return 0;

    // Octave-correct into the common 70–180 BPM window.
    let bpm = bestBpm;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm);
}

// Decode from a remote URL (Spotify preview / yt-dlp stream) — used to analyze a
// node before it has a downloaded file. Accessed via the runtime global so this
// file doesn't depend on the binding being regenerated first.
function DecodeAudioForAnalysisURL(url: string): Promise<{ sample_rate: number; pcm_base64: string }> {
    return (window as unknown as {
        go: { main: { App: { DecodeAudioForAnalysisURL: (u: string) => Promise<{ sample_rate: number; pcm_base64: string }> } } };
    }).go.main.App.DecodeAudioForAnalysisURL(url);
}

export async function analyzeKey(filePath: string): Promise<KeyAnalysisResult> {
    return analyzeDecoded(await DecodeAudioForAnalysis(filePath));
}

export async function analyzeKeyFromUrl(url: string): Promise<KeyAnalysisResult> {
    return analyzeDecoded(await DecodeAudioForAnalysisURL(url));
}

async function analyzeDecoded(decoded: { sample_rate: number; pcm_base64: string }): Promise<KeyAnalysisResult> {
    const sampleRate = decoded.sample_rate || 44100;
    const samples = pcm16MonoArrayBufferToFloat32Samples(base64ToArrayBuffer(decoded.pcm_base64));
    if (samples.length === 0) throw new Error("no audio samples");

    // Large window for frequency resolution at low notes → better chroma/key.
    const chromaSpec = await analyzeSpectrumFromSamples(samples, sampleRate, { fftSize: 8192, windowFunction: "hann" });
    const { pc, minor } = detectKey(buildChroma(chromaSpec));

    // Small window for time resolution → better onset/tempo tracking.
    const fluxSpec = await analyzeSpectrumFromSamples(samples, sampleRate, { fftSize: 1024, windowFunction: "hann" });
    const bpm = estimateBpm(fluxSpec);

    return {
        key: NOTE_NAMES[pc] + (minor ? "m" : ""),
        camelot: (minor ? MINOR_CAMELOT : MAJOR_CAMELOT)[pc],
        bpm,
    };
}
