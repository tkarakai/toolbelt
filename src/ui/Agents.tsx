// Settings → Agents (docs/agent-interface.md), in sub-tabs: Access (the switch, a status summary
// and per-plugin access), Connect (the setup commands) and Activity (active sessions and the log).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Activity, Bot, Check, ChevronRight, Copy, Plug, ShieldCheck, TriangleAlert } from "lucide-react";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { SettingsGroup } from "./components/settings-layout";
import { Icon } from "./lib/icon";
import { cn } from "./lib/utils";
import { pillClass, textClass } from "./renderer/colors";
import { agentAudit, agentsRequest, useAgents } from "./lib/store";
import { usePersisted } from "./lib/uistate";
import { connectCommands, type CommandTab } from "./lib/agent-commands";
import { AgentActivity } from "./AgentActivity";
import { OPERATION_LABELS, type AgentAccess, type AgentPlugin, type AgentsState } from "../shared/agents";

const ACCESS_LABEL: Record<AgentAccess, string> = { none: "No access", read: "Read only", act: "Read and act" };

const TABS = [
	{ id: "access", label: "Access", icon: ShieldCheck },
	{ id: "connect", label: "Connect", icon: Plug },
	{ id: "activity", label: "Activity", icon: Activity },
] as const;

async function run(request: Parameters<typeof agentsRequest>[0]) {
	try {
		const state = await agentsRequest(request);
		if (state.error) toast.error(state.error);
	} catch (error) {
		toast.error(error instanceof Error ? error.message : String(error));
	}
}

export function AgentsSettings() {
	const state = useAgents();
	const [remembered, remember] = usePersisted<string>("toolbelt.agents-tab", "access");
	const tab = TABS.some((t) => t.id === remembered) ? remembered : "access"; // also an older "general" or "plugins"
	if (!state) return <p className="px-1 text-sm text-muted-foreground">Reading agent settings…</p>;
	return (
		<Tabs value={tab} onValueChange={remember} className="gap-6">
			{/* Sized to its tabs, scrolling sideways when the window is narrower. */}
			<div className="flex min-w-0">
			<TabsList aria-label="Agent settings">
				{TABS.map((t) => (
					<TabsTrigger key={t.id} value={t.id} className="flex-none gap-1.5 px-3 data-[state=active]:bg-selected! data-[state=active]:text-selected-foreground! data-[state=active]:hover:text-selected-foreground!">
						<t.icon />
						{t.label}
						{t.id === "activity" && state.sessions.length > 0 && (
							<span className="ml-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[11px] leading-4 text-emerald-800 tabular-nums dark:text-emerald-300" aria-label={`${state.sessions.length} active`}>
								{state.sessions.length}
							</span>
						)}
					</TabsTrigger>
				))}
			</TabsList>
			</div>
			<TabsContent value="access" className="space-y-8">
				<StatusGroup state={state} go={remember} />
				<PluginAccessGroup plugins={state.plugins} />
			</TabsContent>
			<TabsContent value="connect" className="space-y-8">
				{state.command ? (
					<ConnectGroup command={state.command} enabled={state.enabled} warning={state.commandWarning} />
				) : (
					<SettingsGroup title="Setup commands">
						<p className="px-5 py-4 text-sm text-muted-foreground">This build of ToolBelt doesn’t include the toolbelt command, so there’s nothing to set agents up with.</p>
					</SettingsGroup>
				)}
			</TabsContent>
			<TabsContent value="activity" className="space-y-8">
				<SessionsGroup state={state} />
				<AgentActivity plugins={state.plugins} newest={state.audit[0]?.id} />
			</TabsContent>
		</Tabs>
	);
}

/** Today's activity, counted by the host (up to 1,000 entries), refreshed as the log grows. */
function useToday(newest: number | undefined) {
	const [today, setToday] = useState<{ total: number; refused: number; failed: number; more: boolean } | null>(null);
	useEffect(() => {
		let cancelled = false;
		const t = setTimeout(() => {
			agentAudit({ limit: 1000, filter: { since: new Date(new Date().toDateString()).getTime() } })
				.then((page) => {
					if (cancelled) return;
					const count = (o: string) => page.entries.filter((e) => e.outcome === o).length;
					setToday({ total: page.entries.length, refused: count("denied"), failed: count("error"), more: page.next !== null });
				})
				.catch(() => {});
		}, today ? 400 : 0);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [newest]);
	return today;
}

const ago = (at: number) => {
	const m = Math.round((Date.now() - at) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
	return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
};

function readableHint(plugins: AgentPlugin[]) {
	const hidden = plugins.filter((p) => p.effective === "none");
	if (!hidden.length) return "All plugins";
	const undeclared = hidden.filter((p) => !p.declared).length;
	return undeclared ? `${hidden.length} kept from agents, ${undeclared} not declared` : `${hidden.length} kept from agents`;
}

/** The switch, whether it's working, and the numbers worth a glance; tiles lead to their tab. */
function StatusGroup({ state, go }: { state: AgentsState; go: (tab: string) => void }) {
	const today = useToday(state.audit[0]?.id);
	const readable = state.plugins.filter((p) => p.effective !== "none").length;
	const last = state.audit[0];
	const status = state.error
		? { label: "Error", tone: "danger" as const }
		: state.running
			? { label: "On", tone: "success" as const }
			: state.enabled
				? { label: "Starting", tone: "warning" as const }
				: { label: "Off", tone: "default" as const };
	return (
		<section aria-label="Agent access" className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
			<div className="flex flex-wrap items-start gap-4 p-5">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
					<Bot className="size-5" />
				</div>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="text-base font-semibold">Let agents use ToolBelt</h2>
						<span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", pillClass(status.tone))}>
							<span className={cn("size-1.5 rounded-full bg-current", state.running && "tb-pulse")} aria-hidden />
							{status.label}
						</span>
					</div>
					<p className="text-sm text-muted-foreground">
						AI agents on this Mac, such as Claude Code or Codex, can read the plugin screens you allow below, through ToolBelt’s MCP server or the toolbelt command. They can’t change anything.
					</p>
					{state.error ? (
						<p className="text-sm text-destructive">{state.error}</p>
					) : (
						state.running && (
							<p className="text-xs text-muted-foreground">
								Only this Mac’s user can connect, at <span className="font-mono break-all">{state.socket}</span>
							</p>
						)
					)}
				</div>
				<Switch className="mt-1" checked={state.enabled} onCheckedChange={(enabled) => void run({ operation: "setEnabled", enabled })} aria-label="Let agents use ToolBelt" />
			</div>
			<div className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-4">
				<StatTile label="Active sessions" value={String(state.sessions.length)} hint={state.sessions.length ? [...new Set(state.sessions.map((s) => s.client))].join(", ") : state.running ? "No agent connected" : "Agents are off"} onClick={() => go("activity")} />
				<StatTile label="Readable plugins" value={`${readable} of ${state.plugins.length}`} hint={readableHint(state.plugins)} />
				<StatTile
					label="Requests today"
					value={today ? `${today.total}${today.more ? "+" : ""}` : "–"}
					hint={today ? (today.refused || today.failed ? [today.refused && `${today.refused} refused`, today.failed && `${today.failed} failed`].filter(Boolean).join(" · ") : "None refused or failed") : "Counting…"}
					tone={today && (today.failed ? "danger" : today.refused ? "warning" : undefined)}
					onClick={() => go("activity")}
				/>
				<StatTile label="Last activity" value={last ? ago(last.at) : "Never"} hint={last ? `${OPERATION_LABELS[last.operation] ?? last.operation} · ${last.client}` : "No agent has used ToolBelt"} onClick={() => go("activity")} />
			</div>
		</section>
	);
}

function StatTile({ label, value, hint, tone, onClick }: { label: string; value: string; hint: string; tone?: "warning" | "danger" | null; onClick?: () => void }) {
	const body = (
		<>
			<span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
				{label}
				{onClick && <ChevronRight className="size-3.5 opacity-0 transition-opacity duration-200 group-hover:opacity-60" aria-hidden />}
			</span>
			<span className="mt-1 block text-xl font-semibold tracking-tight tabular-nums">{value}</span>
			<span className={cn("mt-0.5 block truncate text-xs text-muted-foreground", tone && textClass(tone))} title={hint}>
				{hint}
			</span>
		</>
	);
	const className = "group min-w-0 bg-card px-5 py-4 text-left";
	return onClick ? (
		<button type="button" onClick={onClick} className={cn(className, "transition-colors duration-200 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset")}>
			{body}
		</button>
	) : (
		<div className={className}>{body}</div>
	);
}

/** A terminal command to paste, in tabs (add / remove), with a copy button. */
function CommandBox({ title, tabs, initial }: { title: string; tabs: CommandTab[]; initial: string }) {
	const [tab, setTab] = useState(tabs.some((t) => t.id === initial) ? initial : tabs[0].id);
	const [copied, setCopied] = useState(false);
	const current = tabs.find((t) => t.id === tab) ?? tabs[0];
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(current.text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error("Couldn’t copy");
		}
	};
	return (
		<div className="space-y-2.5 px-5 py-4">
			<h3 className="text-sm font-medium">{title}</h3>
			<Tabs value={tab} onValueChange={(v) => (setTab(v), setCopied(false))} className="gap-0 overflow-hidden rounded-lg border">
				<div className="flex items-center justify-between gap-2 border-b bg-muted/40 py-1 pr-1.5 pl-1">
					<TabsList variant="line" className="h-7" aria-label={`${title} commands`}>
						{tabs.map((t) => (
							<TabsTrigger key={t.id} value={t.id} className="px-2.5 text-xs">
								{t.label}
							</TabsTrigger>
						))}
					</TabsList>
					<Button variant="ghost" size="xs" onClick={() => void copy()} aria-label={`Copy the ${current.label.toLowerCase()} command for ${title}`}>
						{copied ? <Check className={textClass("success")} /> : <Copy />}
						{copied ? "Copied" : "Copy"}
					</Button>
				</div>
				{tabs.map((t) => (
					<TabsContent key={t.id} value={t.id} className="bg-background">
						<pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all select-text">
							{!t.text.includes("\n") && <span aria-hidden className="mr-2 text-muted-foreground select-none">$</span>}
							{t.text}
						</pre>
					</TabsContent>
				))}
			</Tabs>
			<p className="text-xs text-muted-foreground">{current.note}</p>
		</div>
	);
}

function ConnectGroup({ command, enabled, warning }: { command: string[]; enabled: boolean; warning: string | null }) {
	return (
		<SettingsGroup
			title={enabled ? "Setup commands" : "Remove ToolBelt from agents"}
			description={
				enabled
					? "Add ToolBelt to an agent by pasting its command into a terminal. Each has a Remove tab to undo it. ToolBelt doesn’t change your shell or your agents’ settings itself."
					: "Agents are off, so the ones you connected can’t reach ToolBelt. To remove ToolBelt from them, paste a command into a terminal."
			}
		>
			{warning && (
				<p role="note" className="mx-5 mt-4 flex gap-2 rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
					<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span>{warning}</span>
				</p>
			)}
			{connectCommands(command).map((c) => (
				// Remounts when the switch changes, so each box opens on the tab that fits.
				<CommandBox key={`${c.title}-${enabled}`} title={c.title} tabs={c.tabs} initial={enabled ? "add" : "remove"} />
			))}
		</SettingsGroup>
	);
}

/** What the plugin itself says about agents. */
const PLUGIN_TEXT = (p: AgentPlugin) =>
	!p.declared ? "Not declared" : p.ceiling === "none" ? "Kept from agents by the plugin" : `Allows ${ACCESS_LABEL[p.ceiling].toLowerCase()}`;

function PluginAccessGroup({ plugins }: { plugins: AgentPlugin[] }) {
	const changed = plugins.filter((p) => p.choice !== undefined && p.effective !== p.byDefault).length;
	const undeclared = plugins.filter((p) => !p.declared).length;
	return (
		<SettingsGroup
			title="Plugin access"
			description={`What agents may do with each plugin. A plugin says how far it allows agents to go, and you can lower that. Plugins made before agent access existed don’t say, so agents can’t read them unless you allow it.${changed ? ` You’ve changed ${changed}.` : ""}`}
		>
			{plugins.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No plugins are installed.</p>}
			{plugins.length > 0 && (
				<div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,16rem)_9rem] gap-4 px-5 py-2 text-xs font-medium text-muted-foreground sm:grid">
					<span>Plugin</span>
					<span>The plugin says</span>
					<span>Agents may</span>
				</div>
			)}
			{plugins.map((p) => {
				const allowedByYou = !p.declared && p.effective !== "none";
				return (
					<div key={p.id} className="px-5 py-3">
						<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_9rem]">
							<div className="flex min-w-0 items-center gap-3">
								<div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
									<Icon name={p.icon} className="size-4" />
								</div>
								<div className="min-w-0">
									<h3 className="truncate text-sm font-medium">{p.name}</h3>
									<p className={cn("truncate text-xs sm:hidden", p.declared ? "text-muted-foreground" : textClass("warning"))}>{PLUGIN_TEXT(p)}{!p.declared && " · made before agent access existed"}</p>
								</div>
							</div>
							<div className="hidden min-w-0 sm:block">
								<span className={cn("block truncate text-sm", p.declared ? "text-muted-foreground" : textClass("warning"))} title={PLUGIN_TEXT(p)}>
									{PLUGIN_TEXT(p)}
								</span>
								{!p.declared && <span className="block truncate text-xs text-muted-foreground">{p.update ? `Version ${p.update} is available and may declare it` : "Made before agent access existed"}</span>}
							</div>
							{p.ceiling === "none" ? (
								<span className={cn("justify-self-start rounded-full px-2 py-0.5 text-xs font-medium", pillClass("default"))}>No access</span>
							) : (
								<Select value={p.effective} onValueChange={(access) => void run({ operation: "setAccess", plugin: p.id, access: access === p.byDefault ? null : (access as AgentAccess) })}>
									<SelectTrigger size="sm" aria-label={`Agent access for ${p.name}`} className={cn("w-36", p.effective === "none" && "text-muted-foreground")}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent position="popper" align="end">
										<SelectItem value="read">{ACCESS_LABEL.read}</SelectItem>
										<SelectItem value="none">{ACCESS_LABEL.none}</SelectItem>
									</SelectContent>
								</Select>
							)}
						</div>
						{allowedByYou && (
							<p className={cn("mt-2 rounded-md px-3 py-2 text-xs sm:ml-11", pillClass("warning"))}>
								You let agents read {p.name}. It never said what’s safe to share, so anything it shows in plain text, such as command lines, paths or tokens, reaches agents. Only fields it marks as secret are hidden.
							</p>
						)}
						{!p.declared && p.update && <p className="mt-1 truncate text-xs text-muted-foreground sm:hidden">Version {p.update} is available and may declare it</p>}
					</div>
				);
			})}
			{undeclared > 0 && <p className="px-5 py-3 text-xs text-muted-foreground">{undeclared === 1 ? "1 plugin doesn’t" : `${undeclared} plugins don’t`} declare agent access yet. Updating may add it: its author decides what’s safe for agents.</p>}
		</SettingsGroup>
	);
}

function SessionsGroup({ state }: { state: AgentsState }) {
	return (
		<SettingsGroup title="Active sessions" description="Agents connected to ToolBelt right now. Each MCP server an agent starts is one session, as is each toolbelt command while it runs.">
			{state.sessions.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{state.running ? "No agent is connected right now." : "None: agents are off (see Access)."}</p>}
			{state.sessions.map((s) => (
				<div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
					<div className="flex min-w-0 items-center gap-3">
						<span className="tb-pulse size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
						<span className="truncate text-sm font-medium">{s.client}</span>
						{s.mode === "autonomous" && <span className={cn("shrink-0 rounded px-1.5 text-[11px] leading-4", pillClass("info"))}>Autonomous</span>}
					</div>
					<span className="text-xs text-muted-foreground tabular-nums">Connected {ago(s.since)}</span>
				</div>
			))}
		</SettingsGroup>
	);
}
