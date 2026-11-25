// Settings → Agents (docs/agent-interface.md): whether AI agents may use ToolBelt, how to connect one,
// what each plugin lets them read, who is connected and everything they did.
import { useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { SettingsGroup, SettingsRow } from "./components/settings-layout";
import { Icon } from "./lib/icon";
import { cn } from "./lib/utils";
import { pillClass } from "./renderer/colors";
import { agentAudit, agentsRequest, useAgents } from "./lib/store";
import type { AgentAccess, AgentPlugin, AgentsState, AuditEntry } from "../shared/agents";

const ACCESS_LABEL: Record<AgentAccess, string> = { none: "No access", read: "Read only", act: "Read and act" };
const OPERATION_LABEL: Record<string, string> = {
	toolbelt_status: "Read status",
	list_screens: "Listed screens",
	read_screen: "Read a screen",
	search_screens: "Searched screens",
	list_plugins: "Listed plugins",
};

/** Shell-quoted, for pasting into a terminal. */
const shell = (argv: string[]) => argv.map((a) => (/^[\w./=:@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

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
	if (!state) return <p className="px-1 text-sm text-muted-foreground">Reading agent settings…</p>;
	return (
		<div className="space-y-8">
			<AccessGroup state={state} />
			{state.enabled && state.command && <ConnectGroup command={state.command} />}
			<PluginsGroup plugins={state.plugins} />
			{state.sessions.length > 0 && <SessionsGroup state={state} />}
			<ActivityGroup entries={state.audit} />
		</div>
	);
}

function AccessGroup({ state }: { state: AgentsState }) {
	return (
		<SettingsGroup
			title="Agents"
			description="Let AI agents such as Claude Code or Codex read your plugins’ screens, so you can ask them about your tasks, updates and more. Agents on this Mac connect through ToolBelt’s MCP server or the toolbelt command. They can read only what you allow below, and can’t change anything yet."
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

function CommandRow({ title, description, text }: { title: string; description: string; text: string }) {
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			toast.success("Copied");
		} catch {
			toast.error("Couldn’t copy");
		}
	};
	return (
		<div className="space-y-2 px-5 py-4">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h3 className="text-sm font-medium">{title}</h3>
					<p className="mt-1 text-sm text-muted-foreground">{description}</p>
				</div>
				<Button variant="ghost" size="icon-sm" onClick={copy} aria-label={`Copy: ${title}`} title="Copy">
					<Copy />
				</Button>
			</div>
			<pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
		</div>
	);
}

function ConnectGroup({ command }: { command: string[] }) {
	const cli = shell(command);
	return (
		<SettingsGroup title="Connect an agent" description="Run these in a terminal. ToolBelt doesn’t change your shell or your agents’ settings itself.">
			<CommandRow title="Claude Code" description="Adds ToolBelt as an MCP server for your user." text={`claude mcp add --scope user toolbelt -- ${shell([...command, "mcp"])}`} />
			<CommandRow title="Other MCP clients" description="The command to start ToolBelt’s MCP server on stdio." text={shell([...command, "mcp"])} />
			<CommandRow title="The toolbelt command" description="An alias for your shell profile; then try toolbelt status." text={`alias toolbelt=${shell([cli])}`} />
			<CommandRow title="Skill file" description="Teaches coding agents to use the toolbelt command." text={`mkdir -p ~/.claude/skills/toolbelt && ${cli} skill > ~/.claude/skills/toolbelt/SKILL.md`} />
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
		<SettingsGroup title="Connected">
			{state.sessions.map((s) => (
				<SettingsRow key={s.id} title={s.client} description={`${s.mode === "autonomous" ? "Autonomous" : "Interactive"} · since ${new Date(s.since).toLocaleTimeString()}`} />
			))}
		</SettingsGroup>
	);
}

function ActivityGroup({ entries }: { entries: AuditEntry[] }) {
	const [older, setOlder] = useState<AuditEntry[]>([]);
	const [end, setEnd] = useState(false);
	const all = [...entries, ...older.filter((o) => !entries.some((e) => e.at === o.at && e.session === o.session && e.operation === o.operation))];
	const more = async () => {
		const last = all.at(-1);
		if (!last) return;
		const next = await agentAudit(last.at);
		if (next.length < 50) setEnd(true);
		setOlder((o) => [...o, ...next]);
	};
	return (
		<SettingsGroup title="Activity" description="Everything agents asked ToolBelt for, newest first. Kept for good in agent-audit.jsonl in ToolBelt’s folder.">
			{all.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No agent has used ToolBelt yet.</p>}
			{all.map((e, i) => (
				<div key={`${e.at}-${e.session}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
					<div className="min-w-0 flex-1">
						<span className="font-medium">{OPERATION_LABEL[e.operation] ?? e.operation}</span>
						{e.plugin && <span className="text-muted-foreground"> · {e.plugin}{e.screen ? ` › ${e.screen}` : ""}</span>}
						<span className="text-muted-foreground"> · {e.client}{e.mode === "autonomous" ? " (autonomous)" : ""}</span>
						{e.detail && <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p>}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{e.outcome !== "ok" && <span className={cn("rounded-full px-2 py-0.5 text-xs", pillClass(e.outcome === "denied" ? "warning" : "danger"))}>{e.outcome === "denied" ? "Refused" : "Failed"}</span>}
						<time className="text-xs text-muted-foreground tabular-nums" dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time>
					</div>
				</div>
			))}
			{all.length >= 50 && !end && (
				<div className="px-5 py-3">
					<Button variant="ghost" size="sm" onClick={() => void more()}>Show older</Button>
				</div>
			)}
		</SettingsGroup>
	);
}
