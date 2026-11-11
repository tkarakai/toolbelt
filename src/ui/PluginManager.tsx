import { toast } from "sonner";
import { Activity, TriangleAlert, CircleCheck, CircleX } from "lucide-react";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "./components/ui/tooltip";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./components/ui/select";
import { ResizableDialogContent } from "./components/ui/resizable-dialog-content";
import { MoreHorizontal, Power, RotateCw, Trash2, Download, Loader2, GitBranch } from "lucide-react";
import { Icon } from "./lib/icon";
import { cn } from "./lib/utils";
import { pillClass } from "./renderer/colors";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "./components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./lib/store";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { SettingsGroup } from "./components/settings-layout";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
import {
  canInstall,
  canRecover,
  getPluginManagerAdapter,
  isActivePhase,
  type Candidate,
  type ManagedPlugin,
  type ManagerState,
  type PluginManagerAdapter,
  type RecoveryChoice,
} from "./plugin-manager-model";
export type { PluginManagerAdapter } from "./plugin-manager-model";
const date = (at?: number) =>
  at ? new Date(at).toLocaleString() : "Not yet checked";
/** Compatibility fallback uses only endpoints present in shared/rpc.ts. */
const legacy: PluginManagerAdapter = {
  async restart(id) { await rpc.request.restartPlugin({plugin: id}); },
  async checkUpdates() {
    const response = await rpc.request.pluginManager({operation: "checkUpdates"});
    if (response.error) throw new Error(response.error);
  },
  async read() {
    const r = await rpc.request.pluginManager({ operation: "list" });
    if (r.error) throw Error(r.error);
    return { plugins: r.installed ?? [] };
  },
  async resolve(input) {
    const r = await rpc.request.pluginManager({
      operation: "resolve",
      ...input,
    });
    if (r.error) throw Error(r.error);
    if (!r.candidate) throw Error("No release was returned.");
    return r.candidate;
  },
  async install(token) {
    const r = await rpc.request.pluginManager({ operation: "install", token });
    if (r.error) throw Error(r.error);
  },
  async enable(id, enabled) {
    const r = await rpc.request.pluginManager({
      operation: "enable",
      id,
      enabled,
    });
    if (r.error) throw Error(r.error);
  },
  async remove(id, deleteData) {
    const r = await rpc.request.pluginManager({
      operation: "remove",
      id,
      deleteData,
    });
    if (r.error) throw Error(r.error);
  },
};
export function PluginManager({
  adapter = getPluginManagerAdapter() ?? legacy,
}: {
  adapter?: PluginManagerAdapter;
}) {
  const [state, setState] = useState<ManagerState>({ plugins: [] });
  const notifiedCheck = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = state.schedule?.error ? `${state.schedule.lastChecked}:${state.schedule.error}` : undefined;
    if (key && key !== notifiedCheck.current) toast.error("There were errors checking plugin updates. Open plugin activity for details.");
    notifiedCheck.current = key;
  }, [state.schedule?.error, state.schedule?.lastChecked]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [repo, setRepo] = useState(""),
    [release, setRelease] = useState(""),
    [prerelease, setPrerelease] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [restartingId, setRestartingId] = useState<string>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [remove, setRemove] = useState<ManagedPlugin>(),
    [deleteData, setDeleteData] = useState(false);
  const [recovery, setRecovery] = useState<{
    plugin: ManagedPlugin;
    choice: RecoveryChoice;
  }>();
  const [ack, setAck] = useState(false);
  const mounted = useRef(true),
    locked = useRef(false),
    revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let stopped = false,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      const before = revision.current;
      try {
        const s = await adapter.read();
        if (!stopped && before === revision.current) {
          setState(s);
          setLoaded(true);
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      } finally {
        reading = false;
      }
    };
    const unsubscribe = adapter.subscribe?.((s) => {
      revision.current++;
      setState(s);
      setLoaded(true);
    });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      stopped = true;
      mounted.current = false;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [adapter]);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      const s = await adapter.read();
      if (mounted.current) {
        revision.current++;
        setState(s);
        setLoaded(true);
      }
    } catch (e) {
      if (mounted.current) toast.error(String(e));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const dismissCandidate = () => {
    if (candidate && adapter.discard)
      void adapter
        .discard(candidate.token)
        .catch((error) => toast.error(String(error)));
    setCandidate(undefined);
  };
  const review = (source: string, tag?: string, pre = prerelease) => {
    dismissCandidate();
    void run(async () => {
      const c = await adapter.resolve({
        repo: source.trim(),
        release: tag?.trim() || undefined,
        prerelease: pre,
      });
      if (mounted.current) setCandidate(c);
    });
  };
  const updating = !!candidate && state.plugins.some(plugin => !plugin.removed && plugin.id === candidate.id);
  return (
    <div className="min-w-0 space-y-8">
        <SettingsGroup title="Installed Plugins" description="Each plugin is its own program. ToolBelt starts it and draws its screens. ToolBelt has no control over plugins." actions={<TooltipProvider delayDuration={200} skipDelayDuration={0}><Tooltip><TooltipTrigger asChild><span className="inline-flex" tabIndex={busy || !adapter.checkUpdates ? 0 : undefined}><Button variant="outline" size="sm" className="h-6 text-xs" disabled={busy || !adapter.checkUpdates} onClick={() => void run(async () => {
            setCheckingAll(true);
            try { await adapter.checkUpdates!(); } catch { toast.error("There were errors checking plugin updates. Open plugin activity for details."); } finally { if (mounted.current) setCheckingAll(false); }
          })}>{checkingAll ? <Loader2 className="animate-spin"/> : <RotateCw/>}{checkingAll ? "Checking…" : "Check for updates"}</Button></span></TooltipTrigger><TooltipContent side="top" sideOffset={8}>Last checked: {date(state.schedule?.lastChecked)}</TooltipContent></Tooltip></TooltipProvider>}>
          {!loaded ? (
            <p role="status" className="p-5 text-sm text-muted-foreground">
              Loading plugins…
            </p>
          ) : (
            !state.plugins.some((p) => !p.removed) && (
              <p className="p-5 text-sm text-muted-foreground">
                No plugins installed. Install a repository below to get started.
              </p>
            )
          )}
          {state.plugins
            .filter((p) => !p.removed)
            .map((p) => (
              <article
                key={p.id}
                aria-label={p.manifest.name}
                className="min-w-0 p-5 space-y-4 transition-colors animate-in fade-in-0 duration-200"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40"><Icon name={p.manifest.icon} className="size-5"/></div>
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-semibold">{p.manifest.name}</h3>
                    <p className="mt-1 break-all text-xs text-muted-foreground">{p.repo}</p>
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs capitalize", pillClass(!p.enabled ? "muted" : p.phase === "ready" ? "success" : p.phase === "failed" || p.phase === "quarantined" ? "danger" : "warning"))}>
                      <span className="size-1.5 rounded-full bg-current" aria-hidden="true"/>{!p.enabled ? "Disabled" : p.phase === "ready" ? "Running" : p.phase ?? "Installed"}
                    </span>
                    <Button variant="ghost" size="sm" aria-label={`Reload ${p.manifest.name}`} title="Reload plugin" disabled={busy || !p.enabled || !adapter.restart || isActivePhase(p.phase)} onClick={() => void run(async () => {
                      setRestartingId(p.id);
                      try { await adapter.restart!(p.id); } finally { if (mounted.current) setRestartingId(undefined); }
                    })}>{restartingId === p.id && <Loader2 className="animate-spin"/>}Reload</Button>
                    <details className="group relative">
                      <summary aria-label={`Activity for ${p.manifest.name}`} title="Plugin activity" className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md hover:bg-accent [&::-webkit-details-marker]:hidden">
                        {/· (?:failed|quarantined|Update check failed|Runtime failure)\b/i.test(p.logs?.at(-1) ?? "") ? <TriangleAlert className="size-4 text-amber-500"/> : <Activity className="size-4"/>}
                      </summary>
                      <div className="absolute right-0 top-10 z-30 w-80 max-w-[calc(100vw-4rem)] space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">
                        <p className="text-xs font-medium">Recent activity</p>
                        {p.logs?.length ? p.logs.slice(-3).reverse().map((line, index) => <div key={index} className="flex items-start gap-2 text-xs">
                          {/· (?:failed|quarantined|Update check failed|Runtime failure)\b/i.test(line) ? <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive"/> : <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-green-600"/>}
                          <span className="min-w-0 whitespace-pre-wrap break-words">{line}</span>
                        </div>) : <p className="text-xs text-muted-foreground">No activity recorded yet.</p>}
                      </div>
                    </details>
                    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.manifest.name}`} title="Plugin actions" disabled={busy || isActivePhase(p.phase)}><MoreHorizontal/></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem onSelect={() => void run(() => adapter.enable(p.id, !p.enabled))}><Power/>{p.enabled ? "Disable" : "Enable"}</DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem variant="destructive" onSelect={() => {setDeleteData(false); setRemove(p);}}><Trash2/>Remove plugin…</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <div className="grid gap-4 rounded-lg bg-muted/30 p-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">Installed release</div>
                    <p className="text-sm">Version <span className="font-mono font-medium">{p.version}{p.commit ? ` (${p.commit.slice(0, 7)})` : ""}</span></p>
                    <div className="flex flex-wrap items-center gap-2"><span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs",pillClass(p.installedChannel === "prerelease" ? "warning" : "muted"))}>{p.installedChannel === "prerelease" ? "Prerelease" : p.installedChannel === "stable" ? "Stable" : "Unknown channel"}</span>{p.requestedRelease && <span className="break-all font-mono text-xs text-muted-foreground">{p.requestedRelease}</span>}</div>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`channel-${p.id}`} className="text-xs font-medium text-muted-foreground">Update channel</label>
                    <Select value={p.channel} disabled={busy || !adapter.setChannel || isActivePhase(p.phase)} onValueChange={channel => void run(() => adapter.setChannel!(p.id, channel as "stable" | "prerelease"))}>
                      <SelectTrigger id={`channel-${p.id}`} aria-label={`Update channel for ${p.manifest.name}`} size="sm" className="-ml-2 min-w-0 w-fit justify-start border-transparent px-2 text-sm shadow-none hover:bg-accent data-[state=open]:bg-accent dark:bg-transparent dark:data-[state=open]:bg-accent"><GitBranch className="size-3.5 text-muted-foreground"/><SelectValue/></SelectTrigger>
                      <SelectContent position="popper" align="start" className="p-1"><SelectItem value="stable">Stable</SelectItem><SelectItem value="prerelease">Prerelease</SelectItem></SelectContent>
                    </Select>
                    <p className="text-xs leading-relaxed text-muted-foreground">{p.channel === "prerelease" ? "Include stable and prerelease releases in future checks." : "Use stable releases for future checks."}</p>
                  </div>
                </div>
                {p.detail && (
                  <p className="text-sm text-muted-foreground">{p.detail}</p>
                )}
                {p.operation?.total && (
                  <progress
                    className="w-full"
                    aria-label="Download progress"
                    value={p.operation.received ?? 0}
                    max={p.operation.total}
                  />
                )}
                {p.availableVersion && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">Available update</span><span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs",pillClass(p.availableChannel === "prerelease" ? "warning" : p.availableChannel === "stable" ? "info" : "muted"))}>{p.availableChannel === "prerelease" ? "Prerelease" : p.availableChannel === "stable" ? "Stable" : "Channel not recorded"}</span></div>
                    <p className="text-sm">Version <span className="font-mono font-medium">{p.availableVersion}{p.availableCommit ? ` (${p.availableCommit.slice(0,7)})` : ""}</span></p>
                  </div>
                  <Button size="sm" disabled={busy || isActivePhase(p.phase)} onClick={() => review(p.repo, undefined, p.channel === "prerelease")}><Download/>Review and Update</Button>
                </div>}
                {p.operation?.cancellable && adapter.cancel && <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => void adapter.cancel!(p.operation!.id).catch(e => setError(String(e)))}>Cancel download</Button></div>}
                {!!p.recovery?.length && (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Previous versions and recovery
                    </summary>
                    <div className="space-y-2 pt-3">
                      {p.recovery.map((c) => (
                        <div
                          key={c.id}
                          className="flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <span>
                            {c.version} ·{" "}
                            {c.schemaCompatible
                              ? "Supports current data"
                              : c.snapshotAt
                                ? `Restore data from ${date(c.snapshotAt)}`
                                : "Incompatible with current data; no snapshot"}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              busy ||
                              !adapter.recover ||
                              !canRecover(c) ||
                              isActivePhase(p.phase)
                            }
                            onClick={() => {
                              setAck(false);
                              setRecovery({ plugin: p, choice: c });
                            }}
                          >
                            Review recovery…
                          </Button>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </article>
            ))}

        </SettingsGroup>
        <SettingsGroup title="Install new plugin"><form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            review(repo, release);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Public GitHub repositories only. Private repository sign-in is not
            supported.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              Repository
              <Input
                value={repo}
                placeholder="owner/repository or GitHub URL"
                onChange={(e) => setRepo(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              Release tag (optional)
              <Input
                value={release}
                placeholder="Latest release"
                onChange={(e) => setRelease(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prerelease}
                onChange={(e) => setPrerelease(e.target.checked)}
              />
              Include prereleases for this search
            </label>
            <Button disabled={busy || !repo.trim()}>Review release</Button>
          </div>
        </form></SettingsGroup>
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            Waiting for ToolBelt…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="break-words rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {state.operations?.map((op) => (
          <div
            key={op.id}
            role="status"
            className="rounded-lg border p-3 text-sm"
          >
            <p className="capitalize">{op.phase}</p>
            <p>{op.detail}</p>
            {op.cancellable && adapter.cancel && (
              <Button
                variant="outline"
                onClick={() => {
                  void adapter.cancel!(op.id).catch((e) => setError(String(e)));
                }}
              >
                Cancel download
              </Button>
            )}
          </div>
        ))}

        <Dialog
          open={!!candidate}
          onOpenChange={(open) => !open && !busy && dismissCandidate()}
        >
          <ResizableDialogContent key={candidate?.token} className="gap-4">
            <DialogHeader>
              <DialogTitle className="pr-7">{updating ? "Review update for" : "Review"} {candidate?.name}</DialogTitle>
              <DialogDescription>
                Approve this publisher before any plugin or migration code runs.
              </DialogDescription>
            </DialogHeader>
            {candidate && (
              <>
                <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  <dt>Publisher</dt>
                  <dd className="break-all">{candidate.repo}</dd>
                  <dt>Plugin ID</dt>
                  <dd className="break-all">{candidate.id}</dd>
                  <dt>Version</dt>
                  <dd>{candidate.version}</dd>
                  <dt>Channel</dt>
                  <dd>{candidate.channel ?? "Not reported"}</dd>
                  <dt>Compatibility</dt>
                  <dd>
                    {candidate.compatibility?.summary ??
                      "Compatibility review is not available in this build. Installation is blocked."}
                  </dd>
                  <dt>SHA-256</dt>
                  <dd className="break-all font-mono text-xs">
                    {candidate.hash}
                  </dd>
                </dl>
                <p className="rounded-lg border bg-muted/40 p-3 text-sm">
                  This publisher’s plugin and migrations run with your user
                  privileges, including access to files, processes and the
                  network. Checksums verify bytes; they do not establish
                  publisher trust.
                </p>
                {candidate.notes && (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {candidate.notes}
                  </p>
                )}
                </div>
                <DialogFooter className="shrink-0 pr-8">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={dismissCandidate}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={busy || !canInstall(candidate)}
                    onClick={() =>
                      void run(async () => {
                        await adapter.install(candidate.token);
                        setCandidate(undefined);
                      })
                    }
                  >
                    {updating ? "Update" : "Install"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </ResizableDialogContent>
        </Dialog>
        <Dialog
          open={!!remove}
          onOpenChange={(open) => !open && !busy && setRemove(undefined)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove {remove?.manifest.name}?</DialogTitle>
              <DialogDescription>
                Removing uninstalls the plugin. Keep its data to use again
                later.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              Separately installed commands and shell hooks may remain. Clean
              them up through the plugin while its code is still available.
            </p>
            {remove?.cleanup && adapter.cleanup && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => adapter.cleanup!(remove.id))}
              >
                Review command and shell hook cleanup…
              </Button>
            )}
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteData}
                onChange={(e) => setDeleteData(e.target.checked)}
              />
              Also permanently delete this plugin’s managed data
            </label>
            {deleteData && (
              <p role="alert" className="text-sm text-destructive">
                Your saved plugin data will be deleted. This cannot be undone.
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRemove(undefined)}
              >
                Keep plugin
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await adapter.remove(remove!.id, deleteData);
                    setRemove(undefined);
                  })
                }
              >
                {deleteData ? "Remove and delete data" : "Remove and keep data"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!recovery}
          onOpenChange={(open) => !open && !busy && setRecovery(undefined)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Use version {recovery?.choice.version}?</DialogTitle>
              <DialogDescription>
                {recovery?.choice.schemaCompatible
                  ? "This version supports your current managed data."
                  : `Restore managed data from ${date(recovery?.choice.snapshotAt)}. Changes saved since that snapshot will be lost.`}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              Recovery covers only data managed by ToolBelt. External files,
              databases, services and machine changes require the plugin’s own
              recovery steps.
            </p>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I understand the recovery limits
              {!recovery?.choice.schemaCompatible && " and loss of newer data"}.
            </label>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRecovery(undefined)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !ack || !adapter.recover}
                onClick={() =>
                  void run(async () => {
                    await adapter.recover!(
                      recovery!.plugin.id,
                      recovery!.choice.id,
                    );
                    setRecovery(undefined);
                  })
                }
              >
                Confirm recovery
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </div>
  );
}
