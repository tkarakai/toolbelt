import { GitHubButton } from "./components/github-button";
import { UpdateRecovery, useRecoveryClock } from "./components/update-recovery";
import { ManualUpdate } from "./components/manual-update";
import { RepositoryLink } from "./components/repository-link";
import { buildInfo } from "./build-info";
// Updates, in the UI: the card on ToolBelt's page (version, channel, last check, what's new),
// the dialog that walks through an update (download → verify → install → restart), the red dot
// for the sidebar and the popover's "Update available" row. The work happens in the main
// process (src/bun/updater.ts); this shows its state, pushed as `updateState`.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  Download,
  Loader2,
  RotateCw,
} from "lucide-react";
import type { UpdateState } from "../shared/rpc";
import { openUrl, rpc, updateListeners } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Markdown } from "@/renderer/Render";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "./components/settings-layout";
import { pillClass } from "./renderer/colors";
import appIcon from "../../icon.iconset/icon_128x128.png";
import devAppIcon from "../../dev-icon.iconset/icon_128x128.png";
import { GitBranch } from "lucide-react";
import { KeyHint } from "@/components/key-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getPluginManagerAdapter } from "./plugin-manager-model";
import { Progress } from "@/components/ui/progress";

// One copy of the state for every component in this view.
let current: UpdateState | null = null;
const local = new Set<() => void>();
let asked = false;
let simulated: UpdateState | null = null;
let simulatedKind = "off";
function simulate(kind: string) {
  if (current?.channel !== "dev") return;
  simulatedKind = kind;
  if (kind === "off") simulated = null;
  else {
    const release = {version:"99.0.0",notes:"## Preview release\n\nSample improvements for reviewing the update experience.",page:"https://github.com/tkarakai/toolbelt/releases",dmg:"",size:48*1048576,sha256:null,published:Date.now()};
    const checkFailed = kind === "check-failed" || kind === "check-failed-cached";
    simulated = {...current, enabled:true, available:kind === "check-failed" || kind === "up-to-date" ? null : release, latest:kind === "check-failed" || kind === "up-to-date" ? null : release, checking:false, lastError:checkFailed ? "GitHub’s request quota is exhausted." : null,
      failure:checkFailed ? {at:Date.now(),kind:"quota", message:"GitHub’s request quota is exhausted.", status:403, detail:"API rate limit exceeded", retryAt:Date.now()+12*60000} : undefined,
      retryAt:checkFailed ? Date.now()+12*60000 : undefined,
      phase: kind === "downloading" ? {kind,received:24*1048576,total:48*1048576,speed:2*1048576} : kind === "failed" ? {kind,message:"Simulated update failure. Your app has not been changed."} : {kind:checkFailed || kind === "up-to-date" ? "idle" : kind as "idle"|"verifying"|"installing"|"relaunching"}};
  }
  local.forEach(l => l());
}
function updateAction(action: "installUpdate"|"cancelUpdate"|"dismissUpdate"|"checkForUpdates") {
  if (simulated) { simulate(action === "checkForUpdates" ? simulatedKind : action === "installUpdate" ? "downloading" : "idle"); return; }
  void rpc.request[action]({});
}
function DevUpdatePreview() {
  if (current?.channel !== "dev") return null;
  return <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Development preview (no installation)
    <select aria-label="Simulated app update state" className="rounded border bg-background p-1 text-foreground" value={simulated ? simulatedKind : "off"} onChange={e => simulate(e.target.value)}>
      {[["off","Off"],["up-to-date","No update / manual link"],["check-failed","Check failed / manual guide"],["check-failed-cached","Check failed / cached update"],["idle","Available / confirmation"],["downloading","Downloading"],["verifying","Verifying"],["installing","Installing"],["relaunching","Restarting"],["failed","Installation failed"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </label>;
}
updateListeners.add((s) => {
  current = s;
  local.forEach((l) => l());
});

/** Where updates stand (null until the main process answers). */
export function useUpdateState(): UpdateState | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    local.add(l);
    if (!asked) {
      asked = true;
      void rpc.request.updateState({}).then((s) => {
        current ??= s;
        local.forEach((f) => f());
      });
    }
    return () => void local.delete(l);
  }, []);
  return simulated ?? current;
}

/** The newer version, if there is one. */
export const useUpdateAvailable = () => useUpdateState()?.available ?? null;

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
const date = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** Shared exclamation badge for update navigation. */
export function UpdateIndicator({ className }: { className?: string }) {
  return (
    <span
      aria-label="Update available"
      className={cn(
        "inline-flex size-3 shrink-0 items-center justify-center rounded-full bg-foreground text-background text-[9px] font-bold leading-none ring-2 ring-sidebar",
        className,
      )}
    >!</span>
  );
}

// ── the card on ToolBelt's page ──────────────────────────────────────────
let openDialog: () => void = () => {};

export function UpdatesCard() {
  const s = useUpdateState();
  const now = useRecoveryClock();
  useEffect(() => {
    if (s && location.hash === "#/toolbelt/updates") document.getElementById("updates")?.scrollIntoView({ block: "start" });
  }, [!!s]);
  if (!s) return null;
  const r = s.available;
  return (
    <div id="updates"><SettingsGroup title="App" notice={(s.failure || s.lastError) && <UpdateRecovery failure={s.failure ?? {kind:"invalid", message:s.lastError!}} checkedAt={s.lastChecked}/>} description="ToolBelt · Copyright NetSense LLC." actions={<GitHubButton retryAt={s.retryAt} hint={`Last checked: ${s.lastChecked ? new Date(s.lastChecked).toLocaleString() : "Not yet checked"}`} variant="outline" size="sm" className="h-6 text-xs" disabled={!s.enabled || s.checking || s.phase.kind !== "idle" || (s.retryAt ?? 0) > now} onClick={() => updateAction("checkForUpdates")}><RotateCw className={cn(s.checking && "animate-spin")}/>{s.checking ? "Checking…" : "Check for updates"}</GitHubButton>}>
      <article aria-label="ToolBelt" className="min-w-0 space-y-4 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <img src={s.channel === "dev" ? devAppIcon : appIcon} alt="ToolBelt app icon" className="size-10 shrink-0 object-contain"/>
          <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">ToolBelt</h3><RepositoryLink repo="tkarakai/toolbelt"/></div>
        </div>
        <div className="grid gap-4 rounded-lg bg-muted/30 p-3 sm:grid-cols-2">
          <div className="space-y-2"><div className="text-xs font-medium text-muted-foreground">Installed release</div><p className="text-sm">Version <span className="font-mono font-medium">{s.version} ({buildInfo.commit})</span></p><span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs capitalize",pillClass("muted"))}>{s.channel}</span></div>
          <div className="space-y-2"><div className="text-xs font-medium text-muted-foreground">Update channel</div><div className="flex items-center gap-1.5 text-sm"><GitBranch className="size-3.5 text-muted-foreground"/>{s.channel === "stable" ? "Stable" : s.channel === "dev" ? "Development" : s.channel}</div><p className="text-xs leading-relaxed text-muted-foreground">{s.enabled ? "Use stable releases for future checks." : "Automatic updates are unavailable in this build."}</p></div>
        </div>
        <ManualUpdate name="ToolBelt" version={s.version} commit={buildInfo.commit} repo="tkarakai/toolbelt" failure={s.failure} retryAt={s.retryAt}/>
        {r && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
          <div className="min-w-0 flex-1 space-y-2"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{s.lastError ? "Previously found update" : "Available update"}</span><span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs",pillClass("info"))}>Stable</span></div><p className="text-sm">Version <span className="font-mono font-medium">{r.version}</span></p><p className="text-xs text-muted-foreground">{r.published ? `Released ${date(r.published)} · ` : ""}{mb(r.size)}{s.lastChecked ? ` · Checked ${new Date(s.lastChecked).toLocaleString()}` : ""}</p></div>
          <GitHubButton retryAt={s.retryAt} size="sm" disabled={s.phase.kind !== "idle"} onClick={() => openDialog()}><Download/>Review and Update</GitHubButton>
        </div>}
        <DevUpdatePreview/>
        <UpdateDialog s={s}/>
      </article>
    </SettingsGroup></div>
  );
}

// ── the update, start to finish ──────────────────────────────────────────
const STEPS = [
  "downloading",
  "verifying",
  "installing",
  "relaunching",
] as const;

export function UpdateDialog({ s }: { s: UpdateState }) {
  const [confirming, setConfirming] = useState(false);
  openDialog = () => setConfirming(true);
  const kind = s.phase.kind;
  const busy =
    kind === "downloading" ||
    kind === "verifying" ||
    kind === "installing" ||
    kind === "relaunching";
  useEffect(() => {
    if (kind !== "idle") setConfirming(false);
  }, [kind]);
  const open = confirming || kind !== "idle";
  const r = s.available ?? s.latest;
  const close = () => {
    if (busy) return;
    setConfirming(false);
    if (kind === "failed") updateAction("dismissUpdate");
  };
  const step = STEPS.indexOf(kind as (typeof STEPS)[number]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-lg"
        showCloseButton={!busy}
        onEscapeKeyDown={(e) => {
          if (!busy) return;
          e.preventDefault();
          if (kind === "downloading") updateAction("cancelUpdate"); // the Cancel button's esc
        }}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader className="flex-row items-center gap-4 border-b p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-primary">
            <Download className="size-5" />
          </div>
          <div className="min-w-0 space-y-1.5">
            <DialogTitle icon={null} className="text-base">
              {kind === "idle"
                ? "A new version of ToolBelt"
                : kind === "failed"
                  ? "The update didn't finish"
                  : kind === "relaunching"
                    ? "Restarting…"
                    : "Updating ToolBelt"}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex items-center gap-2">
                <Pill>Version {s.version} ({buildInfo.commit})</Pill>
                <ArrowRight className="size-3.5" />
                <Pill current>v{r?.version ?? "?"}</Pill>
              </div>
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="min-h-64">
          {kind === "idle" && (
            <div className="animate-in fade-in-0 duration-200">
              <div className="max-h-72 overflow-auto px-5 py-4">
                {r?.notes ? (
                  <Markdown text={r.notes} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No release notes.
                  </p>
                )}
              </div>
              <div className="mx-5 mb-5 flex gap-3 rounded-lg bg-amber-500/10 p-3">
                <RotateCw className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="text-sm">
                  <div className="font-medium">
                    ToolBelt will quit and reopen
                  </div>
                  <div className="text-muted-foreground">
                    Its tools restart with it; processes you started in your
                    terminals keep running. It takes a few seconds.
                  </div>
                </div>
              </div>
            </div>
          )}
          {step >= 0 && (
            <ol className="animate-in space-y-5 p-6 fade-in-0 duration-200">
              <Step
                index={0}
                current={step}
                title="Download"
                detail={downloadDetail(s)}
              >
                {s.phase.kind === "downloading" && (
                  <Progress
                    value={
                      (100 * s.phase.received) / Math.max(1, s.phase.total)
                    }
                    className="mt-2 h-1.5 [&>*]:duration-200"
                  />
                )}
              </Step>
              <Step
                index={1}
                current={step}
                title="Verify"
                detail="Checksum from GitHub, bundle id, version, code signature"
              />
              <Step
                index={2}
                current={step}
                title="Install"
                detail={s.appPath ?? "Toolbelt.app"}
              />
              <Step
                index={3}
                current={step}
                title="Restart"
                detail={`ToolBelt reopens with v${r?.version ?? ""}`}
              />
            </ol>
          )}
          {s.phase.kind === "failed" && (
            <div className="flex animate-in flex-col items-center gap-3 px-8 py-10 text-center fade-in-0 duration-200">
              <AlertTriangle className="size-10 text-amber-500" />
              <p className="text-sm">{s.phase.message}</p>
              <p className="text-sm text-muted-foreground">
                Nothing was changed — this version keeps working.
              </p>
            </div>
          )}
        </div>

        {simulated && <DevUpdatePreview/>}
        <DialogFooter className="m-0 items-center rounded-b-xl">
          {r && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground"
              onClick={() => openUrl(r.page)}
            >
              <ArrowUpRight />
              Release on GitHub
            </Button>
          )}
          {kind === "idle" && (
            <>
              <Button variant="outline" onClick={close}>
                Later
                <KeyHint keys="esc" />
              </Button>
              <GitHubButton retryAt={s.retryAt}
                autoFocus
                onClick={() => updateAction("installUpdate")}
              >
                Update &amp; Restart
                <KeyHint keys="↵" />
              </GitHubButton>
            </>
          )}
          {kind === "downloading" && (
            <Button
              variant="outline"
              onClick={() => updateAction("cancelUpdate")}
            >
              Cancel
              <KeyHint keys="esc" />
            </Button>
          )}
          {(kind === "verifying" ||
            kind === "installing" ||
            kind === "relaunching") && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          {kind === "failed" && (
            <>
              <Button variant="outline" onClick={close}>
                Close
                <KeyHint keys="esc" />
              </Button>
              <GitHubButton retryAt={s.retryAt}
                autoFocus
                onClick={() => updateAction("installUpdate")}
              >
                Try Again
                <KeyHint keys="↵" />
              </GitHubButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function downloadDetail(s: UpdateState): string {
  const p = s.phase;
  if (p.kind !== "downloading")
    return s.available ? `Disk image · ${mb(s.available.size)}` : "Disk image";
  let t = `${mb(p.received)} of ${mb(p.total)}`;
  if (p.speed > 1) {
    t += ` · ${mb(p.speed)}/s`;
    const left = (p.total - p.received) / p.speed;
    if (left >= 1) t += ` · ${Math.round(left)} s left`;
  }
  return t;
}

function Pill({
  children,
  current,
}: {
  children: ReactNode;
  current?: boolean;
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 font-mono text-xs font-medium",
        current
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** One line of the checklist: a numbered circle that turns into a spinner, then a check. */
function Step({
  index,
  current,
  title,
  detail,
  children,
}: {
  index: number;
  current: number;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  const done = index < current,
    now = index === current;
  return (
    <li className="flex items-start gap-3.5">
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-200",
          done &&
            "border-transparent bg-emerald-600 text-white dark:bg-emerald-500",
          now && "border-transparent bg-primary/15 text-primary",
          !done && !now && "text-muted-foreground",
        )}
      >
        {done ? (
          <Check className="size-3.5 animate-in zoom-in-50 duration-200" />
        ) : now ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          index + 1
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-sm font-medium transition-colors duration-200",
            !done && !now && "text-muted-foreground",
          )}
        >
          {title}
        </div>
        <div
          className="truncate text-sm text-muted-foreground tabular-nums"
          title={detail}
        >
          {detail}
        </div>
        {now && children}
      </div>
    </li>
  );
}

// Header summary is intentionally pointer-only; keyboard activation opens Settings.
export function PopoverUpdateRow({ onPanelChange }: { onPanelChange?: (open: boolean) => void }) {
  const app = useUpdateAvailable();
  const manager = useUpdateManager();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { onPanelChange?.(open); }, [open, onPanelChange]);
  const plugins = manager.plugins.filter(p => !p.removed && p.availableVersion);
  useEffect(() => { if (!app && !plugins.length) setOpen(false); }, [!!app, plugins.length]);
  if (!app && !plugins.length) return null;
  const show = () => rpc.send.showWindow({ plugin: "toolbelt", screen: "updates" });
  return <div className="relative ml-auto shrink-0" onPointerEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 200); }}
    onPointerLeave={() => { clearTimeout(timer.current); setOpen(false); }}>
    <Button data-update-notice variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={show}
      onFocus={() => { clearTimeout(timer.current); setOpen(false); }} onKeyDown={() => { clearTimeout(timer.current); setOpen(false); }} aria-label="Updates available — open Settings">
      <Download className="size-3.5" /> Updates
    </Button>
    {open && <div role="region" aria-label="Available updates" className="absolute right-0 top-full z-50 w-72 max-w-[calc(100vw-2rem)] pt-2">
      <div className="rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg animate-in fade-in-0 duration-200 motion-reduce:animate-none">
        <div className="mb-2 text-sm font-semibold">Available updates</div>
        <div className="max-h-36 overflow-auto divide-y">
          {app && <div className="py-2 text-xs"><div className="font-medium">ToolBelt <span className="float-right">{app.version}</span></div><div className="mt-1 text-muted-foreground">{app.published ? `Released ${date(app.published)}` : "Release date unavailable"}</div></div>}
          {plugins.map(p => <div key={p.id} className="py-2 text-xs"><div className="flex justify-between gap-2"><span className="min-w-0 break-words font-medium">{p.manifest.name}</span><span>{p.version} → {p.availableVersion}</span></div><div className="mt-1 text-muted-foreground">{p.availableSince ? `Available since ${date(p.availableSince)}` : "Available now"}</div></div>)}
        </div>
        <Button size="sm" variant="outline" className="mt-3 w-full" onClick={show}>Review updates <ArrowRight /></Button>
      </div>
    </div>}
  </div>;
}

function useUpdateManager() {
  const [manager, setManager] = useState<import("./plugin-manager-model").ManagerState>({ plugins: [] });
  useEffect(() => {
    const adapter = getPluginManagerAdapter();
    let live = true;
    void adapter?.read().then(state => { if (live) setManager(state); });
    const unsubscribe = adapter?.subscribe?.(setManager);
    return () => { live = false; unsubscribe?.(); };
  }, []);
  return manager;
}

export function usePluginUpdateAvailable() {
  return useUpdateManager().plugins.some(p => !p.removed && !!p.availableVersion);
}

export function useAnyUpdateAvailable() {
  const app = useUpdateAvailable();
  const manager = useUpdateManager();
  return !!app || manager.plugins.some(p => !p.removed && !!p.availableVersion);
}
