import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
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
        return release ? response(release) : new Response("", { status: 404 });
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
        transitions.push((await req.json()).make_latest);
        release.draft = false;
        return fail("publish") || response(release);
      }
      return new Response(p, { status: 404 });
    },
  });
  return {
    transitions,
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
