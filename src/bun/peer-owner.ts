// Who is on the other end of a loopback connection (docs/remote-access.md). Every macOS account
// and daemon shares 127.0.0.1, and anything there can forge Tailscale Serve's identity header.
// Through Serve, the connecting process is Tailscale itself: the App Store extension runs as the
// signed-in user, the standalone and open-source daemons as root. Remote access accepts its RPC
// socket only from those two owners, so another account on the Mac can't pose as Serve.
//
// The kernel reports each socket's process to any user (`netstat -anv`), and `ps` maps it to a
// user ID. Serve can't proxy to an owner-only Unix socket instead: the App Store extension is
// sandboxed and refuses Unix sockets outside its own container.

export type Exec = (command: string[]) => Promise<{ code: number; stdout: string }>;

const exec: Exec = async (command) => {
	const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 });
	const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { code, stdout };
};

/**
 * The process holding the client end of `127.0.0.1:clientPort → 127.0.0.1:serverPort` in
 * `netstat -anv -p tcp` output, or null. Handles both layouts: `process:pid` (current macOS) and a
 * numeric `pid` column (older releases).
 */
export function connectionPid(netstat: string, clientPort: number, serverPort: number): number | null {
	const lines = netstat.split("\n");
	const header = lines.find((line) => /^Proto\s/.test(line)) ?? "";
	// "Local Address" and "Foreign Address" are two header words but one field each.
	const pidColumn = header.split(/\s+/).indexOf("pid") - 2;
	const local = `127.0.0.1.${clientPort}`;
	const foreign = `127.0.0.1.${serverPort}`;
	for (const line of lines) {
		const fields = line.trim().split(/\s+/);
		if (!fields[0]?.startsWith("tcp4") || fields[3] !== local || fields[4] !== foreign) continue;
		if (fields[5] !== "ESTABLISHED") continue;
		// The process name may contain spaces; state and option flags (hex) follow `name:pid`.
		const named = line.match(/:(\d+)\s+[0-9a-f]{5}\s+[0-9a-f]{8}\s/);
		const pid = named ? Number(named[1]) : pidColumn > 5 ? Number(fields[pidColumn]) : NaN;
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	}
	return null;
}

/** Whether the client end of a loopback connection belongs to this user or root. Fails closed. */
export async function loopbackPeerTrusted(
	clientPort: number,
	serverPort: number,
	options: { exec?: Exec; uid?: number } = {},
): Promise<boolean> {
	const run = options.exec ?? exec;
	const uid = options.uid ?? process.getuid?.();
	if (uid === undefined) return false;
	try {
		const netstat = await run(["/usr/sbin/netstat", "-anv", "-p", "tcp"]);
		if (netstat.code !== 0) return false;
		const pid = connectionPid(netstat.stdout, clientPort, serverPort);
		if (pid === null) return false;
		const ps = await run(["/bin/ps", "-o", "uid=", "-p", String(pid)]);
		const owner = Number(ps.stdout.trim());
		return ps.code === 0 && ps.stdout.trim() !== "" && (owner === 0 || owner === uid);
	} catch {
		return false;
	}
}
