import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  parsePackageManifest,
  safeRelative,
  type PackageManifest,
} from "../shared/package";
/** Validate an author's built output before archiving; never resolves dependencies or runs scripts. */
export function validatePackage(root: string): PackageManifest {
  const manifest = parsePackageManifest(
    JSON.parse(readFileSync(join(root, "toolbelt.json"), "utf8")),
  );
  const files = [
    manifest.entry,
    ...Object.values(manifest.assets ?? {}),
    ...(manifest.migration ? [manifest.migration.entry] : []),
    ...(manifest.cli?.path ? [manifest.cli.path] : []),
  ];
  for (const relative of files) {
    safeRelative(relative);
    for (const part of relative
      .split("/")
      .map((_x, i, a) => a.slice(0, i + 1).join("/"))) {
      const stat = lstatSync(join(root, part));
      if (stat.isSymbolicLink())
        throw new Error(`Package link is unsupported: ${part}`);
    }
    if (!lstatSync(join(root, relative)).isFile())
      throw new Error(`Package file required: ${relative}`);
  }
  return manifest;
}
