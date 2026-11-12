import { isAbsolute } from "node:path";
import { parseManifest, type Manifest } from "./protocol";

export const PACKAGE_FORMAT = 1;
export const SDK_VERSION = "0.3.2";
export const CAPABILITIES = [
  "ui.core",
  "ui.action-key",
  "ui.terminal",
  "ui.conversation",
  "assets",
  "lifecycle",
  "native.handoff",
] as const;
export const LIMITS = {
  archiveBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  files: 10000,
  messageBytes: 4 * 1024 * 1024,
  depth: 32,
  nodes: 50000,
  logs: 64 * 1024,
  messagesPerSecond: 120,
  messageBytesPerSecond: 16 * 1024 * 1024,
  rendersPerSecond: 30,
  handshakeMs: 10000,
  prepareMs: 10000,
  migrationMs: 60000,
};
export type PackageManifest = Manifest & {
  formatVersion: 1;
  repo: string;
  requires: { host: string; bun: string; platforms: string[] };
  capabilities: { required: string[]; optional: string[] };
  data: { schema: number; supports?: number[] };
  assets?: Record<string, string>;
  migration?: { entry: string };
  cli?: {
    command: string;
    entry?: string;
    path?: string;
    cleanupScreen?: string;
  };
};
export function safeRelative(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => p === ".." || p === "" || p === ".")
  )
    throw new Error("unsafe package path");
}
export function parsePackageManifest(value: unknown): PackageManifest {
  const m = parseManifest(value) as PackageManifest;
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      m.version,
    ) ||
    m.version.length > 128 ||
    m.id.length > 128
  )
    throw new Error("invalid package version/id");
  if (
    m.formatVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(
      m.repo ?? "",
    ) ||
    [".", ".."].includes(m.repo?.split("/")[1] ?? "")
  )
    throw new Error("package formatVersion/repo required");
  safeRelative(m.entry);
  const screenIds = new Set<string>();
  for (const screen of m.screens) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,127}$/.test(screen.id) ||
      screenIds.has(screen.id)
    )
      throw new Error("Invalid or duplicate screen id");
    screenIds.add(screen.id);
  }
  if (
    !m.requires ||
    typeof m.requires.host !== "string" ||
    typeof m.requires.bun !== "string" ||
    !Array.isArray(m.requires.platforms) ||
    !m.requires.platforms.length ||
    m.requires.platforms.some((x) => typeof x !== "string")
  )
    throw new Error("package compatibility required");
  if (
    !m.capabilities ||
    !Array.isArray(m.capabilities.required) ||
    !Array.isArray(m.capabilities.optional) ||
    [...m.capabilities.required, ...m.capabilities.optional].some(
      (x) => typeof x !== "string",
    )
  )
    throw new Error("package capabilities required");
  if (!m.data || !Number.isSafeInteger(m.data.schema) || m.data.schema < 0)
    throw new Error("package data schema required");
  if (
    m.handoffActions !== undefined &&
    (!Array.isArray(m.handoffActions) ||
      m.handoffActions.some(
        (id) => typeof id !== "string" || !id || id.length > 256,
      ) ||
      ![...m.capabilities.required, ...m.capabilities.optional].includes(
        "native.handoff",
      ))
  )
    throw new Error(
      "handoffActions requires valid action IDs and native.handoff capability",
    );
  if (
    m.data.supports !== undefined &&
    (!Array.isArray(m.data.supports) ||
      m.data.supports.some((x) => !Number.isSafeInteger(x) || x < 0))
  )
    throw new Error("Invalid supported data schemas");
  if (m.cli) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(m.cli.command))
      throw new Error("Invalid CLI command");
    if (m.cli.entry) safeRelative(m.cli.entry);
    if (m.cli.path) safeRelative(m.cli.path);
    if (
      m.cli.cleanupScreen !== undefined &&
      !m.screens.some((screen) => screen.id === m.cli?.cleanupScreen)
    )
      throw new Error("Invalid CLI cleanup screen");
  }
  if (m.migration) safeRelative(m.migration.entry);
  for (const [name, path] of Object.entries(m.assets ?? {})) {
    if (!/^[\w.-]+$/.test(name)) throw new Error("invalid asset name");
    safeRelative(path);
  }
  return m;
}
export type MigrationRequest = {
  type: "migrate";
  transactionId: string;
  fromVersion: string | null;
  toVersion: string;
  fromSchema: number | null;
  toSchema: number;
  sourceDir: string;
  targetDir: string;
};
