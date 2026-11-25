import { describe, expect, test } from "bun:test";
import { connectionPid, loopbackPeerTrusted, type Exec } from "../src/bun/peer-owner";

// `netstat -anv -p tcp` on current macOS: `process:pid`, and names may contain spaces.
const CURRENT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0      0  127.0.0.1.47380        127.0.0.1.57407        ESTABLISHED        27188        22507  131072  131396              bun:87493  00102 0000000c 0000000008f5ff67 20000080 01000800      3      0 000004
tcp4       0      0  127.0.0.1.57407        127.0.0.1.47380        ESTABLISHED        47822        12242  131072  131396     IPNExtension:91314  00102 00000008 0000000008f5ff66 00000081 04000900      2      0 000000
tcp4       0      0  127.0.0.1.57408        127.0.0.1.47380        ESTABLISHED          404            0  408192  146988   Google Chrome H:4242  00102 00000004 0000000008ffd0b7 00000081 01000800      2      0 000000
tcp4       0      0  127.0.0.1.57409        127.0.0.1.47380        TIME_WAIT              0            0  408192  146988                   :0  00102 00000004 0000000008ffd0b7 00000081 01000800      2      0 000000
tcp4       0      0  127.0.0.1.47380        *.*                    LISTEN                 0            0  131072  131072              bun:87493  00100 00000006 0000000008f5ff35 00000001 00000800      1      0 000000
`;

// Older releases: a numeric pid column.
const OLDER = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options
tcp4       0      0  127.0.0.1.57407        127.0.0.1.47380        ESTABLISHED 408300 146988    700      0 0x0102 0x00000008
tcp4       0      0  127.0.0.1.47380        127.0.0.1.57407        ESTABLISHED 408300 146988    800      0 0x0102 0x0000000c
`;

describe("connection's process", () => {
	test("finds the client end of the connection, not the server's", () => {
		expect(connectionPid(CURRENT, 57407, 47380)).toBe(91314);
		expect(connectionPid(CURRENT, 57408, 47380)).toBe(4242);
		expect(connectionPid(OLDER, 57407, 47380)).toBe(700);
	});
	test("unknown or no-longer-established connections have no process", () => {
		expect(connectionPid(CURRENT, 57409, 47380)).toBeNull();
		expect(connectionPid(CURRENT, 1, 47380)).toBeNull();
		expect(connectionPid(CURRENT, 57407, 47381)).toBeNull();
		expect(connectionPid("", 57407, 47380)).toBeNull();
	});
});

describe("trusted peer", () => {
	const fake = (owners: Record<number, number>, netstat = CURRENT): Exec => async (command) =>
		command[0].endsWith("netstat")
			? { code: 0, stdout: netstat }
			: owners[Number(command.at(-1))] === undefined
				? { code: 1, stdout: "" }
				: { code: 0, stdout: `  ${owners[Number(command.at(-1))]}\n` };

	test("Tailscale running as this user or as root is trusted", async () => {
		expect(await loopbackPeerTrusted(57407, 47380, { exec: fake({ 91314: 501 }), uid: 501 })).toBe(true);
		expect(await loopbackPeerTrusted(57407, 47380, { exec: fake({ 91314: 0 }), uid: 501 })).toBe(true);
	});
	test("another account's process, a vanished process or an unknown connection is refused", async () => {
		expect(await loopbackPeerTrusted(57407, 47380, { exec: fake({ 91314: 502 }), uid: 501 })).toBe(false);
		expect(await loopbackPeerTrusted(57407, 47380, { exec: fake({}), uid: 501 })).toBe(false);
		expect(await loopbackPeerTrusted(1, 47380, { exec: fake({ 91314: 501 }), uid: 501 })).toBe(false);
		const failing: Exec = async () => ({ code: 1, stdout: "" });
		expect(await loopbackPeerTrusted(57407, 47380, { exec: failing, uid: 501 })).toBe(false);
		const throwing: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(await loopbackPeerTrusted(57407, 47380, { exec: throwing, uid: 501 })).toBe(false);
	});

	test.skipIf(process.platform !== "darwin")("on macOS, a real loopback connection from this process is trusted", async () => {
		let verdict: Promise<boolean> | null = null;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request, server) {
				verdict = loopbackPeerTrusted(server.requestIP(request)!.port, server.port!);
				return new Response("ok");
			},
		});
		try {
			await fetch(`http://127.0.0.1:${server.port}/`);
			expect(await verdict!).toBe(true);
			// The same check for this process's uid plus one refuses it as another account.
			const otherUid = process.getuid!() + 1;
			const other = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request, s) {
					verdict = loopbackPeerTrusted(s.requestIP(request)!.port, s.port!, { uid: otherUid });
					return new Response("ok");
				},
			});
			await fetch(`http://127.0.0.1:${other.port}/`);
			expect(await verdict!).toBe(false);
			other.stop(true);
		} finally {
			server.stop(true);
		}
	});
});
