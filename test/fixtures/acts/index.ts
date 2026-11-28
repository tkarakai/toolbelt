// Test plugin for protocol 3 (test/host.test.ts): declared actions with every outcome, tagged
// side effects, per-instance hooks and view refusals. Its page text lists the instance hooks it
// heard. Actions: `ok` (handled), `skip` (not handled), `fail` (throws), `data` (returns data),
// `hang` (settles after 600 ms), `go` (navigates to the other screen, twice), `undo-toast` (a toast with
// a declared Undo), `bad-toast` (a toast whose button isn't declared), `copy`, `break` (the next
// render uses an undeclared action id) and `mend` (offered only while broken, it never reaches the
// plugin: the error tree offers nothing). The mode control allows list and board; onView refuses
// the search "no".
import { definePlugin, type Node } from "../../../src/sdk";

const hooks: string[] = [];
let broken = false;
const ids = ["ok", "skip", "fail", "data", "hang", "go", "undo-toast", "bad-toast", "copy", "break"];

definePlugin({
	views: { "screen:main": { search: true, controls: { mode: "list" }, options: { controls: { mode: ["list", "board"] } } } },
	actions: {
		ok: { effect: "write" },
		skip: { effect: "write" },
		fail: { effect: "write" },
		data: { effect: "write", describe: "Creates a record and returns its id" },
		hang: { effect: "external" },
		go: { effect: "view" },
		"undo-toast": { effect: "destructive" },
		"bad-toast": { effect: "write" },
		copy: { effect: "view" },
		break: { effect: "write" },
		undo: { effect: "write" },
	},
	render: {
		"screen:main": (_ctx, view): Node => ({
			type: "page",
			search: { placeholder: "Search" },
			controls: [{ type: "segmented", id: "mode", value: "", options: [{ value: "list", label: "List" }, { value: "board", label: "Board" }] }],
			actions: [...ids.map((id) => ({ id, label: id })), ...(broken ? [{ id: "mend", label: "Mend" }] : [])],
			children: [{ type: "text", text: `${view.instance}|${view.search}|${view.controls.mode}|${hooks.join(",")}` }],
		}),
		"screen:other": (): Node => ({ type: "text", text: "other" }),
	},
	onOpen: (surface, ctx, { instance, origin }) => {
		hooks.push(`open:${surface}:${instance}:${origin}`);
		ctx.invalidate();
	},
	onClose: (surface, ctx, { instance, origin }) => {
		hooks.push(`close:${surface}:${instance}:${origin}:${ctx.open.has(surface) ? "open" : "closed"}`);
		ctx.invalidate();
	},
	onView: (_surface, view) => (view.search === "no" ? false : undefined),
	async onEvent(_surface, name, _payload, ctx, { id }) {
		if (name === "skip") return false;
		if (name === "fail") throw new Error("it broke");
		if (name === "data") return { data: { created: "r-1", event: id } };
		if (name === "hang") return new Promise<void>((resolve) => setTimeout(resolve, 600));
		if (name === "go") {
			ctx.navigate("other", { select: "row-1" });
			ctx.navigate("main");
			// Background work after the handler: untagged, so it's ignored.
			setTimeout(() => ctx.navigate("other"), 50);
		}
		if (name === "undo-toast") ctx.toast("Deleted", "success", { id: "undo", label: "Undo" });
		if (name === "bad-toast") ctx.toast("Saved", "success", { id: "not-declared", label: "Nope" });
		if (name === "copy") ctx.copy("copied text");
		if (name === "break") (broken = true), ctx.invalidate();
	},
});
