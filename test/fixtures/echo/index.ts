// Test plugin: renders a counter; the `bump` event increments it; `boom` crashes.
import { definePlugin } from "../../../src/sdk";

let n = 0;
definePlugin({
	start: (ctx) => ctx.badge(n),
	render: {
		"screen:main": () => ({ type: "text", text: `count ${n}` }),
		quick: () => ({ type: "stats", items: [{ label: "Count", value: String(n) }] }),
	},
	onEvent(_s, name, _p, ctx) {
		if (name === "boom") process.exit(3);
		if (name === "bump") n++;
		ctx.badge(n);
		ctx.toast(`now ${n}`);
		ctx.invalidate();
	},
});
