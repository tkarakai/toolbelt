// A fake host for plugin tests (`@toolbelt/sdk/testing`): the production SDK over an in-memory
// transport, with the host's checks. Every plugin message is validated as the host validates it,
// and a render that uses an action or form id the plugin didn't declare is recorded in `rejected`,
// as the host would reject it.
//
//   const host = fakeHost(plugin);
//   await host.hello();
//   await host.open("screen:main");
//   const r = await host.event("screen:main", "done", { rowId: "1" });
//   expect(r).toMatchObject({ handled: true });
//   expect(r.toasts[0].text).toBe("Done");
import { definePlugin, type PluginDefinition } from "./index";
import { PERSON, PROTOCOL_VERSION, type Declarations, type HostMessage, type Node, type Origin, type PluginMessage, type ViewState } from "../shared/protocol";
import { CAPABILITIES } from "../shared/package";
import { validateMessage } from "../shared/validation";
import { undeclared } from "../shared/actions";

type Result = Extract<PluginMessage, { type: "result" }>;
type Tagged = Extract<PluginMessage, { type: "toast" | "clipboard" | "navigate" }>;

/** An event's answer, with the toasts, clipboard text and navigation the plugin tagged with it. */
export type FakeResult = Result & {
	toasts: Extract<PluginMessage, { type: "toast" }>[];
	clipboard: string[];
	navigations: { screen: string; select?: string }[];
};

/** A view change the plugin refused (`view` with `refused`): the instance kept `view`. */
export type FakeRefusal = { surface: string; instance: string; view: ViewState; reason: string };

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** In-memory transport using the production SDK; call close() to release the reader. */
export function fakeHost(def: PluginDefinition) {
	const messages: PluginMessage[] = [];
	/** Messages that failed the host's validation, with why. */
	const invalid: { message: unknown; reason: string }[] = [];
	/** Renders the host would reject (an undeclared action or form id), with why. */
	const rejected: { surface: string; instance: string; reason: string }[] = [];
	const refusals: FakeRefusal[] = [];
	const trees = new Map<string, Node>();
	let declarations: Declarations = { views: {}, actions: {}, forms: {} };
	const waiting = new Map<string, (r: Result) => void>();
	let ready = false;
	let wake: (() => void) | undefined;
	let ended = false;
	const queue: HostMessage[] = [];
	const input: AsyncIterable<Uint8Array> = {
		async *[Symbol.asyncIterator]() {
			while (!ended) {
				if (!queue.length) await new Promise<void>((r) => (wake = r));
				wake = undefined;
				while (queue.length) yield new TextEncoder().encode(JSON.stringify(queue.shift()) + "\n");
			}
		},
	};
	const key = (surface: string, instance: string) => `${surface}\n${instance}`;
	const receive = (line: string) => {
		const m = JSON.parse(line) as PluginMessage;
		messages.push(m);
		try {
			validateMessage(m);
		} catch (error) {
			invalid.push({ message: m, reason: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (m.type === "hello") declarations = m.declarations;
		else if (m.type === "declarations") declarations = m.declarations;
		else if (m.type === "ready") ready = true;
		else if (m.type === "render") {
			const reason = undeclared(m.tree, { actions: declarations.actions, forms: declarations.forms, view: declarations.views[m.surface] });
			if (reason) rejected.push({ surface: m.surface, instance: m.instance, reason });
			else trees.set(key(m.surface, m.instance), m.tree);
		} else if (m.type === "view" && m.refused !== undefined) refusals.push({ surface: m.surface, instance: m.instance, view: m.view, reason: m.refused });
		else if (m.type === "result") {
			waiting.get(m.id)?.(m);
			waiting.delete(m.id);
		}
	};
	const context = definePlugin(def, { input, write: receive });
	const send = (message: HostMessage) => {
		queue.push(message);
		wake?.();
	};
	let ids = 0;
	const host = {
		messages,
		invalid,
		rejected,
		refusals,
		context,
		send,
		close() {
			ended = true;
			wake?.();
		},
		/** The plugin's current declarations (hello, then `declarations` messages). */
		get declarations() {
			return declarations;
		},
		/** Says hello with these capabilities (all of this SDK's by default) and waits until the plugin is ready. */
		async hello(capabilities: string[] = [...CAPABILITIES]) {
			send({ type: "hello", protocol: PROTOCOL_VERSION, capabilities, plugin: { id: "test" }, host: { name: "fake host", version: "0.0.0" } });
			for (let i = 0; i < 500 && !ready; i++) await settle();
			if (!ready) throw new Error("the plugin didn't become ready");
		},
		/** Opens an instance (the person's by default), optionally with a view, and lets it render. */
		async open(surface: string, instance: string = PERSON, view?: ViewState) {
			send({ type: "open", surface, instance, ...(view ? { view } : {}) });
			await host.idle();
		},
		async closeInstance(surface: string, instance: string = PERSON) {
			send({ type: "close", surface, instance });
			await host.idle();
		},
		/** Sets an instance's view, as the host does for an agent or the person's Restore. */
		async setView(surface: string, instance: string, view: ViewState) {
			send({ type: "view", surface, instance, view });
			await host.idle();
		},
		/** The latest accepted tree of an instance. */
		tree(surface: string, instance: string = PERSON): Node | undefined {
			return trees.get(key(surface, instance));
		},
		/**
		 * Sends an event and waits for its result (at most `timeout` ms), with what the plugin tagged
		 * with it. `origin: "agent"` needs an `agent` client name, as the host sends it.
		 */
		async event(surface: string, name: string, payload?: unknown, options: { instance?: string; origin?: Origin; agent?: string; timeout?: number } = {}): Promise<FakeResult> {
			const id = `e${++ids}`;
			const from = messages.length;
			const origin = options.origin ?? "person";
			const answer = new Promise<Result>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no result for ${name} in ${options.timeout ?? 2000} ms`)), options.timeout ?? 2000);
				waiting.set(id, (r) => (clearTimeout(timer), resolve(r)));
			});
			send({
				type: "event",
				id,
				surface,
				instance: options.instance ?? PERSON,
				name,
				...(payload !== undefined ? { payload } : {}),
				origin,
				...(origin === "agent" ? { agent: options.agent ?? "test agent" } : {}),
			});
			const r = await answer;
			await host.idle();
			const tagged = messages.slice(from).filter((m): m is Tagged => (m.type === "toast" || m.type === "clipboard" || m.type === "navigate") && m.event === id);
			return {
				...r,
				toasts: tagged.filter((m) => m.type === "toast"),
				clipboard: tagged.flatMap((m) => (m.type === "clipboard" ? [m.text] : [])),
				navigations: tagged.flatMap((m) => (m.type === "navigate" ? [{ screen: m.screen, ...(m.select !== undefined ? { select: m.select } : {}) }] : [])),
			};
		},
		/** Waits until the plugin has handled what was sent and rendered. */
		async idle() {
			for (let i = 0; i < 5; i++) await settle();
		},
	};
	return host;
}
