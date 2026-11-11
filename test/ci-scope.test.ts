import { expect, test } from "bun:test";
import { sdkReleaseOnly, type Change } from "../scripts/ci-scope";
const changes = (channel = "stable", before = "0.3.1", after = "0.3.2"): Change[] => [
  { path: ".toolbelt-release.json", before: "{}", after: JSON.stringify({format:1,repo:"tkarakai/toolbelt",product:"sdk",version:after,channel}) },
  { path: "packages/sdk/CHANGELOG.md", before: "## Unreleased\n- Change", after: `## ${after}\n- Change` },
  { path: "src/shared/package.ts", before: `export const SDK_VERSION = "${before}";\nexport const LIMIT = 1;`, after: `export const SDK_VERSION = "${after}";\nexport const LIMIT = 1;` },
];
test("SDK stable and prerelease version-only requests select complete SDK validation", () => {
  expect(sdkReleaseOnly(changes())).toBe(true);
  expect(sdkReleaseOnly(changes("prerelease", "0.3.2", "0.3.3-rc.1"))).toBe(true);
});
test("host code, workflow, contract and dependency edits retain full app CI", () => {
  for (const path of ["src/ui/renderer/Render.tsx","src/shared/protocol.ts","src/shared/validation.ts",".github/workflows/ci.yml","package.json","bun.lock"]) expect(sdkReleaseOnly([...changes(),{path,before:"a",after:"b"}])).toBe(false);
  const c=changes();c[2].after += "\nexport const NEW_LIMIT = 2;";
  expect(sdkReleaseOnly(c)).toBe(false);
});
test("malformed, missing, added, removed and mismatched release metadata never skips app CI", () => {
  expect(sdkReleaseOnly([])).toBe(false);
  expect(sdkReleaseOnly(changes().slice(1))).toBe(false);
  for (const field of ["before","after"] as const) {const c=changes();c[0][field]=null;expect(sdkReleaseOnly(c)).toBe(false);}
  for (const after of ["{",JSON.stringify({format:1,repo:"other/repo",product:"sdk",version:"0.3.2",channel:"stable"}),JSON.stringify({format:1,repo:"tkarakai/toolbelt",product:"app",version:"0.3.2",channel:"stable"}),JSON.stringify({format:1,repo:"tkarakai/toolbelt",product:"sdk",version:"9.9.9",channel:"stable"})]) {const c=changes();c[0].after=after;expect(sdkReleaseOnly(c)).toBe(false);}
  expect(sdkReleaseOnly(changes("stable","0.3.2","0.3.2"))).toBe(false);
  expect(sdkReleaseOnly(changes("stable","0.3.2","0.3.1"))).toBe(false);
});

test("scope command classifies real push/PR diffs and defaults manual runs to full CI", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "tb-ci-scope-"));
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd: root, stdout:"pipe", stderr:"pipe" });
    const out = await new Response(p.stdout).text();
    if (await p.exited) throw Error(await new Response(p.stderr).text());
    return out.trim();
  };
  try {
    await git("init");
    mkdirSync(join(root,"src/shared"),{recursive:true});mkdirSync(join(root,"packages/sdk"),{recursive:true});
    for(const c of changes())writeFileSync(join(root,c.path),c.before!);
    await git("add",".");await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","base");
    const base=await git("rev-parse","HEAD");
    for(const c of changes())writeFileSync(join(root,c.path),c.after!);
    await git("add",".");await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","SDK release");
    const classify=async(name:string,event:unknown)=>{
      writeFileSync(join(root,"event.json"),JSON.stringify(event));writeFileSync(join(root,"output"),"");
      const p=Bun.spawn([process.execPath,join(import.meta.dir,"../scripts/ci-scope.ts")],{cwd:root,env:{...process.env,GITHUB_EVENT_NAME:name,GITHUB_EVENT_PATH:join(root,"event.json"),GITHUB_OUTPUT:join(root,"output")},stdout:"pipe",stderr:"pipe"});
      expect(await p.exited).toBe(0);return readFileSync(join(root,"output"),"utf8");
    };
    expect(await classify("push",{before:base})).toBe("sdk=true\n");
    expect(await classify("pull_request",{pull_request:{base:{sha:base}}})).toBe("sdk=true\n");
    expect(await classify("workflow_dispatch",{})).toBe("sdk=false\n");
    expect(await classify("push",{before:"0".repeat(40)})).toBe("sdk=false\n");
    writeFileSync(join(root,"host.ts"),"export const changed = true;");await git("add","host.ts");await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","host change");
    expect(await classify("push",{before:base})).toBe("sdk=false\n");
  } finally {rmSync(root,{recursive:true,force:true});}
});
