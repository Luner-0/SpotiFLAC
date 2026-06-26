import { useCallback, useEffect, useMemo, useRef } from "react";
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    type Node,
    type Edge,
    type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, ListChecks, FolderSearch, Play, Trash2, FolderOpen, FolderCog, Square, Library, ChevronDown, Save, FilePlus2, FolderInput, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useDjSet } from "@/hooks/useDjSet";
import { songCount as countSongs, camelotRelation, NODE_LAYOUT_GAP } from "@/lib/djset";
import { SongNode, type SongNodeData } from "@/components/dj/SongNode";

const NODE_GAP = NODE_LAYOUT_GAP;
const nodeTypes = { song: SongNode };

export function DjSetEditorPage() {
    const dj = useDjSet();
    const { set, processing, library } = dj;
    const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
    const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const instanceRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
    const prevCount = useRef(set.order.length);
    const didFit = useRef(false);

    // Each node with a query gets a sequential slot number — matching exactly how
    // processSet numbers the downloaded files, so the sequence is visible up front.
    const positions = useMemo(() => {
        const map: Record<string, number> = {};
        let slot = 0;
        for (const id of set.order) {
            if (set.nodes[id]?.query.trim()) {
                slot += 1;
                map[id] = slot;
            } else {
                map[id] = 0;
            }
        }
        return map;
    }, [set]);

    useEffect(() => {
        const nodes: Node[] = set.order.map((id, i) => {
            const data: SongNodeData = {
                node: set.nodes[id],
                position: positions[id],
                isFirst: i === 0,
                isLast: i === set.order.length - 1,
                processing,
                onQueryChange: dj.updateQuery,
                onResolve: dj.resolveNode,
                onRemove: dj.removeNode,
                onMove: dj.moveNode,
                onSearch: dj.searchTrack,
                onPick: dj.pickMatch,
            };
            return {
                id,
                type: "song",
                position: { x: set.nodes[id]?.x ?? 0, y: set.nodes[id]?.y ?? i * NODE_GAP },
                data: data as unknown as Record<string, unknown>,
            };
        });
        const edges: Edge[] = [];
        for (let i = 0; i < set.order.length - 1; i += 1) {
            const source = set.order[i];
            const target = set.order[i + 1];
            const edge: Edge = { id: `${source}->${target}`, source, target };
            // Label the connector with the neutral harmonic distance between the
            // two keys (not a verdict) when both tracks have a Camelot code.
            const relation = camelotRelation(set.nodes[source]?.harmonics?.camelot, set.nodes[target]?.harmonics?.camelot);
            if (relation) {
                const palette = relation.compatible
                    ? { stroke: "#22c55e", bg: "#dcfce7", text: "#15803d" } // smooth move
                    : { stroke: "#94a3b8", bg: "#e2e8f0", text: "#475569" }; // neutral distance
                edge.label = relation.label;
                edge.labelStyle = { fill: palette.text, fontWeight: 600, fontSize: 11 };
                edge.labelBgStyle = { fill: palette.bg };
                edge.labelBgPadding = [6, 3];
                edge.labelBgBorderRadius = 6;
                edge.style = { stroke: palette.stroke, strokeWidth: 2 };
            }
            edges.push(edge);
        }
        setRfNodes(nodes);
        setRfEdges(edges);
    }, [set, positions, processing, dj.updateQuery, dj.resolveNode, dj.removeNode, dj.moveNode, dj.searchTrack, dj.pickMatch, setRfNodes, setRfEdges]);

    // Fit the view once, after the real nodes have actually been loaded into the
    // canvas (fitting while the canvas is still empty leaves nodes off-screen).
    useEffect(() => {
        if (didFit.current) return;
        if (instanceRef.current && rfNodes.length > 0) {
            instanceRef.current.fitView({ maxZoom: 1 });
            didFit.current = true;
        }
    }, [rfNodes]);

    // When a node is added, pan the canvas to it (keeping zoom) so it's always
    // visible — otherwise new nodes land below the viewport and look like nothing
    // happened.
    useEffect(() => {
        const instance = instanceRef.current;
        if (instance && set.order.length > prevCount.current) {
            const last = set.nodes[set.order[set.order.length - 1]];
            instance.setCenter((last?.x ?? 0) + 160, (last?.y ?? 0) + 80, { zoom: 1, duration: 350 });
        }
        prevCount.current = set.order.length;
    }, [set.order.length]);

    // Persist canvas positions after a drag so the manual layout is preserved
    // across typing and adding nodes. (Play order is controlled by the ▲▼ arrows.)
    const onNodeDragStop = useCallback(() => {
        dj.persistPositions(rfNodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
    }, [rfNodes, dj]);

    const songCount = Object.values(positions).filter((p) => p > 0).length;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">DJ Set Editor</h1>
                    <p className="text-sm text-muted-foreground">
                        Arrange songs into your play order. Processing downloads (or renumbers) each track with an
                        index prefix so the folder is pre-sorted for rekordbox.
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                    <Label className="text-xs">Set name</Label>
                    <Input
                        value={set.name}
                        disabled={processing}
                        onChange={(e) => dj.setName(e.target.value)}
                        className="h-8 w-48"
                    />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                    <Label className="text-xs">Destination folder</Label>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded-md bg-muted/50 px-2 py-1.5 text-xs" title={dj.getSetFolder()}>
                            {dj.getSetFolder() || "No download folder set"}
                        </code>
                        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" disabled={processing} onClick={dj.selectFolder} title="Change base folder">
                            <FolderCog className="h-4 w-4" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={dj.openFolder} title="Open destination folder">
                            <FolderOpen className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={processing}>
                            <Library className="h-4 w-4" /> Sets <ChevronDown className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-72">
                        <DropdownMenuItem onClick={dj.saveCurrent} className="gap-2 cursor-pointer">
                            <Save className="h-4 w-4" /> Save current set
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={dj.newSet} className="gap-2 cursor-pointer">
                            <FilePlus2 className="h-4 w-4" /> New set
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={dj.importFromFolder} className="gap-2 cursor-pointer">
                            <FolderInput className="h-4 w-4" /> Import from folder…
                        </DropdownMenuItem>
                        {library.length > 0 && <DropdownMenuSeparator />}
                        {library.length > 0 && <DropdownMenuLabel>Saved sets</DropdownMenuLabel>}
                        {library.map((s) => (
                            <DropdownMenuItem key={s.id} onClick={() => dj.loadSet(s.id)} className="flex items-center justify-between gap-2 cursor-pointer">
                                <span className="min-w-0 flex-1 truncate">
                                    {s.name}
                                    <span className="ml-1 text-xs text-muted-foreground">· {countSongs(s)} song(s)</span>
                                </span>
                                <span
                                    role="button"
                                    tabIndex={0}
                                    className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                    onClick={(e) => { e.stopPropagation(); dj.deleteSet(s.id); }}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" disabled={processing} onClick={() => dj.addNode()}>
                    <Plus className="h-4 w-4" /> Add Song
                </Button>
                <Button variant="outline" size="sm" disabled={processing} onClick={dj.resolveAll}>
                    <ListChecks className="h-4 w-4" /> Resolve All
                </Button>
                <Button variant="outline" size="sm" disabled={processing} onClick={dj.checkFolder}>
                    <FolderSearch className="h-4 w-4" /> Check Folder
                </Button>
                <Button variant="outline" size="sm" disabled={processing} onClick={dj.clearSet}>
                    <Trash2 className="h-4 w-4" /> Clear
                </Button>
                <div className="ml-auto flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">{songCount} song(s)</span>
                    {processing && (
                        <Button size="sm" variant="destructive" onClick={dj.stopProcessing}>
                            <Square className="h-4 w-4" /> Stop
                        </Button>
                    )}
                    <Button size="sm" disabled={processing || songCount === 0} onClick={dj.processSet}>
                        {processing ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        {processing ? "Processing…" : "Process Set"}
                    </Button>
                </div>
            </div>

            <div className="h-[70vh] min-h-[420px] w-full overflow-hidden rounded-lg border">
                <ReactFlow
                    nodes={rfNodes}
                    edges={rfEdges}
                    nodeTypes={nodeTypes}
                    onInit={(instance) => { instanceRef.current = instance; }}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeDragStop={onNodeDragStop}
                    nodesConnectable={false}
                    minZoom={0.3}
                    proOptions={{ hideAttribution: false }}
                >
                    <Background />
                    <Controls showInteractive={false} />
                    <MiniMap pannable zoomable />
                </ReactFlow>
            </div>
        </div>
    );
}
