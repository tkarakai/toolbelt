// Plugin development mode in Settings → Plugins (docs/plugin-development.md): switch to a
// development profile, open local archives (optionally watched), and read diagnostics. Each local
// plugin's card in Installed Plugins shows its archive and watch switch (LocalSourceControl).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, FlaskConical, FolderOpen, FolderSearch, Loader2, LogOut } from "lucide-react";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { SettingsGroup } from "./components/settings-layout";
import { DiagnosticDisclosure } from "./components/diagnostic-disclosure";
import { developmentRequest, useDevelopment } from "./lib/store";
import { pillClass } from "./renderer/colors";
import { cn } from "./lib/utils";
import type { DevelopmentDiagnostic, DevelopmentRequest } from "../shared/development";

const PROFILE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

async function run(request: DevelopmentRequest, success?: string) {
    const response = await developmentRequest(request);
    if (response.error) toast.error(response.error);
    else if (success) toast.success(success);
    return response;
}

/** Shown in Settings → Plugins: above the manager in development mode, below it otherwise. */
export function DevelopmentSettings() {
    const state = useDevelopment();
    if (!state?.available) return null;
    return state.active ? <DevelopmentWorkspace /> : <EnterDevelopment />;
}

function EnterDevelopment() {
    const state = useDevelopment()!;
    const [profile, setProfile] = useState("default");
    const [confirming, setConfirming] = useState(false);
    const valid = PROFILE_NAME.test(profile);
    return <SettingsGroup title="Plugin development" description="Test unreleased plugin archives in a separate profile. Released plugins stop until you return to normal mode, and nothing installed there carries over.">
        <form className="space-y-3 p-5" onSubmit={e => { e.preventDefault(); if (valid) setConfirming(true); }}>
            <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-0 flex-1 space-y-1 text-sm">
                    Development profile
                    <Input value={profile} onChange={e => setProfile(e.target.value)} aria-invalid={!valid} placeholder="default" className="font-mono" />
                </label>
                <Button type="submit" variant="outline" disabled={!valid || state.switching}>
                    {state.switching ? <Loader2 className="animate-spin" /> : <FlaskConical />}
                    {state.switching ? "Preparing plugins…" : "Switch to development mode…"}
                </Button>
            </div>
            {!valid && <p className="text-xs text-destructive">Use letters, digits, underscores and dashes.</p>}
            {state.profiles.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Existing profiles:
                {state.profiles.map(name => <Button key={name} type="button" size="xs" variant={name === profile ? "secondary" : "ghost"} className="font-mono" onClick={() => setProfile(name)}>{name}</Button>)}
            </div>}
        </form>
        <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Switch to development mode?</DialogTitle>
                    <DialogDescription>
                        ToolBelt asks your plugins to stop, then relaunches with the development profile <span className="font-mono">{profile}</span>.
                    </DialogDescription>
                </DialogHeader>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    <li>Released plugins don’t run, so their scheduled work pauses until you return.</li>
                    <li>Development plugins keep their own data, separate from your normal plugins.</li>
                    <li>Quitting ToolBelt always brings it back in normal mode.</li>
                </ul>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
                    <Button autoFocus disabled={state.switching} onClick={() => { setConfirming(false); void run({ operation: "enter", profile }); }}>Relaunch</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </SettingsGroup>;
}

function DevelopmentWorkspace() {
    const state = useDevelopment()!;
    const [archive, setArchive] = useState("");
    const [repo, setRepo] = useState("");
    const [approved, setApproved] = useState(false);
    const [loading, setLoading] = useState<"open" | "watch">();
    const [choosing, setChoosing] = useState(false);
    const ready = approved && archive.trim().endsWith(".tar.gz") && /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
    const open = async (watch: boolean) => {
        if (!ready || loading) return;
        setLoading(watch ? "watch" : "open");
        const response = await run({ operation: "load", archive: archive.trim(), repo: repo.trim(), approved, watch });
        setLoading(undefined);
        if (response.installed) toast.success(`Installed ${response.installed.id} ${response.installed.version}`, watch ? { description: "Rebuilds of this archive install automatically." } : undefined);
    };
    return <SettingsGroup
        title="Plugin development"
        actions={<div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs", pillClass("warning"))}><FlaskConical className="size-3" />Profile <span className="font-mono">{state.profile}</span></span>
            <Button size="sm" variant="outline" disabled={state.switching} onClick={() => void run({ operation: "exit" })}>
                {state.switching ? <Loader2 className="animate-spin" /> : <LogOut />}
                {state.switching ? "Preparing plugins…" : "Return to normal mode"}
            </Button>
        </div>}
        description="Released plugins aren’t running. Plugins here use this profile’s own data; quitting ToolBelt returns to normal mode."
    >
        <form className="space-y-4 p-5" onSubmit={e => { e.preventDefault(); void open(false); }}>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-1 text-sm">
                    <label htmlFor="development-archive">Built archive</label>
                    <div className="flex gap-2">
                        <Input id="development-archive" value={archive} onChange={e => setArchive(e.target.value)} placeholder="/path/to/plugin.tar.gz" className="min-w-0 font-mono" spellCheck={false} />
                        <Button type="button" variant="outline" disabled={choosing} onClick={async () => {
                            setChoosing(true);
                            const response = await run({ operation: "choose", archive });
                            setChoosing(false);
                            if (!response.chosen) return;
                            setArchive(response.chosen.archive);
                            if (response.chosen.repo) setRepo(response.chosen.repo);
                        }}>{choosing ? <Loader2 className="animate-spin" /> : <FolderSearch />}Choose…</Button>
                    </div>
                </div>
                <label className="min-w-0 space-y-1 text-sm">
                    Publisher repository
                    <Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/repository" className="font-mono" spellCheck={false} />
                </label>
            </div>
            <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={approved} onChange={e => setApproved(e.target.checked)} />
                Run this publisher’s plugin code with my user’s privileges
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">Watched archives reinstall whenever they’re rebuilt. Turn watching on or off for each plugin under Installed Plugins.</p>
                <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" disabled={!ready || !!loading} onClick={() => void open(true)}>{loading === "watch" ? <Loader2 className="animate-spin" /> : <Eye />}Open and watch</Button>
                    <Button type="submit" disabled={!ready || !!loading}>{loading === "open" ? <Loader2 className="animate-spin" /> : <FolderOpen />}Open archive</Button>
                </div>
            </div>
        </form>
        <div className="p-3"><Diagnostics /></div>
    </SettingsGroup>;
}

/** Confirms deleting a local plugin's data; it reinstalls fresh from its recorded archive. */
export function ResetDataDialog({ plugin, onClose }: { plugin?: { id: string; manifest: { name: string } }; onClose: () => void }) {
    const state = useDevelopment();
    const [busy, setBusy] = useState(false);
    return <Dialog open={!!plugin} onOpenChange={open => !open && !busy && onClose()}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Reset {plugin?.manifest.name}’s data?</DialogTitle>
                <DialogDescription>
                    This deletes its data in the development profile <span className="font-mono">{state?.profile}</span> and reinstalls it from its archive, so it starts fresh. Its watch setting stays the same.
                </DialogDescription>
            </DialogHeader>
            <DialogFooter>
                <Button variant="outline" autoFocus disabled={busy} onClick={onClose}>Cancel</Button>
                <Button variant="destructive" disabled={busy} onClick={async () => {
                    setBusy(true);
                    const response = await run({ operation: "reset", id: plugin!.id });
                    setBusy(false);
                    if (!response.error) toast.success(response.installed ? `Reset ${plugin!.manifest.name}` : `Removed ${plugin!.manifest.name}`, { description: response.installed ? "It starts with fresh data." : "Its archive is gone; open it again to reinstall." });
                    onClose();
                }}>{busy && <Loader2 className="animate-spin" />}Reset data</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>;
}

/** On a local plugin's card in Installed Plugins: its archive and the watch switch. */
export function LocalSourceControl({ id }: { id: string }) {
    const state = useDevelopment();
    const source = state?.sources.find(s => s.id === id);
    const [busy, setBusy] = useState(false);
    if (!source) return <p className="text-xs leading-relaxed text-muted-foreground">Local builds aren’t checked for releases. Open the archive in Plugin development to replace it.</p>;
    return <div className="space-y-2">
        <p className="break-all font-mono text-xs text-muted-foreground" title={source.archive}>{source.archive}</p>
        <label className="flex items-center gap-2 text-sm">
            <Switch checked={source.watching} disabled={busy} aria-label={`Watch the archive of ${id} for rebuilds`} onCheckedChange={async watching => {
                setBusy(true);
                await run({ operation: "watch", id, watching }, watching ? "Watching for rebuilds" : "Stopped watching");
                setBusy(false);
            }} />
            Install rebuilds automatically
        </label>
    </div>;
}

function Diagnostics() {
    const [entries, setEntries] = useState<DevelopmentDiagnostic[]>([]);
    const [open, setOpen] = useState(false);
    // Read only while expanded: entries can carry whole render trees.
    useEffect(() => {
        if (!open) return;
        let stopped = false;
        const read = () => void developmentRequest({ operation: "diagnostics" }).then(r => { if (!stopped && r.diagnostics) setEntries(r.diagnostics); });
        read();
        const timer = setInterval(read, 1000);
        return () => { stopped = true; clearInterval(timer); };
    }, [open]);
    return <DiagnosticDisclosure compact title="Diagnostics" onOpenChange={setOpen} badge={open ? <span className="text-xs tabular-nums text-muted-foreground">{entries.length}</span> : undefined}>
        <div className="max-h-80 overflow-auto border-t px-3 py-2">
            {entries.length === 0 && <p className="py-2 text-sm text-muted-foreground">Nothing recorded yet.</p>}
            {entries.slice().reverse().map((entry, i) => <div key={`${entry.time}-${i}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 py-1 font-mono text-xs">
                <span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span>
                <span className={cn(entry.kind.includes("error") && "text-destructive")}>{entry.kind}</span>
                <span className="whitespace-pre-wrap break-all text-muted-foreground">{typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail)}</span>
            </div>)}
        </div>
    </DiagnosticDisclosure>;
}
