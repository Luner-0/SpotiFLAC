import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Search,
    Trash2,
    ChevronUp,
    ChevronDown,
    Music,
    CheckCircle2,
    AlertCircle,
    Replace,
    Play,
    Pause,
    Wand2,
} from "lucide-react";
import { camelotColor, type DjSetNode, type NodeStatus, type ResolvedTrack } from "@/lib/djset";
import { providerLabel } from "@/lib/media";

export interface SongNodeData {
    node: DjSetNode;
    position: number; // 1-based slot among real songs (0 if not yet a song)
    isFirst: boolean;
    isLast: boolean;
    processing: boolean;
    onQueryChange: (id: string, query: string) => void;
    onResolve: (id: string) => void;
    onRemove: (id: string) => void;
    onMove: (id: string, direction: -1 | 1) => void;
    onSearch: (query: string) => Promise<ResolvedTrack[]>;
    onPick: (id: string, track: ResolvedTrack) => void;
    onPreview: (node: DjSetNode) => void;
    onAnalyze: (id: string) => void;
    previewPlayingId: string | null;
    previewLoadingId: string | null;
    [key: string]: unknown;
}

const STATUS_META: Record<NodeStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    empty: { label: "Empty", variant: "outline" },
    queued: { label: "Not resolved", variant: "outline" },
    resolving: { label: "Resolving…", variant: "secondary" },
    resolved: { label: "Resolved", variant: "secondary" },
    "no-match": { label: "No match", variant: "destructive" },
    present: { label: "On disk", variant: "secondary" },
    missing: { label: "Missing", variant: "outline" },
    downloading: { label: "Downloading…", variant: "secondary" },
    renaming: { label: "Renumbering…", variant: "secondary" },
    done: { label: "Ready", variant: "default" },
    error: { label: "Error", variant: "destructive" },
};

function StatusIcon({ status }: { status: NodeStatus }) {
    if (status === "resolving" || status === "downloading" || status === "renaming") {
        return <Spinner className="h-4 w-4 text-primary" />;
    }
    if (status === "done") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === "error" || status === "no-match") return <AlertCircle className="h-4 w-4 text-destructive" />;
    return <Music className="h-4 w-4 text-muted-foreground" />;
}

export function SongNode(props: NodeProps) {
    const data = props.data as unknown as SongNodeData;
    const { node, position, isFirst, isLast, processing } = data;
    const [pickerOpen, setPickerOpen] = useState(false);
    const [results, setResults] = useState<ResolvedTrack[]>([]);
    const [searching, setSearching] = useState(false);

    const busy = processing || node.status === "resolving" || node.status === "downloading" || node.status === "renaming";
    const meta = STATUS_META[node.status];
    const isExternal = !!node.source && node.source !== "spotify";
    const isPreviewPlaying = data.previewPlayingId === node.id;
    const isPreviewLoading = data.previewLoadingId === node.id;

    const openPicker = async () => {
        setPickerOpen(true);
        setSearching(true);
        try {
            setResults(await data.onSearch(node.query));
        } catch {
            setResults([]);
        } finally {
            setSearching(false);
        }
    };

    return (
        <div className="w-80 rounded-lg border bg-card shadow-sm">
            <Handle type="target" position={Position.Top} className="!bg-muted-foreground/50" />

            <div className="flex items-center gap-2 border-b px-3 py-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary tabular-nums">
                    {position > 0 ? String(position).padStart(2, "0") : "–"}
                </div>
                <StatusIcon status={node.status} />
                <Badge variant={meta.variant} className="ml-auto">{meta.label}</Badge>
                <div className="flex">
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={isFirst || busy} onClick={() => data.onMove(node.id, -1)}>
                        <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={isLast || busy} onClick={() => data.onMove(node.id, 1)}>
                        <ChevronDown className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" disabled={busy} onClick={() => data.onRemove(node.id)}>
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="space-y-2 p-3">
                <div className="flex gap-2 nodrag">
                    <Input
                        value={node.query}
                        placeholder="Search, or paste a SoundCloud / YouTube URL"
                        disabled={busy}
                        onChange={(e) => data.onQueryChange(node.id, e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && node.query.trim()) data.onResolve(node.id);
                        }}
                        className="h-8"
                    />
                    <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" disabled={busy || !node.query.trim()} onClick={() => data.onResolve(node.id)} title="Resolve top match">
                        <Search className="h-4 w-4" />
                    </Button>
                </div>

                {node.track && (
                    <div className="flex items-center gap-2 rounded-md bg-muted/40 p-2">
                        {node.track.images ? (
                            <img src={node.track.images} alt="" className="h-10 w-10 rounded object-cover" />
                        ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded bg-muted">
                                <Music className="h-4 w-4 text-muted-foreground" />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{node.track.name}</p>
                            <p className="truncate text-xs text-muted-foreground">{node.track.artists}</p>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0 nodrag"
                            disabled={node.status === "resolving"}
                            onClick={() => data.onPreview(node)}
                            title={isPreviewPlaying ? "Stop preview" : "Preview"}
                        >
                            {isPreviewLoading ? (
                                <Spinner className="h-4 w-4" />
                            ) : isPreviewPlaying ? (
                                <Pause className="h-4 w-4" />
                            ) : (
                                <Play className="h-4 w-4" />
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0 nodrag"
                            disabled={busy || node.harmonicsStatus === "loading"}
                            onClick={() => data.onAnalyze(node.id)}
                            title={node.filePath
                                ? "Estimate key / BPM from the file (in-app, may be inaccurate)"
                                : "Estimate key / BPM from a preview (in-app, may be inaccurate)"}
                        >
                            <Wand2 className="h-4 w-4" />
                        </Button>
                        {isExternal ? (
                            <Badge variant="secondary" className="shrink-0">{providerLabel(node.source)}</Badge>
                        ) : (
                            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 nodrag" disabled={busy || !node.query.trim()} onClick={openPicker} title="Pick a different match">
                                <Replace className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                )}

                {node.track && (node.harmonics || node.harmonicsStatus) && (
                    <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                            {node.harmonicsStatus === "loading" ? (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Spinner className="h-3 w-3" /> reading key / BPM…
                                </span>
                            ) : node.harmonics ? (
                                <>
                                    {node.harmonics.camelot && (() => {
                                        const color = camelotColor(node.harmonics.camelot);
                                        return (
                                            <Badge
                                                className="font-mono border-transparent"
                                                style={color ? { backgroundColor: color.bg, color: color.fg } : undefined}
                                                title="Camelot code"
                                            >
                                                {node.harmonics.camelot}
                                            </Badge>
                                        );
                                    })()}
                                    {node.harmonics.key && (
                                        <Badge variant="outline" title="Musical key">{node.harmonics.key}</Badge>
                                    )}
                                    {node.harmonics.bpm ? (
                                        <Badge variant="secondary" title="Tempo">{node.harmonics.bpm} BPM</Badge>
                                    ) : null}
                                    {node.harmonics.estimated && (
                                        <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400" title="Estimated by in-app analysis">~est</Badge>
                                    )}
                                </>
                            ) : node.harmonicsStatus === "none" ? (
                                <span className="text-xs text-muted-foreground">No key / BPM data</span>
                            ) : null}
                        </div>
                        {node.harmonics?.estimated && (
                            <p className="text-[10px] leading-tight text-amber-600/90 dark:text-amber-400/90">
                                ≈ Estimated in-app — likely inaccurate. Treat as a rough guide.
                            </p>
                        )}
                    </div>
                )}

                {node.error && <p className="text-xs text-destructive">{node.error}</p>}
            </div>

            <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground/50" />

            <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Choose a match</DialogTitle>
                        <DialogDescription>Results for “{node.query}”</DialogDescription>
                    </DialogHeader>
                    <div className="max-h-96 space-y-1 overflow-y-auto">
                        {searching ? (
                            <div className="flex items-center justify-center py-8">
                                <Spinner className="h-5 w-5 text-primary" />
                            </div>
                        ) : results.length === 0 ? (
                            <p className="py-8 text-center text-sm text-muted-foreground">No results found.</p>
                        ) : (
                            results.map((track) => (
                                <button
                                    key={track.spotify_id}
                                    className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-accent"
                                    onClick={() => {
                                        data.onPick(node.id, track);
                                        setPickerOpen(false);
                                    }}
                                >
                                    {track.images ? (
                                        <img src={track.images} alt="" className="h-10 w-10 rounded object-cover" />
                                    ) : (
                                        <div className="flex h-10 w-10 items-center justify-center rounded bg-muted">
                                            <Music className="h-4 w-4 text-muted-foreground" />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{track.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">{track.artists}</p>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
