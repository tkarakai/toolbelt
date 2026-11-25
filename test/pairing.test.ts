import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry, deviceName, NO_PAIRING, TOO_MANY, WRONG_CODE } from "../src/bun/pairing";
import { PAIRING_MAX_FAILURES, PAIRING_TTL_MS } from "../src/shared/remote";

const file = () => join(mkdtempSync(join(tmpdir(), "toolbelt-pairing-")), "remote-devices.json");

describe("pairing", () => {
	test("a six-digit code or the QR secret pairs, and the token verifies", () => {
		const registry = new DeviceRegistry(file());
		const session = registry.start();
		expect(session.code).toMatch(/^\d{6}$/);
		expect(session.secret.length).toBeGreaterThanOrEqual(43);
		const byCode = registry.pair(`${session.code.slice(0, 3)} ${session.code.slice(3)}`, "iphone (Safari)");
		const bySecret = registry.pair(session.secret, "iphone (Home Screen app)");
		if ("error" in byCode || "error" in bySecret) throw new Error("expected pairing");
		expect(registry.verify(byCode.token)).toEqual(byCode.device);
		expect(registry.verify(bySecret.token)).toEqual(bySecret.device);
		expect(byCode.token).not.toBe(bySecret.token);
		expect(registry.pairing()?.paired).toEqual(["iphone (Safari)", "iphone (Home Screen app)"]);
	});

	test("without a pairing in progress nothing pairs", () => {
		const registry = new DeviceRegistry(file());
		expect(registry.pair("123456", "x")).toEqual({ error: NO_PAIRING });
		const session = registry.start();
		registry.stop();
		expect(registry.pair(session.code, "x")).toEqual({ error: NO_PAIRING });
	});

	test("codes expire", () => {
		let now = 1_000;
		const registry = new DeviceRegistry(file(), () => now);
		const session = registry.start();
		now += PAIRING_TTL_MS;
		expect(registry.pairing()).toBeNull();
		expect(registry.pair(session.code, "x")).toEqual({ error: NO_PAIRING });
	});

	test("wrong codes end the pairing after the allowed number", () => {
		const registry = new DeviceRegistry(file());
		const session = registry.start();
		const wrong = session.code === "000000" ? "111111" : "000000";
		for (let i = 1; i < PAIRING_MAX_FAILURES; i++) expect(registry.pair(wrong, "x")).toEqual({ error: WRONG_CODE });
		expect(registry.pair(wrong, "x")).toEqual({ error: TOO_MANY });
		expect(registry.pair(session.code, "x")).toEqual({ error: NO_PAIRING });
		expect(registry.list()).toEqual([]);
	});

	test("non-strings, short tokens and junk never verify or pair", () => {
		const registry = new DeviceRegistry(file());
		const session = registry.start();
		expect(registry.verify(undefined)).toBeNull();
		expect(registry.verify(42)).toBeNull();
		expect(registry.verify("short")).toBeNull();
		expect(registry.pair(undefined, "x")).toEqual({ error: WRONG_CODE });
		expect(registry.pair({ code: session.code }, "x")).toEqual({ error: WRONG_CODE });
	});

	test("devices persist as hashes in an owner-only file, survive a reload and can be revoked", () => {
		const path = file();
		const registry = new DeviceRegistry(path);
		const session = registry.start();
		const paired = registry.pair(session.code, "ipad (Safari)");
		if ("error" in paired) throw new Error("expected pairing");
		const saved = readFileSync(path, "utf8");
		expect(saved).not.toContain(paired.token);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const reloaded = new DeviceRegistry(path);
		expect(reloaded.verify(paired.token)).toEqual(paired.device);
		expect(reloaded.revoke(paired.device.id)).toBe(true);
		expect(new DeviceRegistry(path).verify(paired.token)).toBeNull();
		expect(reloaded.revoke(paired.device.id)).toBe(false);
	});

	test("names stay unique and an unreadable file means no devices", () => {
		const path = file();
		const registry = new DeviceRegistry(path);
		const session = registry.start();
		registry.pair(session.code, "iphone (Safari)");
		registry.pair(session.secret, "iphone (Safari)");
		expect(registry.list().map((d) => d.name)).toEqual(["iphone (Safari)", "iphone (Safari) 2"]);
		writeFileSync(path, "{not json");
		expect(new DeviceRegistry(path).list()).toEqual([]);
		writeFileSync(path, JSON.stringify({ devices: [{ id: "a", name: "x", tokenHash: "nothex", pairedAt: 1, lastSeen: 1 }] }));
		expect(new DeviceRegistry(path).list()).toEqual([]);
	});

	test("device names come from Tailscale and the browser, cleaned", () => {
		expect(deviceName("iphone", "Safari")).toBe("iphone (Safari)");
		expect(deviceName(null, "Home Screen app")).toBe("Device (Home Screen app)");
		expect(deviceName("ipad", "<script>")).toBe("ipad (script)");
		expect(deviceName("ipad", 5)).toBe("ipad");
		expect(deviceName("ipad", "x".repeat(100))).toBe(`ipad (${"x".repeat(40)})`);
	});
});
