import { LIMITS } from "../shared/package";
import {
  PackageManager,
  type Candidate,
  type ReleaseDescriptor,
} from "./packages";
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function parseRepository(input: string) {
  const value = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!repoPattern.test(value))
    throw new Error("Use a public GitHub owner/repo or repository URL");
  return value;
}
async function download(url: string, limit: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit) throw new Error("Download size limit");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("Missing response body");
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Download size limit");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
export async function resolveGithub(
  manager: PackageManager,
  input: string,
  options: {
    release?: string;
    prerelease?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<Candidate> {
  const repo = parseRepository(input);
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases${options.release ? `/tags/${encodeURIComponent(options.release)}` : options.prerelease ? "?per_page=30" : "/latest"}`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    },
  );
  if (response.status === 404)
    throw new Error(
      "Public release not found; private repositories/authentication are unsupported",
    );
  if (!response.ok)
    throw new Error(`GitHub release lookup failed (${response.status})`);
  if(!new URL(response.url).pathname.toLowerCase().startsWith('/repos/'+repo.toLowerCase()+'/releases'))throw new Error('Repository identity changed; review new publisher explicitly');
  const result=(await response.json()) as any;
  const release=Array.isArray(result)?result.find(r=>!r.draft&&(options.prerelease||!r.prerelease)):result;
  if(!release||typeof release.html_url!=='string'||!release.html_url.toLowerCase().startsWith('https://github.com/'+repo.toLowerCase()+'/releases/'))throw new Error('Release publisher identity changed');
  if (release.draft || (release.prerelease && !options.prerelease))
    throw new Error("Prerelease requires explicit opt-in");
  const assets = release.assets as any[];
  if (!Array.isArray(assets)) throw new Error("Release assets missing");
  const descriptors = assets.filter((a) => a.name === "toolbelt-release.json");
  if (descriptors.length !== 1)
    throw new Error("Expected one toolbelt-release.json");
  const descriptor = JSON.parse(
    new TextDecoder().decode(
      await download(
        descriptors[0].browser_download_url,
        1024 * 1024,
        options.signal,
      ),
    ),
  ) as ReleaseDescriptor;
  if (
    descriptor.formatVersion !== 1 ||
    descriptor.repo.toLowerCase() !== repo.toLowerCase() ||
    !Array.isArray(descriptor.packages) ||
    !/^[a-f0-9]{40}$/.test(descriptor.commit)
  )
    throw new Error("Invalid release descriptor/publisher");
  const targets = descriptor.packages.filter(
    (p) =>
      p.target === `${process.platform}-${process.arch}` ||
      p.target === "portable",
  );
  if (targets.length !== 1)
    throw new Error("Ambiguous or unsupported package target");
  const target = targets[0]!;
  const matches = assets.filter((a) => a.name === target.asset);
  if (matches.length !== 1 || matches[0].size !== target.size)
    throw new Error("Release package asset mismatch");
  const asset = matches[0];
  if (asset.digest && asset.digest !== `sha256:${target.sha256}`)
    throw new Error("GitHub asset digest mismatch");
  const bytes = await download(
      asset.browser_download_url,
      LIMITS.archiveBytes,
      options.signal,
    );
  if(bytes.length!==target.size)throw new Error("Downloaded package size mismatch");
  const candidate=await manager.stage(bytes,target.sha256,repo);
  if (
    candidate.manifest.id !== descriptor.id ||
    candidate.manifest.version !== descriptor.version
  )
    throw new Error("Descriptor/manifest identity mismatch");
  return { ...candidate, release: release.tag_name, asset: String(asset.id),channel:release.prerelease?"prerelease":"stable" };
}
