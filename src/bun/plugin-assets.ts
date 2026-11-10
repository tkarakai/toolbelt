import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PackageManager } from "./packages";
const mime: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
export function pluginAsset(
  manager: PackageManager,
  reference: string,
): string | null {
  const match = /^asset:([a-z0-9-]+)@([^/]+)\/([\w.-]+)$/.exec(reference);
  if (!match) return null;
  const p = manager.registry().plugins[match[1]!];
  if (!p || p.removed || p.version !== match[2]) return null;
  const path = p.manifest.assets?.[match[3]!];
  if (!path) return null;
  const type = mime[path.split(".").at(-1)!.toLowerCase()];
  if (!type) return null;
  try {
    const bytes = readFileSync(join(p.packageRoot, path));
    if (bytes.length > 2 * 1024 * 1024) return null;
    if (type === "image/svg+xml") {
      const svg = bytes.toString();
      if (
        /<\s*(script|foreignObject|iframe|object|embed)|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?!#)|url\s*\(/i.test(
          svg,
        )
      )
        return null;
    }
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
