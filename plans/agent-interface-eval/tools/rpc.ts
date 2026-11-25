// Calls the browser preview's RPC (as the ToolBelt UI would): bun rpc.ts <port> <method> '<json params>'
const [port, method, params = "{}"] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
const timer = setTimeout(() => (console.error("timeout"), process.exit(1)), 120_000);
ws.onopen = () => ws.send(JSON.stringify({ kind: "request", id: 1, method, params: JSON.parse(params) }));
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	if (m.kind === "response" && m.id === 1) {
		clearTimeout(timer);
		console.log(JSON.stringify(m.error ? { error: m.error } : m.result, null, 2));
		ws.close();
		process.exit(m.error ? 1 : 0);
	}
};
ws.onerror = (e) => (console.error("ws error", e), process.exit(1));
