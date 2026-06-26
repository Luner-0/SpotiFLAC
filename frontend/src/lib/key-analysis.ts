// In-app musical key + BPM estimation from a local audio file.
//
// IMPORTANT: this is a lightweight chromagram + Krumhansl-Schmuckler estimate and
// a rough autocorrelation tempo guess. It is NOT reliable — results are flagged as
// estimated in the UI. Prefer GetSongBPM data when available.

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

function buildChroma(spectrum: SpectrumData): number[] {
    const chroma = new Array(12).fill(0);
    const sr = spectrum.sample_rate;
    const bins = spectrum.freq_bins;
    const fftSize = (bins - 1) * 2;
    const pcOfBin = new Int8Array(bins).fill(-1);
    for (let j = 1; j < bins; j++) {
        const freq = (j * sr) / fftSize;
        if (freq < 27.5 || freq > 5000) continue; // A0 .. ~D8
        const midi = 69 + 12 * Math.log2(freq / 440);
        pcOfBin[j] = (((Math.round(midi) % 12) + 12) % 12) as number;
    }
    for (const slice of spectrum.time_slices) {
        const mags = slice.magnitudes as Float32Array | number[];
        for (let j = 1; j < bins; j++) {
            const pc = pcOfBin[j];
            if (pc < 0) continue;
            const db = mags[j];
            if (db <= -120) continue;
            chroma[pc] += Math.pow(10, db / 10); // back to linear power
        }
    }
    return chroma;
}

function detectKey(chroma: number[]): { pc: number; minor: boolean } {
    let best = { score: -Infinity, pc: 0, minor: false };
    for (let r = 0; r < 12; r++) {
        const major = new Array(12);
        const minor = new Array(12);
        for (let i = 0; i < 12; i++) {
            major[i] = KK_MAJOR[((i - r) % 12 + 12) % 12];
            minor[i] = KK_MINOR[((i - r) % 12 + 12) % 12];
        }
        const majScore = pearson(chroma, major);
        const minScore = pearson(chroma, minor);
        if (majScore > best.score) best = { score: majScore, pc: r, minor: false };
        if (minScore > best.score) best = { score: minScore, pc: r, minor: true };
    }
    return { pc: best.pc, minor: best.minor };
}

function estimateBpm(samples: Float32Array, sampleRate: number): number {
    if (samples.length < sampleRate) return 0;
    const hop = Math.max(1, Math.floor(sampleRate * 0.01)); // 10ms frames
    const envelope: number[] = [];
    let prev = 0;
    for (let i = 0; i < samples.length; i += hop) {
        const end = Math.min(i + hop, samples.length);
        let sum = 0;
        for (let j = i; j < end; j++) sum += samples[j] * samples[j];
        const rms = Math.sqrt(sum / Math.max(1, end - i));
        envelope.push(Math.max(0, rms - prev));
        prev = rms;
    }
    const fps = sampleRate / hop;
    let bestBpm = 0;
    let bestScore = -Infinity;
    for (let bpm = 70; bpm <= 180; bpm++) {
        const lag = Math.round((fps * 60) / bpm);
        if (lag < 1 || lag >= envelope.length) continue;
        let score = 0;
        for (let i = 0; i + lag < envelope.length; i++) score += envelope[i] * envelope[i + lag];
        if (score > bestScore) {
            bestScore = score;
            bestBpm = bpm;
        }
    }
    return bestBpm;
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

    const spectrum = await analyzeSpectrumFromSamples(samples, sampleRate, { fftSize: 4096, windowFunction: "hann" });
    const { pc, minor } = detectKey(buildChroma(spectrum));
    return {
        key: NOTE_NAMES[pc] + (minor ? "m" : ""),
        camelot: (minor ? MINOR_CAMELOT : MAJOR_CAMELOT)[pc],
        bpm: estimateBpm(samples, sampleRate),
    };
}
