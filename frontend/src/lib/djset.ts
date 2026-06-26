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
}

export interface DjSet {
    name: string;
    outputFolder: string; // base folder; tracks land in <outputFolder>/<name>
    order: string[]; // node ids in play order
    nodes: Record<string, DjSetNode>;
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
        name: "My DJ Set",
        outputFolder,
        order: [first.id],
        nodes: { [first.id]: first },
    };
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
        // Reset in-progress statuses that can't survive a restart so a node saved
        // mid-resolve/download doesn't come back stuck in a spinner state.
        for (const id of parsed.order) {
            const node = parsed.nodes[id];
            if (!node) continue;
            if (node.status === "resolving" || node.status === "downloading" || node.status === "renaming") {
                node.status = node.track ? "resolved" : node.query.trim() ? "queued" : "empty";
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
