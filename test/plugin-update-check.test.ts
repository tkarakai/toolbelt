import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManagerService } from "../src/bun/plugin-manager-service";
import { readRegistry, atomicJSON, type PackageManager, type Registry, type Candidate, type Installed } from "../src/bun/packages";
import type { PluginHost } from "../src/bun/host";
import { parsePackageManifest } from "../src/shared/package";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "toolbelt-check-update-"));
  mkdirSync(join(root, "plugins"));
  const plugin = (id: string): Installed => ({id, repo:`test/${id}`, version:"1.0.0", hash:"a".repeat(64), packageRoot:join(root,"plugins/packages",id,`1.0.0-${"a".repeat(64)}`), enabled:true, channel:"stable", manifest:parsePackageManifest({
    formatVersion:1,id,name:id,repo:`test/${id}`,version:"1.0.0",entry:"index.js",protocol:1,
    requires:{host:">=0.1.0",bun:">=1.3.0",platforms:["portable"]},capabilities:{required:["ui.core"],optional:[]},data:{schema:1},screens:[{id:"main",title:"Main"}],
  })});
  const registry: Registry = {formatVersion:1, plugins:{first:plugin("first"),second:plugin("second")},updateSchedule:{lastChecked:10,nextCheck:20}};
  registry.plugins.second!.availableVersion="1.5.0";
  atomicJSON(join(root,"plugins/registry.json"),registry);
  let executions = 0;
  const released: string[] = [], requested: string[] = [];
  const packages = {root,collectCandidates:()=>{},recoveryWarnings:[],listeners:new Set(), registry:() => readRegistry(root), releaseCandidate:(candidate:Candidate) => released.push(candidate.manifest.id), install:async () => {executions++;}} as unknown as PackageManager;
  const host = {subscribe:() => {},list:() => [],prepare:async () => {executions++;},stop:async () => {executions++;}} as unknown as PluginHost;
  const resolve = async (_manager:PackageManager,repo:string): Promise<Candidate> => {
    requested.push(repo);
    const id=repo.split("/")[1]!;
    return {repo,hash:"b".repeat(64),packageRoot:root,manifest:{...registry.plugins[id]!.manifest,version:"2.0.0"}};
  };
  return {root,registry,packages,host,requested,released,resolve,executions:() => executions};
}

test("checking all plugins discovers releases without executing or installing them", async () => {
  const f=fixture();
  try {
    const service=new PluginManagerService(f.packages,f.host,f.resolve);
    const response=await service.handle({operation:"checkUpdates"});
    expect(response.error).toBeUndefined();
    if (!response.state) throw new Error("Missing manager state");
    expect(f.requested).toEqual(["test/first", "test/second"]);
    expect(f.released).toEqual(["first", "second"]);
    expect(f.executions()).toBe(0);
    // Checking updates availability and schedule while installed releases remain unchanged.
    expect(response.state.plugins.find(p=>p.id==="first")?.availableVersion).toBe("2.0.0");
    expect(response.state.plugins.find(p=>p.id==="second")?.availableVersion).toBe("2.0.0");
    expect(response.state.schedule.lastChecked).toBeGreaterThan(10);
    expect(response.state.schedule.nextCheck).toBeGreaterThan(20);
    expect(response.state.plugins.find(p=>p.id==="first")?.version).toBe("1.0.0");
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("failed checks retain installed releases and report errors without executing plugins",async () => {
  const f=fixture();
  try {
    const service=new PluginManagerService(f.packages,f.host,async () => {throw Error("Network unavailable");});
    const response = await service.handle({operation:"checkUpdates"});
    expect(response.state?.schedule.error).toContain("Network unavailable");
    expect(response.state?.plugins.find(p => p.id === "first")?.version).toBe("1.0.0");
    expect(response.state?.plugins.find(p => p.id === "second")?.availableVersion).toBe("1.5.0");
    expect(f.executions()).toBe(0);
    expect(f.registry.plugins.second!.availableVersion).toBe("1.5.0");
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("availability records the detected release channel rather than the future update preference",async () => {
  const f=fixture();
  try {
    const registry=readRegistry(f.root);
    registry.plugins.first!.channel="prerelease";
    registry.plugins.first!.installedChannel="stable";
    atomicJSON(join(f.root,"plugins/registry.json"),registry);
    const service=new PluginManagerService(f.packages,f.host,async (manager,repo,options) => {
      if (repo==="test/first") expect(options?.prerelease).toBe(true);
      const candidate=await f.resolve(manager,repo);
      return {...candidate,channel:repo==="test/first" ? "stable" : "prerelease",commit:"c".repeat(40)};
    });
    const result=await service.handle({operation:"checkUpdates"});
    const first=result.state!.plugins.find(p=>p.id==="first")!;
    expect(first.installedChannel).toBe("stable");
    expect(first.channel).toBe("prerelease");
    expect(first.availableChannel).toBe("stable");
    expect(first.availableCommit).toBe("c".repeat(40));
    expect(result.state!.plugins.find(p=>p.id==="second")!.availableChannel).toBe("prerelease");
    await service.handle({operation:"setChannel",id:"first",channel:"stable"});
    const changed=service.read().plugins.find(p=>p.id==="first")!;
    expect(changed.installedChannel).toBe("stable");
    expect(changed.availableVersion).toBeUndefined();
    expect(changed.availableChannel).toBeUndefined();
    expect(changed.availableCommit).toBeUndefined();
    expect(f.executions()).toBe(0);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});


test("failed check activities survive service restart and are followed by successful checks", async () => {
  const f = fixture();
  try {
    const failed = new PluginManagerService(f.packages, f.host, async () => {throw Error("Offline for test");});
    await failed.checkUpdates();
    const restored = new PluginManagerService(f.packages, f.host, f.resolve);
    expect(restored.read().plugins.find(p => p.id === "first")?.logs.at(-1)).toContain("Update check failed: first");
    expect(restored.read().schedule.error).toContain("Offline for test");
    await restored.checkUpdates();
    expect(restored.read().schedule.error).toBeUndefined();
    const logs = restored.read().plugins.find(p => p.id === "first")!.logs;
    expect(logs.at(-1)).toContain("Update available");
    expect(logs.some(line => line.includes("Offline for test"))).toBe(true);
    const restarted = new PluginManagerService(f.packages, f.host, f.resolve);
    expect(restarted.read().plugins.find(p => p.id === "first")!.logs).toEqual(logs.slice(-3));
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("structured update failures preserve the last successful result and date across restart", async () => {
  const { GitHubError } = await import("../src/shared/github");
  const f = fixture();
  try {
    await new PluginManagerService(f.packages,f.host,f.resolve).checkUpdates();
    const checked = readRegistry(f.root).plugins.first!.updateCheckedAt;
    const problem = {kind:"quota" as const, message:"Quota exhausted", status:403, retryAt:Date.now()+720000};
    const service = new PluginManagerService(f.packages,f.host,async () => {throw new GitHubError(problem);});
    await service.checkUpdates();
    const restored = new PluginManagerService(f.packages,f.host,f.resolve).read().plugins.find(p=>p.id === "first")!;
    expect(restored.availableVersion).toBe("2.0.0");
    expect(restored.updateCheckedAt).toBe(checked);
    expect(restored.updateFailure).toEqual(problem);
    const response = await service.handle({operation:"resolve",repo:"test/first"});
    expect(response.failure).toEqual(problem);
    expect(f.executions()).toBe(0);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("release review carries publisher release notes and exact tag through RPC", async () => {
  const f = fixture();
  try {
    const notes = "## Changes\n\n- A useful improvement\n\n[Details](https://github.com/test/first/releases/tag/v2.0.0)";
    const service = new PluginManagerService(f.packages, f.host, async (manager, repo) => ({...await f.resolve(manager,repo), release:"v2.0.0", notes}));
    const result = await service.handle({operation:"resolve",repo:"test/first"});
    expect(result.candidate?.release).toBe("v2.0.0");
    expect(result.candidate?.notes).toBe(notes);
    expect(f.executions()).toBe(0);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("plugin GitHub failures notify About immediately and persist the same notice on both tabs", async () => {
  const { Updater } = await import("../src/bun/updater");
  const { githubMetadata } = await import("../src/bun/github-metadata");
  const f=fixture();
  const previousFetch=globalThis.fetch;
  let notices=0;
  const updater=new Updater({version:"1.0.0",channel:"stable",stateFile:join(f.root,"update.json"),appPath:null,onChange:()=>{notices++;},relaunch:()=>{}});
  // A dev-channel instance subscribes without starting a network check of its own.
  const about=new Updater({version:"1.0.0",channel:"dev",stateFile:join(f.root,"update.json"),appPath:null,onChange:()=>{notices++;},relaunch:()=>{}});
  try {
    globalThis.fetch=(async()=>Response.json({message:"secondary rate limit"},{status:429,headers:{"retry-after":"720"}})) as unknown as typeof fetch;
    about.start();
    const client=githubMetadata(join(f.root,"cache/github-metadata.json"));
    await expect(client.get("https://api.github.com/repos/test/first/releases/latest")).rejects.toThrow();
    const plugins=new PluginManagerService(f.packages,f.host,f.resolve).read();
    expect(notices).toBe(3); // request history, response history, shared failure
    expect(about.state().failure?.kind).toBe("throttled");
    expect(updater.state().retryAt).toBe(plugins.schedule.retryAt);
    expect(about.state().failure).toEqual(plugins.schedule.failure);
    expect(about.state().githubHistory).toEqual(plugins.githubHistory);
    expect(plugins.githubHistory[0]?.status).toBe(429);
  } finally {about.stop();globalThis.fetch=previousFetch;rmSync(f.root,{recursive:true,force:true});}
});
