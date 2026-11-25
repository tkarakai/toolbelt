// The Tailscale CLI, as remote access uses it (docs/remote-access.md): find it, read status and
// Serve configuration, and create or remove ToolBelt's Serve rule. Everything goes through an
// injectable runner so tests never touch a real Tailscale configuration.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ServeRule, TailscaleView } from "../shared/remote";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cli: string, args: string[]) => Promise<RunResult>;

/** Where the CLI can live when it's not on PATH (Finder-launched apps get a minimal PATH). */
export const KNOWN_CLI_PATHS = [
	"/opt/homebrew/bin/tailscale",
	"/usr/local/bin/tailscale",
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const executable = (path: string) => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

/** PATH first, then the known locations. */
export function findTailscaleCli(
	path = process.env.PATH ?? "",
	isExecutable: (path: string) => boolean = executable,
	known = KNOWN_CLI_PATHS,
): string | null {
	const candidates = [
		...path.split(delimiter).filter(Boolean).map((dir) => join(dir, "tailscale")),
		...known,
	];
	return candidates.find((candidate) => isExecutable(candidate)) ?? null;
}

export const defaultRunner: Runner = async (cli, args) => {
	const child = Bun.spawn([cli, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
};

export type Peer = {
	name: string;
	os: string | null;
	/** "direct", "relay <region>" or null. */
	path: string | null;
};

export type TailscaleStatus = Omit<TailscaleView, "cli" | "cliError"> & {
	/** Every device on the tailnet (this Mac included), by tailnet IP. */
	peers: Map<string, Peer>;
};

type RawNode = {
	HostName?: string;
	DNSName?: string;
	OS?: string;
	TailscaleIPs?: string[];
	CurAddr?: string;
	Relay?: string;
	UserID?: number;
	CapMap?: Record<string, unknown>;
	Capabilities?: string[];
};

const shortName = (node: RawNode) =>
	node.DNSName?.replace(/\.$/, "").split(".")[0] || node.HostName || "Unknown device";

/** Reads `tailscale status --json`. */
export function parseStatus(json: string): TailscaleStatus {
	const raw = JSON.parse(json) as {
		BackendState?: string;
		Self?: RawNode;
		Peer?: Record<string, RawNode>;
		User?: Record<string, { LoginName?: string }>;
	};
	const self = raw.Self ?? {};
	const login =
		self.UserID !== undefined ? (raw.User?.[String(self.UserID)]?.LoginName ?? null) : null;
	const https =
		(!!self.CapMap && Object.hasOwn(self.CapMap, "https")) ||
		!!self.Capabilities?.includes("https");
	const peers = new Map<string, Peer>();
	const add = (node: RawNode, isSelf: boolean) => {
		const path = isSelf
			? "this Mac"
			: node.CurAddr
				? "direct"
				: node.Relay
					? `relay ${node.Relay}`
					: null;
		for (const ip of node.TailscaleIPs ?? [])
			peers.set(ip, { name: shortName(node), os: node.OS || null, path });
	};
	add(self, true);
	for (const peer of Object.values(raw.Peer ?? {})) add(peer, false);
	return {
		backend: raw.BackendState ?? null,
		login,
		dnsName: self.DNSName ? self.DNSName.replace(/\.$/, "") : null,
		https,
		peers,
	};
}

/** The proxy targets that count as ToolBelt's own server on `port`. */
export const ourTargets = (port: number) => [
	`http://127.0.0.1:${port}`,
	`http://127.0.0.1:${port}/`,
	`127.0.0.1:${port}`,
];

/** Reads `tailscale serve status --json` for the rule on `port`. */
export function parseServeRule(json: string, port: number): ServeRule {
	const raw = (json.trim() ? JSON.parse(json) : {}) as {
		TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>;
		Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
	};
	const tcp = raw.TCP?.[String(port)];
	const web = Object.entries(raw.Web ?? {}).filter(([hostPort]) =>
		hostPort.endsWith(`:${port}`),
	);
	if (!tcp && !web.length) return { state: "missing" };
	if (tcp?.TCPForward) return { state: "conflict", target: `TCP forward to ${tcp.TCPForward}` };
	if (tcp && !tcp.HTTPS) return { state: "conflict", target: "a plain HTTP rule" };
	const handlers = web.flatMap(([, value]) => Object.entries(value.Handlers ?? {}));
	if (!handlers.length) return { state: "missing" };
	const foreign = handlers.find(
		([mount, handler]) => mount !== "/" || !handler.Proxy || !ourTargets(port).includes(handler.Proxy),
	);
	if (foreign) {
		const [mount, handler] = foreign;
		const target = handler.Proxy ?? (handler.Path ? `files at ${handler.Path}` : "static text");
		return { state: "conflict", target: mount === "/" ? target : `${mount} → ${target}` };
	}
	return { state: "ours" };
}

const failure = (args: string[], result: RunResult) =>
	new Error(
		`tailscale ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
	);

export class Tailscale {
	constructor(
		readonly cli: string,
		private readonly run: Runner = defaultRunner,
	) {}

	private async json(args: string[]) {
		const result = await this.run(this.cli, args);
		if (result.code !== 0) throw failure(args, result);
		return result.stdout;
	}

	async status(): Promise<TailscaleStatus> {
		return parseStatus(await this.json(["status", "--json"]));
	}

	async rule(port: number): Promise<ServeRule> {
		return parseServeRule(await this.json(["serve", "status", "--json"]), port);
	}

	/** Publishes `http://127.0.0.1:<port>` as HTTPS on the same tailnet port. Never overwrites. */
	async createRule(port: number): Promise<void> {
		const current = await this.rule(port);
		if (current.state === "ours") return;
		if (current.state === "conflict")
			throw new Error(`Tailscale port ${port} already forwards to ${current.target}`);
		const args = ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`];
		const result = await this.run(this.cli, args);
		if (result.code !== 0) throw failure(args, result);
	}

	/** Removes the rule only while it still forwards to ToolBelt's own address. */
	async removeRule(port: number): Promise<void> {
		const current = await this.rule(port);
		if (current.state === "missing") return;
		if (current.state !== "ours")
			throw new Error(
				`The rule on port ${port} no longer forwards to ToolBelt; remove it in Tailscale instead`,
			);
		const args = ["serve", `--https=${port}`, "off"];
		const result = await this.run(this.cli, args);
		if (result.code !== 0) throw failure(args, result);
	}
}
