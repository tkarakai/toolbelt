// ToolBelt's service worker on remote devices (docs/remote-access.md). It keeps the app shell so
// the app starts without downloading code over a slow link:
// - hashed build files (/assets/) come from the cache once fetched; a new UI build starts a
//   fresh cache, so old builds don't pile up;
// - the page itself always asks the Mac first and falls back to the cached copy, whose
//   connection banner then explains that the Mac can't be reached. Tailscale Serve answers
//   502/504 while ToolBelt isn't listening (quit, or remote access off), and ToolBelt answers
//   503 while it can't read the owner: those count as unreachable too;
// - /rpc and /.well-known/ are never touched.
const SHELL = "toolbelt-shell";
const ASSETS = "toolbelt-assets";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ToolBelt</title><style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box;text-align:center;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #8886;background:transparent;color:inherit}</style>
<div><h1 style="font-size:1.1rem">Can’t reach your Mac</h1><p>Check that your Mac is awake, ToolBelt is running with remote access on, and Tailscale is connected on both devices.</p><button onclick="location.reload()">Try again</button></div></html>`;

/** Fetches like `fetch`, but a gateway error (nothing behind Serve) fails like the network. */
async function fromMac(request) {
	const response = await fetch(request);
	if (response.status === 502 || response.status === 503 || response.status === 504) throw new Error("unreachable");
	return response;
}

const buildOf = (html) => html.match(/<script[^>]+src="[^"]*?([^"/]+\.js)"/)?.[1] ?? null;

async function page(request) {
	const shell = await caches.open(SHELL);
	try {
		const response = await fromMac(request);
		if (response.ok) {
			const html = await response.clone().text();
			const build = buildOf(html);
			const previous = await shell.match("build").then((r) => r?.text());
			if (build && previous && build !== previous) await caches.delete(ASSETS);
			if (build) await shell.put("build", new Response(build));
			await shell.put("page", response.clone());
		}
		return response;
	} catch {
		return (await shell.match("page")) ?? new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } });
	}
}

async function asset(request) {
	const cache = await caches.open(ASSETS);
	const hit = await cache.match(request);
	if (hit) return hit;
	const response = await fetch(request);
	if (response.ok) await cache.put(request, response.clone());
	return response;
}

async function other(request) {
	const cache = await caches.open(SHELL);
	try {
		const response = await fromMac(request);
		if (response.ok) await cache.put(request, response.clone());
		return response;
	} catch {
		const hit = await cache.match(request);
		if (hit) return hit;
		throw new Error("offline");
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || url.pathname === "/rpc" || url.pathname.startsWith("/.well-known/")) return;
	if (request.mode === "navigate") return event.respondWith(page(request));
	if (url.pathname.startsWith("/assets/")) return event.respondWith(asset(request));
	event.respondWith(other(request));
});
