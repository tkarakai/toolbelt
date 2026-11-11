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
  type Product,
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

export type RetrySelector = { tag: string; product?: Product; pr?: string; source?: string };

async function taggedSource(gh: GitHub, tag: string): Promise<string | undefined> {
  const ref = await gh.request(`git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return undefined;
  if (ref.object?.type !== "tag") throw Error("Release tag must be annotated");
  const annotated = await gh.request(`git/tags/${ref.object.sha}`);
  if (annotated?.object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(annotated.object.sha))
    throw Error("Release tag must identify an exact commit");
  return annotated.object.sha;
}

/** Resolve an original authorization, never a movable main fallback. Read-only. */
export async function resolveRetrySource(gh: GitHub, config: ReleaseConfig, selector: RetrySelector) {
  const { tag, product, pr, source: explicit } = selector;
  if (typeof tag !== "string" || !/^(sdk-)?v[0-9A-Za-z.-]+$/.test(tag)) throw Error("Invalid retry tag");
  if (pr !== undefined && (typeof pr !== "string" || !/^[1-9][0-9]*$/.test(pr) || !Number.isSafeInteger(Number(pr)))) throw Error("Expected a positive release PR number");
  if (explicit !== undefined && (typeof explicit !== "string" || !/^[0-9a-f]{40}$/.test(explicit))) throw Error("Expected an exact merge commit SHA");
  if (pr !== undefined && explicit !== undefined) throw Error("Choose --pr or --source, not both");
  let source = explicit;
  if (pr !== undefined) {
    const pull = await gh.request(`pulls/${pr}`);
    if (!pull?.merged_at || pull.base?.ref !== "main" || pull.base?.repo?.full_name !== config.repo || pull.head?.repo?.full_name !== config.repo || !/^[0-9a-f]{40}$/.test(pull.merge_commit_sha))
      throw Error("Retry PR must be a merged same-repository release PR to main");
    source = pull.merge_commit_sha;
  }
  const tagged = await taggedSource(gh, tag);
  if (source && tagged && source !== tagged) throw Error("Retry source conflicts with immutable release tag");
  source ??= tagged;
  if (!source) throw Error("Release has no tag yet; specify --pr <merged-release-PR> or --source <exact-merge-SHA>");
  const request = await authorizedSource(gh, source, config);
  if (!request || tagOf(request) !== tag || (product !== undefined && request.product !== product)) throw Error("No matching merged release authorization");
  return { source, request };
}

/** Candidate recovery guards are applied both before dispatch and again in CI. */
export async function planRelease(gh: GitHub, source: string, request: Request) {
  const tag = tagOf(request);
  const tagged = await taggedSource(gh, tag);
  if (tagged && tagged !== source) throw Error("Retry source conflicts with immutable release tag");
  const candidate = await existingCandidate(gh, tag, source);
  const release = await gh.release(tag);
  if (!candidate && (release || tagged)) throw Error("Frozen CI artifacts unavailable; recover original bytes before retrying; never rebuild a tagged or uploaded candidate");
  return { candidate, release };
}

export async function dispatchRetry(gh: GitHub, config: ReleaseConfig, selector: RetrySelector) {
  const resolved = await resolveRetrySource(gh, config, selector);
  const plan = await planRelease(gh, resolved.source, resolved.request);
  await gh.request("actions/workflows/release.yml/dispatches", "POST", {
    ref: "main", inputs: { tag: selector.tag, source: resolved.source },
  });
  return { ...resolved, ...plan };
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
  const stableFeed = record.channel === "stable" && record.product !== "sdk";
  const wasDraft = release.draft;
  const currentLatest = async () => {
    const current = await gh.request("releases/latest");
    if (!current) return undefined;
    if (current.draft || current.prerelease || typeof current.tag_name !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(current.tag_name))
      throw Error("Latest must identify a stable version before publication");
    const version = current.tag_name.slice(1);
    validateRequest({ ...record, version, channel: "stable" }, config);
    return version;
  };
  let promote = false;
  let minimumLatest: string | undefined;
  if (wasDraft && stableFeed) {
    const previous = await currentLatest();
    promote = previous === undefined || Bun.semver.order(record.version, previous) > 0;
    minimumLatest = previous !== undefined && Bun.semver.order(previous, record.version) > 0 ? previous : record.version;
  }
  if (wasDraft)
    await gh.request(`releases/${release.id}`, "PATCH", {
      draft: false,
      prerelease: record.channel === "prerelease",
      make_latest: promote ? "true" : "false",
    });
  release = await gh.request(`releases/${releaseId}`);
  if (
    !release ||
    release.draft ||
    release.prerelease !== (record.channel === "prerelease")
  )
    throw Error("Publication could not be confirmed; retry the same tag");
  if (minimumLatest !== undefined) {
    const after = await currentLatest();
    if (after === undefined || Bun.semver.order(after, minimumLatest) < 0)
      throw Error("Latest moved backwards during publication; inspect the feed before retrying");
  }
  console.log(release.html_url);
  return release.html_url as string;
}
export async function existingCandidate(
  gh: GitHub,
  tag: string,
  source: string,
) {
  let expired = false;
  for (let page = 1; ; page++) {
    const response = await gh.request(
      `actions/artifacts?name=${encodeURIComponent("release-" + tag)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response?.artifacts)) throw Error("Frozen CI candidate inventory is unavailable");
    for (const artifact of response.artifacts) {
      const workflow = await gh.request("actions/runs/" + artifact.workflow_run.id);
      if (
        workflow?.path === ".github/workflows/release.yml" &&
        workflow.head_branch === "main" &&
        ["push", "workflow_dispatch"].includes(workflow.event) &&
        (workflow.event !== "push" || workflow.head_sha === source)
      ) {
        if (artifact.expired) expired = true;
        else return artifact;
      }
    }
    if (response.artifacts.length < 100) break;
  }
  if (expired) throw Error("Frozen CI candidate expired; recover original bytes or prepare a new version");
  return undefined;
}
export function recordIdentity(r: ReleaseRecord) {
  return `${r.repo}/${tagOf(r)}@${r.source}`;
}
