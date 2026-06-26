import { useState, useCallback, useEffect, useRef } from "react";
import { downloadTrack } from "@/lib/api";
import { getSettings, sanitizeAutoOrder, type Settings } from "@/lib/settings";
import { joinPath, sanitizePath } from "@/lib/utils";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { logger } from "@/lib/logger";
import type { DownloadRequest, DownloadResponse } from "@/types/api";
import {
    type DjSet,
    type DjSetNode,
    type ResolvedTrack,
    DJ_FILENAME_FORMAT,
    basename,
    buildSetFromFolder,
    coreName,
    createEmptySet,
    createNode,
    deleteFromLibrary,
    getLibrarySet,
    indexedName,
    loadDjSet,
    loadLibrary,
    NODE_LAYOUT_GAP,
    saveDjSet,
    saveToLibrary,
    songCount,
    stripExtension,
    stripIndexPrefix,
} from "@/lib/djset";
import { detectMediaUrl, ResolveMedia, DownloadMedia, ensureYtDlp, IsYtDlpInstalled } from "@/lib/media";

// Raw search result shape returned by the Go SearchSpotify binding.
interface RawSearchResult {
    id: string;
    name: string;
    type?: string;
    artists?: string;
    album_name?: string;
    images?: string;
    release_date?: string;
    external_urls?: string;
    duration_ms?: number;
}
interface RawSearchResponse {
    tracks?: RawSearchResult[];
    albums?: RawSearchResult[];
    artists?: RawSearchResult[];
    playlists?: RawSearchResult[];
}

// Bound Go methods accessed via the runtime global (mirrors the pattern already
// used in useDownload for CheckFilesExistence etc.).
type WailsApp = Record<string, (...args: unknown[]) => Promise<unknown>>;
const wails = (): WailsApp => (window as unknown as { go: { main: { App: WailsApp } } }).go.main.App;
const SearchSpotify = (req: { query: string; limit: number }) =>
    wails().SearchSpotify(req) as Promise<RawSearchResponse>;
const GetStreamingURLs = (id: string, region: string) =>
    wails().GetStreamingURLs(id, region) as Promise<string>;
const ListAudioFilesInDir = (dir: string) =>
    wails().ListAudioFilesInDir(dir) as Promise<Array<{ name: string; path: string }>>;
const RenameFileTo = (oldPath: string, newName: string) =>
    wails().RenameFileTo(oldPath, newName) as Promise<void>;
const SelectFolder = (def: string) => wails().SelectFolder(def) as Promise<string>;
const OpenFolder = (path: string) => wails().OpenFolder(path) as Promise<void>;
const ForceStopDownloads = () => wails().ForceStopDownloads() as Promise<void>;
const GetSongHarmonics = (artist: string, title: string) =>
    wails().GetSongHarmonics(artist, title) as Promise<{ bpm: number; key: string; camelot: string }>;

function mapResult(r: RawSearchResult): ResolvedTrack {
    return {
        spotify_id: r.id,
        name: r.name,
        artists: r.artists || "",
        album_name: r.album_name || "",
        release_date: r.release_date || "",
        images: r.images || "",
        duration_ms: r.duration_ms || 0,
        external_url: r.external_urls || "",
    };
}

function httpsOrUndefined(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().replace(/\/+$/g, "");
    return trimmed.startsWith("https://") ? trimmed : undefined;
}

// Download a single track with a DJ-set filename ("NN. Title - Artist") into the
// given folder, honoring the user's service/quality settings. This calls the
// low-level download API directly (rather than useDownload) so the index prefix
// is deterministic regardless of the user's global filename template.
async function downloadDjTrack(
    settings: Settings,
    track: ResolvedTrack,
    position: number,
    outputDir: string,
): Promise<DownloadResponse> {
    const customTidalApi = httpsOrUndefined(settings.customTidalApi);
    const customQobuzApi = httpsOrUndefined(settings.customQobuzApi);
    const base: Omit<DownloadRequest, "service"> = {
        query: `${track.name} ${track.artists}`.trim(),
        track_name: track.name,
        artist_name: track.artists,
        artists: track.artists,
        album_name: track.album_name,
        album_artist: track.artists,
        release_date: track.release_date,
        cover_url: track.images,
        output_dir: outputDir,
        filename_format: DJ_FILENAME_FORMAT,
        position,
        track_number: false,
        spotify_id: track.spotify_id,
        duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined,
        embed_lyrics: settings.embedLyrics,
        embed_max_quality_cover: settings.embedMaxQualityCover,
        save_cover: settings.saveCover,
        use_first_artist_only: settings.useFirstArtistOnly,
        use_single_genre: settings.useSingleGenre,
        embed_genre: settings.embedGenre,
    };

    const service = settings.downloader;
    if (service === "auto") {
        const order = sanitizeAutoOrder(settings.autoOrder).split("-");
        let streamingURLs: { tidal_url?: string; amazon_url?: string } | null = null;
        if (track.spotify_id && (order.includes("tidal") || order.includes("amazon"))) {
            try {
                streamingURLs = JSON.parse(await GetStreamingURLs(track.spotify_id, ""));
            } catch (err) {
                logger.warning(`Failed to get streaming URLs: ${err}`);
            }
        }
        const is24 = (settings.autoQuality || "24") === "24";
        const tidalQuality = is24 ? "HI_RES_LOSSLESS" : "LOSSLESS";
        const qobuzQuality = is24 ? "27" : "6";
        let last: DownloadResponse = { success: false, message: "", error: "No matching services found" };
        for (const s of order) {
            if (s === "tidal" && streamingURLs?.tidal_url) {
                last = await downloadTrack({ ...base, service: "tidal", service_url: streamingURLs.tidal_url, audio_format: tidalQuality, tidal_api_url: customTidalApi });
            } else if (s === "amazon" && streamingURLs?.amazon_url) {
                last = await downloadTrack({ ...base, service: "amazon", service_url: streamingURLs.amazon_url, audio_format: is24 ? "24" : "16" });
            } else if (s === "qobuz") {
                last = await downloadTrack({ ...base, service: "qobuz", audio_format: qobuzQuality, qobuz_api_url: customQobuzApi });
            } else {
                continue;
            }
            if (last.success) return last;
        }
        return last;
    }

    let audioFormat: string | undefined;
    if (service === "tidal") audioFormat = settings.tidalQuality || "LOSSLESS";
    else if (service === "qobuz") audioFormat = settings.qobuzQuality || "6";
    else if (service === "amazon") audioFormat = settings.amazonQuality || "16";
    return downloadTrack({
        ...base,
        service: service as "tidal" | "qobuz" | "amazon",
        audio_format: audioFormat,
        tidal_api_url: service === "tidal" ? customTidalApi : undefined,
        qobuz_api_url: service === "qobuz" ? customQobuzApi : undefined,
    });
}

export function useDjSet() {
    const [set, setSet] = useState<DjSet>(() => loadDjSet() ?? createEmptySet(getSettings().downloadPath));
    const [library, setLibrary] = useState<DjSet[]>(() => loadLibrary());
    const [processing, setProcessing] = useState(false);
    const setRef = useRef(set);
    const processingRef = useRef(false);
    const stopRef = useRef(false);

    useEffect(() => {
        setRef.current = set;
        saveDjSet(set);
    }, [set]);

    const updateNode = useCallback((id: string, patch: Partial<DjSetNode>) => {
        setSet((prev) => {
            const node = prev.nodes[id];
            if (!node) return prev;
            return { ...prev, nodes: { ...prev.nodes, [id]: { ...node, ...patch } } };
        });
    }, []);

    const addNode = useCallback((query = "") => {
        setSet((prev) => {
            const node = createNode(query);
            const ys = prev.order.map((id) => prev.nodes[id]?.y ?? 0);
            const maxY = ys.length ? Math.max(...ys) : -NODE_LAYOUT_GAP;
            node.x = 0;
            node.y = maxY + NODE_LAYOUT_GAP;
            return { ...prev, order: [...prev.order, node.id], nodes: { ...prev.nodes, [node.id]: node } };
        });
    }, []);

    // Persist canvas positions after a drag so the manual layout survives edits.
    const persistPositions = useCallback((positions: Array<{ id: string; x: number; y: number }>) => {
        setSet((prev) => {
            const nodes = { ...prev.nodes };
            let changed = false;
            for (const p of positions) {
                const node = nodes[p.id];
                if (node && (node.x !== p.x || node.y !== p.y)) {
                    nodes[p.id] = { ...node, x: p.x, y: p.y };
                    changed = true;
                }
            }
            return changed ? { ...prev, nodes } : prev;
        });
    }, []);

    const removeNode = useCallback((id: string) => {
        setSet((prev) => {
            if (!prev.nodes[id]) return prev;
            const nodes = { ...prev.nodes };
            delete nodes[id];
            return { ...prev, order: prev.order.filter((x) => x !== id), nodes };
        });
    }, []);

    const updateQuery = useCallback((id: string, query: string) => {
        setSet((prev) => {
            const node = prev.nodes[id];
            if (!node) return prev;
            const trimmed = query.trim();
            return {
                ...prev,
                nodes: {
                    ...prev.nodes,
                    [id]: {
                        ...node,
                        query,
                        track: undefined,
                        filePath: undefined,
                        error: undefined,
                        status: trimmed ? "queued" : "empty",
                    },
                },
            };
        });
    }, []);

    const reorder = useCallback((order: string[]) => {
        setSet((prev) => ({ ...prev, order }));
    }, []);

    const moveNode = useCallback((id: string, direction: -1 | 1) => {
        setSet((prev) => {
            const index = prev.order.indexOf(id);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= prev.order.length) return prev;
            const order = [...prev.order];
            [order[index], order[target]] = [order[target], order[index]];
            return { ...prev, order };
        });
    }, []);

    const setName = useCallback((name: string) => setSet((prev) => ({ ...prev, name })), []);
    const setOutputFolder = useCallback((outputFolder: string) => setSet((prev) => ({ ...prev, outputFolder })), []);

    const getSetFolder = useCallback(() => {
        const settings = getSettings();
        const os = settings.operatingSystem;
        const current = setRef.current;
        const base = current.outputFolder || settings.downloadPath;
        if (!base) return "";
        return joinPath(os, base, sanitizePath(current.name.replace(/\//g, " "), os));
    }, []);

    const searchTrack = useCallback(async (query: string): Promise<ResolvedTrack[]> => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const res = await SearchSpotify({ query: trimmed, limit: 8 });
        return (res?.tracks ?? []).map(mapResult);
    }, []);

    // Fetch key/BPM/Camelot for a node's track from GetSongBPM (no-op if the user
    // hasn't set an API key). Runs in the background after a track is resolved.
    const fetchHarmonics = useCallback(async (id: string, track: ResolvedTrack) => {
        const apiKey = getSettings().getSongBpmApiKey?.trim();
        if (!apiKey) return;
        updateNode(id, { harmonicsStatus: "loading" });
        try {
            const h = await GetSongHarmonics(track.artists, track.name);
            if (h && (h.bpm || h.key)) {
                updateNode(id, {
                    harmonics: { bpm: h.bpm || undefined, key: h.key || undefined, camelot: h.camelot || undefined },
                    harmonicsStatus: "done",
                });
            } else {
                updateNode(id, { harmonicsStatus: "none" });
            }
        } catch {
            updateNode(id, { harmonicsStatus: "none" });
        }
    }, [updateNode]);

    // Resolve one node's query to its top Spotify match. Returns the track (also
    // written to state) or null on no-match/error.
    const resolveNode = useCallback(async (id: string): Promise<ResolvedTrack | null> => {
        const node = setRef.current.nodes[id];
        if (!node || !node.query.trim()) return null;
        updateNode(id, { status: "resolving", error: undefined });

        // SoundCloud / YouTube / other URL → resolve via yt-dlp instead of Spotify.
        const provider = detectMediaUrl(node.query);
        if (provider) {
            try {
                if (!(await IsYtDlpInstalled())) {
                    toast.info("Setting up yt-dlp (one-time download)…");
                }
                if (!(await ensureYtDlp())) {
                    updateNode(id, { status: "error", error: "yt-dlp is not available" });
                    return null;
                }
                const media = await ResolveMedia(node.query.trim());
                const track: ResolvedTrack = {
                    spotify_id: "",
                    name: media.title,
                    artists: media.uploader || provider,
                    album_name: "",
                    release_date: "",
                    images: media.thumbnail || "",
                    duration_ms: (media.duration || 0) * 1000,
                    external_url: media.webpage_url || node.query.trim(),
                };
                updateNode(id, { status: "resolved", track, source: provider });
                void fetchHarmonics(id, track); // often misses for bootlegs — fine
                return track;
            } catch (err) {
                updateNode(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
                return null;
            }
        }

        try {
            const res = await SearchSpotify({ query: node.query.trim(), limit: 5 });
            const top = res?.tracks?.[0];
            if (!top) {
                updateNode(id, { status: "no-match" });
                return null;
            }
            const track = mapResult(top);
            updateNode(id, { status: "resolved", track, source: "spotify" });
            void fetchHarmonics(id, track);
            return track;
        } catch (err) {
            updateNode(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
            return null;
        }
    }, [updateNode, fetchHarmonics]);

    const pickMatch = useCallback((id: string, track: ResolvedTrack) => {
        updateNode(id, { status: "resolved", track, filePath: undefined, error: undefined, harmonics: undefined, harmonicsStatus: undefined });
        void fetchHarmonics(id, track);
    }, [updateNode, fetchHarmonics]);

    const resolveAll = useCallback(async () => {
        for (const id of setRef.current.order) {
            const node = setRef.current.nodes[id];
            if (!node || node.track || !node.query.trim()) continue;
            await resolveNode(id);
        }
    }, [resolveNode]);

    // Scan the set folder and mark each resolved node present/missing based on
    // whether a file matching its track (ignoring index prefix) exists.
    const checkFolder = useCallback(async () => {
        const folder = getSetFolder();
        if (!folder) {
            toast.error("Set a download folder first");
            return;
        }
        let files: Array<{ name: string; path: string }> = [];
        try {
            files = (await ListAudioFilesInDir(folder)) ?? [];
        } catch {
            files = [];
        }
        const byCore = new Map<string, string>();
        for (const f of files) {
            const key = stripIndexPrefix(stripExtension(basename(f.path))).toLowerCase();
            if (!byCore.has(key)) byCore.set(key, f.path);
        }
        setSet((prev) => {
            const nodes = { ...prev.nodes };
            for (const id of prev.order) {
                const node = nodes[id];
                if (!node?.track) continue;
                const hit = byCore.get(coreName(node.track).toLowerCase());
                nodes[id] = hit
                    ? { ...node, status: "present", filePath: hit }
                    : { ...node, status: "missing", filePath: undefined };
            }
            return { ...prev, nodes };
        });
    }, [getSetFolder]);

    const stopProcessing = useCallback(async () => {
        stopRef.current = true;
        toast.info("Stopping…");
        try {
            await ForceStopDownloads();
        } catch (err) {
            console.error("Failed to stop downloads:", err);
        }
    }, []);

    // The main action: walk the set in order and, for each song slot, either
    // rename the existing file to its correct index or download it numbered.
    // Position is the slot number (counts every node with a query) so file
    // numbering matches what the user sees in the editor.
    const processSet = useCallback(async () => {
        if (processingRef.current) return;
        const settings = getSettings();
        const folder = getSetFolder();
        if (!folder) {
            toast.error("Set a download folder first");
            return;
        }
        processingRef.current = true;
        stopRef.current = false;
        setProcessing(true);
        try {
            const order = [...setRef.current.order];

            // Scan the destination folder once, keyed by index-stripped name.
            let files: Array<{ name: string; path: string }> = [];
            try {
                files = (await ListAudioFilesInDir(folder)) ?? [];
            } catch {
                files = [];
            }
            const byCore = new Map<string, string>();
            for (const f of files) {
                const key = stripIndexPrefix(stripExtension(basename(f.path))).toLowerCase();
                if (!byCore.has(key)) byCore.set(key, f.path);
            }

            // Make sure yt-dlp is ready if the set contains any URL (SoundCloud/
            // YouTube) nodes.
            const hasExternal = order.some((id) => detectMediaUrl(setRef.current.nodes[id]?.query ?? "") !== null);
            if (hasExternal) {
                if (!(await IsYtDlpInstalled())) toast.info("Setting up yt-dlp (one-time download)…");
                await ensureYtDlp();
            }

            let position = 0;
            let downloaded = 0;
            let renamed = 0;
            let skipped = 0;
            let failed = 0;
            let stopped = false;

            for (const id of order) {
                const node = setRef.current.nodes[id];
                if (!node || !node.query.trim()) continue; // empty nodes take no slot
                if (stopRef.current) {
                    stopped = true;
                    break;
                }
                position += 1;

                // Resolve on demand if the node doesn't already have a track.
                let track = node.track;
                if (!track) track = (await resolveNode(id)) ?? undefined;
                if (!track) {
                    // resolveNode already set the node to no-match/error.
                    failed += 1;
                    continue;
                }

                const desired = indexedName(track, position);
                const existing = byCore.get(coreName(track).toLowerCase());

                if (existing) {
                    const currentName = stripExtension(basename(existing));
                    if (currentName === desired) {
                        updateNode(id, { status: "done", filePath: existing });
                        skipped += 1;
                        continue;
                    }
                    updateNode(id, { status: "renaming" });
                    try {
                        await RenameFileTo(existing, desired);
                        const ext = existing.slice(existing.lastIndexOf("."));
                        const dir = existing.slice(0, existing.length - basename(existing).length);
                        updateNode(id, { status: "done", filePath: dir + desired + ext });
                        renamed += 1;
                        logger.success(`renumbered: ${desired}`);
                    } catch (err) {
                        updateNode(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
                        failed += 1;
                    }
                    continue;
                }

                updateNode(id, { status: "downloading" });
                try {
                    logger.info(`downloading ${position}. ${track.name} - ${track.artists}`);
                    if (detectMediaUrl(node.query) !== null) {
                        // URL node (SoundCloud / YouTube / …) via yt-dlp.
                        const r = await DownloadMedia({ url: track.external_url || node.query.trim(), output_dir: folder, filename: desired, audio_format: settings.externalAudioFormat });
                        if (stopRef.current) { updateNode(id, { status: "missing" }); stopped = true; break; }
                        if (r.success) {
                            updateNode(id, { status: "done", filePath: r.file || undefined });
                            downloaded += 1;
                            logger.success(`downloaded: ${desired}`);
                        } else {
                            updateNode(id, { status: "error", error: r.error || "Download failed" });
                            failed += 1;
                        }
                    } else {
                        const resp = await downloadDjTrack(settings, track, position, folder);
                        if (resp.cancelled || stopRef.current) { updateNode(id, { status: "missing" }); stopped = true; break; }
                        if (resp.success) {
                            updateNode(id, { status: "done", filePath: resp.file || undefined });
                            downloaded += 1;
                            logger.success(`downloaded: ${desired}`);
                        } else {
                            updateNode(id, { status: "error", error: resp.error || resp.message || "Download failed" });
                            failed += 1;
                        }
                    }
                } catch (err) {
                    updateNode(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
                    failed += 1;
                }
            }

            const parts: string[] = [];
            if (downloaded) parts.push(`${downloaded} downloaded`);
            if (renamed) parts.push(`${renamed} renumbered`);
            if (skipped) parts.push(`${skipped} already ordered`);
            if (failed) parts.push(`${failed} failed`);
            const summary = parts.length ? parts.join(", ") : "Nothing to process";
            if (stopped) toast.info(`Stopped — ${summary}`);
            else if (failed) toast.warning(summary);
            else toast.success(summary);
        } finally {
            processingRef.current = false;
            stopRef.current = false;
            setProcessing(false);
        }
    }, [getSetFolder, resolveNode, updateNode]);

    const selectFolder = useCallback(async () => {
        try {
            const current = setRef.current.outputFolder || getSettings().downloadPath;
            const selected = await SelectFolder(current);
            if (selected) setOutputFolder(selected);
        } catch (err) {
            toast.error(`Failed to select folder: ${err}`);
        }
    }, [setOutputFolder]);

    const openFolder = useCallback(async () => {
        const folder = getSetFolder();
        if (!folder) {
            toast.error("Set a download folder first");
            return;
        }
        try {
            await OpenFolder(folder);
        } catch (err) {
            toast.error(`Failed to open folder: ${err}`);
        }
    }, [getSetFolder]);

    // Auto-snapshot the current set into the library before switching away, so
    // unsaved work isn't lost when starting/loading/importing another set.
    const snapshotCurrent = useCallback(() => {
        const current = setRef.current;
        if (current.order.some((id) => current.nodes[id]?.query.trim())) {
            setLibrary(saveToLibrary(current));
        }
    }, []);

    const saveCurrent = useCallback(() => {
        setLibrary(saveToLibrary(setRef.current));
        toast.success("Set saved");
    }, []);

    const newSet = useCallback(() => {
        snapshotCurrent();
        setSet(createEmptySet(getSettings().downloadPath));
    }, [snapshotCurrent]);

    const loadSet = useCallback((id: string) => {
        const target = getLibrarySet(id);
        if (!target) {
            toast.error("Saved set not found");
            return;
        }
        snapshotCurrent();
        setSet(JSON.parse(JSON.stringify(target)) as DjSet);
        setLibrary(loadLibrary());
        toast.success(`Loaded "${target.name}"`);
    }, [snapshotCurrent]);

    const deleteSet = useCallback((id: string) => {
        setLibrary(deleteFromLibrary(id));
    }, []);

    const importFromFolder = useCallback(async () => {
        try {
            const folder = await SelectFolder(getSettings().downloadPath);
            if (!folder) return;
            let files: Array<{ name: string; path: string }> = [];
            try {
                files = (await ListAudioFilesInDir(folder)) ?? [];
            } catch {
                files = [];
            }
            if (files.length === 0) {
                toast.error("No audio files found in that folder");
                return;
            }
            snapshotCurrent();
            const imported = buildSetFromFolder(folder, files);
            setSet(imported);
            toast.success(`Imported ${songCount(imported)} track(s) — run Resolve All to match them`);
        } catch (err) {
            toast.error(`Failed to import folder: ${err}`);
        }
    }, [snapshotCurrent]);

    const clearSet = useCallback(() => {
        setSet(createEmptySet(getSettings().downloadPath));
    }, []);

    return {
        set,
        library,
        processing,
        saveCurrent,
        newSet,
        loadSet,
        deleteSet,
        importFromFolder,
        addNode,
        removeNode,
        updateQuery,
        reorder,
        moveNode,
        persistPositions,
        setName,
        setOutputFolder,
        getSetFolder,
        searchTrack,
        resolveNode,
        resolveAll,
        pickMatch,
        checkFolder,
        processSet,
        stopProcessing,
        selectFolder,
        openFolder,
        clearSet,
    };
}
