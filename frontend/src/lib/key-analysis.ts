// In-app musical key + BPM estimation. The DSP now runs in the Go backend
// (backend/audioanalysis.go) — HPCP-style harmonic-summed chroma + per-segment
// key voting, and a multi-band onset envelope with perceptually-weighted tempo
// search. It's still a DSP estimate (flagged ~est in the UI), but much better
// than the old in-JS chromagram, and it doesn't block the UI thread.

export interface KeyAnalysisResult {
    key: string; // e.g. "Am", "F#"
    camelot: string; // e.g. "8A"
    bpm: number; // 0 if undetermined
    confidence?: number; // 0..1 key-detection confidence
}

interface GoAnalysis {
    key: string;
    camelot: string;
    bpm: number;
    confidence: number;
}

type AppApi = {
    AnalyzeAudioFile: (path: string) => Promise<GoAnalysis>;
    AnalyzeAudioURL: (url: string) => Promise<GoAnalysis>;
};
const app = (): AppApi => (window as unknown as { go: { main: { App: AppApi } } }).go.main.App;

export async function analyzeKey(filePath: string): Promise<KeyAnalysisResult> {
    const r = await app().AnalyzeAudioFile(filePath);
    return { key: r.key, camelot: r.camelot, bpm: r.bpm, confidence: r.confidence };
}

export async function analyzeKeyFromUrl(url: string): Promise<KeyAnalysisResult> {
    const r = await app().AnalyzeAudioURL(url);
    return { key: r.key, camelot: r.camelot, bpm: r.bpm, confidence: r.confidence };
}
