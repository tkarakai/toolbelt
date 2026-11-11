import { appendFileSync, readFileSync } from "node:fs";

export type Change = { path: string; before: string | null; after: string | null };
const versionLine = /^export const SDK_VERSION = "([^"]+)";$/m;
const allowed = [".toolbelt-release.json", "packages/sdk/CHANGELOG.md", "src/shared/package.ts"];

/** Only release metadata and one SDK version constant may bypass app CI. */
export function sdkReleaseOnly(changes: Change[]): boolean {
  if (changes.length !== allowed.length || !allowed.every(p => changes.some(c => c.path === p))) return false;
  if (changes.some(c => c.before === null || c.after === null)) return false;
  const versions = changes.find(c => c.path === "src/shared/package.ts")!;
  const before = versionLine.exec(versions.before!)?.[1];
  const after = versionLine.exec(versions.after!)?.[1];
  if (!before || !after || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(before) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(after) || Bun.semver.order(after, before) <= 0) return false;
  if (versions.before!.replace(versionLine, "SDK_VERSION") !== versions.after!.replace(versionLine, "SDK_VERSION")) return false;
  try {
    const request = JSON.parse(changes.find(c => c.path === ".toolbelt-release.json")!.after!);
    return request.format === 1 && request.repo === "tkarakai/toolbelt" && request.product === "sdk" && request.version === after && (after.includes("-") ? request.channel === "prerelease" : request.channel === "stable");
  } catch { return false; }
}

if (import.meta.main) {
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(err);
    return out;
  };
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  let base = process.env.GITHUB_EVENT_NAME === "pull_request" ? event.pull_request?.base?.sha : process.env.GITHUB_EVENT_NAME === "push" ? event.before : undefined;
  let sdk = false;
  if (typeof base === "string" && /^[0-9a-f]{40}$/.test(base) && !/^0+$/.test(base)) {
    if (process.env.GITHUB_EVENT_NAME === "pull_request") base = (await git("merge-base", base, "HEAD")).trim();
    const paths = (await git("diff", "--no-renames", "--name-only", "-z", base, "HEAD")).split("\0").filter(Boolean);
    if (paths.length === allowed.length && paths.every(p => allowed.includes(p))) {
      const changes: Change[] = [];
      for (const path of paths) {
        // Added/deleted metadata fails closed rather than treating a new file as release-only.
        try { changes.push({ path, before: await git("show", `${base}:${path}`), after: await git("show", `HEAD:${path}`) }); }
        catch { changes.push({ path, before: null, after: null }); }
      }
      sdk = sdkReleaseOnly(changes);
    }
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sdk=${sdk}\n`);
  console.log(sdk ? "SDK release-only validation" : "Full app and SDK validation");
}
