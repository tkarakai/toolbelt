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
	/** This device's pairing was revoked: forget the device token and pair again. */
	revoked: 4003,
} as const;

/** How long a pairing code (and its QR code) stays valid. */
export const PAIRING_TTL_MS = 5 * 60_000;
/** Wrong codes allowed before the pairing ends and the Mac must start a new one. */
export const PAIRING_MAX_FAILURES = 5;
/**
 * The pairing QR code's link carries the secret in the fragment (`#pair=…`): browsers never send
 * fragments to the server, so it stays out of requests and logs.
 */
export const PAIR_PARAM = "pair";

/** A device that may use remote access (docs/remote-access.md, "Pairing"). */
export type PairedDevice = {
	id: string;
	/** Tailscale's device name and the browser or home-screen app, e.g. "iphone (Home Screen app)". */
	name: string;
	pairedAt: number;
	/** When it last connected or disconnected. */
	lastSeen: number;
	/** Its live connection while it has ToolBelt open, else null. */
	live: RemoteConnection | null;
};

/** The pairing the Mac is showing, while it lasts. */
export type PairingView = {
	/** Six digits to type on the device. */
	code: string;
	/** One-time secret in the QR code's link. */
	secret: string;
	expiresAt: number;
	/** Names of the devices paired with it so far. */
	paired: string[];
};

/** Before any request, a browser connection identifies itself or pairs (docs/remote-access.md). */
export type PairingClientMessage =
	| { kind: "hello"; token?: string }
	| { kind: "pair"; secret: string; label: string };
export type PairingServerMessage =
	| { kind: "paired"; device: { id: string; name: string } | null; token?: string }
	| { kind: "unpaired" }
	| { kind: "pairFailed"; error: string };

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

/** A paired device's open connections (one per window), with Tailscale's view of the device. */
export type RemoteConnection = {
	/** Tailnet IP (from Serve). */
	ip: string | null;
	/** Tailscale's name for the device. */
	tailscaleName: string | null;
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
	/** Devices allowed to connect, with their live connections. */
	paired: PairedDevice[];
	/** The pairing in progress, or null. */
	pairing: PairingView | null;
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
	/** Ends a paired device's connections; it stays paired. */
	| { operation: "disconnect"; id: string }
	/** Shows a new pairing code and QR code (replacing one in progress). */
	| { operation: "startPairing" }
	| { operation: "stopPairing" }
	/** Forgets a paired device and closes its connections. */
	| { operation: "revoke"; id: string }
	| { operation: "setBadgePlugins"; plugins: string[] };

export const validPort = (port: unknown): port is number =>
	typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;

/** The address a phone opens: the MagicDNS name on the dedicated port. */
export const remoteUrl = (dnsName: string | null, port: number) =>
	dnsName ? `https://${dnsName}:${port}/` : null;

/** The pairing QR code's link: opens the address, pairs, then shows how to install. */
export const pairingLink = (url: string, secret: string) => `${url}?install#${PAIR_PARAM}=${encodeURIComponent(secret)}`;

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
