import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { github } from "../src/release/github";
import { hash, run, save } from "../src/release/core";
import { extractArchive } from "../src/bun/packages";
import { validatePackage } from "../src/sdk/package";
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--tag" ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[1]!)
)
  throw Error("Usage: bun run seed:update --tag <published-explorer-tag>");
if (await run(["git", "status", "--porcelain"]))
  throw Error("Use clean, up-to-date main");
await run(["git", "fetch", "origin", "main"]);
if (
  (await run(["git", "branch", "--show-current"])) !== "main" ||
  (await run(["git", "rev-parse", "HEAD"])) !==
    (await run(["git", "rev-parse", "origin/main"]))
)
  throw Error("Use clean, up-to-date main");
const tag = args[1]!,
  repo = "tkarakai/toolbelt-sdk-demo",
  gh = await github(repo),
  release = await gh.release(tag);
if (!release || release.draft)
  throw Error("Seed release must already be public");
const descriptorAsset = release.assets.find(
  (a: any) => a.name === "toolbelt-release.json",
);
if (!descriptorAsset) throw Error("Seed descriptor missing");
const descriptor = JSON.parse(
  new TextDecoder().decode(await gh.bytes(descriptorAsset)),
);
if (
  descriptor.id !== "sdk-demo" ||
  descriptor.repo !== repo ||
  descriptor.formatVersion !== 1
)
  throw Error("Seed publisher/identity mismatch");
const pkg = descriptor.packages.find((p: any) => p.target === "darwin-arm64");
const asset = release.assets.find((a: any) => a.name === pkg?.asset);
if (!asset) throw Error("Seed archive missing");
const bytes = await gh.bytes(asset);
if (bytes.length !== pkg.size || hash(bytes) !== pkg.sha256)
  throw Error("Seed archive integrity mismatch");
const temp = mkdtempSync(join(tmpdir(), "toolbelt-seed-update-"));
try {
  extractArchive(bytes, temp);
  const m = validatePackage(temp);
  if (
    m.repo !== repo ||
    m.id !== "sdk-demo" ||
    m.version !== descriptor.version
  )
    throw Error("Seed archive identity mismatch");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const branch = `seed/${tag}`;
const host = await github("tkarakai/toolbelt");
const existing = await host.request(
  `pulls?state=open&base=main&head=tkarakai:${encodeURIComponent(branch)}`,
);
if (existing?.length) {
  console.log(existing[0].html_url);
  process.exit(0);
}
await run(["git", "switch", "-c", branch]);
save("seed.config.json", {
  repo,
  url: asset.browser_download_url,
  sha256: pkg.sha256,
});
await run(["git", "add", "seed.config.json"]);
await run([
  "git",
  "commit",
  "-m",
  `chore: update bundled SDK Explorer to ${descriptor.version}`,
]);
await run(["git", "push", "-u", "origin", branch]);
const note = join(mkdtempSync(join(tmpdir(), "toolbelt-seed-pr-")), "notes.md");
try {
  save(note, { repo, tag, version: descriptor.version, sha256: pkg.sha256 });
  console.log(
    await run([
      "gh",
      "pr",
      "create",
      "--repo",
      "tkarakai/toolbelt",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `chore: update bundled SDK Explorer to ${descriptor.version}`,
      "--body-file",
      note,
    ]),
  );
} finally {
  rmSync(join(note, ".."), { recursive: true, force: true });
}
