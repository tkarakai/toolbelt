// The plugin side of the Toolbelt protocol (to become `@toolbelt/sdk`).
//
//   import { definePlugin } from "../../src/sdk";
//   definePlugin({
//     render: { "screen:main": () => ({ type: "text", text: "hello" }) },
//     onEvent: (surface, name, payload, ctx) => { … ctx.invalidate(); },
//   });
//
// `render` functions are called for surfaces that are open, whenever `ctx.invalidate()` is
// called. Unchanged trees aren't sent again.
import { PROTOCOL_VERSION, splitLines, type HostMessage, type Node, type PluginMessage } from "../shared/protocol";
import { resolve, sep } from "node:path";
import { CAPABILITIES, SDK_VERSION, type MigrationRequest } from "../shared/package";
export * from "../shared/package";

export type { Node, Cell, Column, Row, GroupLabel, Action, Field, EnvironmentEntry, Tone, Hue, Dot, Tag, Mark, Target, Filter, EventPayloads, Dialog, LogLine, Message, DetailItem, Manifest, HostMessage, PluginMessage } from "../shared/protocol";
export { HUES } from "../shared/protocol";
export { duration, relative } from "../shared/time";

/** This plugin's own folder for data (settings, state, logs). Toolbelt creates it. */
export function dataDir(): string {
	return process.env.TOOLBELT_DATA_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/toolbelt-data/${process.env.TOOLBELT_PLUGIN ?? "plugin"}`;
}

export function packageRoot(): string { return process.env.TOOLBELT_PACKAGE_ROOT ?? process.cwd(); }
export function payload(relative: string): string {
 const root = resolve(packageRoot(), "payload");
 const path = resolve(root, relative);
 if (!path.startsWith(root + sep)) throw new Error("payload path escapes package");
 return path;
}
export function asset(name: string): string {
 if (!/^[\w.-]+$/.test(name)) throw new Error("invalid asset name");
 return `asset:${process.env.TOOLBELT_PLUGIN}@${process.env.TOOLBELT_PLUGIN_VERSION}/${name}`;
}
export function defineMigration(run: (ctx: MigrationRequest & { progress(text:string):void }) => void | Promise<void>) {
 void (async () => {
  const line = (await Bun.stdin.text()).trim();
  try {
   const request = JSON.parse(line) as MigrationRequest;
   if (request.type !== "migrate" || !request.targetDir || !request.transactionId) throw new Error("invalid migration request");
   await run({...request, progress:(text)=>console.log(JSON.stringify({type:"migration-progress",text}))});
   console.log(JSON.stringify({type:"migration-complete"}));
  } catch (error) { console.log(JSON.stringify({type:"migration-failed",error:String(error)})); process.exitCode=1; }
 })();
}

export type Context = {
	/** Negotiated host capabilities; authors provide fallbacks for unavailable optional features. */
	readonly capabilities: ReadonlySet<string>;
	/** Re-render open surfaces (all, or the ones named). */
	invalidate(...surfaces: string[]): void;
	badge(value: number | string | null): void;
	toast(text: string, tone?: "default" | "success" | "error", action?: { id: string; label: string; payload?: unknown }): void;
	/** Put text on the clipboard. */
	copy(text: string): void;
	/** Surfaces the host currently shows. */
	readonly open: ReadonlySet<string>;
};

export type PluginDefinition = {
	prepare?: (reason: string, ctx: Context) => { ready: boolean; reason?: string } | Promise<{ ready: boolean; reason?: string }>;
	stop?: (ctx: Context) => void | Promise<void>;
	/** Surface → its UI. Surfaces: `screen:<id>` and `quick`. */
	render: Record<string, (ctx: Context) => Node | Promise<Node>>;
	onEvent?: (surface: string, name: string, payload: any, ctx: Context) => void | Promise<void>;
	/** Called once after the host said hello. */
	start?: (ctx: Context) => void | Promise<void>;
	onOpen?: (surface: string, ctx: Context) => void;
	onClose?: (surface: string, ctx: Context) => void;
};

export function definePlugin(def: PluginDefinition, io: { write?: (line: string) => void; input?: AsyncIterable<Uint8Array> } = {}) {
	const write = io.write ?? ((line: string) => void process.stdout.write(line));
	const send = (m: PluginMessage) => write(JSON.stringify(m) + "\n");
	const open = new Set<string>();
	const capabilities = new Set<string>();
	const last = new Map<string, string>();
	let pending: Set<string> | "all" | null = null;

	const flush = async () => {
		const which = pending === "all" ? [...open] : [...(pending ?? [])].filter((s) => open.has(s));
		pending = null;
		for (const surface of which) {
			const fn = def.render[surface];
			if (!fn) continue;
			let tree: Node;
			try {
				tree = await fn(ctx);
			} catch (e) {
				tree = { type: "empty", icon: "triangle-alert", title: "This view failed to render", description: String((e as Error)?.message ?? e) };
			}
			const json = JSON.stringify(tree);
			if (last.get(surface) === json) continue;
			last.set(surface, json);
			write(`{"type":"render","surface":${JSON.stringify(surface)},"tree":${json}}\n`);
		}
	};

	const ctx: Context = {
		capabilities,
		invalidate(...surfaces) {
			const wasIdle = pending === null;
			if (surfaces.length === 0 || pending === "all") pending = "all";
			else {
				pending ??= new Set();
				for (const s of surfaces) pending.add(s);
			}
			// Coalesce bursts of invalidations into one render pass.
			if (wasIdle) queueMicrotask(() => void flush());
		},
		badge: (value) => send({ type: "badge", value }),
		toast: (text, tone, action) => send({ type: "toast", text, tone, action }),
		copy: (text) => send({ type: "clipboard", text }),
		open,
	};

	const handle = async (msg: HostMessage) => {
		switch (msg.type) {
			case "hello":
				capabilities.clear();for(const capability of msg.capabilities ?? ["ui.core"])capabilities.add(capability);
				if (msg.protocol !== PROTOCOL_VERSION) throw new Error("incompatible host protocol");
				send({type:"hello",protocol:PROTOCOL_VERSION,sdk:SDK_VERSION,capabilities:[...CAPABILITIES]});
				await def.start?.(ctx);
				send({type:"ready"});
				break;
			case "prepare": {
				const result = await def.prepare?.(msg.reason,ctx) ?? {ready:true};
				send({type:"prepared",requestId:msg.requestId,...result});
				break;
			}
			case "shutdown": await def.stop?.(ctx); break;
			case "open":
				open.add(msg.surface);
				last.delete(msg.surface); // a new viewer needs the full tree
				def.onOpen?.(msg.surface, ctx);
				ctx.invalidate(msg.surface);
				break;
			case "close":
				open.delete(msg.surface);
				def.onClose?.(msg.surface, ctx);
				break;
			case "event":
				await def.onEvent?.(msg.surface, msg.name, msg.payload, ctx);
				break;
		}
	};

	const input = io.input ?? Bun.stdin.stream();
	(async () => {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of input) {
			const { lines, rest } = splitLines(buf + decoder.decode(chunk, { stream: true }));
			buf = rest;
			for (const line of lines) {
				let msg: HostMessage;
				try {
					msg = JSON.parse(line);
				} catch {
					console.error("toolbelt sdk: bad JSON from host");
					continue;
				}
				await handle(msg).catch((e) => console.error("toolbelt sdk:", e));
			}
		}
		// The host closed our stdin: Toolbelt quit or stopped us.
		if (!io.input) process.exit(0);
	})();

	return ctx;
}
export { search, editDistance, type Search } from "./search";
