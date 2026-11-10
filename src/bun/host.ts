// Finds plugins, starts each as a Bun child process, and relays its UI trees to the web views.
// No Electrobun imports here, so it can be tested on its own.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, parseManifest, splitLines, type HostMessage, type Manifest, type Node, type PluginMessage } from "../shared/protocol";
import type { PluginInfo, PluginState } from "../shared/rpc";

export type Discovered = { manifest: Manifest; dir: string };

/** Every `<dir>/<plugin>/toolbelt.json` under the given directories; first id wins. */
export function discover(dirs: string[], log: (msg: string) => void = console.error): Discovered[] {
	const found = new Map<string, Discovered>();
	for (const root of dirs) {
		if (!existsSync(root)) continue;
		const candidates = existsSync(join(root, "toolbelt.json")) ? [root] : readdirSync(root).map((d) => join(root, d));
		for (const dir of candidates) {
			const file = join(dir, "toolbelt.json");
			if (!existsSync(file)) continue;
			try {
				const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")));
				if (!found.has(manifest.id)) found.set(manifest.id, { manifest, dir });
			} catch (e) {
				log(`skipping ${file}: ${(e as Error).message}`);
			}
		}
	}
	return [...found.values()];
}

type Listener = {
	plugins(list: PluginInfo[]): void;
	tree(plugin: string, surface: string, tree: Node): void;
	toast(plugin: string, text: string, tone?: "default" | "success" | "error", action?: { id: string; label: string; payload?: unknown }): void;
	clipboard?(plugin: string, text: string): void;
};

class PluginProcess {
	state: PluginState = "stopped";
	badge: number | string | null = null;
	error?: string;
	trees = new Map<string, Node>();
	/** Surface → how many viewers have it open. */
	viewers = new Map<string, number>();
	private proc?: ReturnType<typeof Bun.spawn>;
	private stderrTail: string[] = [];
	private restarts = 0;
	private stopping = false;
	private restartTimer?: ReturnType<typeof setTimeout>;

	constructor(
		readonly manifest: Manifest,
		readonly dir: string,
		private readonly opts: { bun: string; env: Record<string, string | undefined>; host: { name: string; version: string }; data: string },
		private readonly changed: () => void,
		private readonly listener: Listener,
	) {}

	info(): PluginInfo {
		return { manifest: this.manifest, state: this.state, badge: this.badge, error: this.error };
	}

	start() {
		this.stopping = false;
		this.state = "starting";
		this.error = undefined;
		this.stderrTail = [];
		const entry = resolve(this.dir, this.manifest.entry);
		const data = join(this.opts.data, this.manifest.id);
		try {
			mkdirSync(data, { recursive: true });
		} catch (e) {
			this.log(`can't create its data folder ${data}: ${(e as Error).message}`);
		}
		const proc = Bun.spawn([this.opts.bun, entry], {
			cwd: this.dir,
			env: { ...this.opts.env, TOOLBELT_PLUGIN: this.manifest.id, TOOLBELT_PROTOCOL: String(PROTOCOL_VERSION), TOOLBELT_DATA_DIR: data },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.proc = proc;
		this.send({ type: "hello", protocol: PROTOCOL_VERSION, plugin: { id: this.manifest.id }, host: this.opts.host });
		for (const [surface, n] of this.viewers) if (n > 0) this.send({ type: "open", surface });
		this.state = "running";
		this.changed();
		void this.read(proc.stdout as ReadableStream<Uint8Array>);
		void this.readErr(proc.stderr as ReadableStream<Uint8Array>);
		void proc.exited.then((code) => this.exited(proc, code));
	}

	stop() {
		this.stopping = true;
		clearTimeout(this.restartTimer);
		try {
			(this.proc?.stdin as import("bun").FileSink | undefined)?.end();
		} catch {}
		this.proc?.kill();
	}

	restart() {
		this.stop();
		this.restarts = 0;
		this.restartTimer = setTimeout(() => this.start(), 200);
	}

	send(msg: HostMessage) {
		const stdin = this.proc?.stdin as import("bun").FileSink | undefined;
		if (!stdin || this.state === "crashed") return;
		try {
			stdin.write(JSON.stringify(msg) + "\n");
			stdin.flush();
		} catch {}
	}

	open(surface: string) {
		const n = (this.viewers.get(surface) ?? 0) + 1;
		this.viewers.set(surface, n);
		if (n === 1) this.send({ type: "open", surface });
		return this.trees.get(surface) ?? null;
	}

	close(surface: string) {
		const n = Math.max(0, (this.viewers.get(surface) ?? 0) - 1);
		this.viewers.set(surface, n);
		if (n === 0) this.send({ type: "close", surface });
	}

	private async read(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of stream) {
			const { lines, rest } = splitLines(buf + decoder.decode(chunk, { stream: true }));
			buf = rest;
			for (const line of lines) {
				let msg: PluginMessage;
				try {
					msg = JSON.parse(line);
				} catch {
					this.log(`not a protocol message: ${line.slice(0, 200)}`);
					continue;
				}
				this.handle(msg);
			}
		}
	}

	private async readErr(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			for (const line of text.split("\n").filter(Boolean)) {
				this.stderrTail.push(line);
				if (this.stderrTail.length > 20) this.stderrTail.shift();
				this.log(line);
			}
		}
	}

	private handle(msg: PluginMessage) {
		switch (msg.type) {
			case "render":
				this.trees.set(msg.surface, msg.tree);
				this.listener.tree(this.manifest.id, msg.surface, msg.tree);
				break;
			case "badge":
				this.badge = msg.value;
				this.changed();
				break;
			case "toast":
				this.listener.toast(this.manifest.id, msg.text, msg.tone, msg.action);
				break;
			case "clipboard":
				this.listener.clipboard?.(this.manifest.id, msg.text);
				break;
		}
	}

	private exited(proc: ReturnType<typeof Bun.spawn>, code: number | null) {
		if (proc !== this.proc) return; // an older process after a restart
		if (this.stopping) {
			this.state = "stopped";
			this.changed();
			return;
		}
		this.log(`exited with ${code}`);
		// Restart a crashing plugin a few times, backing off; then leave it crashed.
		if (this.restarts < 3) {
			this.restarts++;
			this.state = "starting";
			this.changed();
			this.restartTimer = setTimeout(() => this.start(), 500 * 2 ** this.restarts);
			return;
		}
		this.state = "crashed";
		this.error = this.stderrTail.slice(-8).join("\n") || `exited with ${code}`;
		this.changed();
	}

	private log(line: string) {
		console.error(`[${this.manifest.id}] ${line}`);
	}
}

export class PluginHost {
	private plugins = new Map<string, PluginProcess>();
	private listeners = new Set<Listener>();

	/** `data`: the folder that holds each plugin's data folder (`<data>/<id>/`). */
	constructor(private readonly opts: { dirs: string[]; bun: string; env?: Record<string, string | undefined>; host: { name: string; version: string }; data: string }) {}

	start() {
		for (const { manifest, dir } of discover(this.opts.dirs)) {
			const p = new PluginProcess(
				manifest,
				dir,
				{ bun: this.opts.bun, env: this.opts.env ?? process.env, host: this.opts.host, data: this.opts.data },
				() => this.emitPlugins(),
				{
					plugins: () => {},
					tree: (plugin, surface, tree) => this.listeners.forEach((l) => l.tree(plugin, surface, tree)),
					toast: (plugin, text, tone, action) => this.listeners.forEach((l) => l.toast(plugin, text, tone, action)),
					clipboard: (plugin, text) => this.listeners.forEach((l) => l.clipboard?.(plugin, text)),
				},
			);
			this.plugins.set(manifest.id, p);
			p.start();
		}
	}

	stop() {
		for (const p of this.plugins.values()) p.stop();
	}

	subscribe(l: Listener) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	list(): PluginInfo[] {
		return [...this.plugins.values()].map((p) => p.info());
	}

	open(plugin: string, surface: string) {
		return this.get(plugin).open(surface);
	}

	close(plugin: string, surface: string) {
		this.plugins.get(plugin)?.close(surface);
	}

	event(plugin: string, surface: string, name: string, payload?: unknown) {
		this.get(plugin).send({ type: "event", surface, name, payload });
	}

	restart(plugin: string) {
		this.get(plugin).restart();
	}

	private get(id: string) {
		const p = this.plugins.get(id);
		if (!p) throw new Error(`no plugin ${id}`);
		return p;
	}

	private emitPlugins() {
		const list = this.list();
		this.listeners.forEach((l) => l.plugins(list));
	}
}

/** Toolbelt's folder: settings, plugins, plugin data. `TOOLBELT_CONFIG_DIR` overrides it. */
export const configDir = (home: string, env: Record<string, string | undefined> = process.env) => env.TOOLBELT_CONFIG_DIR ?? join(home, "Library/Application Support/Toolbelt");

/** Where plugins live: bundled ones, the person's installed ones, and `TOOLBELT_PLUGINS`. */
export function pluginDirs(opts: { bundled?: string; home: string; extra?: string }) {
	return [
		...(opts.extra ? opts.extra.split(":").filter(Boolean) : []),
		join(opts.home, "Library/Application Support/Toolbelt/plugins"),
		...(opts.bundled ? [opts.bundled] : []),
	];
}

