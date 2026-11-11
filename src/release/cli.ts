#!/usr/bin/env bun
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  freeze,
  json,
  prepareNotes,
  releaseNotes,
  requestFile,
  run,
  save,
  tagOf,
  validateRequest,
  verifyFrozen,
  verifyPlugin,
  type Product,
  type ReleaseConfig,
  type Request,
} from "./core";
import { authorizedSource, existingCandidate, github, publish } from "./github";

const help = `Toolbelt releases (non-interactive)
Prepare: bun run release:<app|sdk|plugin> --version X.Y.Z --channel stable|prerelease [--check]
Retry:   bun run release:<app|sdk|plugin>:retry --tag <existing-tag>
Preparation writes a release branch/version/changelog PR. --check builds in temporary staging.
Merging the validated release PR authorizes CI publication. Retry resumes that authorization.
Local build commands do not publish. No bare release command is supported.`;
function args(input: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < input.length; i++) {
    const key = input[i]!;
    if (
      !["--version", "--channel", "--tag", "--check"].includes(key) ||
      flags[key] !== undefined
    )
      throw Error(help);
    if (key === "--check") flags[key] = true;
    else {
      const value = input[++i];
      if (!value || value.startsWith("--")) throw Error(help);
      flags[key] = value;
    }
  }
  return flags;
}
async function configAt(root = process.cwd()): Promise<ReleaseConfig> {
  const config = (
    await import(pathToFileURL(join(root, "release.config.ts")).href)
  ).default as ReleaseConfig;
  const remote = await run(["git", "remote", "get-url", "origin"], root);
  if (
    !remote.replace(/\.git$/, "").endsWith("/" + config.repo) &&
    !remote.replace(/\.git$/, "").endsWith(":" + config.repo)
  )
    throw Error("Git origin does not match release.config.ts");
  return config;
}
async function clean() {
  const status = await run([
    "git",
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (status)
    throw Error("Use a clean checkout before release preparation/build");
}
async function unique(gh: Awaited<ReturnType<typeof github>>, r: Request) {
  if (
    (await gh.request(`git/ref/tags/${tagOf(r)}`)) ||
    (await gh.release(tagOf(r)))
  )
    throw Error("Version/tag already exists; use a new release version");
}
async function build(config: ReleaseConfig, r: Request) {
  const product = config.products[r.product]!;
  if (product.version() !== r.version)
    throw Error("Requested version differs from committed source");
  if (r.product === "plugin" && json("package.json").version !== r.version)
    throw Error("Plugin package/manifest versions differ");
  await run(["bun", "install", "--frozen-lockfile"]);
  await run(["bun", "run", "typecheck"]);
  await run(["bun", "test"]);
  return product.build();
}
async function prepare(
  config: ReleaseConfig,
  product: Product,
  flags: Record<string, string | boolean>,
) {
  if (!flags["--version"] || !flags["--channel"] || flags["--tag"])
    throw Error(help);
  const r = validateRequest(
    {
      format: 1,
      repo: config.repo,
      product,
      version: flags["--version"],
      channel: flags["--channel"],
    },
    config,
  );
  const adapter = config.products[product]!;
  await clean();
  const gh = await github(config.repo);
  await unique(gh, r);
  const branch = `release/${product}-${r.version}`;
  const existing = await gh.request(
    `pulls?state=open&head=${encodeURIComponent(config.repo.split("/")[0] + ":" + branch)}&base=main`,
  );
  if (existing?.length && !flags["--check"]) {
    const content = await gh.request(
      "contents/" + requestFile + "?ref=" + encodeURIComponent(branch),
    );
    const prior =
      content &&
      validateRequest(
        JSON.parse(Buffer.from(content.content, "base64").toString()),
        config,
      );
    if (
      !prior ||
      prior.channel !== r.channel ||
      prior.product !== r.product ||
      prior.version !== r.version
    )
      throw Error("Existing PR request conflicts");
    console.log(existing[0].html_url);
    return;
  }
  const currentBranch = await run(["git", "branch", "--show-current"]);
  const resume =
    currentBranch === branch &&
    adapter.version() === r.version &&
    JSON.stringify(json(requestFile)) === JSON.stringify(r);
  if (!resume && Bun.semver.order(r.version, adapter.version()) <= 0)
    throw Error("Choose a version newer than the current product version");
  const preparedNotes = resume
    ? readFileSync(adapter.changelog, "utf8")
    : prepareNotes(readFileSync(adapter.changelog, "utf8"), r.version);
  if (flags["--check"]) {
    const stage = mkdtempSync(join(tmpdir(), "toolbelt-release-check-"));
    const original = process.cwd();
    try {
      const archive = join(stage, "source.tar");
      await run(["git", "archive", "--output", archive, "HEAD"]);
      const source = join(stage, "source");
      mkdirSync(source);
      await run(["tar", "-xf", archive, "-C", source]);
      await run(["git", "init"], source);
      await run(
        [
          "git",
          "remote",
          "add",
          "origin",
          `https://github.com/${config.repo}.git`,
        ],
        source,
      );
      await run(["git", "add", "."], source);
      await run(
        [
          "git",
          "-c",
          "user.name=Release check",
          "-c",
          "user.email=release-check@localhost",
          "commit",
          "-m",
          "Release check snapshot",
        ],
        source,
      );
      process.chdir(source);
      const staged = await configAt(source),
        stagedAdapter = staged.products[product]!;
      await stagedAdapter.setVersion(r.version);
      writeFileSync(stagedAdapter.changelog, preparedNotes);
      const paths = await build(staged, r);
      console.log(
        `Validated ${tagOf(r)}: ${paths.length} artifacts; nothing written to GitHub`,
      );
    } finally {
      process.chdir(original);
      rmSync(stage, { recursive: true, force: true });
    }
    return;
  }
  if (!resume) {
    await run(["git", "fetch", "origin", "main"]);
    if (
      (await run(["git", "branch", "--show-current"])) !== "main" ||
      (await run(["git", "rev-parse", "HEAD"])) !==
        (await run(["git", "rev-parse", "origin/main"]))
    )
      throw Error("Prepare releases from clean, up-to-date main");
    await run(["git", "switch", "-c", branch]);
    await adapter.setVersion(r.version);
    writeFileSync(adapter.changelog, preparedNotes);
    save(requestFile, r);
    await run(["bun", "install", "--frozen-lockfile"]);
    await run(["git", "add", "-u"]);
    await run(["git", "add", requestFile]);
    await run([
      "git",
      "commit",
      "-m",
      `release: ${product} ${r.version} (${r.channel})`,
    ]);
  }
  await run(["git", "push", "-u", "origin", branch]);
  const body = join(
    mkdtempSync(join(tmpdir(), "toolbelt-release-pr-")),
    "body.md",
  );
  try {
    writeFileSync(
      body,
      `Release ${product} ${r.version} (${r.channel}) from ${config.repo}.\n\nMerging this PR authorizes CI to build its merge commit and publish ${tagOf(r)}. ${product === "sdk" || r.channel === "prerelease" ? "The app Latest feed stays unchanged." : "The repository Latest feed advances."}\n\n${releaseNotes(readFileSync(adapter.changelog, "utf8"), r.version)}`,
    );
    console.log(
      await run([
        "gh",
        "pr",
        "create",
        "--repo",
        config.repo,
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        `release: ${product} ${r.version}`,
        "--body-file",
        body,
      ]),
    );
  } finally {
    rmSync(resolve(body, ".."), { recursive: true, force: true });
  }
}
async function output(values: Record<string, string>) {
  const path = process.env.GITHUB_OUTPUT;
  for (const [k, v] of Object.entries(values)) {
    if (/[\r\n]/.test(v)) throw Error("Invalid workflow output");
    if (path) writeFileSync(path, `${k}=${v}\n`, { flag: "a" });
    else console.log(`${k}=${v}`);
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes("--help")) {
    console.log(help);
    if (!argv.length) process.exitCode = 1;
    return;
  }
  const [command, ...input] = argv;
  if (["app", "sdk", "plugin"].includes(command!)) {
    const f = args(input);
    if (!f["--version"] || !f["--channel"]) throw Error(help);
  }
  const config = await configAt();
  if (["app", "sdk", "plugin"].includes(command!))
    return prepare(config, command as Product, args(input));
  if (command?.endsWith(":retry")) {
    const flags = args(input),
      product = command.split(":")[0];
    if (
      !flags["--tag"] ||
      Object.keys(flags).length !== 1 ||
      !["app", "sdk", "plugin"].includes(product!)
    )
      throw Error(help);
    const gh = await github(config.repo),
      tag = String(flags["--tag"]);
    const release = await gh.release(tag),
      ref = await gh.request(`git/ref/tags/${tag}`);
    let source =
      ref?.object.type === "tag"
        ? (await gh.request(`git/tags/${ref.object.sha}`))?.object.sha
        : ref?.object.sha;
    // Before tagging, the committed merged request still identifies the authorized release.
    if (!source) source = (await gh.request("commits/main"))?.sha;
    const r = await authorizedSource(gh, source, config);
    if (!r || tagOf(r) !== tag || r.product !== product)
      throw Error("No matching merged release authorization");
    await gh.request("actions/workflows/release.yml/dispatches", "POST", {
      ref: "main",
      inputs: { tag },
    });
    console.log(
      `CI retry requested for ${tag}${release && !release.draft ? " (will verify the immutable published release)" : ""}`,
    );
    return;
  }
  if (command === "validate-request") {
    const changed = await run([
      "git",
      "diff",
      "--name-only",
      "origin/main...HEAD",
    ]);
    if (!changed.split("\n").includes(requestFile)) return;
    const r = validateRequest(json(requestFile), config),
      adapter = config.products[r.product]!;
    if (
      adapter.version() !== r.version ||
      (r.product === "plugin" && json("package.json").version !== r.version)
    )
      throw Error("Release version sources disagree");
    releaseNotes(readFileSync(adapter.changelog, "utf8"), r.version);
    console.log("Release request validated; merging authorizes publication");
    return;
  }
  if (command === "ci-plan") {
    if (
      !process.env.GITHUB_ACTIONS ||
      process.env.GITHUB_REPOSITORY !== config.repo ||
      process.env.GITHUB_REF !== "refs/heads/main"
    )
      throw Error("CI command requires the owning main workflow");
    const gh = await github(config.repo);
    let source = process.env.GITHUB_SHA!;
    const event = json(process.env.GITHUB_EVENT_PATH!);
    const retryTag = event.inputs?.tag;
    if (retryTag) {
      if (!/^(sdk-)?v[0-9A-Za-z.-]+$/.test(retryTag))
        throw Error("Invalid retry tag");
      const ref = await gh.request(`git/ref/tags/${retryTag}`);
      if (ref)
        source =
          ref.object.type === "tag"
            ? (await gh.request(`git/tags/${ref.object.sha}`)).object.sha
            : ref.object.sha;
    }
    const r = await authorizedSource(gh, source, config);
    if (!r) {
      await output({ release: "false" });
      return;
    }
    if (retryTag && retryTag !== tagOf(r))
      throw Error("Retry tag does not match merged source");
    const candidate = await existingCandidate(gh, tagOf(r), source);
    const remote = await gh.release(tagOf(r));
    if (!candidate && remote)
      throw Error(
        "Frozen CI artifacts unavailable; recover original bytes before retrying; never rebuild an uploaded candidate",
      );
    await output({
      release: "true",
      source,
      tag: tagOf(r),
      product: r.product,
      artifact: candidate ? String(candidate.id) : "",
      artifact_run: candidate ? String(candidate.workflow_run.id) : "",
      reuse: candidate ? "true" : "false",
    });
    return;
  }
  if (command === "ci-build") {
    const r = validateRequest(json(requestFile), config),
      source = await run(["git", "rev-parse", "HEAD"]);
    if (!process.env.GITHUB_ACTIONS) throw Error("Candidate builds run in CI");
    const paths = await build(config, r);
    const notes =
      releaseNotes(
        readFileSync(config.products[r.product]!.changelog, "utf8"),
        r.version,
      ) +
      (r.product === "app"
        ? "\n\n## Downloads\n\nDownload the Toolbelt app DMG or standalone Plugin Tester. Apps are ad-hoc signed, not notarized. SDK archives are published separately under sdk-v tags.\n"
        : "");
    freeze(r, source, paths, notes, "release-candidate");
    return;
  }
  if (command === "ci-publish") {
    if (
      !process.env.GITHUB_ACTIONS ||
      process.env.GITHUB_REPOSITORY !== config.repo
    )
      throw Error("Publication only runs in the owning CI workflow");
    const record = verifyFrozen("release-candidate", config);
    if ((await run(["git", "rev-parse", "HEAD"])) !== record.source)
      throw Error("Checkout and frozen source differ");
    return publish(await github(config.repo), "release-candidate", config);
  }
  if (command === "verify-target") {
    const record = verifyFrozen("release-candidate", config);
    if ((await run(["git", "rev-parse", "HEAD"])) !== record.source)
      throw Error("Native verification source mismatch");
    const descriptor = json("release-candidate/toolbelt-release.json");
    const target = `${process.platform}-${process.arch}`;
    const item = descriptor.packages.find(
      (p: any) => p.target === target || p.target === "portable",
    );
    if (!item) throw Error("No package for native runner");
    await verifyPlugin(
      join("release-candidate", item.asset),
      config.hostVersion,
      {
        repo: descriptor.repo,
        version: descriptor.version,
        target: item.target,
      },
    );
    return;
  }
  throw Error(help);
}
if (import.meta.main)
  main().catch((error) => {
    console.error(`Release stopped: ${error.message}`);
    process.exitCode = 1;
  });
