/** Development control planes accept local origins; cross-site pages cannot approve execution through them. */
export function localControlRequest(request: Request) {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}
