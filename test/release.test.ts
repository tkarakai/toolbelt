import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  cpSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freeze,
  hash,
  prepareNotes,
  releaseNotes,
  save,
  validateRequest,
  verifyFrozen,
  tagOf,
  run,
  packagePlugin,
  type ReleaseConfig,
  type Request,
} from "../src/release/core";
import { GitHub, publish } from "../src/release/github";
const roots: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), "tb-release-test-"));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const config: ReleaseConfig = {
  repo: "example/plugin",
  hostVersion: "0.1.0",
  products: {
    plugin: {
      changelog: "CHANGELOG.md",
      version: () => "1.0.0",
      async setVersion() {},
      async build() {
        return [];
      },
    },
  },
};
const request: Request = {
  format: 1,
  repo: config.repo,
  product: "plugin",
  version: "1.0.1",
  channel: "stable",
};
const source = "a".repeat(40);
test("explicit product, version and channel rules", () => {
  expect(validateRequest(request, config)).toEqual(request);
  for (const changes of [
    { version: "1.0.1-rc.1" },
    { channel: "prerelease" },
    { version: "1.0" },
    { version: "01.0.1" },
    { version: "1.0.1+rebuild" },
    { repo: "another/plugin" },
    { product: "app" },
  ])
    expect(() => validateRequest({ ...request, ...changes }, config)).toThrow();
  expect(
    validateRequest(
      { ...request, version: "1.0.1-rc.1", channel: "prerelease" },
      config,
    ).channel,
  ).toBe("prerelease");
});
test("notes move only Unreleased and reject empty sections", () => {
  const notes = prepareNotes(
    "# Changes\n\n## Unreleased\n\n- Something new\n\n## 1.0.0 — 2026-01-01\n\n- Old\n",
    "1.0.1",
  );
  expect(releaseNotes(notes, "1.0.1")).toBe("- Something new");
  expect(notes).toContain("## Unreleased");
  expect(() => prepareNotes("## Unreleased\n\n### Added\n", "1.0.1")).toThrow();
});
test("frozen candidate binds bytes, source and filenames", () => {
  const root = temp();
  writeFileSync(join(root, "a.tgz"), "one");
  const out = join(root, "candidate");
  freeze(request, source, [join(root, "a.tgz")], "Notes", out);
  expect(verifyFrozen(out, config).source).toBe(source);
  writeFileSync(join(out, "a.tgz"), "two");
  expect(() => verifyFrozen(out, config)).toThrow("Frozen bytes");
});
function fixture(releaseRequest: Request = request) {
  const tag = tagOf(releaseRequest);
  const transitions: string[] = [];
  let authorized = true;
  let latest: any = null;
  const root = temp();
  writeFileSync(join(root, "plugin.tgz"), "fixture");
  const candidate = join(root, "candidate");
  const record = freeze(
    releaseRequest,
    source,
    [join(root, "plugin.tgz")],
    "Notes",
    candidate,
  );
  let release: any = null,
    ref: any = null;
  let writes = 0;
  let failAfter: string | undefined;
  const bytes = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url),
        p = url.pathname.replace("/repos/example/plugin/", "");
      const response = (value: unknown) => Response.json(value);
      const fail = (stage: string) => {
        if (failAfter === stage) {
          failAfter = undefined;
          return new Response("lost response", { status: 503 });
        }
        return null;
      };
      if (p === `commits/${source}`)
        return response({
          sha: source,
          files: authorized
            ? [{ filename: ".toolbelt-release.json", status: "modified" }]
            : [],
        });
      if (p === `commits/${source}/pulls`)
        return response([
          {
            merged_at: "today",
            merge_commit_sha: source,
            base: { ref: "main", repo: { full_name: config.repo } },
            head: { repo: { full_name: config.repo } },
          },
        ]);
      if (p === "contents/.toolbelt-release.json")
        return response({
          encoding: "base64",
          content: Buffer.from(JSON.stringify(releaseRequest)).toString(
            "base64",
          ),
        });
      if (p === "git/ref/tags/" + tag)
        return ref ? response(ref) : new Response("", { status: 404 });
      if (p === "git/tags" && req.method === "POST") {
        writes++;
        return fail("tag-object") || response({ sha: "tag-object" });
      }
      if (p === "git/refs" && req.method === "POST") {
        writes++;
        ref = { object: { type: "tag", sha: "tag-object" } };
        return fail("ref") || response(ref);
      }
      if (p === "git/tags/tag-object")
        return response({ object: { type: "commit", sha: source } });
      if (p === "releases/1" && req.method === "GET") return response(release);
      if (p === "releases/latest")
        return latest ? response(latest) : new Response("", { status: 404 });
      if (p === "releases" && req.method === "GET")
        return response(release ? [release] : []);
      if (p === "releases" && req.method === "POST") {
        writes++;
        release = {
          id: 1,
          tag_name: tag,
          draft: true,
          prerelease: releaseRequest.channel === "prerelease",
          assets: [],
          upload_url: `${server.url}upload{?name}`,
          html_url: "https://example.test/release",
        };
        return fail("draft") || response(release);
      }
      if (url.pathname === "/upload") {
        writes++;
        const name = url.searchParams.get("name")!,
          data = new Uint8Array(await req.arrayBuffer());
        bytes.set(name, data);
        release.assets.push({
          name,
          size: data.length,
          url: `${server.url}asset?name=${encodeURIComponent(name)}`,
        });
        return fail("upload") || response({});
      }
      if (url.pathname === "/asset")
        return new Response(
          new Uint8Array(bytes.get(url.searchParams.get("name")!)!).buffer,
        );
      if (p === "releases/1" && req.method === "PATCH") {
        writes++;
        const patch = await req.json();
        transitions.push(patch.make_latest);
        release.draft = false;
        if (patch.make_latest === "true") latest = { ...release };
        return fail("publish") || response(release);
      }
      return new Response(p, { status: 404 });
    },
  });
  return {
    transitions,
    setLatest: (version: string) => { latest = { tag_name: version, draft: false, prerelease: false }; },
    get latest() { return latest; },
    forbid: () => {
      authorized = false;
    },
    candidate,
    record,
    gh: new GitHub(
      config.repo,
      "fake",
      server.url.toString().replace(/\/$/, ""),
    ),
    server,
    get writes() {
      return writes;
    },
    get release() {
      return release;
    },
    bytes,
    setFailure: (s: string) => {
      failAfter = s;
    },
  };
}
for (const stage of ["tag-object", "ref", "draft", "upload", "publish"])
  test(`lost ${stage} response resumes without replacing bytes`, async () => {
    const f = fixture();
    try {
      f.setFailure(stage);
      await expect(publish(f.gh, f.candidate, config)).rejects.toThrow();
      await publish(f.gh, f.candidate, config);
      expect(f.release.draft).toBe(false);
      const writes = f.writes;
      await publish(f.gh, f.candidate, config);
      expect(f.writes).toBe(writes);
      expect(hash(f.bytes.get("plugin.tgz")!)).toBe(f.record.files[0]!.sha256);
    } finally {
      f.server.stop(true);
    }
  });
test("conflicting remote bytes are never clobbered", async () => {
  const f = fixture();
  try {
    await publish(f.gh, f.candidate, config);
    f.bytes.set("plugin.tgz", new TextEncoder().encode("changed"));
    const writes = f.writes;
    await expect(publish(f.gh, f.candidate, config)).rejects.toThrow(
      "conflicts",
    );
    expect(f.writes).toBe(writes);
  } finally {
    f.server.stop(true);
  }
});
test("CLI missing arguments prints help before loading config or changing files", async () => {
  const cwd = temp();
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/release/cli.ts"),
      "plugin",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).not.toContain("Cannot find module");
});
test("real plugin archive passes bounded extraction and lifecycle on an isolated host", async () => {
  const root = temp(),
    original = process.cwd();
  const pkg = join(root, "package");
  mkdirSync(pkg);
  save(join(pkg, "toolbelt.json"), {
    formatVersion: 1,
    id: "fixture",
    name: "Fixture",
    repo: "example/plugin",
    version: "1.0.0",
    protocol: 1,
    entry: "index.js",
    screens: [{ id: "main", title: "Main", default: true }],
    requires: { host: ">=0.1.0", bun: ">=1.3.0", platforms: ["portable"] },
    capabilities: { required: ["ui.core", "lifecycle"], optional: [] },
    data: { schema: 1 },
  });
  const sdk = join(import.meta.dir, "../src/sdk/index.ts");
  const built = await Bun.build({ entrypoints: [sdk], target: "bun" });
  await Bun.write(join(pkg, "sdk.js"), built.outputs[0]!);
  writeFileSync(
    join(pkg, "index.js"),
    `import {definePlugin} from './sdk.js';definePlugin({render:{'screen:main':()=>({type:'text',text:'Hello'})}});`,
  );
  try {
    process.chdir(root);
    await run(["git", "init"]);
    await run(["git", "add", "."]);
    await run([
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "fixture",
    ]);
    const paths = await packagePlugin(pkg, join(root, "out"), "0.1.0");
    expect(paths.length).toBe(3);
    expect(
      JSON.parse(readFileSync(paths[2]!, "utf8")).packages[0].sha256,
    ).toHaveLength(64);
  } finally {
    process.chdir(original);
  }
});

for (const product of ["plugin", "sdk"] as const)
  test(product + " prerelease never advances Latest", async () => {
    const r: Request = {
      ...request,
      product,
      version: "1.0.1-rc.1",
      channel: "prerelease",
    };
    const f = fixture(r);
    const c = {
      ...config,
      products: { plugin: config.products.plugin, sdk: config.products.plugin },
    };
    try {
      await publish(f.gh, f.candidate, c);
      expect(f.transitions).toEqual(["false"]);
    } finally {
      f.server.stop(true);
    }
  });
test("stable SDK never advances Latest", async () => {
  const f = fixture({ ...request, product: "sdk" }),
    c = { ...config, products: { sdk: config.products.plugin } };
  try {
    await publish(f.gh, f.candidate, c);
    expect(f.transitions).toEqual(["false"]);
  } finally {
    f.server.stop(true);
  }
});
test("ordinary merges cannot publish", async () => {
  const f = fixture();
  try {
    f.forbid();
    await expect(publish(f.gh, f.candidate, config)).rejects.toThrow(
      "authorization",
    );
    expect(f.writes).toBe(0);
  } finally {
    f.server.stop(true);
  }
});

test("candidate builds run complete adapter validation or the existing default checks", async () => {
  for (const custom of [true, false]) {
    const root = temp();
    const git = (...args: string[]) => run(["git", ...args], root);
    await git("init");await git("remote","add","origin","https://github.com/example/sdk.git");
    save(join(root,"package.json"),{type:"module",scripts:{typecheck:`bun -e "await Bun.write('typecheck-ran', 'yes')"`}});
    writeFileSync(join(root,"default.test.ts"),`import {test} from 'bun:test';test('default validation',async()=>{await Bun.write('tests-ran','yes');});`);
    writeFileSync(join(root,"release.config.ts"),`export default {repo:'example/sdk',hostVersion:'0.1.0',products:{sdk:{changelog:'CHANGELOG.md',version:()=> '1.0.0',setVersion:async()=>{},${custom?"validate:async()=>{await Bun.write('custom-ran','yes');},":""}build:async()=>{await Bun.write('sdk.tgz','fixture');return ['sdk.tgz'];}}}};`);
    save(join(root,".toolbelt-release.json"),{format:1,repo:"example/sdk",product:"sdk",version:"1.0.0",channel:"stable"});
    writeFileSync(join(root,"CHANGELOG.md"),"## 1.0.0 — 2026-11-11\n- Fixture release.\n");
    await run([process.execPath,"install"],root);
    await git("add",".");await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture");
    await run([process.execPath,join(import.meta.dir,"../src/release/cli.ts"),"ci-build"],root,{...process.env,GITHUB_ACTIONS:"true"});
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root,"custom-ran"))).toBe(custom);
    expect(existsSync(join(root,"typecheck-ran"))).toBe(!custom);
    expect(existsSync(join(root,"tests-ran"))).toBe(!custom);
    expect(verifyFrozen(join(root,"release-candidate"),{repo:"example/sdk",hostVersion:"0.1.0",products:{sdk:{changelog:"CHANGELOG.md",version:()=>"1.0.0",setVersion:async()=>{},build:async()=>[]}}}).version).toBe("1.0.0");
  }
},30000);

for (const product of ["app", "plugin"] as const) {
  test(`${product} recovery publishes an older draft without replacing newer Latest`, async () => {
    const f = fixture({ ...request, product });
    const c = { ...config, products: { [product]: config.products.plugin } };
    try {
      f.setLatest("v1.1.0");
      // Resume a real partial publication: the draft and uploaded bytes already exist.
      f.setFailure("upload");
      await expect(publish(f.gh, f.candidate, c)).rejects.toThrow();
      await publish(f.gh, f.candidate, c);
      expect(f.release.draft).toBe(false);
      expect(f.latest.tag_name).toBe("v1.1.0");
      expect(f.transitions).toEqual(["false"]);
      const writes = f.writes;
      await publish(f.gh, f.candidate, c);
      expect(f.writes).toBe(writes);
      expect(f.latest.tag_name).toBe("v1.1.0");
    } finally { f.server.stop(true); }
  });
  test(`${product} newer stable publication advances Latest by semantic version`, async () => {
    const f = fixture({ ...request, product, version: "1.10.0" });
    const c = { ...config, products: { [product]: config.products.plugin } };
    try {
      f.setLatest("v1.9.0");
      await publish(f.gh, f.candidate, c);
      expect(f.transitions).toEqual(["true"]);
      expect(f.latest.tag_name).toBe("v1.10.0");
    } finally { f.server.stop(true); }
  });
}
test("an unrecognized Latest fails closed before making a stable draft public", async () => {
  const f = fixture();
  try {
    f.setLatest("unrecognized-version");
    await expect(publish(f.gh, f.candidate, config)).rejects.toThrow("Latest");
    expect(f.release.draft).toBe(true);
    expect(f.transitions).toEqual([]);
  } finally { f.server.stop(true); }
});

test("captured current publisher preserves Latest while verifying a historical checkout and frozen bytes", async () => {
  const control = temp();
  const built = await Bun.build({entrypoints:[join(import.meta.dir,"../src/release/cli.ts")],target:"bun",packages:"bundle"});
  expect(built.success).toBe(true);
  const publisher=join(control,"publisher.js");await Bun.write(publisher,built.outputs[0]!);
  for (const product of ["app","plugin"] as const) {
    const f=fixture({...request,product});
    const original=temp();
    try {
      f.setLatest("v1.1.0");
      cpSync(f.candidate,join(original,"release-candidate"),{recursive:true});
      mkdirSync(join(original,"src/release"),{recursive:true});
      writeFileSync(join(original,"src/release/cli.ts"),"throw Error('Historical publisher must not run');");
      writeFileSync(join(original,"release.config.ts"),`await Bun.write('historical-config-loaded','yes');export default {repo:'example/plugin',hostVersion:'0.1.0',products:{${product}:{changelog:'CHANGELOG.md',version:()=> '1.0.1',setVersion:async()=>{},build:async()=>[]}}};`);
      const bin=join(original,"bin");mkdirSync(bin);
      const git=join(bin,"git");
      writeFileSync(git,`#!/bin/sh\ncase "$*" in\n'remote get-url origin') echo https://github.com/example/plugin.git ;;\n'rev-parse HEAD') echo ${source} ;;\n*) exit 1 ;;\nesac\n`);chmodSync(git,0o755);
      const preload=join(original,"fake-api.ts");
      writeFileSync(preload,`const baseFetch=globalThis.fetch;const api=${JSON.stringify(f.server.url.origin)};globalThis.fetch=(input,init)=>{const url=new URL(String(input));if(url.origin==='https://api.github.com')return baseFetch(api+url.pathname+url.search,init);if(url.origin===api)return baseFetch(input,init);throw Error('Unexpected network request');};`);
      const child=Bun.spawn([process.execPath,"--preload",preload,publisher,"ci-publish"],{cwd:original,env:{...process.env,PATH:bin+":"+process.env.PATH,GH_TOKEN:"fake",GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:config.repo},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
      const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);
      expect(stderr).toBe("");expect(code).toBe(0);
      expect(readFileSync(join(original,"historical-config-loaded"),"utf8")).toBe("yes");
      expect(f.release.draft).toBe(false);expect(f.latest.tag_name).toBe("v1.1.0");expect(f.transitions).toEqual(["false"]);
      expect(JSON.parse(readFileSync(join(original,"release-candidate/release-record.json"),"utf8"))).toEqual(f.record);
      expect(hash(f.bytes.get("plugin.tgz")!)).toBe(f.record.files[0]!.sha256);
    } finally {f.server.stop(true);}
  }
},30000);
