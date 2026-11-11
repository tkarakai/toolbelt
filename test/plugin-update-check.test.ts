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
  const packages = {root,recoveryWarnings:[],listeners:new Set(), registry:() => readRegistry(root), releaseCandidate:(candidate:Candidate) => released.push(candidate.manifest.id), install:async () => {executions++;}} as unknown as PackageManager;
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
