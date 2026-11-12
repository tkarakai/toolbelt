import { describe, test, expect } from "bun:test";
import { GitHubMetadata, GitHubError } from "../src/bun/github-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = "https://api.github.com/repos/example/tool/releases/latest";
function fixture(replies: (Response | Error)[]) {
  let now = 1800000000000;
  const requests: RequestInit[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(init);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw Error("Unexpected fetch");
    return reply;
  }) as typeof fetch;
  const client = new GitHubMetadata({ fetch: fetcher, now: () => now });
  return { client, requests, advance: (ms: number) => { now += ms; }, now: () => now, fetcher };
}
const fail = (status: number, message: string, headers: Record<string, string> = {}) => Response.json({ message }, { status, headers });
async function failure(work: Promise<unknown>) {
  try { await work; throw Error("Expected rejection"); } catch (error) { expect(error).toBeInstanceOf(GitHubError); return (error as GitHubError).failure; }
}
describe("GitHub metadata", () => {
  test("classifies JSON errors without treating every 403 as throttling", async () => {
    for (const [response, kind] of [
      [fail(403, "API rate limit exceeded", {"x-ratelimit-remaining":"0"}), "quota"],
      [fail(403, "You have exceeded a secondary rate limit"), "throttled"],
      [fail(429, "Slow down"), "throttled"],
      [fail(403, "Forbidden"), "access"], [fail(404, "Not Found"), "missing"],
      [fail(503, "Unavailable"), "service"], [new Error("offline"), "network"],
    ] as const) {
      const {client} = fixture([response]);
      expect((await failure(client.get(url))).kind).toBe(kind);
    }
  });
  test("quota reset blocks other repositories and channels until permitted", async () => {
    const f = fixture([fail(403, "quota", {"x-ratelimit-remaining":"0", "x-ratelimit-reset":"1800000720"}), Response.json({tag_name:"v1"})]);
    expect((await failure(f.client.get(url))).retryAt).toBe(f.now() + 720000);
    await failure(f.client.get(url + "?channel=other"));
    expect(f.requests.length).toBe(1);
    f.advance(720000);
    await f.client.get(url);
    expect(f.requests.length).toBe(2);
  });
  test("Retry-After supports seconds and dates and respects the later quota reset", async () => {
    for (const retry of ["120", new Date(1800000120000).toUTCString()]) {
      const f = fixture([fail(429, "slow", {"retry-after":retry})]);
      expect((await failure(f.client.get(url))).retryAt).toBe(f.now()+120000);
    }
    const f = fixture([fail(403, "quota", {"retry-after":"60", "x-ratelimit-remaining":"0", "x-ratelimit-reset":"1800000720"})]);
    expect((await failure(f.client.get(url))).retryAt).toBe(f.now()+720000);
  });
  test("missing or invalid timing uses bounded exponential delays", async () => {
    const f = fixture(Array.from({length:8}, () => fail(429, "slow", {"retry-after":"invalid"})));
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = Math.min(60000 * 2 ** attempt, 1800000);
      expect((await failure(f.client.get(url))).retryAt).toBe(f.now()+delay);
      f.advance(delay);
    }
  });
  test("deduplicates in-flight lookups and revalidates ETags; errors preserve metadata", async () => {
    const f = fixture([Response.json({ tag_name:"v1" }, {headers:{etag:'"one"'}}), fail(503,"Unavailable"), new Response(null, {status:304})]);
    const [a,b] = await Promise.all([f.client.get(url), f.client.get(url)]);
    expect(a.data).toEqual(b.data);
    expect(f.requests.length).toBe(1);
    await failure(f.client.get(url));
    f.advance(1000);
    expect((await f.client.get(url)).data).toEqual({tag_name:"v1"});
    expect(new Headers(f.requests[2]!.headers).get("if-none-match")).toBe('"one"');
  });
  test("cache and cooldown survive restart, scoped to their profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-gh-"));
    try {
      const f = fixture([Response.json({tag_name:"v1"}, {headers:{etag:'"one"'}}), fail(429,"slow", {"retry-after":"120"}), new Response(null,{status:304})]);
      const options = {file:join(dir,"cache.json"), fetch:f.fetcher, now:f.now};
      const client = new GitHubMetadata(options);
      await client.get(url);
      await failure(client.get(url));
      const restored = new GitHubMetadata(options);
      await failure(restored.get(url));
      expect(f.requests.length).toBe(2);
      f.advance(120000);
      expect((await restored.get(url)).data).toEqual({tag_name:"v1"});
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test("one subscriber cancelling does not abort the shared request", async () => {
    const f = fixture([Response.json({tag_name:"v1"})]);
    const abort = new AbortController();
    const first = f.client.get(url,{signal:abort.signal});
    const second = f.client.get(url);
    abort.abort();
    await expect(first).rejects.toThrow();
    expect((await second).data).toEqual({tag_name:"v1"});
    expect(f.requests.length).toBe(1);
  });
});

test("non-rate errors are dated, shared across repositories, expire, and never gate requests", async () => {
  const f = fixture([fail(503,"Unavailable",{"retry-after":"3600"}), Response.json({tag_name:"v1"})]);
  let broadcasts=0;
  f.client.listeners.add(()=>broadcasts++);
  const error=await failure(f.client.get(url));
  expect(error.at).toBe(f.now());
  expect(error.retryAt).toBeUndefined();
  expect(f.client.cooldown(url)).toBeUndefined();
  expect(f.client.notice("https://api.github.com/repos/other/tool/releases/latest")).toEqual(error);
  expect(broadcasts).toBe(1);
  f.advance(2*3600000);
  expect(f.client.notice(url)).toBeUndefined();
  await f.client.get(url);
  expect(f.requests.length).toBe(2);
  expect(broadcasts).toBe(2);
});

test("rate-limit notice survives the cooldown, expires two hours later and clears on success", async () => {
  const f=fixture([fail(429,"slow",{"retry-after":"60"}), Response.json({tag_name:"v1"})]);
  await failure(f.client.get(url));
  f.advance(60000);
  expect(f.client.cooldown(url)).toBeUndefined();
  expect(f.client.notice(url)?.kind).toBe("throttled");
  f.advance(2*3600000-1);
  expect(f.client.notice(url)?.kind).toBe("throttled");
  f.advance(1);
  expect(f.client.notice(url)).toBeUndefined();
  await f.client.get(url);
  expect(f.client.notice(url)).toBeUndefined();
});

test("records the receipt time, retry source and diagnostic headers", async () => {
  const f=fixture([fail(403,"quota",{"x-ratelimit-remaining":"0","x-ratelimit-limit":"60","x-ratelimit-used":"60","x-ratelimit-resource":"core","x-ratelimit-reset":"1800000720","x-github-request-id":"ABCD:1234","date":new Date(1800000000000).toUTCString()})]);
  const error=await failure(f.client.get(url));
  expect(error.at).toBe(f.now());
  expect(error.retrySource).toBe("quota-reset");
  expect(error.rateLimit).toEqual({limit:60,remaining:0,used:60,resource:"core"});
  expect(error.requestId).toBe("ABCD:1234");
  expect(error.serverAt).toBe(f.now());
  const explicit=fixture([fail(429,"slow",{"retry-after":"120"})]);
  expect((await failure(explicit.client.get(url))).retrySource).toBe("retry-after");
  const estimated=fixture([fail(429,"slow")]);
  expect((await failure(estimated.client.get(url))).retrySource).toBe("backoff");
});
