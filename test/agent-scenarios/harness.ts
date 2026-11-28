// Runs agent scenarios (format.ts) against a real ToolBelt agent interface: the plugin host with
// the fixture plugins in test/fixtures/agents, the agent core and socket server, and a channel
// adapter (adapters.ts) per run. Each run gets its own isolated world.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../../src/bun/host";
import { ChangeJournal } from "../../src/bun/journal";
import { ViewStore } from "../../src/bun/views";
import { PERSON } from "../../src/shared/protocol";
import { cleanView } from "../../src/shared/views";
import { createAgentInterface } from "../../src/bun/agent";
import { declaredAccess, type AgentSettings } from "../../src/shared/agents";
import { HOUR, NOW } from "../fixtures/agents/clock";
import { adapter, uriOf, type ChannelAdapter, type Outcome } from "./adapters";
import { needsResources, validateScenario, type Approve, type Channel, type Expect, type PersonAction, type Scenario, type Step } from "./format";

export const FIXTURES = join(import.meta.dir, "../fixtures/agents");
/** Plugins agents may act on: worlds with `setup.acting` add them. */
export const ACT_FIXTURES = join(import.meta.dir, "../fixtures/agents-act");
export const SCENARIOS = join(import.meta.dir, "scenarios");

export function loadScenarios(dir = SCENARIOS): Scenario[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => validateScenario(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

/** Resolves when `check` passes, polling. */
export async function until<T>(check: () => T | undefined | null | false, ms = 5000, what = "condition"): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = check();
		if (v) return v;
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const split = (screen: string) => {
	const [plugin, id] = screen.split("/");
	return { plugin, surface: `screen:${id}` };
};

/**
 * Where a world's plugins come from and what time it is. The scenarios use the defaults; the model
 * evaluation in evals/agent-models runs real plugin releases with seeded data on the real clock.
 */
export type WorldOptions = {
	/** Plugin folders, or folders of them (default: the fixtures). */
	dirs?: string[];
	/** The agent core's clock (default: the fixtures' NOW). */
	now?: () => number;
	/** The host version plugins see (default 0.3.24). */
	hostVersion?: string;
	/** Writes plugin data into `<data>/<plugin id>/` before the plugins start. */
	prepare?: (data: string) => void | Promise<void>;
};

/** ToolBelt with the fixture plugins and the agent interface, in temporary folders. */
export async function createWorld(setup: Scenario["setup"] = {}, options: WorldOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tb-sc-"));
	await options.prepare?.(join(dir, "data"));
	const views = new ViewStore(join(dir, "views.json"), 0);
	// Every change made through a plugin's screens, by people and agents alike.
	const journal = new ChangeJournal(join(dir, "journal/changes.jsonl"), { syncMs: 10 });
	const host = new PluginHost({ dirs: options.dirs ?? (setup.acting ? [FIXTURES, ACT_FIXTURES] : [FIXTURES]), bun: process.execPath, host: { name: "ToolBelt", version: options.hostVersion ?? "0.3.24" }, data: join(dir, "data"), views, journal });
	// The person's screens, as show_screen sees them: the Mac's window and paired devices.
	const devices = { window: setup.devices?.window ?? true, paired: setup.devices?.paired ?? [] };
	const navigated: string[] = [];
	const trees: { plugin: string; surface: string; at: number }[] = [];
	/** Events the plugins answered. */
	const settled = new Set<string>();
	host.subscribe({ plugins: () => {}, tree: (plugin, surface) => void trees.push({ plugin, surface, at: Date.now() }), toast: () => {}, settled: (e) => void settled.add(e.id) });
	host.start();
	await until(() => host.list().every((p) => p.state === "running"), 10_000, "fixture plugins to start");
	let settings: AgentSettings = { enabled: setup.agents ?? true, access: { ...(setup.access ?? {}) }, grants: [], writeGrants: [] };
	const agents = createAgentInterface({
		host,
		settings: () => settings,
		save: (next) => (settings = next),
		app: () => ({ name: "ToolBelt", version: "0.3.24", channel: "stable", developmentProfile: null }),
		appUpdate: () => ({ available: "0.4.0", lastChecked: NOW - HOUR }),
		installed: () =>
			host.list().map((p) => ({
				id: p.manifest.id,
				name: p.manifest.name,
				version: p.manifest.version,
				repo: p.manifest.repo,
				enabled: true,
				phase: "enabled",
				availableVersion: p.manifest.id === "kit" ? "0.5.0" : undefined,
				declared: declaredAccess(p.manifest),
			})),
		configRoot: dir,
		profileRoot: dir,
		bun: process.execPath,
		changed: () => {},
		now: options.now ?? (() => NOW),
		holdMs: 5000,
		approvalMs: 3000,
		settleRenderMs: 300,
		person: {
			devices: () => [{ name: "the Mac", kind: "mac" as const, showing: devices.window }, ...devices.paired.map((d) => ({ name: d.name, kind: "device" as const, showing: d.connected }))],
			openWindow: () => void (devices.window = true),
			navigate: (plugin, screen) => void navigated.push(`${plugin}/${screen}`),
			view: (plugin, surface) => host.personView(plugin, surface),
			setView: (plugin, surface, view) => {
				const clean = cleanView(host.declaredView(plugin, surface) ?? undefined, view);
				if ((host.snapshot(plugin, surface, PERSON)?.viewers ?? 0) > 0) host.setView(plugin, surface, PERSON, clean);
				else views.save(plugin, surface, clean);
			},
		},
	});
	await agents.start();
	// What reaches the person, routed as the app routes it (src/bun/index.ts): toasts, the Mac's
	// clipboard and plugins' navigation.
	const personToasts: { text: string; source?: string }[] = [];
	const clipboard: string[] = [];
	host.subscribe({
		plugins: () => {},
		tree: () => {},
		toast: (_plugin, text, _tone, _action, event) => {
			const route = agents.routing.toast(event);
			if (route.show) personToasts.push({ text, ...(route.source ? { source: route.source } : {}) });
		},
		clipboard: (_plugin, text, event) => void (agents.routing.clipboard(event) && clipboard.push(text)),
		navigate: (plugin, screen, _select, event) => void (agents.routing.navigate(event) && navigated.push(`${plugin}/${screen}`)),
	});
	const socket = agents.server.path;
	let stateOpen = false;
	const world = {
		dir,
		host,
		agents,
		socket,
		settings: () => settings,
		navigated,
		/** Answers show_screen's question once it's asked (or gives up after a few seconds). */
		async answer(answer: { allow: boolean; duration?: string }) {
			const asked = await until(() => agents.core.state().approvals[0], 4000, "the person to be asked").catch(() => null);
			if (asked) agents.handle({ operation: "answer", id: asked.id, allow: answer.allow, duration: answer.duration as never });
		},
		personToasts,
		clipboard,
		journal: () => (journal.flush(), journal.read(1000).sort((a, b) => a.seq - b.seq)),
		/**
		 * Answers a run_action or fill_form approval once it's asked (or gives up after a few seconds),
		 * after doing `meanwhile`. `cancel` is the adapter's: the agent withdraws the call.
		 */
		async approve(approve: Approve, meanwhile: PersonAction | undefined, cancel: () => void) {
			const asked = await until(() => agents.core.state().approvals.find((a) => a.change), 4000, "the person to be asked").catch(() => null);
			if (!asked) return;
			if (meanwhile) await world.person(meanwhile);
			if (approve === "cancel") return cancel();
			if (approve === "deny") agents.handle({ operation: "answer", id: asked.id, allow: false });
			else if (approve === "once") agents.handle({ operation: "answer", id: asked.id, allow: true, scope: "once" });
			else agents.handle({ operation: "answer", id: asked.id, allow: true, scope: "grant", duration: approve.grant });
		},
		/** The errands fixture's state, from its debug screen (an instance of the harness's own). */
		async state(): Promise<Record<string, unknown>> {
			if (!stateOpen) {
				host.open("errands", "screen:debug", "test:state", {});
				stateOpen = true;
			}
			const tree = await until(() => host.snapshot("errands", "screen:debug", "test:state")?.tree, 4000, "errands' debug screen");
			return JSON.parse(((tree as { children: { text: string }[] }).children[0]).text);
		},
		audit: () =>
			readFileSync(join(dir, "agent-audit.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l)),
		/** Does what the person does in ToolBelt, and waits until it took effect. */
		async person(action: PersonAction) {
			if ("open" in action) {
				const { plugin, surface } = split(action.open);
				host.open(plugin, surface);
				await until(() => host.snapshot(plugin, surface)?.tree, 4000, `${action.open} to render`);
			} else if ("close" in action) {
				const { plugin, surface } = split(action.close);
				host.close(plugin, surface);
			} else if ("event" in action) {
				const { plugin, surface } = split(action.event.screen);
				// The person acts on a screen they see: ToolBelt checks the event against it.
				const glance = !host.snapshot(plugin, surface)?.viewers;
				if (glance) {
					host.open(plugin, surface);
					await until(() => host.snapshot(plugin, surface)?.tree, 4000, `${action.event.screen} to render`);
				}
				const before = trees.length;
				const id = host.event(plugin, surface, action.event.name, action.event.payload);
				// Once the plugin answered, the screen renders again if the event changed it.
				await until(() => id !== null && settled.has(id), 4000, `${plugin} to answer ${action.event.name}`);
				await until(() => trees.slice(before).some((t) => t.plugin === plugin && t.surface === surface), 1000, "").catch(() => {});
				if (glance) host.close(plugin, surface);
			} else if ("access" in action) {
				agents.handle({ operation: "setAccess", plugin: action.access.plugin, access: action.access.level });
			} else if ("agents" in action) {
				agents.handle({ operation: "setEnabled", enabled: action.agents });
				await until(() => agents.server.listening === action.agents, 4000, `agents ${action.agents ? "on" : "off"}`);
			} else if ("restore" in action) {
				const { plugin, surface } = split(action.restore);
				agents.handle({ operation: "restoreView", plugin, surface });
				await Bun.sleep(100);
			} else if ("toast" in action) {
				const id = host.event(action.toast.plugin, "toast", action.toast.action, action.toast.payload);
				await until(() => id !== null && settled.has(id), 4000, `${action.toast.plugin} to answer its toast's ${action.toast.action}`);
			} else if ("revoke" in action) {
				// "*": every agent's grants, view and write.
				const state = agents.core.state();
				for (const client of action.revoke === "*" ? state.grants.map((g) => g.client) : [action.revoke]) agents.handle({ operation: "revokeGrant", client });
				for (const g of state.writeGrants) if (action.revoke === "*" || g.client === action.revoke) agents.handle({ operation: "revokeWriteGrant", client: g.client, plugin: g.plugin });
			}
		},
		async stop() {
			agents.stop();
			agents.core.stop();
			host.stop();
			journal.flush();
			await Bun.sleep(50);
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return world;
}
export type World = Awaited<ReturnType<typeof createWorld>>;

/** One step's record, for failure messages and reports. */
export type StepRecord = { step: Step; outcome: Outcome | null; notifications: { method: string; params: unknown }[]; failures: string[] };
export type RunRecord = { scenario: string; channel: Channel; steps: StepRecord[]; failures: string[] };

function check(expect: Expect | undefined, outcome: Outcome | null, failures: string[], where: string) {
	if (!outcome) return;
	const e = expect ?? {};
	const wantRefused = e.refused === true;
	const wantUnreachable = e.unreachable === true;
	if (outcome.unreachable !== wantUnreachable) failures.push(`${where}: expected ${wantUnreachable ? "ToolBelt to be unreachable" : "ToolBelt to be reachable"}`);
	else if (outcome.refused !== wantRefused) failures.push(`${where}: expected ${wantRefused ? "a refusal" : "success"}, got ${outcome.refused ? "a refusal" : "success"}: ${outcome.text.slice(0, 200)}`);
	for (const fact of e.contains ?? []) if (!outcome.text.includes(fact)) failures.push(`${where}: missing ${JSON.stringify(fact)}`);
	for (const secret of e.absent ?? []) if (outcome.text.includes(secret)) failures.push(`${where}: must not contain ${JSON.stringify(secret)}`);
}

const describeStep = (step: Step) =>
	"call" in step
		? `${step.call} ${JSON.stringify(step.args ?? {})}${step.structured ? " (structured)" : ""}`
		: "person" in step
			? `person ${JSON.stringify(step.person)}`
			: "read" in step
				? `resources/read ${step.read}`
				: "subscribe" in step
					? `resources/subscribe ${step.subscribe}`
					: `resources/unsubscribe ${step.unsubscribe}`;

/** Runs a scenario over one channel in a fresh world. */
export async function runScenario(s: Scenario, channel: Channel): Promise<RunRecord> {
	const world = await createWorld(s.setup);
	const agent: ChannelAdapter = adapter(channel, { socket: world.socket, autonomous: s.mode === "autonomous", client: `scenario ${s.id}` });
	/** Other agents a step names (`as`), each its own session. */
	const others = new Map<string, ChannelAdapter>();
	const agentFor = async (name?: string) => {
		if (name === undefined) return agent;
		let other = others.get(name);
		if (!other) {
			other = adapter(channel, { socket: world.socket, autonomous: s.mode === "autonomous", client: `scenario ${s.id} ${name}` });
			others.set(name, other);
			await other.start?.();
		}
		return other;
	};
	const record: RunRecord = { scenario: s.id, channel, steps: [], failures: [] };
	try {
		for (const p of s.setup?.person ?? []) await world.person(p);
		await agent.start?.();
		for (const [i, step] of s.steps.entries()) {
			const where = `${s.id} [${channel}] step ${i + 1} (${describeStep(step)})`;
			const failures: string[] = [];
			if (needsResources(step) && !agent.resources) throw new Error(`${where}: ${channel} has no resources`);
			const seen = agent.notifications?.().length ?? 0;
			const started = Date.now();
			let outcome: Outcome | null = null;
			const navigatedBefore = world.navigated.length;
			const toastsBefore = world.personToasts.length;
			const clipboardBefore = world.clipboard.length;
			if ("call" in step) {
				const answering = step.answer ? world.answer(step.answer) : null;
				let cancel = () => {};
				const cancelled = new Promise<void>((resolve) => (cancel = resolve));
				const approving = step.approve !== undefined ? world.approve(step.approve, step.meanwhile, cancel) : null;
				outcome = await (await agentFor(step.as)).call(step.call, step.args ?? {}, step.structured === true, cancelled);
				await answering;
				await approving;
			}
			else if ("read" in step) outcome = await agent.read!(uriOf(step.read));
			else if ("subscribe" in step) outcome = await agent.subscribe!(uriOf(step.subscribe));
			else if ("unsubscribe" in step) outcome = await agent.unsubscribe!(uriOf(step.unsubscribe));
			else await world.person(step.person);
			check(step.expect, outcome, failures, where);
			if (step.expect?.navigated && JSON.stringify(world.navigated.slice(navigatedBefore)) !== JSON.stringify(step.expect.navigated))
				failures.push(`${where}: expected the person's screens to show ${JSON.stringify(step.expect.navigated)}, got ${JSON.stringify(world.navigated.slice(navigatedBefore))}`);
			if (step.expect?.personView) {
				const { plugin, surface } = split(step.expect.personView.screen);
				const want = JSON.stringify(step.expect.personView.view);
				const got = await until(() => JSON.stringify(world.host.personView(plugin, surface)) === want && want, 2000, "").catch(() => JSON.stringify(world.host.personView(plugin, surface)));
				if (got !== want) failures.push(`${where}: expected the person's view of ${step.expect.personView.screen} to be ${want}, got ${got}`);
			}
			if (step.expect?.state) {
				const want = step.expect.state;
				const matches = (state: Record<string, unknown>) => Object.entries(want).every(([k, v]) => JSON.stringify(state[k]) === JSON.stringify(v));
				let last: Record<string, unknown> = {};
				const end = Date.now() + 2000;
				while (Date.now() < end) {
					last = await world.state();
					if (matches(last)) break;
					await Bun.sleep(20);
				}
				for (const [k, v] of Object.entries(want)) if (JSON.stringify(last[k]) !== JSON.stringify(v)) failures.push(`${where}: expected errands' ${k} to be ${JSON.stringify(v)}, got ${JSON.stringify(last[k])}`);
			}
			if (step.expect?.personToasts) {
				// Toasts arrive while the plugin handles the event: give a late one a moment.
				await Bun.sleep(50);
				const seen = world.personToasts.slice(toastsBefore).map((t) => ({ text: t.text, fromAgent: t.source !== undefined }));
				if (JSON.stringify(seen) !== JSON.stringify(step.expect.personToasts)) failures.push(`${where}: expected the person to see toasts ${JSON.stringify(step.expect.personToasts)}, got ${JSON.stringify(seen)}`);
			}
			if (step.expect?.clipboard) {
				const written = world.clipboard.slice(clipboardBefore);
				if (JSON.stringify(written) !== JSON.stringify(step.expect.clipboard)) failures.push(`${where}: expected the Mac's clipboard to get ${JSON.stringify(step.expect.clipboard)}, got ${JSON.stringify(written)}`);
			}
			const got: { method: string; params: unknown }[] = [];
			if (agent.resources && agent.notifications)
				for (const n of step.expect?.notifications ?? []) {
					const uri = n.screen ? uriOf(n.screen) : undefined;
					const hit = await until(
						() => agent.notifications!().slice(seen).find((r) => r.method === n.method && (!uri || r.params?.uri === uri)),
						n.withinMs + 200,
						"",
					).catch(() => null);
					if (!hit || hit.at - started > n.withinMs) failures.push(`${where}: no ${n.method}${uri ? ` for ${uri}` : ""} within ${n.withinMs} ms`);
					else got.push({ method: hit.method, params: hit.params });
				}
			record.steps.push({ step, outcome, notifications: got, failures });
			record.failures.push(...failures);
		}
		const all = record.steps.map((r) => [r.outcome?.text ?? "", ...r.notifications.map((n) => JSON.stringify(n))].join("\n")).join("\n");
		for (const fact of s.expect?.contains ?? []) if (!all.includes(fact)) record.failures.push(`${s.id} [${channel}]: no output contains ${JSON.stringify(fact)}`);
		for (const secret of s.expect?.absent ?? []) if (all.includes(secret)) record.failures.push(`${s.id} [${channel}]: an output contains ${JSON.stringify(secret)}`);
		if (s.expect?.audit?.length) {
			// Give the core a moment to append the last entry.
			await Bun.sleep(20);
			const audit = world.audit();
			let from = 0;
			for (const want of s.expect.audit) {
				const at = audit.findIndex((a, i) => i >= from && Object.entries(want).every(([k, v]) => a[k] === v));
				if (at < 0) record.failures.push(`${s.id} [${channel}]: no audit entry ${JSON.stringify(want)} in order`);
				else from = at + 1;
			}
		}
		if (s.expect?.journal) {
			// Entries are written once each event's result arrives.
			await Bun.sleep(50);
			const journal = world.journal();
			const fits = (e: (typeof journal)[number], want: NonNullable<NonNullable<Scenario["expect"]>["journal"]>[number]) =>
				e.name === want.name && e.actor.kind === want.actor && (want.approval === undefined || e.approval === want.approval) && (want.outcome === undefined || e.outcome === want.outcome);
			let from = 0;
			for (const want of s.expect.journal) {
				const at = journal.findIndex((e, i) => i >= from && fits(e, want));
				if (at < 0) record.failures.push(`${s.id} [${channel}]: no journal entry ${JSON.stringify(want)} in order (journal: ${JSON.stringify(journal.map((e) => ({ name: e.name, actor: e.actor.kind, approval: e.approval, outcome: e.outcome })))})`);
				else from = at + 1;
			}
			if (s.expect.journalExact && journal.length !== s.expect.journal.length)
				record.failures.push(`${s.id} [${channel}]: expected ${s.expect.journal.length} journal entries, got ${journal.length}: ${JSON.stringify(journal.map((e) => ({ name: e.name, actor: e.actor.kind, approval: e.approval })))}`);
			// The journal and the audit log name the same events.
			const audited = new Set(world.audit().flatMap((a) => (a.events as string[] | undefined) ?? []));
			for (const e of journal) if (e.actor.kind === "agent" && !audited.has(e.event)) record.failures.push(`${s.id} [${channel}]: journal entry ${e.name} (event ${e.event}) has no audit entry`);
		}
	} finally {
		await agent.close();
		for (const other of others.values()) await other.close();
		await world.stop();
	}
	return record;
}

/** A run as Markdown: the prompt, each step with what the agent got back, and any failures. */
export function formatRun(s: Scenario, run: RunRecord): string {
	const lines = [
		`# ${s.id} [${run.channel}]: ${s.title}`,
		"",
		`**Prompt:** ${s.prompt}  `,
		`**Persona:** ${s.persona}${s.mode === "autonomous" ? " (autonomous)" : ""}  `,
		`**Result:** ${run.failures.length ? `FAIL (${run.failures.length})` : "pass"}`,
		...run.failures.map((f) => `- ${f}`),
	];
	if (s.setup?.person?.length) lines.push("", `Setup, as the person: ${s.setup.person.map((p) => JSON.stringify(p)).join(", ")}`);
	run.steps.forEach((r, i) => {
		lines.push("", `## Step ${i + 1}: ${describeStep(r.step)}`);
		if (r.outcome) {
			const state = r.outcome.unreachable ? "unreachable" : r.outcome.refused ? "refused" : "ok";
			lines.push(`(${state})`, "", "```", r.outcome.text || "(no output)", "```");
		}
		for (const n of r.notifications) lines.push(`Notification: ${JSON.stringify(n)}`);
		for (const f of r.failures) lines.push(`**Failed:** ${f}`);
	});
	if (s.rubric?.length) lines.push("", "## Rubric (for a model judge)", ...s.rubric.map((r) => `- ${r}`));
	return lines.join("\n") + "\n";
}
