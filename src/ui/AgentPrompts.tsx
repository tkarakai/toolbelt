// What agents ask of the person's screens (docs/agent-interface.md, Showing the person a
// screen): the dialog that asks whether an agent may change their view and for how long, shown
// on every person's screen at once, and the "Shown by" notice on a screen an agent changed, with
// Restore.
import { useEffect, useState } from "react";
import { Bot, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentsRequest, useAgents } from "@/lib/store";
import { DEFAULT_GRANT, GRANT_DURATIONS, type GrantDuration } from "../shared/agents";

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

/** An agent asking to change what the person's screens show; the oldest question first. */
export function ViewApprovalDialog() {
	const state = useAgents();
	const approval = state?.approvals[0];
	const [duration, setDuration] = useState<GrantDuration>(DEFAULT_GRANT);
	const left = useSecondsLeft(approval?.expires);
	useEffect(() => setDuration(DEFAULT_GRANT), [approval?.id]);
	if (!approval) return null;
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
					<Select value={duration} onValueChange={(v) => setDuration(v as GrantDuration)}>
						<SelectTrigger size="sm" className="w-36" aria-label="How long to allow it">
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
