// The agent scenario format (docs/agent-interface.md → Testing). A scenario is a life-like prompt, the
// tool calls an agent makes to answer it, and what those calls must and must not return. It is
// transport-neutral: each channel adapter (adapters.ts) runs the same steps over its transport.
// The `rubric` is for model-based evaluation (plans/agent-interface.md); scripted tests ignore it.

export type Channel = "mcp" | "cli";
export const CHANNELS: Channel[] = ["mcp", "cli"];

export type Tool = "toolbelt_status" | "list_screens" | "read_screen" | "search_screens" | "list_plugins";
export const TOOLS: Tool[] = ["toolbelt_status", "list_screens", "read_screen", "search_screens", "list_plugins"];

export type Access = "none" | "read" | "act";

/** Something the person does in ToolBelt while the agent works. Screens are "plugin/screen". */
export type PersonAction =
	/** Opens a screen in the window (the person becomes a viewer of it). */
	| { open: string }
	| { close: string }
	/** A UI event on a screen: `search`, `filter`, an action id… as the renderer sends it. */
	| { event: { screen: string; name: string; payload?: unknown } }
	/** Settings → Agents: a plugin's access (null: back to the plugin's own level). */
	| { access: { plugin: string; level: Access | null } }
	/** Settings → Agents: the master switch. */
	| { agents: boolean };

export type Notification = {
	method: "notifications/resources/updated" | "notifications/resources/list_changed";
	/** For `updated`: the screen, "plugin/screen". */
	screen?: string;
	withinMs: number;
};

export type Expect = {
	/** Facts: each string appears in the step's output. */
	contains?: string[];
	/** Each string appears nowhere in the step's output. */
	absent?: string[];
	/** The call was refused (an MCP `isError` result, CLI exit code 2). Default: it succeeds. */
	refused?: boolean;
	/** ToolBelt couldn't be reached (agents off: the MCP server won't start, CLI exit code 1). */
	unreachable?: boolean;
	/** Notifications that arrive after this step, on channels that deliver them (MCP). */
	notifications?: Notification[];
};

export type Step =
	| { call: Tool; args?: Record<string, unknown>; /** The structured result (MCP structuredContent, CLI --json) instead of text. */ structured?: boolean; expect?: Expect }
	/** Resource steps: channels with resources only (MCP). */
	| { read: string; expect?: Expect }
	| { subscribe: string; expect?: Expect }
	| { unsubscribe: string; expect?: Expect }
	| { person: PersonAction; expect?: Expect };

export type AuditExpect = { operation: string; outcome: "ok" | "denied" | "error"; plugin?: string; mode?: "interactive" | "autonomous" };

export type Scenario = {
	id: string;
	title: string;
	/** What the person (or routine) asked the agent. */
	prompt: string;
	persona: string;
	channels: Channel[];
	mode?: "interactive" | "autonomous";
	setup?: {
		/** Settings → Agents switch at the start (default on). */
		agents?: boolean;
		/** The person's per-plugin choices at the start. */
		access?: Record<string, Access>;
		/** What the person does before the agent starts. */
		person?: PersonAction[];
	};
	steps: Step[];
	/** Checks over the whole run: every output together, and the audit log. */
	expect?: { contains?: string[]; absent?: string[]; audit?: AuditExpect[] };
	/** What a good final answer does: for a model judge (layer 4), not for scripted tests. */
	rubric?: string[];
	/** Where the scenario came from, e.g. the first hand-run evaluation. */
	origin?: { run: string; case: string; plugins: string[]; channel: string; calls: string[]; verdict: string; notes?: string };
};

/** Steps only channels with resources and notifications can run. */
export const needsResources = (step: Step) => "read" in step || "subscribe" in step || "unsubscribe" in step;

const SCREEN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Checks a parsed scenario; throws with the scenario id and what's wrong. */
export function validateScenario(value: unknown): Scenario {
	const s = value as Scenario;
	const fail = (what: string): never => {
		throw new Error(`scenario ${s?.id ?? "?"}: ${what}`);
	};
	if (!s || typeof s !== "object") fail("not an object");
	for (const key of ["id", "title", "prompt", "persona"] as const) if (typeof s[key] !== "string" || !s[key]) fail(`${key} is required`);
	if (!Array.isArray(s.channels) || !s.channels.length || s.channels.some((c) => !CHANNELS.includes(c))) fail(`channels must be some of ${CHANNELS.join(", ")}`);
	if (s.mode !== undefined && s.mode !== "interactive" && s.mode !== "autonomous") fail("mode");
	if (!Array.isArray(s.steps) || !s.steps.length) fail("steps are required");
	const screen = (v: unknown, where: string) => (typeof v === "string" && SCREEN.test(v)) || fail(`${where}: "plugin/screen" expected`);
	const person = (p: PersonAction, where: string) => {
		const keys = Object.keys(p ?? {});
		if (keys.length !== 1) fail(`${where}: one person action per step`);
		if ("open" in p) screen(p.open, where);
		else if ("close" in p) screen(p.close, where);
		else if ("event" in p) (screen(p.event?.screen, where), typeof p.event.name === "string" || fail(`${where}: event name`));
		else if ("access" in p) (typeof p.access?.plugin === "string" && (p.access.level === null || ["none", "read", "act"].includes(p.access.level))) || fail(`${where}: access`);
		else if ("agents" in p) typeof p.agents === "boolean" || fail(`${where}: agents`);
		else fail(`${where}: unknown person action ${keys[0]}`);
	};
	for (const p of s.setup?.person ?? []) person(p, "setup");
	s.steps.forEach((step, i) => {
		const where = `step ${i + 1}`;
		if ("call" in step) {
			if (!TOOLS.includes(step.call)) fail(`${where}: unknown tool ${step.call}`);
		} else if ("read" in step) screen(step.read, where);
		else if ("subscribe" in step) screen(step.subscribe, where);
		else if ("unsubscribe" in step) screen(step.unsubscribe, where);
		else if ("person" in step) person(step.person, where);
		else fail(`${where}: unknown step`);
		if (needsResources(step) && s.channels.includes("cli")) fail(`${where}: resource steps need channels ["mcp"]`);
		const e = step.expect;
		if (e?.refused && e.unreachable) fail(`${where}: refused and unreachable`);
		for (const n of e?.notifications ?? []) {
			if (n.method === "notifications/resources/updated") screen(n.screen, where);
			if (!(n.withinMs > 0)) fail(`${where}: withinMs`);
		}
	});
	return s;
}
