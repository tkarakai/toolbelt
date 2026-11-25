// Settings → Agents (docs/agent-interface.md), in sub-tabs: General (the switch and connected
// agents), Connect (commands to add or remove ToolBelt), Plugins (access) and Activity.
import { useState } from "react";
import { toast } from "sonner";
import { Activity, Check, Copy, Plug, Power, Puzzle } from "lucide-react";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { SettingsGroup, SettingsRow } from "./components/settings-layout";
import { Icon } from "./lib/icon";
import { textClass } from "./renderer/colors";
import { agentsRequest, useAgents } from "./lib/store";
import { usePersisted } from "./lib/uistate";
import { connectCommands, type CommandTab } from "./lib/agent-commands";
import { AgentActivity } from "./AgentActivity";
import type { AgentAccess, AgentPlugin, AgentsState } from "../shared/agents";

const ACCESS_LABEL: Record<AgentAccess, string> = { none: "No access", read: "Read only", act: "Read and act" };

const TABS = [
	{ id: "general", label: "General", icon: Power },
	{ id: "connect", label: "Connect", icon: Plug },
	{ id: "plugins", label: "Plugins", icon: Puzzle },
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
	const [remembered, remember] = usePersisted<string>("toolbelt.agents-tab", "general");
	const tab = TABS.some((t) => t.id === remembered) ? remembered : "general";
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
						{t.id === "general" && state.sessions.length > 0 && (
							<span className="ml-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[11px] leading-4 text-emerald-800 tabular-nums dark:text-emerald-300" aria-label={`${state.sessions.length} connected`}>
								{state.sessions.length}
							</span>
						)}
					</TabsTrigger>
				))}
			</TabsList>
			</div>
			<TabsContent value="general" className="space-y-8">
				<AccessGroup state={state} />
				<SessionsGroup state={state} />
			</TabsContent>
			<TabsContent value="connect" className="space-y-8">
				{state.command ? (
					<ConnectGroup command={state.command} enabled={state.enabled} />
				) : (
					<SettingsGroup title="Connect an agent">
						<p className="px-5 py-4 text-sm text-muted-foreground">This build of ToolBelt doesn’t include the toolbelt command, so there’s nothing to connect agents with.</p>
					</SettingsGroup>
				)}
			</TabsContent>
			<TabsContent value="plugins" className="space-y-8">
				<PluginsGroup plugins={state.plugins} />
			</TabsContent>
			<TabsContent value="activity" className="space-y-8">
				<AgentActivity plugins={state.plugins} newest={state.audit[0]?.id} />
			</TabsContent>
		</Tabs>
	);
}

function AccessGroup({ state }: { state: AgentsState }) {
	return (
		<SettingsGroup
			title="Agents"
			description="Let AI agents such as Claude Code or Codex read your plugins’ screens, so you can ask them about your tasks, updates and more. Agents on this Mac connect through ToolBelt’s MCP server or the toolbelt command. They can read only what you allow under Plugins, and can’t change anything yet."
		>
			<SettingsRow
				title="Let agents use ToolBelt"
				description={
					state.error ? (
						<span className="text-destructive">{state.error}</span>
					) : state.running ? (
						<>Listening for agents on this Mac only, at <span className="break-all font-mono">{state.socket}</span>.</>
					) : (
						"Off: no agent can connect."
					)
				}
			>
				<Switch checked={state.enabled} onCheckedChange={(enabled) => void run({ operation: "setEnabled", enabled })} aria-label="Let agents use ToolBelt" />
			</SettingsRow>
		</SettingsGroup>
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

function ConnectGroup({ command, enabled }: { command: string[]; enabled: boolean }) {
	return (
		<SettingsGroup
			title={enabled ? "Connect an agent" : "Remove ToolBelt from agents"}
			description={
				enabled
					? "Paste a command into a terminal. Each has a Remove tab to undo it. ToolBelt doesn’t change your shell or your agents’ settings itself."
					: "Agents are off, so the ones you connected can’t reach ToolBelt. To remove ToolBelt from them, paste a command into a terminal."
			}
		>
			{connectCommands(command).map((c) => (
				// Remounts when the switch changes, so each box opens on the tab that fits.
				<CommandBox key={`${c.title}-${enabled}`} title={c.title} tabs={c.tabs} initial={enabled ? "add" : "remove"} />
			))}
		</SettingsGroup>
	);
}

function PluginsGroup({ plugins }: { plugins: AgentPlugin[] }) {
	return (
		<SettingsGroup title="Plugins" description="What agents may do with each plugin. A plugin sets the most it allows; you can lower it. Plugins that don’t say are read only.">
			{plugins.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No plugins are installed.</p>}
			{plugins.map((p) => (
				<div key={p.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-3">
					<div className="flex min-w-0 flex-1 items-center gap-3">
						<div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
							<Icon name={p.icon} className="size-4" />
						</div>
						<div className="min-w-0">
							<h3 className="truncate text-sm font-medium">{p.name}</h3>
							<p className="text-sm text-muted-foreground">
								{p.ceiling === "none" ? "This plugin keeps its screens from agents." : p.declared ? `The plugin allows: ${ACCESS_LABEL[p.ceiling].toLowerCase()}.` : "The plugin doesn’t say, so agents can read it at most."}
							</p>
						</div>
					</div>
					{p.ceiling !== "none" && (
						<Select value={p.effective} onValueChange={(access) => void run({ operation: "setAccess", plugin: p.id, access: access as AgentAccess })}>
							<SelectTrigger size="sm" aria-label={`Agent access for ${p.name}`} className="w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper" align="end">
								<SelectItem value="none">{ACCESS_LABEL.none}</SelectItem>
								<SelectItem value="read">{ACCESS_LABEL.read}</SelectItem>
							</SelectContent>
						</Select>
					)}
				</div>
			))}
		</SettingsGroup>
	);
}

function SessionsGroup({ state }: { state: AgentsState }) {
	return (
		<SettingsGroup title="Connected agents" description="Agents with a connection open right now. Each MCP server an agent starts, and each toolbelt command while it runs, is one connection.">
			{state.sessions.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{state.running ? "No agent is connected." : "None: agents are off."}</p>}
			{state.sessions.map((s) => (
				<SettingsRow key={s.id} title={s.client} description={`${s.mode === "autonomous" ? "Autonomous" : "Interactive"} · connected since ${new Date(s.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`} />
			))}
		</SettingsGroup>
	);
}
