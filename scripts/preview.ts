#!/usr/bin/env bun
// Toolbelt's UI in a plain browser, with the real plugins: serves dist/ (run `bun run views`
// first) and bridges the web view RPC over a WebSocket. For designing and screenshotting the
// UI without the app. Run: bun scripts/preview.ts  →  http://localhost:5174 (#popover too)
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { PluginHost, configDir, pluginDirs } from "../src/bun/host";
import type { ServerWebSocket } from "bun";
import { DEFAULTS, type Settings } from "../src/bun/settings";
import { displayAccelerator } from "../src/bun/hotkey";

// Settings live in memory here (the preview doesn't touch the app's settings file).
let settings: Settings = { ...DEFAULTS };

const port = Number(process.env.PORT ?? 5174);
const host = new PluginHost({ dirs: pluginDirs({ bundled: "build-plugins", home: homedir(), extra: process.env.TOOLBELT_PLUGINS }), bun: process.execPath, host: { name: "Toolbelt preview", version: "0.0.0" }, data: join(configDir(homedir()), "data") });
const clients = new Set<ServerWebSocket<{ opened: Set<string> }>>();
const broadcast = (name: string, payload: unknown) => clients.forEach((c) => c.send(JSON.stringify({ kind: "message", name, payload })));
host.subscribe({
	plugins: (list) => broadcast("plugins", list),
	tree: (plugin, surface, tree) => broadcast("tree", { plugin, surface, tree }),
	toast: (plugin, text, tone, action) => broadcast("toast", { plugin, text, tone, action }),
	clipboard: (_plugin, text) => {
		const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
		p.stdin.write(text);
		p.stdin.end();
	},
});
host.start();

Bun.serve<{ opened: Set<string> }>({
	port,
	fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/rpc") return server.upgrade(req, { data: { opened: new Set() } }) ? undefined : new Response("no", { status: 400 });
		const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
		const file = Bun.file(join("dist", path));
		return file.size ? new Response(file) : new Response("not found", { status: 404 });
	},
	websocket: {
		open: (ws) => void clients.add(ws),
		close: (ws) => {
			clients.delete(ws);
			for (const k of ws.data.opened) host.close(...(k.split("\n") as [string, string]));
		},
		message(ws, raw) {
			const m = JSON.parse(String(raw));
			if (m.kind !== "request") return;
			const p = m.params ?? {};
			const reply = (result: unknown) => ws.send(JSON.stringify({ kind: "response", id: m.id, result }));
			try {
				switch (m.method) {
					case "plugins": return reply(host.list());
					case "open": ws.data.opened.add(`${p.plugin}\n${p.surface}`); return reply(host.open(p.plugin, p.surface));
					case "close": ws.data.opened.delete(`${p.plugin}\n${p.surface}`); host.close(p.plugin, p.surface); return reply(true);
					case "event": host.event(p.plugin, p.surface, p.name, p.payload); return reply(true);
					case "restartPlugin": host.restart(p.plugin); return reply(true);
					case "settings": return reply({ ...settings, shortcutLabel: displayAccelerator(settings.shortcut), shortcutError: null });
					case "setAppearance":
						settings = { ...settings, ...(p.theme ? { theme: p.theme } : {}), ...(p.mode ? { mode: p.mode } : {}) };
						broadcast("settingsChanged", {});
						return reply(true);
					case "setShortcut": settings = { ...settings, shortcut: p.accelerator }; broadcast("settingsChanged", {}); return reply({ ok: true, label: displayAccelerator(p.accelerator) });
					case "pauseShortcut": return reply(true);
					case "openUrl": return reply(false); // the browser opens links itself
				}
			} catch (e) {
				ws.send(JSON.stringify({ kind: "response", id: m.id, error: (e as Error).message }));
			}
		},
	},
});
console.log(`Toolbelt preview: http://localhost:${port}  (popover: http://localhost:${port}/#popover)`);
process.on("SIGINT", () => (host.stop(), process.exit(0)));
