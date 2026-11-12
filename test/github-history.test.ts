import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubMetadata } from "../src/bun/github-metadata";
import { GITHUB_HISTORY_AGE, quotaComparison, quotaNumber, type GitHubCall } from "../src/shared/github-history";
const url = "https://api.github.com/repos/example/tool/releases/latest";

describe("GitHub quota history", () => {
  test("records every real call including success, 304, quota failure and network failure; not blocked or shared lookups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-quota-"));
    let now = 1800000000000;
    let sent = 0;
    const replies = [
      Response.json({tag_name:"v1"}, {headers:{etag:'"one"', "x-ratelimit-remaining":"42", "x-ratelimit-used":"18", "x-ratelimit-reset":"1800000720", "set-cookie":"secret"}}),
      new Response(null, {status:304, headers:{"x-ratelimit-remaining":"41"}}),
      Response.json({message:"private body"}, {status:403, headers:{"x-ratelimit-remaining":"0", "x-ratelimit-reset":"1800000720"}}),
    ];
    const fetcher = (async () => { sent++; const response = replies.shift(); if (!response) throw Error("secret network error"); return response; }) as unknown as typeof fetch;
    const options = {file:join(dir,"metadata.json"), fetch:fetcher, now:()=>now};
    try {
      const client = new GitHubMetadata(options);
      const endpoint = url + "?token=secret";
      await Promise.all([client.get(endpoint, {trigger:"scheduled",headers:{Authorization:"Bearer secret"}}), client.get(endpoint)]);
      await client.get(endpoint);
      await expect(client.get(endpoint)).rejects.toThrow();
      await expect(client.get(endpoint)).rejects.toThrow();
      now += 720000;
      await expect(client.get(endpoint)).rejects.toThrow();
      expect(sent).toBe(4);
      const calls = client.history();
      expect(calls).toHaveLength(4);
      expect(calls.map(call=>call.status)).toEqual([200,304,403,undefined]);
      expect(calls[3]!.networkError).toBe(true);
      expect(quotaNumber(calls[0]!,"used")).toBe(18);
      expect(quotaNumber(calls[0]!,"remaining")).toBe(42);
      expect(calls[0]!.trigger).toBe("scheduled");
      expect(calls[0]!.authenticated).toBe(true);
      expect(calls[1]!.conditional).toBe(true);
      const file = join(dir,"github-history.json");
      const raw = readFileSync(file,"utf8");
      expect(raw).not.toContain("secret");
      expect(raw).not.toContain("private body");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(new GitHubMetadata(options).history()).toEqual(calls);
      now = calls[0]!.at + GITHUB_HISTORY_AGE;
      expect(client.history()).toHaveLength(1);
      now += 720000;
      client.pruneHistory();
      expect(JSON.parse(readFileSync(file,"utf8")).calls).toEqual([]);
      expect(new GitHubMetadata(options).history()).toEqual([]);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test("records each redirect hop and download without consuming bodies or leaking credentials", async () => {
    const observed: {url:string; headers:Headers; redirect:RequestRedirect|undefined}[] = [];
    const client = new GitHubMetadata({ fetch: (async (input: string, init: RequestInit) => {
      observed.push({url:input,headers:new Headers(init.headers),redirect:init.redirect});
      if (observed.length === 1) return new Response(null,{status:302,headers:{location:"https://assets.example/download?signature=secret","x-ratelimit-remaining":"12"}});
      return new Response("archive bytes");
    }) as unknown as typeof fetch });
    const response = await client.fetchResponse(url,{headers:{Authorization:"Bearer secret",Cookie:"secret"}},{purpose:"download",trigger:"manual"});
    expect(await response.text()).toBe("archive bytes");
    expect(observed[0]!.redirect).toBe("manual");
    expect(observed[1]!.headers.has("Authorization")).toBe(false);
    expect(observed[1]!.headers.has("Cookie")).toBe(false);
    const calls = client.history();
    expect(calls.map(call=>call.status)).toEqual([302,200]);
    expect(calls.every(call=>call.purpose === "download")).toBe(true);
    expect(calls[1]!.headers).toEqual({});
    expect(JSON.stringify(calls)).not.toContain("secret");
  });
  test("an in-flight request is persisted and remains visible if no response arrives", async () => {
    let finish!: (response: Response)=>void;
    const client = new GitHubMetadata({fetch:(()=>new Promise(resolve=>{finish=resolve;})) as unknown as typeof fetch});
    const work = client.get(url);
    expect(client.history()).toHaveLength(1);
    expect(client.history()[0]!.completedAt).toBeUndefined();
    finish(Response.json({}));
    await work;
    expect(client.history()[0]!.status).toBe(200);
  });
});
function sample(id: string, at: number, used: string, reset = "1800000720"): GitHubCall {
  return {id,at,completedAt:at+10,pid:1,url,headers:{"x-ratelimit-used":used,"x-ratelimit-remaining":String(60-Number(used)),"x-ratelimit-limit":"60","x-ratelimit-reset":reset,"x-ratelimit-resource":"core"},purpose:"metadata",conditional:false,authenticated:false};
}
test("compares shared quota usage with host calls only within a comparable window", () => {
  const first=sample("a",100, "10"), second=sample("b",200,"40");
  expect(quotaComparison(second,[first,second])).toEqual({delta:30,appCalls:1});
  expect(quotaComparison(first,[first,second])).toBeNull();
  expect(quotaComparison(sample("c",300,"1","new-window"),[first,second])).toBeNull();
  expect(quotaComparison({...second,authenticated:true},[first,second])).toBeNull();
  expect(quotaComparison({...second,headers:{}},[first,second])).toBeNull();
  expect(quotaComparison(sample("d",300,"9"),[first])).toEqual({delta:-1,appCalls:0});
});
