import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPlugin } from "../src/bun/plugin-inspection";
import { PluginManagerService } from "../src/bun/plugin-manager-service";
import { atomicJSON, readRegistry, type Candidate, type Installed, type PackageManager, type Registry } from "../src/bun/packages";
import type { PluginHost } from "../src/bun/host";
import { parsePackageManifest } from "../src/shared/package";
import { agentAccessText, unmetRequirements } from "../src/ui/components/plugin-inspection";

const manifest = (overrides: Record<string, unknown> = {}) => parsePackageManifest({
  formatVersion: 1, id: "demo", name: "Demo", repo: "test/demo", version: "1.0.0", entry: "index.js", protocol: 2, agent: { access: "read" },
  requires: { host: ">=0.3.0", bun: ">=1.3.0", platforms: ["portable"] },
  capabilities: { required: ["ui.core"], optional: ["ui.timeline"] },
  data: { schema: 2, supports: [1, 2] },
  screens: [{ id: "main", title: "Main" }, { id: "settings", title: "Settings" }],
  quickView: true,
  ...overrides,
});

test("a compatible plugin's facts are compared with this host", () => {
  const i = inspectPlugin(manifest({ agent: { access: "read" }, cli: { command: "demo" } }), { hostVersion: "0.5.1", sdk: "0.3.18", bunVersion: "1.4.4", platform: "darwin-arm64" });
  expect(i.compatible).toBe(true);
  expect(i.host).toEqual({ requires: ">=0.3.0", version: "0.5.1", ok: true });
  expect(i.bun).toEqual({ requires: ">=1.3.0", version: "1.4.4", ok: true });
  expect(i.platforms).toEqual({ declared: ["portable"], current: "darwin-arm64", ok: true });
  expect(i.protocol).toEqual({ plugin: 2, host: 2, ok: true });
  expect(i.capabilities.required).toEqual([{ id: "ui.core", supported: true }]);
  expect(i.capabilities.optional).toEqual([{ id: "ui.timeline", supported: true }]);
  expect(i).toMatchObject({ agentAccess: "read", sdk: "0.3.18", data: { schema: 2, supports: [1, 2] }, screens: 2, quickView: true, command: "demo" });
  expect(unmetRequirements(i)).toEqual([]);
});

test("unmet requirements and unknown capabilities are reported, not thrown", () => {
  const i = inspectPlugin(manifest({
    requires: { host: ">=9.0.0", bun: ">=2.0.0", platforms: ["linux-x64"] },
    capabilities: { required: ["ui.core", "ui.future"], optional: ["ui.someday"] },
  }), { hostVersion: "0.5.1", bunVersion: "1.4.4", platform: "darwin-arm64" });
  expect(i.compatible).toBe(false);
  expect(i.host.ok).toBe(false);
  expect(i.bun.ok).toBe(false);
  expect(i.platforms.ok).toBe(false);
  expect(i.capabilities.required).toEqual([{ id: "ui.core", supported: true }, { id: "ui.future", supported: false }]);
  expect(i.capabilities.optional).toEqual([{ id: "ui.someday", supported: false }]);
  expect(i.sdk).toBeUndefined();
  expect(unmetRequirements(i)).toEqual(["ToolBelt >=9.0.0", "Bun >=2.0.0", "platform linux-x64", "capability ui.future"]);
});

test("an unsupported optional capability alone keeps a plugin compatible", () => {
  const i = inspectPlugin(manifest({ capabilities: { required: ["ui.core"], optional: ["ui.someday"] } }), { hostVersion: "0.5.1" });
  expect(i.compatible).toBe(true);
});

test("agent access reads as the plugin declares it", () => {
  expect(inspectPlugin(manifest(), { hostVersion: "0.5.1" }).agentAccess).toBe("read");
  // A record installed before protocol 2 may declare nothing.
  expect(inspectPlugin({ ...manifest(), agent: undefined } as never, { hostVersion: "0.5.1" }).agentAccess).toBeUndefined();
  expect(agentAccessText(undefined).label).toBe("Not declared");
  expect(agentAccessText("none").label).toBe("Kept from agents");
  expect(agentAccessText("read").label).toBe("Read only");
});

function fixture(extra: Partial<Installed> = {}) {
  const root = mkdtempSync(join(tmpdir(), "toolbelt-inspect-"));
  mkdirSync(join(root, "plugins"));
  const installed: Installed = {
    id: "demo", repo: "test/demo", version: "1.0.0", hash: "a".repeat(64),
    packageRoot: join(root, "plugins/packages/demo", `1.0.0-${"a".repeat(64)}`), enabled: true, channel: "stable",
    manifest: manifest(), ...extra,
  };
  const registry: Registry = { formatVersion: 1, plugins: { demo: installed } };
  atomicJSON(join(root, "plugins/registry.json"), registry);
  const packages = { root, hostVersion: "0.5.1", collectCandidates: () => {}, recoveryWarnings: [], listeners: new Set(), registry: () => readRegistry(root), save: (r: Registry) => atomicJSON(join(root, "plugins/registry.json"), r), releaseCandidate: () => {} } as unknown as PackageManager;
  const host = { subscribe: () => {}, list: () => [{ manifest: installed.manifest, state: "running", badge: null, sdk: "0.3.18" }] } as unknown as PluginHost;
  return { root, packages, host };
}

test("Settings → Plugins state carries each plugin's inspection and release dates", async () => {
  const f = fixture({ publishedAt: 1_700_000_000_000, installedAt: 1_700_000_100_000 });
  try {
    const resolve = async (_m: PackageManager, repo: string): Promise<Candidate> => ({ repo, hash: "b".repeat(64), packageRoot: f.root, manifest: { ...manifest(), version: "2.0.0" }, publishedAt: 1_800_000_000_000 });
    const service = new PluginManagerService(f.packages, f.host, resolve);
    const plugin = service.read().plugins[0]!;
    expect(plugin.inspection).toMatchObject({ compatible: true, sdk: "0.3.18", host: { version: "0.5.1", ok: true } });
    expect(plugin.publishedAt).toBe(1_700_000_000_000);
    expect(plugin.installedAt).toBe(1_700_000_100_000);
    await service.checkUpdates();
    const updated = service.read().plugins[0]!;
    expect(updated.availableVersion).toBe("2.0.0");
    expect(updated.availablePublishedAt).toBe(1_800_000_000_000);
    await service.handle({ operation: "setChannel", id: "demo", channel: "prerelease" });
    expect(service.read().plugins[0]!.availablePublishedAt).toBeUndefined();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the registry sets aside a record with malformed release times", () => {
  const f = fixture({ publishedAt: -1 });
  try {
    const registry = readRegistry(f.root);
    expect(Object.keys(registry.plugins)).toEqual([]);
    expect(Object.values(registry.invalid ?? {})[0]?.error).toBe("Invalid plugin release time");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
