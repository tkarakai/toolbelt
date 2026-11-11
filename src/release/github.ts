import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hash,
  run,
  tagOf,
  validateRequest,
  verifyFrozen,
  type ReleaseConfig,
  type ReleaseRecord,
  type Request,
} from "./core";

export class GitHub {
  constructor(
    readonly repo: string,
    private token: string,
    private base = "https://api.github.com",
  ) {}
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const url =
      path.startsWith("https://") || path.startsWith("http://")
        ? path
        : `${this.base}/repos/${this.repo}/${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type":
          body instanceof Uint8Array
            ? "application/octet-stream"
            : "application/json",
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? new Uint8Array(body).buffer
            : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok)
      throw Error(`GitHub ${method} failed (${response.status})`);
    if (response.status === 204) return true;
    return response.json();
  }
  async bytes(asset: { url: string }) {
    const response = await fetch(asset.url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/octet-stream",
      },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error(`Asset download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
  async release(tag: string) {
    const published = await this.request(
      "releases/tags/" + encodeURIComponent(tag),
    );
    if (published) return published;
    // Authenticated draft discovery also works when the tag endpoint omits drafts.
    for (let page = 1; ; page++) {
      const releases = await this.request("releases?per_page=100&page=" + page);
      if (!Array.isArray(releases)) return null;
      const match = releases.find((r: any) => r.tag_name === tag);
      if (match) return match;
      if (releases.length < 100) return null;
    }
  }
}
export async function github(repo: string) {
  return new GitHub(
    repo,
    process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN ||
      (await run(["gh", "auth", "token"])),
  );
}

export async function authorizedSource(
  gh: GitHub,
  source: string,
  config: ReleaseConfig,
): Promise<Request | null> {
  if (!/^[0-9a-f]{40}$/.test(source)) throw Error("Expected an exact commit");
  const commit = await gh.request(`commits/${source}`);
  if (!commit || commit.sha !== source)
    throw Error("Source commit is unavailable");
  // Old request files carried by ordinary feature merges never authorize publication.
  if (
    !commit.files?.some(
      (f: any) =>
        f.filename === ".toolbelt-release.json" && f.status !== "removed",
    )
  )
    return null;
  const prs = await gh.request(`commits/${source}/pulls`);
  const pr = prs?.find(
    (p: any) =>
      p.merged_at &&
      p.merge_commit_sha === source &&
      p.base.ref === "main" &&
      p.base.repo.full_name === config.repo &&
      p.head.repo?.full_name === config.repo,
  );
  if (!pr)
    throw Error(
      "Release source must be the merged commit of a same-repository release PR to main",
    );
  const content = await gh.request(
    `contents/.toolbelt-release.json?ref=${source}`,
  );
  if (!content || content.encoding !== "base64")
    throw Error("Missing release request");
  return validateRequest(
    JSON.parse(Buffer.from(content.content, "base64").toString()),
    config,
  );
}

/** Every write is preceded by remote inspection, so a lost response can be retried safely. */
export async function publish(
  gh: GitHub,
  directory: string,
  config: ReleaseConfig,
) {
  const record = verifyFrozen(directory, config);
  const authorized = await authorizedSource(gh, record.source, config);
  if (
    !authorized ||
    ["repo", "product", "version", "channel"].some(
      (k) => (authorized as any)[k] !== (record as any)[k],
    )
  )
    throw Error("Frozen candidate does not match merged authorization");
  const tag = tagOf(record);
  let ref = await gh.request(`git/ref/tags/${tag}`);
  if (!ref) {
    const object = await gh.request("git/tags", "POST", {
      tag,
      message: `${record.product} ${record.version}`,
      object: record.source,
      type: "commit",
      tagger: undefined,
    });
    await gh.request("git/refs", "POST", {
      ref: `refs/tags/${tag}`,
      sha: object.sha,
    });
    ref = await gh.request(`git/ref/tags/${tag}`);
  }
  if (ref?.object.type !== "tag") throw Error("Release tag must be annotated");
  const tagged = await gh.request(`git/tags/${ref.object.sha}`);
  if (tagged?.object.sha !== record.source || tagged.object.type !== "commit")
    throw Error("Release tag source conflicts");
  let release = await gh.release(tag);
  if (!release)
    release = await gh.request("releases", "POST", {
      tag_name: tag,
      name: `${record.product === "app" ? "Toolbelt" : record.product === "sdk" ? "Toolbelt SDK" : config.repo.split("/")[1]} ${record.version}`,
      body: record.notes,
      draft: true,
      prerelease: record.channel === "prerelease",
      make_latest: "false",
    });
  if (!release)
    throw Error("Draft creation could not be confirmed; retry the same tag");
  const releaseId = release.id;
  if (release.prerelease !== (record.channel === "prerelease"))
    throw Error("Release channel conflicts");
  const expected = [
    ...record.files,
    {
      name: "release-record.json",
      size: readFileSync(join(directory, "release-record.json")).length,
      sha256: hash(readFileSync(join(directory, "release-record.json"))),
    },
  ];
  for (const file of expected) {
    release = await gh.request(`releases/${releaseId}`);
    const asset = release.assets.find((a: any) => a.name === file.name);
    if (asset) {
      if (asset.size !== file.size)
        throw Error(`Remote asset size conflicts: ${file.name}`);
      const bytes = await gh.bytes(asset);
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        throw Error(`Remote asset conflicts: ${file.name}`);
    } else {
      if (!release.draft)
        throw Error(
          "Published release is missing an asset; cannot repair immutable releases",
        );
      const upload =
        release.upload_url.replace(/\{.*$/, "") +
        `?name=${encodeURIComponent(file.name)}`;
      await gh.request(
        upload,
        "POST",
        new Uint8Array(readFileSync(join(directory, file.name))),
      );
    }
  }
  release = await gh.request(`releases/${releaseId}`);
  if (
    release.assets.length !== expected.length ||
    expected.some(
      (f) =>
        !release.assets.some(
          (a: any) => a.name === f.name && a.size === f.size,
        ),
    )
  )
    throw Error("Remote release inventory differs");
  // Verify every uploaded byte before making the draft visible.
  for (const f of expected) {
    const bytes = await gh.bytes(
      release.assets.find((a: any) => a.name === f.name),
    );
    if (hash(bytes) !== f.sha256 || bytes.length !== f.size)
      throw Error(`Remote verification failed: ${f.name}`);
  }
  const latest = record.channel === "stable" && record.product !== "sdk";
  const wasDraft = release.draft;
  if (wasDraft)
    await gh.request(`releases/${release.id}`, "PATCH", {
      draft: false,
      prerelease: record.channel === "prerelease",
      make_latest: latest ? "true" : "false",
    });
  release = await gh.request(`releases/${releaseId}`);
  if (
    !release ||
    release.draft ||
    release.prerelease !== (record.channel === "prerelease")
  )
    throw Error("Publication could not be confirmed; retry the same tag");
  if (
    wasDraft &&
    latest &&
    (await gh.request("releases/latest"))?.tag_name !== tag
  )
    throw Error("Latest does not point to the published release");
  console.log(release.html_url);
  return release.html_url as string;
}
export async function existingCandidate(
  gh: GitHub,
  tag: string,
  source: string,
) {
  const artifacts = await gh.request(
    `actions/artifacts?name=${encodeURIComponent("release-" + tag)}&per_page=100`,
  );
  for (const artifact of artifacts?.artifacts ?? []) {
    if (artifact.expired) continue;
    const workflow = await gh.request(
      "actions/runs/" + artifact.workflow_run.id,
    );
    if (
      workflow?.path === ".github/workflows/release.yml" &&
      workflow.head_branch === "main" &&
      ["push", "workflow_dispatch"].includes(workflow.event) &&
      (workflow.event !== "push" || workflow.head_sha === source)
    )
      return artifact;
  }
  return undefined;
}
export function recordIdentity(r: ReleaseRecord) {
  return `${r.repo}/${tagOf(r)}@${r.source}`;
}
