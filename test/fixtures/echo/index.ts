// Test plugin: renders a counter; the `bump` action increments it; `boom` crashes; `where`
// toasts its data folder; `go-<screen>` navigates to that screen (a start-up navigation, with no
// action before it, must be ignored). Every action is offered in the page's toolbar, since the
// host refuses events the screen doesn't offer.
import { dataDir, definePlugin, type Node } from "../../../src/sdk";

let n = 0;
const actions = ["bump", "boom", "where", "go-nope", "go-main"].map((id) => ({ id, label: id }));
definePlugin({
	start: (ctx) => {
		ctx.badge(n);
		ctx.navigate("main");
	},
	render: {
		"screen:main": (): Node => ({ type: "page", actions, children: [{ type: "text", text: `count ${n}` }] }),
		quick: (): Node => ({ type: "page", actions, children: [{ type: "stats", items: [{ label: "Count", value: String(n) }] }] }),
	},
	onEvent(_s, name, _p, ctx) {
		if (name === "boom") process.exit(3);
		if (name === "where") return ctx.toast(`data ${dataDir()}`);
		if (name.startsWith("go-")) return void ctx.navigate(name.slice(3), { select: "row-1" });
		if (name === "bump") n++;
		ctx.badge(n);
		ctx.toast(`now ${n}`);
		ctx.invalidate();
	},
});
