// Device pairing for remote access (docs/remote-access.md, "Pairing"). Tailscale proves the
// person is signed in to the owner's account; pairing adds that the owner approved this browser
// or home-screen app on the Mac. The Mac shows a short-lived code and QR code; a device that
// presents either gets a random device token. Only token hashes are stored, in an owner-only file.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PAIRING_MAX_FAILURES, PAIRING_TTL_MS, type PairingView } from "../shared/remote";

type Stored = { id: string; name: string; tokenHash: string; pairedAt: number; lastSeen: number };
export type DeviceRef = { id: string; name: string };
export type Pairing = Omit<PairingView, "paired"> & { paired: string[]; failures: number };

const hash = (token: string) => createHash("sha256").update(token).digest();
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const token = () => randomBytes(32).toString("base64url");
/** Written at most this often per device just to move "last used" along. */
const LAST_SEEN_WRITE_MS = 10 * 60_000;

export const NO_PAIRING = "No pairing is in progress on your Mac. Open ToolBelt’s Settings → Remote Access there and choose Pair a device.";
export const TOO_MANY = "Too many wrong codes. Start pairing again on your Mac.";
export const WRONG_CODE = "That code doesn’t match. Check the code on your Mac.";

export class DeviceRegistry {
	private devices: Stored[];
	private session: Pairing | null = null;

	constructor(
		private readonly file: string,
		private readonly now: () => number = Date.now,
	) {
		this.devices = load(file);
	}

	list() {
		return this.devices.map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen }));
	}

	/** The paired device a token belongs to, or null. */
	verify(presented: unknown): DeviceRef | null {
		if (typeof presented !== "string" || presented.length < 20 || presented.length > 200) return null;
		const digest = hash(presented);
		const device = this.devices.find((d) => same(Buffer.from(d.tokenHash, "hex"), digest));
		if (!device) return null;
		const now = this.now();
		if (now - device.lastSeen > LAST_SEEN_WRITE_MS) {
			device.lastSeen = now;
			this.save();
		}
		return { id: device.id, name: device.name };
	}

	/** The pairing in progress, or null once it ended or expired. */
	pairing(): Pairing | null {
		if (this.session && this.now() >= this.session.expiresAt) this.session = null;
		return this.session;
	}

	start(): Pairing {
		this.session = {
			code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
			secret: token(),
			expiresAt: this.now() + PAIRING_TTL_MS,
			paired: [],
			failures: 0,
		};
		return this.session;
	}

	stop() {
		this.session = null;
	}

	/**
	 * Pairs a device that presents the QR code's secret or the six-digit code. The pairing stays
	 * open until it expires, so a phone can pair its browser and then its home-screen app.
	 */
	pair(secret: unknown, name: string): { token: string; device: DeviceRef } | { error: string } {
		const session = this.pairing();
		if (!session) return { error: NO_PAIRING };
		const presented = typeof secret === "string" ? secret.trim() : "";
		const code = presented.replace(/[\s-]/g, "");
		const matches =
			same(Buffer.from(presented), Buffer.from(session.secret)) ||
			(/^\d{6}$/.test(code) && same(Buffer.from(code), Buffer.from(session.code)));
		if (!matches) {
			session.failures++;
			if (session.failures >= PAIRING_MAX_FAILURES) {
				this.session = null;
				return { error: TOO_MANY };
			}
			return { error: WRONG_CODE };
		}
		const issued = token();
		const now = this.now();
		const device: Stored = { id: crypto.randomUUID(), name: uniqueName(name, this.devices), tokenHash: hash(issued).toString("hex"), pairedAt: now, lastSeen: now };
		this.devices.push(device);
		this.save();
		session.paired.push(device.name);
		return { token: issued, device: { id: device.id, name: device.name } };
	}

	revoke(id: string): boolean {
		const before = this.devices.length;
		this.devices = this.devices.filter((d) => d.id !== id);
		if (this.devices.length === before) return false;
		this.save();
		return true;
	}

	private save() {
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ version: 1, devices: this.devices }, null, 2), { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.file);
	}
}

/** Two devices never share a name: "iphone (Safari)", "iphone (Safari) 2". */
function uniqueName(name: string, devices: Stored[]) {
	const taken = new Set(devices.map((d) => d.name));
	if (!taken.has(name)) return name;
	let n = 2;
	while (taken.has(`${name} ${n}`)) n++;
	return `${name} ${n}`;
}

/** Saved devices; a missing or unreadable file means none (every device pairs again). */
function load(file: string): Stored[] {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { devices?: unknown };
		if (!Array.isArray(raw.devices)) return [];
		return raw.devices.filter(
			(d): d is Stored =>
				!!d &&
				typeof d.id === "string" &&
				typeof d.name === "string" &&
				typeof d.tokenHash === "string" &&
				/^[0-9a-f]{64}$/.test(d.tokenHash) &&
				typeof d.pairedAt === "number" &&
				typeof d.lastSeen === "number",
		);
	} catch {
		return [];
	}
}

/** The name a newly paired device gets: its Tailscale name and how ToolBelt runs on it. */
export function deviceName(tailscaleName: string | null, label: unknown) {
	const how = typeof label === "string" ? label.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40) : "";
	const base = tailscaleName?.trim() || "Device";
	return how ? `${base} (${how})` : base;
}
