// DJ Set Editor — shared types, filename helpers, and persistence.
//
// The editor arranges song "nodes" into a play sequence. On processing, every
// track is downloaded (or, if already present, renamed) with an index prefix
// matching its position in the set — e.g. "01. Title - Artist.flac" — so the
// folder is pre-sorted for rekordbox in the exact order of the set.

export type NodeStatus =
    | "empty" // no query entered yet
    | "queued" // a query is entered but no track is resolved yet
    | "resolving" // searching Spotify for a match
    | "resolved" // a track match is selected, not yet checked/processed
    | "no-match" // search returned nothing
    | "present" // matching file already on disk (may need renumbering)
    | "missing" // resolved but not found on disk
    | "downloading" // download in progress
    | "renaming" // renumbering an existing file
    | "done" // file is on disk with the correct index
    | "error"; // resolve/download/rename failed

export interface SongHarmonics {
    bpm?: number;
    key?: string; // musical key text, e.g. "Gm"
    camelot?: string; // Camelot code, e.g. "6A"
}

export type HarmonicsStatus = "loading" | "done" | "none";

export interface ResolvedTrack {
    spotify_id: string;
    name: string;
    artists: string;
    album_name: string;
    release_date: string;
    images: string; // cover URL
    duration_ms: number;
    external_url: string;
}

export interface DjSetNode {
    id: string;
    query: string;
    status: NodeStatus;
    track?: ResolvedTrack;
    filePath?: string; // current path on disk once present/done
    error?: string;
    harmonics?: SongHarmonics;
    harmonicsStatus?: HarmonicsStatus;
}

export interface DjSet {
    id: string;
    name: string;
    outputFolder: string; // base folder; tracks land in <outputFolder>/<name>
    order: string[]; // node ids in play order
    nodes: Record<string, DjSetNode>;
    updatedAt?: number;
}

// Filename format used for every downloaded track in a set. The {track} token
// is expanded to the zero-padded position by the Go backend (see filename.go).
export const DJ_FILENAME_FORMAT = "{track}. {title} - {artist}";

const STORAGE_KEY = "spotiflac_dj_set";

export function createNode(query = ""): DjSetNode {
    return {
        id: crypto.randomUUID(),
        query,
        status: query.trim() ? "queued" : "empty",
    };
}

export function createEmptySet(outputFolder: string): DjSet {
    const first = createNode();
    return {
        id: crypto.randomUUID(),
        name: "My DJ Set",
        outputFolder,
        order: [first.id],
        nodes: { [first.id]: first },
        updatedAt: Date.now(),
    };
}

export function songCount(set: DjSet): number {
    return set.order.filter((id) => set.nodes[id]?.query.trim()).length;
}

// Number of leading digits in a filename, used to order imported files.
export function parseIndexPrefix(nameWithoutExt: string): number | null {
    const match = nameWithoutExt.match(/^\s*(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

// --- Camelot wheel: colors + harmonic compatibility ---

// Colors approximating the Camelot wheel. Each wheel position (1–12) has a hue;
// the "B" (major) ring is saturated, the "A" (minor) ring is a lighter pastel.
const CAMELOT_B_COLORS: Record<number, string> = {
    1: "#3FD9A6", 2: "#3CCB5C", 3: "#8FD94A", 4: "#F2C23D", 5: "#F2933D", 6: "#F26B6B",
    7: "#F25C9C", 8: "#E86FC6", 9: "#B57BE6", 10: "#7C84E8", 11: "#4FA6F2", 12: "#3DD3E6",
};
const CAMELOT_A_COLORS: Record<number, string> = {
    1: "#A8ECD6", 2: "#A8E6B8", 3: "#CDEDA6", 4: "#F7E2A6", 5: "#F7CFA6", 6: "#F7B8B8",
    7: "#F7B3D1", 8: "#F3BCE3", 9: "#DEC0F2", 10: "#C0C4F2", 11: "#B0D4F7", 12: "#AEEAF2",
};

export function parseCamelot(code?: string): { num: number; letter: "A" | "B" } | null {
    if (!code) return null;
    const match = code.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    if (num < 1 || num > 12) return null;
    return { num, letter: match[2] as "A" | "B" };
}

export function camelotColor(code?: string): { bg: string; fg: string } | null {
    const parsed = parseCamelot(code);
    if (!parsed) return null;
    const bg = parsed.letter === "A" ? CAMELOT_A_COLORS[parsed.num] : CAMELOT_B_COLORS[parsed.num];
    return { bg, fg: "#0b0b0c" };
}

// Describe the harmonic relationship between two Camelot codes as a neutral
// label (not a pass/fail verdict — "incompatible" keys can still work).
// `compatible` marks the classic smooth moves (same key, relative major/minor,
// or one step around the wheel) for gentle color-coding only.
export function camelotRelation(a?: string, b?: string): { label: string; compatible: boolean } | null {
    const pa = parseCamelot(a);
    const pb = parseCamelot(b);
    if (!pa || !pb) return null;

    // Signed shortest distance around the wheel (-5..+6).
    let steps = pb.num - pa.num;
    if (steps > 6) steps -= 12;
    if (steps < -6) steps += 12;
    const sameLetter = pa.letter === pb.letter;

    if (steps === 0 && sameLetter) return { label: "same key", compatible: true };
    if (steps === 0 && !sameLetter) return { label: "relative", compatible: true };

    const signed = `${steps > 0 ? "+" : ""}${steps}`;
    if (sameLetter) {
        return { label: signed, compatible: Math.abs(steps) === 1 };
    }
    // Different mode (major↔minor) and a wheel distance.
    return { label: `${signed} ·m`, compatible: false };
}

// Port of backend SanitizeFilename (backend/filename.go) so the names we
// compute on the frontend match the files the backend actually writes.
export function sanitizeFilename(name: string): string {
    let s = name.replace(/\//g, " ");
    s = s.replace(/[<>:"\\|?*]/g, " ");
    // Strip control characters (keep tab/newline/carriage-return like Go does).
    s = Array.from(s)
        .filter((ch) => {
            const c = ch.codePointAt(0) ?? 0;
            if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
            if (c === 0x7f) return false;
            return true;
        })
        .join("");
    s = s.trim();
    s = s.replace(/^[.\s]+|[.\s]+$/g, ""); // strings.Trim(s, ". ")
    s = s.replace(/\s+/g, " ");
    s = s.replace(/_+/g, "_");
    s = s.replace(/^[_\s]+|[_\s]+$/g, ""); // strings.Trim(s, "_ ")
    return s === "" ? "Unknown" : s;
}

function pad(position: number): string {
    return String(position).padStart(2, "0");
}

// "Title - Artist" with no index — the stable identity of a track's file.
export function coreName(track: ResolvedTrack): string {
    return `${sanitizeFilename(track.name)} - ${sanitizeFilename(track.artists)}`;
}

// "NN. Title - Artist" — the desired filename (without extension) for a given
// position in the set.
export function indexedName(track: ResolvedTrack, position: number): string {
    return `${pad(position)}. ${coreName(track)}`;
}

export function stripExtension(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return dot > 0 ? filename.slice(0, dot) : filename;
}

// Remove a leading index prefix such as "01. ", "1 - ", "12_" so a file can be
// matched back to its track regardless of its current numbering.
export function stripIndexPrefix(nameWithoutExt: string): string {
    return nameWithoutExt.replace(/^\s*\d+\s*[.\-_)]?\s+/, "").trim();
}

export function basename(path: string): string {
    return path.split(/[/\\]/).pop() ?? path;
}

export function loadDjSet(): DjSet | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as DjSet;
        if (!parsed || !Array.isArray(parsed.order) || typeof parsed.nodes !== "object") {
            return null;
        }
        if (!parsed.id) parsed.id = crypto.randomUUID(); // backfill pre-library sets
        // Reset in-progress statuses that can't survive a restart so a node saved
        // mid-resolve/download doesn't come back stuck in a spinner state.
        for (const id of parsed.order) {
            const node = parsed.nodes[id];
            if (!node) continue;
            if (node.status === "resolving" || node.status === "downloading" || node.status === "renaming") {
                node.status = node.track ? "resolved" : node.query.trim() ? "queued" : "empty";
            }
            if (node.harmonicsStatus === "loading") {
                node.harmonicsStatus = node.harmonics ? "done" : undefined;
            }
        }
        return parsed;
    } catch (err) {
        console.error("Failed to load DJ set:", err);
        return null;
    }
}

export function saveDjSet(set: DjSet): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(set));
    } catch (err) {
        console.error("Failed to save DJ set:", err);
    }
}

// --- Saved-sets library (separate from the active working set) ---

const LIBRARY_KEY = "spotiflac_dj_sets";

function persistLibrary(library: DjSet[]): void {
    try {
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch (err) {
        console.error("Failed to save DJ set library:", err);
    }
}

export function loadLibrary(): DjSet[] {
    try {
        const raw = localStorage.getItem(LIBRARY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as DjSet[]) : [];
    } catch (err) {
        console.error("Failed to load DJ set library:", err);
        return [];
    }
}

// Upsert a set (by id) into the library and return the refreshed, recency-sorted list.
export function saveToLibrary(set: DjSet): DjSet[] {
    const snapshot: DjSet = JSON.parse(JSON.stringify({ ...set, updatedAt: Date.now() }));
    const library = loadLibrary().filter((s) => s.id !== set.id);
    library.unshift(snapshot);
    library.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    persistLibrary(library);
    return library;
}

export function deleteFromLibrary(id: string): DjSet[] {
    const library = loadLibrary().filter((s) => s.id !== id);
    persistLibrary(library);
    return library;
}

export function getLibrarySet(id: string): DjSet | null {
    return loadLibrary().find((s) => s.id === id) ?? null;
}

// Build a set from a folder of (numbered) audio files: ordered by index prefix,
// each node's query derived from the filename, with the file path attached.
export function buildSetFromFolder(folder: string, files: Array<{ path: string }>): DjSet {
    const entries = files
        .map((f) => {
            const nameNoExt = stripExtension(basename(f.path));
            return { path: f.path, nameNoExt, index: parseIndexPrefix(nameNoExt) };
        })
        .sort((a, b) => {
            const ai = a.index ?? Number.MAX_SAFE_INTEGER;
            const bi = b.index ?? Number.MAX_SAFE_INTEGER;
            return ai - bi || a.nameNoExt.localeCompare(b.nameNoExt);
        });

    const order: string[] = [];
    const nodes: Record<string, DjSetNode> = {};
    for (const entry of entries) {
        const core = stripIndexPrefix(entry.nameNoExt) || entry.nameNoExt;
        const node = createNode(core);
        node.filePath = entry.path;
        nodes[node.id] = node;
        order.push(node.id);
    }
    if (order.length === 0) {
        const empty = createNode();
        nodes[empty.id] = empty;
        order.push(empty.id);
    }

    const normalized = folder.replace(/[\\/]+$/, "");
    const name = normalized.split(/[\\/]/).pop() || "Imported Set";
    const parent = normalized.slice(0, normalized.length - name.length).replace(/[\\/]+$/, "");

    return {
        id: crypto.randomUUID(),
        name,
        outputFolder: parent,
        order,
        nodes,
        updatedAt: Date.now(),
    };
}
