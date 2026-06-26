import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Download, FolderOpen, FolderCog, Search, Music } from "lucide-react";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { getSettings } from "@/lib/settings";
import {
    detectMediaUrl,
    ensureYtDlp,
    IsYtDlpInstalled,
    ResolveMedia,
    DownloadMedia,
    providerLabel,
    type ExternalMedia,
    type MediaProvider,
} from "@/lib/media";
import { SelectFolder, OpenFolder } from "../../wailsjs/go/main/App";
import { EventsOn, EventsOff } from "../../wailsjs/runtime/runtime";

function formatDuration(seconds: number): string {
    if (!seconds || seconds < 0) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

export function LinkGrabberPage() {
    const [url, setUrl] = useState("");
    const [provider, setProvider] = useState<MediaProvider | null>(null);
    const [media, setMedia] = useState<ExternalMedia | null>(null);
    const [resolving, setResolving] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [installProgress, setInstallProgress] = useState(0);
    const [format, setFormat] = useState<"mp3" | "opus" | "best">(getSettings().externalAudioFormat || "mp3");
    const [folder, setFolder] = useState(getSettings().downloadPath || "");

    const ensureReady = async (): Promise<boolean> => {
        if (await IsYtDlpInstalled()) return true;
        setInstalling(true);
        setInstallProgress(0);
        EventsOn("ytdlp:progress", (p: number) => setInstallProgress(p));
        const ok = await ensureYtDlp();
        EventsOff("ytdlp:progress");
        setInstalling(false);
        if (!ok) toast.error("Failed to set up yt-dlp");
        return ok;
    };

    const handleResolve = async () => {
        const detected = detectMediaUrl(url);
        if (!detected) {
            toast.error("Enter a valid SoundCloud / YouTube (or other) URL");
            return;
        }
        if (!(await ensureReady())) return;
        setResolving(true);
        setMedia(null);
        setProvider(detected);
        try {
            const result = await ResolveMedia(url.trim());
            setMedia(result);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not read that link");
        } finally {
            setResolving(false);
        }
    };

    const handleDownload = async () => {
        if (!media) return;
        if (!folder) {
            toast.error("Choose a destination folder first");
            return;
        }
        if (!(await ensureReady())) return;
        setDownloading(true);
        try {
            const result = await DownloadMedia({ url: media.webpage_url || url.trim(), output_dir: folder, audio_format: format });
            if (result.success) {
                toast.success("Downloaded", { description: media.title });
            } else {
                toast.error(result.error || "Download failed");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Download failed");
        } finally {
            setDownloading(false);
        }
    };

    const chooseFolder = async () => {
        try {
            const selected = await SelectFolder(folder);
            if (selected) setFolder(selected);
        } catch (err) {
            toast.error(`Failed to select folder: ${err}`);
        }
    };

    const openDestination = async () => {
        if (!folder) return;
        try {
            await OpenFolder(folder);
        } catch (err) {
            toast.error(`Failed to open folder: ${err}`);
        }
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold">Link Grabber</h1>
                <p className="text-sm text-muted-foreground">
                    Download audio from SoundCloud, YouTube, Bandcamp and more by URL (via yt-dlp). Audio is lossy
                    (MP3/Opus).
                </p>
            </div>

            <div className="flex gap-2">
                <Input
                    value={url}
                    placeholder="https://soundcloud.com/… or https://youtube.com/…"
                    disabled={resolving || downloading || installing}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && url.trim()) handleResolve();
                    }}
                />
                <Button onClick={handleResolve} disabled={!url.trim() || resolving || downloading || installing}>
                    {resolving ? <Spinner className="h-4 w-4" /> : <Search className="h-4 w-4" />}
                    Resolve
                </Button>
            </div>

            {installing && (
                <div className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                    <Spinner className="h-4 w-4 text-primary" />
                    <span>Setting up yt-dlp (one-time)… {installProgress > 0 ? `${installProgress}%` : ""}</span>
                </div>
            )}

            {media && (
                <div className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-center gap-3">
                        {media.thumbnail ? (
                            <img src={media.thumbnail} alt="" className="h-16 w-16 rounded object-cover" />
                        ) : (
                            <div className="flex h-16 w-16 items-center justify-center rounded bg-muted">
                                <Music className="h-6 w-6 text-muted-foreground" />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{media.title}</p>
                            <p className="truncate text-sm text-muted-foreground">{media.uploader}</p>
                            <div className="mt-1 flex items-center gap-2">
                                {provider && <Badge variant="secondary">{providerLabel(provider)}</Badge>}
                                {media.duration > 0 && (
                                    <span className="text-xs text-muted-foreground">{formatDuration(media.duration)}</span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                        <div className="space-y-1">
                            <Label className="text-xs">Format</Label>
                            <Select value={format} onValueChange={(value: "mp3" | "opus" | "best") => setFormat(value)}>
                                <SelectTrigger className="h-9 w-32">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="mp3">MP3 (320k)</SelectItem>
                                    <SelectItem value="opus">Opus</SelectItem>
                                    <SelectItem value="best">Best (original)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                            <Label className="text-xs">Destination folder</Label>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 truncate rounded-md bg-muted/50 px-2 py-1.5 text-xs" title={folder}>
                                    {folder || "No folder set"}
                                </code>
                                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={chooseFolder} title="Change folder">
                                    <FolderCog className="h-4 w-4" />
                                </Button>
                                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={openDestination} title="Open folder">
                                    <FolderOpen className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                        <Button onClick={handleDownload} disabled={downloading || installing}>
                            {downloading ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                            {downloading ? "Downloading…" : "Download"}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
