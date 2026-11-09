// The plugin SDK with an in-memory host.
import { expect, test } from "bun:test";
import { definePlugin } from "../src/sdk";
import type { HostMessage, PluginMessage } from "../src/shared/protocol";

function harness() {
	const out: PluginMessage[] = [];
	let push: (m: HostMessage) => void = () => {};
	const input: AsyncIterable<Uint8Array> = {
		async *[Symbol.asyncIterator]() {
			const queue: HostMessage[] = [];
			let wake: (() => void) | null = null;
			push = (m) => (queue.push(m), wake?.());
			while (true) {
				if (!queue.length) await new Promise<void>((r) => (wake = r));
				wake = null;
				yield new TextEncoder().encode(JSON.stringify(queue.shift()) + "\n");
			}
		},
	};
	const write = (line: string) => out.push(JSON.parse(line));
	return { out, input, write, send: (m: HostMessage) => push(m) };
}

const tick = () => Bun.sleep(10);

test("renders open surfaces, skips unchanged trees, coalesces invalidations", async () => {
	const h = harness();
	let n = 0;
	let renders = 0;
	const ctx = definePlugin({ render: { "screen:a": () => (renders++, { type: "text", text: `n=${n}` }) } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 0, plugin: { id: "t" }, host: { name: "test", version: "0" } });
	h.send({ type: "open", surface: "screen:a" });
	await tick();
	expect(h.out).toEqual([{ type: "render", surface: "screen:a", tree: { type: "text", text: "n=0" } }]);

	ctx.invalidate();
	await tick();
	expect(h.out.length).toBe(1); // same tree: not sent again

	n = 1;
	renders = 0;
	ctx.invalidate();
	ctx.invalidate("screen:a");
	ctx.invalidate();
	await tick();
	expect(renders).toBe(1);
	expect(h.out.at(-1)).toEqual({ type: "render", surface: "screen:a", tree: { type: "text", text: "n=1" } });

	h.send({ type: "close", surface: "screen:a" });
	await tick();
	n = 2;
	ctx.invalidate();
	await tick();
	expect(h.out.length).toBe(2); // closed: nothing rendered
});

test("a render that throws shows an error view instead of killing the plugin", async () => {
	const h = harness();
	definePlugin({ render: { quick: () => { throw new Error("nope"); } } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "open", surface: "quick" });
	await tick();
	expect(h.out[0]).toMatchObject({ type: "render", surface: "quick", tree: { type: "empty", description: "nope" } });
});

test("events reach onEvent with the surface and payload", async () => {
	const h = harness();
	const seen: unknown[] = [];
	definePlugin({ render: {}, onEvent: (surface, name, payload) => void seen.push([surface, name, payload]) }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "event", surface: "screen:a", name: "action", payload: { rowId: "7" } });
	await tick();
	expect(seen).toEqual([["screen:a", "action", { rowId: "7" }]]);
});
