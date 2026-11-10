// Updates, in the UI: the card on Toolbelt's page (version, channel, last check, what's new),
// the dialog that walks through an update (download → verify → install → restart), the red dot
// for the sidebar and the popover's "Update available" row. The work happens in the main
// process (src/bun/updater.ts); this shows its state, pushed as `updateState`.
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, ArrowUpRight, BadgeCheck, Check, Clock, Download, Loader2, RotateCw } from "lucide-react";
import type { UpdateState } from "../shared/rpc";
import { openUrl, rpc, updateListeners } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Markdown, When } from "@/renderer/Render";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyHint } from "@/components/key-hint";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

// One copy of the state for every component in this view.
let current: UpdateState | null = null;
const local = new Set<() => void>();
let asked = false;
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
	return current;
}

/** The newer version, if there is one. */
export const useUpdateAvailable = () => useUpdateState()?.available ?? null;

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The red dot that marks an available update. */
export function UpdateDot({ className }: { className?: string }) {
	return <span aria-label="Update available" className={cn("inline-block size-2 shrink-0 rounded-full bg-red-500 ring-2 ring-sidebar", className)} />;
}

// ── the card on Toolbelt's page ──────────────────────────────────────────
let openDialog: () => void = () => {};

export function UpdatesCard() {
	const s = useUpdateState();
	if (!s) return null;
	const r = s.available;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Updates</CardTitle>
				<CardDescription>
					{s.enabled ? "Toolbelt looks for new releases on GitHub a few times a day and updates itself when you say so." : "This is a dev build: it doesn't update itself — it runs from your checkout (bun run dev)."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
						<StatusIcon s={s} />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2 text-sm font-medium">
							{title(s)}
						</div>
						<div className="text-sm text-muted-foreground">
							<Detail s={s} />
						</div>
					</div>
					{s.enabled && !r && (
						<Button variant="outline" size="sm" disabled={s.checking || s.phase.kind !== "idle"} onClick={() => void rpc.request.checkForUpdates({})}>
							<RotateCw className={cn(s.checking && "animate-spin")} />
							Check now
						</Button>
					)}
				</div>
				{r && (
					<div className="animate-in rounded-lg border fade-in-0 duration-200">
						<div className="flex items-center gap-3 border-b px-4 py-3">
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">What's new in {r.version}</div>
								<div className="text-xs text-muted-foreground">
									{r.published ? `Released ${date(r.published)}` : "Released recently"} · {mb(r.size)}
								</div>
							</div>
							<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => openUrl(r.page)}>
								<ArrowUpRight />
								On GitHub
							</Button>
							<Button size="sm" disabled={s.phase.kind !== "idle"} onClick={() => openDialog()}>
								<Download />
								Update to {r.version}…
							</Button>
						</div>
						<div className="max-h-72 overflow-auto px-4 py-3">{r.notes ? <Markdown text={r.notes} /> : <p className="text-sm text-muted-foreground">No release notes.</p>}</div>
					</div>
				)}
				<UpdateDialog s={s} />
			</CardContent>
		</Card>
	);
}

function StatusIcon({ s }: { s: UpdateState }) {
	if (s.checking) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
	if (s.available) return <UpdateDot className="size-2.5 ring-0" />;
	if (s.lastError) return <AlertTriangle className="size-4 text-amber-500" />;
	if (s.lastChecked) return <BadgeCheck className="size-4 text-emerald-600 dark:text-emerald-400" />;
	return <Clock className="size-4 text-muted-foreground" />;
}

function title(s: UpdateState): string {
	if (!s.enabled) return `Toolbelt ${s.version}`;
	if (s.checking) return "Checking GitHub for a new version…";
	if (s.available) return `Toolbelt ${s.available.version} is available`;
	if (s.lastError) return "Couldn't check for updates";
	if (s.lastChecked) return "Toolbelt is up to date";
	return "Not checked yet";
}

function Detail({ s }: { s: UpdateState }) {
	const parts: ReactNode[] = [];
	if (!s.enabled) {
		parts.push(`${s.channel} channel`, "updates come from the checkout");
	} else {
		parts.push(s.available ? `You have ${s.version}` : `Version ${s.version}`);
		if (s.lastError) parts.push(<span className="text-foreground">{s.lastError.replace(/[. ]+$/, "")}</span>);
		else if (s.latest && !s.available) parts.push(`${s.latest.version} is the newest release${s.latest.published ? `, from ${date(s.latest.published)}` : ""}`);
		if (s.lastChecked)
			parts.push(
				<>
					checked <When at={s.lastChecked} />
				</>,
			);
		if (!s.available && s.nextCheck && s.nextCheck > Date.now())
			parts.push(
				<>
					next {s.lastError ? "try" : "check"} <When at={s.nextCheck} />
				</>,
			);
	}
	return (
		<>
			{parts.map((p, i) => (
				<span key={i}>
					{i > 0 && " · "}
					{p}
				</span>
			))}
		</>
	);
}

// ── the update, start to finish ──────────────────────────────────────────
const STEPS = ["downloading", "verifying", "installing", "relaunching"] as const;

export function UpdateDialog({ s }: { s: UpdateState }) {
	const [confirming, setConfirming] = useState(false);
	openDialog = () => setConfirming(true);
	const kind = s.phase.kind;
	const busy = kind === "downloading" || kind === "verifying" || kind === "installing" || kind === "relaunching";
	useEffect(() => {
		if (kind !== "idle") setConfirming(false);
	}, [kind]);
	const open = confirming || kind !== "idle";
	const r = s.available ?? s.latest;
	const close = () => {
		if (busy) return;
		setConfirming(false);
		if (kind === "failed") void rpc.request.dismissUpdate({});
	};
	const step = STEPS.indexOf(kind as (typeof STEPS)[number]);

	return (
		<Dialog open={open} onOpenChange={(o) => !o && close()}>
			<DialogContent className="gap-0 p-0 sm:max-w-lg" showCloseButton={!busy} onEscapeKeyDown={(e) => {
					if (!busy) return;
					e.preventDefault();
					if (kind === "downloading") void rpc.request.cancelUpdate({}); // the Cancel button's esc
				}} onInteractOutside={(e) => busy && e.preventDefault()}>
				<DialogHeader className="flex-row items-center gap-4 border-b p-5">
					<div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
						<Download className="size-6" />
					</div>
					<div className="min-w-0 space-y-1.5">
						<DialogTitle className="text-base">{kind === "idle" ? "A new version of Toolbelt" : kind === "failed" ? "The update didn't finish" : kind === "relaunching" ? "Restarting…" : "Updating Toolbelt"}</DialogTitle>
						<DialogDescription asChild>
							<div className="flex items-center gap-2">
								<Pill>v{s.version}</Pill>
								<ArrowRight className="size-3.5" />
								<Pill current>v{r?.version ?? "?"}</Pill>
							</div>
						</DialogDescription>
					</div>
				</DialogHeader>

				<div className="min-h-64">
					{kind === "idle" && (
						<div className="animate-in fade-in-0 duration-200">
							<div className="max-h-72 overflow-auto px-5 py-4">{r?.notes ? <Markdown text={r.notes} /> : <p className="text-sm text-muted-foreground">No release notes.</p>}</div>
							<div className="mx-5 mb-5 flex gap-3 rounded-lg bg-amber-500/10 p-3">
								<RotateCw className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
								<div className="text-sm">
									<div className="font-medium">Toolbelt will quit and reopen</div>
									<div className="text-muted-foreground">Its tools restart with it; processes you started in your terminals keep running. It takes a few seconds.</div>
								</div>
							</div>
						</div>
					)}
					{step >= 0 && (
						<ol className="animate-in space-y-5 p-6 fade-in-0 duration-200">
							<Step index={0} current={step} title="Download" detail={downloadDetail(s)}>
								{s.phase.kind === "downloading" && <Progress value={(100 * s.phase.received) / Math.max(1, s.phase.total)} className="mt-2 h-1.5 [&>*]:duration-200" />}
							</Step>
							<Step index={1} current={step} title="Verify" detail="Checksum from GitHub, bundle id, version, code signature" />
							<Step index={2} current={step} title="Install" detail={s.appPath ?? "Toolbelt.app"} />
							<Step index={3} current={step} title="Restart" detail={`Toolbelt reopens with v${r?.version ?? ""}`} />
						</ol>
					)}
					{s.phase.kind === "failed" && (
						<div className="flex animate-in flex-col items-center gap-3 px-8 py-10 text-center fade-in-0 duration-200">
							<AlertTriangle className="size-10 text-amber-500" />
							<p className="text-sm">{s.phase.message}</p>
							<p className="text-sm text-muted-foreground">Nothing was changed — this version keeps working.</p>
						</div>
					)}
				</div>

				<DialogFooter className="m-0 items-center rounded-b-xl">
					{r && (
						<Button variant="ghost" size="sm" className="mr-auto text-muted-foreground" onClick={() => openUrl(r.page)}>
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
							<Button autoFocus onClick={() => void rpc.request.installUpdate({})}>
								Update &amp; Restart
								<KeyHint keys="↵" />
							</Button>
						</>
					)}
					{kind === "downloading" && (
						<Button variant="outline" onClick={() => void rpc.request.cancelUpdate({})}>
							Cancel
							<KeyHint keys="esc" />
						</Button>
					)}
					{(kind === "verifying" || kind === "installing" || kind === "relaunching") && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
					{kind === "failed" && (
						<>
							<Button variant="outline" onClick={close}>
								Close
								<KeyHint keys="esc" />
							</Button>
							<Button autoFocus onClick={() => void rpc.request.installUpdate({})}>
								Try Again
								<KeyHint keys="↵" />
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function downloadDetail(s: UpdateState): string {
	const p = s.phase;
	if (p.kind !== "downloading") return s.available ? `Disk image · ${mb(s.available.size)}` : "Disk image";
	let t = `${mb(p.received)} of ${mb(p.total)}`;
	if (p.speed > 1) {
		t += ` · ${mb(p.speed)}/s`;
		const left = (p.total - p.received) / p.speed;
		if (left >= 1) t += ` · ${Math.round(left)} s left`;
	}
	return t;
}

function Pill({ children, current }: { children: ReactNode; current?: boolean }) {
	return <span className={cn("rounded-full px-2 py-0.5 font-mono text-xs font-medium", current ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>{children}</span>;
}

/** One line of the checklist: a numbered circle that turns into a spinner, then a check. */
function Step({ index, current, title, detail, children }: { index: number; current: number; title: string; detail: string; children?: ReactNode }) {
	const done = index < current, now = index === current;
	return (
		<li className="flex items-start gap-3.5">
			<div
				className={cn(
					"flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-200",
					done && "border-transparent bg-emerald-600 text-white dark:bg-emerald-500",
					now && "border-transparent bg-primary/15 text-primary",
					!done && !now && "text-muted-foreground",
				)}
			>
				{done ? <Check className="size-3.5 animate-in zoom-in-50 duration-200" /> : now ? <Loader2 className="size-3.5 animate-spin" /> : index + 1}
			</div>
			<div className="min-w-0 flex-1">
				<div className={cn("text-sm font-medium transition-colors duration-200", !done && !now && "text-muted-foreground")}>{title}</div>
				<div className="truncate text-sm text-muted-foreground tabular-nums" title={detail}>
					{detail}
				</div>
				{now && children}
			</div>
		</li>
	);
}

// ── the popover's row ────────────────────────────────────────────────────
/** "Update available — 0.2.0": opens the window on Toolbelt's page. */
export function PopoverUpdateRow() {
	const r = useUpdateAvailable();
	if (!r) return null;
	return (
		<button
			onClick={() => rpc.send.showWindow({ plugin: "toolbelt" })}
			className="mx-2 mb-1 flex animate-in items-center gap-2.5 rounded-lg bg-red-500/10 px-3 py-2 text-left text-sm outline-none fade-in-0 duration-200 hover:bg-red-500/15"
		>
			<UpdateDot className="ring-0" />
			<span className="flex-1 font-medium">Update available — {r.version}</span>
			<span className="text-xs text-muted-foreground">Update…</span>
		</button>
	);
}
