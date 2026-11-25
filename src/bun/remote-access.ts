// Remote access (docs/remote-access.md): the loopback server, the Tailscale owner check, the
// Serve rule, reachability and the connected-devices list. Independent of Electrobun so it runs
// under tests with a fake CLI and fake fetch.
import {
	REMOTE_CLOSE,
	remoteUrl,
	validPort,
	type RemoteAccessRequest,
	type RemoteAccessState,
	type RemoteDevice,
	type RemoteSettings,
	type ServeRule,
	type TailscaleView,
} from "../shared/remote";
import {
	checkRemoteRequest,
	startRemoteServer,
	type RemoteClient,
	type RemoteServer,
	type RemoteServerOptions,
} from "./remote-server";
import { loopbackPeerTrusted } from "./peer-owner";
import { findTailscaleCli, Tailscale, type Peer, type Runner } from "./tailscale";

export type RemoteAccessOptions = {
	settings(): RemoteSettings;
	save(settings: RemoteSettings): void;
	/** Built UI to serve. */
	root: string;
	/** What the server does with connections (the app's RPC). */
	handlers: Pick<RemoteServerOptions, "request" | "message" | "opened" | "closed">;
	changed(state: RemoteAccessState): void;
	findCli?: () => string | null;
	runner?: Runner;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** How often status refreshes while remote access is on. */
	refreshMs?: number;
	/** How often device figures are pushed while devices are connected. */
	metricsMs?: number;
	/** Listen address (tests may use another loopback name). */
	hostname?: string;
	/** Who may open the RPC socket (src/bun/peer-owner.ts); tests replace it. */
	trustPeer?: (clientPort: number, serverPort: number) => Promise<boolean>;
};

const NO_TAILSCALE: TailscaleView = {
	cli: null,
	cliError: null,
	backend: null,
	login: null,
	dnsName: null,
	https: false,
};

const CLI_NOT_FOUND = "The Tailscale command-line tool was not found on PATH or in its usual places";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const portInUse = (port: number) => `Port ${port} is already in use on this Mac. Choose another port.`;

/** Whether nothing listens on `port` (checked by briefly listening on it). */
function portFree(port: number, hostname = "127.0.0.1") {
	try {
		Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
		return true;
	} catch {
		return false;
	}
}

export class RemoteAccess {
	private server: RemoteServer | null = null;
	private serverError: string | null = null;
	private tailscale: TailscaleView = { ...NO_TAILSCALE };
	private peers = new Map<string, Peer>();
	private rule: ServeRule = { state: "unknown" };
	private reachable: RemoteAccessState["reachable"] = "unknown";
	private reachError: string | null = null;
	private busy: string | null = null;
	private lastError: string | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private metricsTimer: ReturnType<typeof setInterval> | undefined;
	private refreshing: Promise<void> | null = null;
	/** Changes to the server, the rule and the port run one at a time, in order. */
	private serial: Promise<unknown> = Promise.resolve();
	/** Random per run: the reachability probe proves the ts.net address reaches this server. */
	readonly instance = crypto.randomUUID();

	constructor(private readonly options: RemoteAccessOptions) {}

	state(): RemoteAccessState {
		const settings = this.options.settings();
		return {
			settings,
			running: !!this.server,
			serverError: this.serverError,
			tailscale: { ...this.tailscale },
			rule: this.rule,
			reachable: this.reachable,
			reachError: this.reachError,
			url: remoteUrl(this.tailscale.dnsName, settings.port),
			devices: this.devices(),
			busy: this.busy,
			lastError: this.lastError,
		};
	}

	/** At app start: serve if remote access was left on. */
	async start() {
		if (this.options.settings().enabled) await this.exclusive(() => this.setEnabled(true));
	}

	async handle(request: RemoteAccessRequest): Promise<RemoteAccessState> {
		this.lastError = null;
		try {
			switch (request.operation) {
				case "read":
					if (this.rule.state === "unknown") await this.refresh();
					break;
				case "refresh":
					await this.refresh();
					break;
				case "setEnabled":
					await this.operation("setEnabled", () => this.setEnabled(request.enabled === true));
					break;
				case "setPort":
					await this.operation("setPort", () => this.setPort(request.port, request.moveRule === true));
					break;
				case "createRule":
					await this.operation("createRule", async () => {
						await this.cli().createRule(this.options.settings().port);
						await this.refresh();
					});
					break;
				case "removeRule":
					await this.operation("removeRule", async () => {
						await this.cli().removeRule(this.options.settings().port);
						await this.refresh();
					});
					break;
				case "disconnect":
					for (const client of this.server?.clients ?? [])
						if (client.ip === request.ip) client.close(REMOTE_CLOSE.disconnected, "Disconnected from the Mac");
					break;
				case "setBadgePlugins":
					this.save({
						badgePlugins: Array.isArray(request.plugins)
							? [...new Set(request.plugins.filter((p): p is string => typeof p === "string"))]
							: [],
					});
					break;
				default:
					throw new Error("Unknown remote access operation");
			}
		} catch (error) {
			this.lastError = message(error);
		}
		this.emit();
		return this.state();
	}

	/** App quit. */
	async stop() {
		this.stopTimers();
		const server = this.server;
		this.server = null;
		await server?.stop(REMOTE_CLOSE.off, "ToolBelt quit");
	}

	private save(patch: Partial<RemoteSettings>) {
		this.options.save({ ...this.options.settings(), ...patch });
	}

	/** Runs after every earlier change has finished, whether it succeeded or not. */
	private exclusive<T>(run: () => Promise<T>): Promise<T> {
		const next = this.serial.then(run, run);
		this.serial = next.catch(() => {});
		return next;
	}

	private operation(name: string, run: () => Promise<void>) {
		return this.exclusive(async () => {
			this.busy = name;
			this.emit();
			try {
				await run();
			} finally {
				this.busy = null;
			}
		});
	}

	private cli(): Tailscale {
		const path = this.tailscale.cli ?? (this.options.findCli ?? findTailscaleCli)();
		if (!path) {
			this.tailscale = { ...NO_TAILSCALE, cliError: CLI_NOT_FOUND };
			throw new Error(CLI_NOT_FOUND);
		}
		return new Tailscale(path, this.options.runner);
	}

	private async setEnabled(enabled: boolean) {
		this.save({ enabled });
		if (enabled) {
			await this.refresh();
			this.listen();
			await this.refresh();
		} else {
			this.stopTimers();
			await this.closeServer("Remote access was turned off on the Mac");
			this.serverError = null;
			this.reachable = "unknown";
			this.reachError = null;
		}
	}

	private async closeServer(reason: string) {
		const server = this.server;
		this.server = null;
		await server?.stop(REMOTE_CLOSE.off, reason);
	}

	private async setPort(port: number, moveRule: boolean) {
		if (!validPort(port)) throw new Error("Choose a port between 1024 and 65535");
		const previous = this.options.settings().port;
		if (port === previous) return;
		const cli = moveRule ? this.cli() : null;
		// Make sure the new port is free before touching the rule that devices use now.
		if (this.server) {
			const probe = this.serverOn(port);
			if ("error" in probe) throw new Error(probe.error);
			const old = this.server;
			this.server = probe.server;
			await old.stop(REMOTE_CLOSE.off, "Remote access moved to another port");
		} else if (!portFree(port, this.options.hostname)) throw new Error(portInUse(port));
		this.save({ port });
		if (cli) {
			await cli.createRule(port);
			await cli.removeRule(previous);
		}
		await this.refresh();
	}

	/** Starts the server on the configured port unless one is already running. */
	private listen() {
		if (!this.server) {
			const started = this.serverOn(this.options.settings().port);
			this.server = "server" in started ? started.server : null;
			this.serverError = "error" in started ? started.error : null;
		}
		this.startTimers();
	}

	private serverOn(port: number): { server: RemoteServer } | { error: string } {
		try {
			const server = startRemoteServer({
				port,
				hostname: this.options.hostname,
				root: this.options.root,
				trustPeer: this.options.trustPeer ?? loopbackPeerTrusted,
				check: (request, peer) =>
					checkRemoteRequest(request, peer, { owner: this.tailscale.login, dnsName: this.tailscale.dnsName }),
				wellKnown: {
					check: (request, peer) =>
						checkRemoteRequest(
							request,
							peer,
							{ owner: this.tailscale.login, dnsName: this.tailscale.dnsName },
							{ requireOwner: false },
						),
					body: () => ({ app: "ToolBelt", instance: this.instance }),
				},
				...this.options.handlers,
				opened: (client) => {
					this.options.handlers.opened?.(client);
					this.emit();
				},
				closed: (client) => {
					this.options.handlers.closed?.(client);
					this.emit();
				},
			});
			return { server };
		} catch (error) {
			return { error: /EADDRINUSE|in use/i.test(message(error)) ? portInUse(port) : message(error) };
		}
	}

	private startTimers() {
		this.stopTimers();
		this.refreshTimer = setInterval(() => void this.refresh().then(() => this.emit()), this.options.refreshMs ?? 30_000);
		this.metricsTimer = setInterval(() => {
			if (this.server?.clients.size) this.emit();
		}, this.options.metricsMs ?? 2_000);
	}

	private stopTimers() {
		clearInterval(this.refreshTimer);
		clearInterval(this.metricsTimer);
	}

	/** Reads Tailscale status and the Serve rule, then probes reachability. One at a time. */
	refresh(): Promise<void> {
		this.refreshing ??= this.readTailscale().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async readTailscale() {
		const path = (this.options.findCli ?? findTailscaleCli)();
		if (!path) {
			this.tailscale = { ...NO_TAILSCALE, cliError: CLI_NOT_FOUND };
			this.peers = new Map();
			this.rule = { state: "unknown" };
			this.reachable = "unknown";
			return;
		}
		const cli = new Tailscale(path, this.options.runner);
		try {
			const status = await cli.status();
			this.tailscale = {
				cli: path,
				cliError: null,
				backend: status.backend,
				login: status.login,
				dnsName: status.dnsName,
				https: status.https,
			};
			this.peers = status.peers;
		} catch (error) {
			this.tailscale = { ...NO_TAILSCALE, cli: path, cliError: message(error) };
			this.peers = new Map();
			this.rule = { state: "unknown" };
			this.reachable = "unknown";
			return;
		}
		try {
			this.rule = this.tailscale.backend === "Running" ? await cli.rule(this.options.settings().port) : { state: "unknown" };
		} catch (error) {
			this.rule = { state: "unknown" };
			this.lastError = message(error);
		}
		await this.probe();
	}

	private async probe() {
		const url = remoteUrl(this.tailscale.dnsName, this.options.settings().port);
		if (!this.server || this.rule.state !== "ours" || !url) {
			this.reachable = "unknown";
			this.reachError = null;
			return;
		}
		this.reachable = "checking";
		try {
			const response = await (this.options.fetch ?? fetch)(`${url}.well-known/toolbelt`, {
				signal: AbortSignal.timeout(5_000),
			});
			const body = response.ok ? ((await response.json()) as { instance?: string }) : null;
			this.reachable = body?.instance === this.instance ? "yes" : "no";
			this.reachError =
				this.reachable === "yes"
					? null
					: response.ok
						? "The address answers, but not from this ToolBelt"
						: `The address answered ${response.status}`;
		} catch (error) {
			this.reachable = "no";
			this.reachError = message(error);
		}
	}

	private devices(): RemoteDevice[] {
		const byIp = new Map<string, RemoteClient[]>();
		for (const client of this.server?.clients ?? []) {
			const key = client.ip ?? "local";
			byIp.set(key, [...(byIp.get(key) ?? []), client]);
		}
		return [...byIp].map(([ip, clients]) => {
			const peer = this.peers.get(ip);
			const sum = (pick: (c: RemoteClient) => number) => clients.reduce((n, c) => n + pick(c), 0);
			const rtts = clients.map((c) => c.rtt).filter((r): r is number => r !== null);
			return {
				ip,
				name: peer?.name ?? ip,
				os: peer?.os ?? null,
				path: peer?.path ?? null,
				connections: clients.length,
				connectedAt: Math.min(...clients.map((c) => c.connectedAt)),
				bytesOut: sum((c) => c.queue.bytesOut),
				bytesIn: sum((c) => c.bytesIn),
				wireOut: Math.round(sum((c) => c.queue.bytesOut * c.ratio)),
				treesSent: sum((c) => c.queue.treesSent),
				treesSkipped: sum((c) => c.queue.treesSkipped),
				rtt: rtts.length ? Math.min(...rtts) : null,
			};
		});
	}

	private emit() {
		this.options.changed(this.state());
	}
}
