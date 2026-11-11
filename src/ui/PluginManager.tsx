import { useEffect, useRef, useState } from "react";
import { rpc } from "./lib/store";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
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
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [repo, setRepo] = useState(""),
    [release, setRelease] = useState(""),
    [prerelease, setPrerelease] = useState(false);
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
      if (mounted.current) setError(String(e));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const dismissCandidate = () => {
    if (candidate && adapter.discard)
      void adapter
        .discard(candidate.token)
        .catch((error) => setError(String(error)));
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
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Plugins</CardTitle>
        <CardDescription>
          Add tools from publishers you trust. Updates are installed only when
          you approve them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 min-w-0">
        <section
          aria-label="Plugin updates"
          className="rounded-lg border bg-muted/30 p-4 space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Update checks · notify only</h3>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !adapter.checkUpdates}
              onClick={() => void run(() => adapter.checkUpdates!())}
            >
              Check now
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {state.schedule
              ? `Checks every ${state.schedule.intervalHours} hours. Last: ${date(state.schedule.lastChecked)}. Next: ${date(state.schedule.nextCheck)}.`
              : "Automatic checks are not available in this build. Use Check update on a plugin to review a release."}
          </p>
          {state.schedule?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.schedule.error}
            </p>
          )}
        </section>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            review(repo, release);
          }}
        >
          <h3 className="text-sm font-medium">Add a plugin</h3>
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
        </form>
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
        <section aria-label="Installed plugins" className="space-y-3">
          <h3 className="text-sm font-medium">
            Installed plugins{" "}
            <span className="text-muted-foreground">
              {state.plugins.filter((p) => !p.removed).length}
            </span>
          </h3>
          {!loaded ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading plugins…
            </p>
          ) : (
            !state.plugins.some((p) => !p.removed) && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No plugins installed. Add a repository above to get started.
              </p>
            )
          )}
          {state.plugins
            .filter((p) => !p.removed)
            .map((p) => (
              <article
                key={p.id}
                aria-label={p.manifest.name}
                className="min-w-0 rounded-lg border p-4 space-y-3 transition-colors animate-in fade-in-0 duration-200"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="text-sm font-medium">
                      {p.manifest.name}{" "}
                      <span className="text-muted-foreground">{p.version}</span>
                    </h4>
                    <p className="text-xs text-muted-foreground break-all">
                      {p.repo} · {p.id}
                    </p>
                  </div>
                  <span
                    role="status"
                    className="self-start rounded-full bg-muted px-2 py-1 text-xs capitalize"
                  >
                    {p.phase ??
                      (p.enabled ? "Installed · enabled" : "Disabled")}
                  </span>
                </div>
                {p.availableVersion && (
                  <p className="text-sm">
                    Version {p.availableVersion} is available. Review it before
                    updating.
                  </p>
                )}
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
                {p.error && (
                  <p
                    role="alert"
                    className="text-sm text-destructive break-words"
                  >
                    {p.error}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || isActivePhase(p.phase)}
                    onClick={() =>
                      void run(() => adapter.enable(p.id, !p.enabled))
                    }
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || isActivePhase(p.phase)}
                    onClick={() =>
                      review(p.repo, undefined, p.channel === "prerelease")
                    }
                  >
                    Check update
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || isActivePhase(p.phase)}
                    onClick={() => {
                      setDeleteData(false);
                      setRemove(p);
                    }}
                  >
                    Remove…
                  </Button>
                  {p.operation?.cancellable && adapter.cancel && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void adapter.cancel!(p.operation!.id).catch((e) =>
                          setError(String(e)),
                        )
                      }
                    >
                      Cancel download
                    </Button>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={p.channel === "prerelease"}
                    disabled={
                      busy || !adapter.setChannel || isActivePhase(p.phase)
                    }
                    onChange={(e) => {
                      const channel = e.target.checked
                        ? "prerelease"
                        : "stable";
                      void run(() => adapter.setChannel!(p.id, channel));
                    }}
                  />
                  Include prereleases in future checks
                  {!adapter.setChannel && " (unavailable in this build)"}
                </label>
                {(p.logs?.length ?? 0) > 0 && (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Activity and error details
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                      {p.logs!.slice(-200).join("\n")}
                    </pre>
                  </details>
                )}
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
        </section>
        <Dialog
          open={!!candidate}
          onOpenChange={(open) => !open && !busy && dismissCandidate()}
        >
          <DialogContent className="max-h-[85vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Review {candidate?.name}</DialogTitle>
              <DialogDescription>
                Approve this publisher before any plugin or migration code runs.
              </DialogDescription>
            </DialogHeader>
            {candidate && (
              <>
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
                <DialogFooter>
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
                    Trust publisher and install {candidate.version}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
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
      </CardContent>
    </Card>
  );
}
