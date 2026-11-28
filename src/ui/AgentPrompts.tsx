// What agents ask of the person's screens (docs/agent-interface.md, Showing the person a screen and
// Approvals): the dialog that asks whether an agent may change their view and for how long, or
// make a change in a plugin, shown on every person's screen at once and drawn by ToolBelt from
// what it resolved (never the agent's words), and the "Shown by" notice on a screen an agent
// changed, with Restore.
import { useEffect, useState } from "react";
import { Bot, RotateCcw, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentsRequest, useAgents } from "@/lib/store";
import { cn } from "@/lib/utils";
import { pillClass } from "./renderer/colors";
import { DEFAULT_GRANT, GRANT_DURATIONS, type ChangeRequest, type GrantDuration, type ViewApproval } from "../shared/agents";

async function run(request: Parameters<typeof agentsRequest>[0]) {
	try {
		await agentsRequest(request);
	} catch (error) {
		toast.error(error instanceof Error ? error.message : String(error));
	}
}

/** Seconds left until `at`, ticking. */
function useSecondsLeft(at: number | undefined) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!at) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [at]);
	return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

/** How long to allow it: the grant durations, today by default. */
function DurationSelect({ value, onChange, label }: { value: GrantDuration; onChange: (d: GrantDuration) => void; label: string }) {
	return (
		<Select value={value} onValueChange={(v) => onChange(v as GrantDuration)}>
			<SelectTrigger size="sm" className="w-36" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent position="popper" align="end">
				{GRANT_DURATIONS.map((d) => (
					<SelectItem key={d.id} value={d.id}>
						{d.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** What a change does, in a sentence, by its declared effect. */
const EFFECT_TEXT: Record<ChangeRequest["effect"], (plugin: string) => string> = {
	view: () => "It changes only the agent’s own copy of the screen.",
	write: (plugin) => `It changes your data in ${plugin}.`,
	external: (plugin) => `It reaches outside ${plugin}: it may open an app or website, start a process or send something.`,
	destructive: () => "It deletes something, or can’t be undone.",
};
const EFFECT_PILL: Record<ChangeRequest["effect"], { label: string; tone: "default" | "info" | "warning" | "danger" }> = {
	view: { label: "View", tone: "default" },
	write: { label: "Change", tone: "info" },
	external: { label: "Outside ToolBelt", tone: "warning" },
	destructive: { label: "Can’t be undone", tone: "danger" },
};

/**
 * An agent asking to run an action or fill a form. Everything shown is what ToolBelt resolved in
 * the agent's copy of the screen: the action's label, the plugin and screen, the rows' titles, the
 * plugin's own question and the dialog's values. "Allow changes in <plugin>" is offered only for a
 * plain write.
 */
function ChangeApprovalDialog({ approval }: { approval: ViewApproval & { change: ChangeRequest } }) {
	const c = approval.change;
	const [duration, setDuration] = useState<GrantDuration>(DEFAULT_GRANT);
	const left = useSecondsLeft(approval.expires);
	useEffect(() => setDuration(DEFAULT_GRANT), [approval.id]);
	const answer = (allow: boolean, scope: "once" | "grant" = "once") => void run({ operation: "answer", id: approval.id, allow, duration, scope });
	const destructive = c.effect === "destructive";
	const pill = EFFECT_PILL[c.effect];
	const more = c.rowCount - c.rows.length;
	return (
		<Dialog open onOpenChange={(open) => !open && answer(false)}>
			<DialogContent showCloseButton={false} className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle icon={destructive ? <TriangleAlert className="size-5 text-destructive" /> : <Bot className="size-5" />}>
						{c.kind === "run" ? (
							<>
								{approval.client} wants to run “{c.label}”
							</>
						) : (
							<>
								{approval.client} wants to change “{c.label}”
							</>
						)}
					</DialogTitle>
					<DialogDescription>
						In <span className="font-medium text-foreground">{c.pluginName} › {c.screen}</span>. {EFFECT_TEXT[c.effect](c.pluginName)}
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-[50vh] min-w-0 space-y-3 overflow-y-auto text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", pillClass(pill.tone))}>{pill.label}</span>
						{c.rowCount > 0 && (
							<span className="text-xs text-muted-foreground">
								{c.rowCount === 1 ? "On 1 item" : `On ${c.rowCount} items`}
							</span>
						)}
					</div>
					{c.rows.length > 0 && (
						<ul aria-label="What it acts on" className="space-y-1 rounded-lg border bg-muted/40 px-3 py-2">
							{c.rows.map((title, i) => (
								<li key={i} className="truncate" title={title}>
									{title}
								</li>
							))}
							{more > 0 && <li className="text-xs text-muted-foreground">and {more} more</li>}
						</ul>
					)}
					{c.confirm && (
						<p className="rounded-lg border px-3 py-2">
							<span className="block text-xs font-medium text-muted-foreground">{c.pluginName} asks</span>
							<span className="break-words">{c.confirm}</span>
						</p>
					)}
					{c.fields && c.fields.values.length > 0 && (
						<div className="rounded-lg border px-3 py-2">
							{c.fields.title && <span className="block text-xs font-medium text-muted-foreground">{c.kind === "fill" ? "It sets" : c.fields.title}</span>}
							<dl className="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
								{c.fields.values.map((f, i) => (
									<div key={i} className="contents">
										<dt className="truncate text-muted-foreground">{f.label}</dt>
										<dd className="break-words">{f.value || <span className="text-muted-foreground">empty</span>}</dd>
									</div>
								))}
							</dl>
						</div>
					)}
				</div>
				{c.grantable && (
					<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
						<span className="min-w-0">Or let {approval.client} make changes in {c.pluginName} without asking, for</span>
						<div className="flex flex-wrap items-center gap-2">
							<DurationSelect value={duration} onChange={setDuration} label={`How long to let ${approval.client} make changes in ${c.pluginName}`} />
							<Button variant="secondary" onClick={() => answer(true, "grant")}>
								Allow changes in {c.pluginName}
							</Button>
						</div>
					</div>
				)}
				<DialogFooter className="flex-row flex-wrap items-center justify-end gap-2">
					<span className="mr-auto text-xs text-muted-foreground tabular-nums" aria-live="off">
						It waits {left}s for your answer
					</span>
					<Button variant="outline" autoFocus onClick={() => answer(false)}>
						Deny
					</Button>
					<Button variant={destructive ? "destructive" : "default"} onClick={() => answer(true)}>
						Allow once
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** An agent asking to change what the person's screens show, or to make a change; the oldest question first. */
export function ViewApprovalDialog() {
	const state = useAgents();
	const approval = state?.approvals[0];
	const [duration, setDuration] = useState<GrantDuration>(DEFAULT_GRANT);
	const left = useSecondsLeft(approval?.expires);
	useEffect(() => setDuration(DEFAULT_GRANT), [approval?.id]);
	if (!approval) return null;
	if (approval.change) return <ChangeApprovalDialog key={approval.id} approval={approval as ViewApproval & { change: ChangeRequest }} />;
	const answer = (allow: boolean) => void run({ operation: "answer", id: approval.id, allow, duration });
	return (
		<Dialog open onOpenChange={(open) => !open && answer(false)}>
			<DialogContent showCloseButton={false} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle icon={<Bot className="size-5" />}>{approval.client} wants to change your view</DialogTitle>
					<DialogDescription>
						It wants to show you <span className="font-medium text-foreground">{approval.what}</span> on every ToolBelt screen you have open, here and on paired devices, as if you had set it yourself. You can put your view back with Restore.
					</DialogDescription>
				</DialogHeader>
				<label className="flex flex-wrap items-center justify-between gap-3 text-sm">
					<span>Allow it to change your view for</span>
					<DurationSelect value={duration} onChange={setDuration} label="How long to allow it" />
				</label>
				<DialogFooter className="flex-row flex-wrap items-center justify-end gap-2">
					<span className="mr-auto text-xs text-muted-foreground tabular-nums" aria-live="off">
						It waits {left}s for your answer
					</span>
					<Button variant="outline" onClick={() => answer(false)}>
						Don’t allow
					</Button>
					<Button autoFocus onClick={() => answer(true)}>
						Allow
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** "Shown by <agent>" above a screen an agent changed, with Restore to put the person's view back. */
export function ShownNotice({ plugin, surface }: { plugin: string; surface: string }) {
	const state = useAgents();
	const shown = state?.shown.find((s) => s.plugin === plugin && s.surface === surface);
	if (!shown) return null;
	return (
		<div role="status" className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none">
			<Bot className="size-3.5 shrink-0" aria-hidden />
			<span className="min-w-0 flex-1 truncate">Shown by {shown.client}</span>
			<Button size="xs" variant="ghost" onClick={() => void run({ operation: "restoreView", plugin, surface })}>
				<RotateCcw />
				Restore
			</Button>
			<Button size="icon-xs" variant="ghost" aria-label="Keep this view and close the notice" onClick={() => void run({ operation: "dismissShown", plugin, surface })}>
				<X />
			</Button>
		</div>
	);
}
