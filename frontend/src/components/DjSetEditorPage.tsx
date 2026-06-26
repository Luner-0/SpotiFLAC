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
import { Plus, ListChecks, FolderSearch, Play, Trash2, FolderOpen, FolderCog, Square } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useDjSet } from "@/hooks/useDjSet";
import { SongNode, type SongNodeData } from "@/components/dj/SongNode";

const NODE_GAP = 190;
const nodeTypes = { song: SongNode };

export function DjSetEditorPage() {
    const dj = useDjSet();
    const { set, processing } = dj;
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
                position: { x: 0, y: i * NODE_GAP },
                data: data as unknown as Record<string, unknown>,
            };
        });
        const edges: Edge[] = [];
        for (let i = 0; i < set.order.length - 1; i += 1) {
            edges.push({ id: `${set.order[i]}->${set.order[i + 1]}`, source: set.order[i], target: set.order[i + 1] });
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
            const lastIndex = set.order.length - 1;
            instance.setCenter(160, lastIndex * NODE_GAP + 80, { zoom: 1, duration: 350 });
        }
        prevCount.current = set.order.length;
    }, [set.order.length]);

    // After a drag, re-derive the play order from the vertical position of nodes.
    const onNodeDragStop = useCallback(() => {
        const sorted = [...rfNodes].sort((a, b) => a.position.y - b.position.y);
        const newOrder = sorted.map((n) => n.id);
        if (newOrder.join("|") !== set.order.join("|")) {
            dj.reorder(newOrder);
        }
    }, [rfNodes, set.order, dj]);

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
