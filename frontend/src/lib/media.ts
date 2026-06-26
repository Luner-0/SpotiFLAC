// URL-based media (SoundCloud / YouTube / etc.) helpers, backed by yt-dlp.

export type MediaProvider = "soundcloud" | "youtube" | "url";

export interface ExternalMedia {
    title: string;
    uploader: string;
    duration: number; // seconds
    thumbnail: string;
    webpage_url: string;
    extractor_key: string;
}

// Classify a string as a downloadable media URL. Spotify links are intentionally
// excluded — those go through the existing Spotify flow, not yt-dlp.
export function detectMediaUrl(text: string): MediaProvider | null {
    const trimmed = text.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    let host: string;
    try {
        host = new URL(trimmed).hostname.toLowerCase();
    } catch {
        return null;
    }
    if (host.includes("spotify.com")) return null;
    if (host.includes("soundcloud.com") || host.includes("snd.sc")) return "soundcloud";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    return "url"; // any other http(s) URL — let yt-dlp try
}

// Classify a URL as a SoundCloud/YouTube playlist (a set of tracks). Returns the
// provider when it looks like a playlist, otherwise null.
export function detectPlaylistUrl(text: string): MediaProvider | null {
    const trimmed = text.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.includes("soundcloud.com")) {
        // SoundCloud playlists/albums live under /<user>/sets/<name>.
        if (path.includes("/sets/")) return "soundcloud";
        return null;
    }
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
        if (parsed.searchParams.has("list") || path.startsWith("/playlist")) return "youtube";
        return null;
    }
    return null;
}

export interface ExternalPlaylistEntry {
    title: string;
    uploader: string;
    duration: number;
    thumbnail: string;
    url: string;
}

export interface ExternalPlaylist {
    title: string;
    entries: ExternalPlaylistEntry[];
}

export function providerLabel(provider?: MediaProvider | "spotify"): string {
    switch (provider) {
        case "soundcloud": return "SoundCloud";
        case "youtube": return "YouTube";
        case "url": return "Link";
        default: return "";
    }
}

type AppApi = Record<string, (...args: unknown[]) => Promise<unknown>>;
const app = (): AppApi => (window as unknown as { go: { main: { App: AppApi } } }).go.main.App;

export const ResolveMedia = (url: string) => app().ResolveMedia(url) as Promise<ExternalMedia>;
export const ResolvePlaylist = (url: string) => app().ResolvePlaylist(url) as Promise<ExternalPlaylist>;
export const DownloadMedia = (req: { url: string; output_dir: string; filename?: string; audio_format?: string }) =>
    app().DownloadMedia(req) as Promise<{ success: boolean; file?: string; error?: string }>;
export const GetMediaStreamURL = (url: string) => app().GetMediaStreamURL(url) as Promise<string>;
export const IsYtDlpInstalled = () => app().IsYtDlpInstalled() as Promise<boolean>;
export const DownloadYtDlp = () => app().DownloadYtDlp() as Promise<{ success: boolean; error?: string }>;

// Make sure yt-dlp is available, fetching it on first use. Returns true if ready.
export async function ensureYtDlp(): Promise<boolean> {
    try {
        if (await IsYtDlpInstalled()) return true;
        const resp = await DownloadYtDlp();
        return !!resp.success;
    } catch {
        return false;
    }
}
