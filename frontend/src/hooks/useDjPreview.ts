import { useEffect, useRef, useState } from "react";
import { GetPreviewURL } from "@/../wailsjs/go/main/App";
import { getPreviewVolume } from "@/lib/preview";
import { createPreviewPlayback, type PreviewPlayback } from "@/lib/preview-player";
import { GetMediaStreamURL } from "@/lib/media";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import type { DjSetNode } from "@/lib/djset";

// Single-player preview shared across all DJ nodes (only one plays at a time).
// Spotify nodes use the 30s Spotify preview; URL nodes get a stream via yt-dlp.
export function useDjPreview() {
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const playbackRef = useRef<PreviewPlayback | null>(null);

    const stop = () => {
        if (playbackRef.current) {
            playbackRef.current.destroy();
            playbackRef.current = null;
        }
    };
    useEffect(() => () => stop(), []);

    const resolveUrl = async (node: DjSetNode): Promise<string> => {
        if (node.source && node.source !== "spotify") {
            return await GetMediaStreamURL(node.track?.external_url || node.query.trim());
        }
        if (node.track?.spotify_id) {
            return await GetPreviewURL(node.track.spotify_id);
        }
        return "";
    };

    const toggle = async (node: DjSetNode) => {
        try {
            if (playingId === node.id && playbackRef.current) {
                stop();
                setPlayingId(null);
                return;
            }
            stop();
            setPlayingId(null);
            setLoadingId(node.id);
            const url = await resolveUrl(node);
            if (!url) {
                toast.error("Preview not available");
                setLoadingId(null);
                return;
            }
            const playback = await createPreviewPlayback(url, getPreviewVolume());
            const audio = playback.audio;
            audio.addEventListener("loadeddata", () => {
                setLoadingId(null);
                setPlayingId(node.id);
            });
            audio.addEventListener("ended", () => {
                setPlayingId((cur) => (cur === node.id ? null : cur));
                if (playbackRef.current?.audio === audio) {
                    playbackRef.current.destroy();
                    playbackRef.current = null;
                }
            });
            audio.addEventListener("error", () => {
                toast.error("Preview not available");
                setLoadingId(null);
                setPlayingId(null);
                if (playbackRef.current?.audio === audio) {
                    playbackRef.current.destroy();
                    playbackRef.current = null;
                }
            });
            playbackRef.current = playback;
            await audio.play();
        } catch (err) {
            stop();
            setLoadingId(null);
            setPlayingId(null);
            toast.error(err instanceof Error ? err.message : "Preview not available");
        }
    };

    return { toggle, playingId, loadingId };
}
