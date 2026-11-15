// Test plugin: renders a counter; the `bump` event increments it; `boom` crashes; `where`
// toasts its data folder; `go` navigates to `payload.screen` (a start-up navigation, with no
// action before it, must be ignored).
import { dataDir, definePlugin } from "../../../src/sdk";

let n = 0;
definePlugin({
	start: (ctx) => {
		ctx.badge(n);
		ctx.navigate("main");
	},
	render: {
		"screen:main": () => ({ type: "text", text: `count ${n}` }),
		quick: () => ({ type: "stats", items: [{ label: "Count", value: String(n) }] }),
	},
	onEvent(_s, name, _p, ctx) {
		if (name === "boom") process.exit(3);
		if (name === "where") return ctx.toast(`data ${dataDir()}`);
		if (name === "go") return void ctx.navigate((_p as { screen: string }).screen, { select: "row-1" });
		if (name === "bump") n++;
		ctx.badge(n);
		ctx.toast(`now ${n}`);
		ctx.invalidate();
	},
});
