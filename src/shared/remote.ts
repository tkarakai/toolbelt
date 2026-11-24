// Remote access (docs/remote-access.md): ToolBelt's UI served to the owner's other devices
// through a Tailscale Serve rule. Types shared by the main process and the renderer, and the
// pure rules both sides use.

/** Default loopback/tailnet port. Dev builds use the next one so both can run. */
export const REMOTE_DEFAULT_PORT = 47380;

/** WebSocket close codes the client understands. */
export const REMOTE_CLOSE = {
	/** "Disconnect" in the Remote Access tab: stop reconnecting until the person asks. */
	disconnected: 4001,
	/** Remote access was turned off on the Mac. */
	off: 4002,
} as const;

/** The server sends a heartbeat this often; clients treat 2.5× silence as a dead socket. */
export const REMOTE_HEARTBEAT_MS = 20_000;

export type RemoteSettings = {
	enabled: boolean;
	port: number;
	/** Plugin IDs whose badges count toward the PWA's home-screen badge. */
	badgePlugins: string[];
};

export type TailscaleView = {
	/** Absolute path of the CLI in use, or null when none was found. */
	cli: string | null;
	/** Why the CLI is unusable (not found, failed to run). */
	cliError: string | null;
	/** Tailscale's BackendState ("Running", "Stopped", "NeedsLogin", …), null when unknown. */
	backend: string | null;
	/** Login of the Tailscale user who owns this Mac: the owner check compares with it. */
	login: string | null;
	/** MagicDNS name without the trailing dot, e.g. "mac.tailnet.ts.net". */
	dnsName: string | null;
	/** Whether the tailnet allows HTTPS certificates. */
	https: boolean;
};

export type ServeRule =
	| { state: "unknown" }
	| { state: "missing" }
	| { state: "ours" }
	| { state: "conflict"; target: string };

export type RemoteDevice = {
	/** Tailnet IP, the device's key. */
	ip: string;
	name: string;
	os: string | null;
	/** "direct", "relay <region>" or null when Tailscale does not know. */
	path: string | null;
	connections: number;
	connectedAt: number;
	/** Uncompressed bytes sent to and received from the device. */
	bytesOut: number;
	bytesIn: number;
	/** Estimated bytes on the wire after WebSocket compression. */
	wireOut: number;
	treesSent: number;
	/** Render trees replaced by a newer one before they could be sent. */
	treesSkipped: number;
	/** Last heartbeat round trip, ms. */
	rtt: number | null;
};

export type RemoteAccessState = {
	settings: RemoteSettings;
	/** Whether the HTTP server is listening. */
	running: boolean;
	serverError: string | null;
	tailscale: TailscaleView;
	rule: ServeRule;
	/** Result of requesting /.well-known/toolbelt through the ts.net address. */
	reachable: "unknown" | "checking" | "yes" | "no";
	reachError: string | null;
	/** The address to open on a phone (null until Tailscale's name is known). */
	url: string | null;
	devices: RemoteDevice[];
	/** An operation in progress ("createRule", …). */
	busy: string | null;
	lastError: string | null;
};

export type RemoteAccessRequest =
	| { operation: "read" }
	| { operation: "refresh" }
	| { operation: "setEnabled"; enabled: boolean }
	/** `moveRule`: remove ToolBelt's rule on the old port and create one on the new port. */
	| { operation: "setPort"; port: number; moveRule?: boolean }
	| { operation: "createRule" }
	| { operation: "removeRule" }
	| { operation: "disconnect"; ip: string }
	| { operation: "setBadgePlugins"; plugins: string[] };

export const validPort = (port: unknown): port is number =>
	typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;

/** The address a phone opens: the MagicDNS name on the dedicated port. */
export const remoteUrl = (dnsName: string | null, port: number) =>
	dnsName ? `https://${dnsName}:${port}/` : null;

/**
 * What the home-screen badge shows for the chosen plugins: the sum of their numeric badges, a
 * plain dot when they only have text badges, or nothing.
 */
export function badgeTotal(
	plugins: { manifest: { id: string }; badge: number | string | null }[],
	selected: string[],
): number | "dot" | null {
	const chosen = new Set(selected);
	let total = 0;
	let text = false;
	for (const p of plugins) {
		if (!chosen.has(p.manifest.id) || p.badge === null || p.badge === "") continue;
		if (typeof p.badge === "number") total += Number.isFinite(p.badge) && p.badge > 0 ? p.badge : 0;
		else if (/^\d+$/.test(p.badge.trim())) total += Number(p.badge.trim());
		else text = true;
	}
	return total > 0 ? total : text ? "dot" : null;
}
