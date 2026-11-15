import { expect, test } from "bun:test";
import {
  canInstall,
  canRecover,
  isActivePhase,
  pluginCheckResult,
  type Candidate,
} from "../src/ui/plugin-manager-model";
test("publisher approval cannot bypass missing or incompatible compatibility review", () => {
  const c: Candidate = {
    token: "review",
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
    repo: "fixture/plugin",
    hash: "a".repeat(64),
  };
  expect(canInstall(c)).toBe(false);
  expect(
    canInstall({
      ...c,
      compatibility: { compatible: false, summary: "Unsupported host" },
    }),
  ).toBe(false);
  expect(
    canInstall({
      ...c,
      compatibility: { compatible: true, summary: "Compatible" },
    }),
  ).toBe(true);
});
test("incompatible older code requires matching snapshot", () => {
  expect(canRecover({ id: "old", version: "1", schemaCompatible: false })).toBe(
    false,
  );
  expect(canRecover({ id: "old", version: "1", schemaCompatible: true })).toBe(
    true,
  );
  expect(
    canRecover({
      id: "snapshot",
      version: "1",
      schemaCompatible: false,
      snapshotAt: 1000,
    }),
  ).toBe(true);
});
test("all mutating lifecycle phases block conflicting actions", () => {
  for (const phase of [
    "downloading",
    "verifying",
    "starting",
    "migrating",
    "stopping",
    "updating",
    "removing",
  ] as const)
    expect(isActivePhase(phase)).toBe(true);
  for (const phase of ["ready", "failed", "quarantined", "disabled"] as const)
    expect(isActivePhase(phase)).toBe(false);
});

test("manual update recovery follows each plugin's latest check, not runtime activity", async () => {
  const { updateCheckFailed } = await import("../src/ui/plugin-manager-model");
  const failure = "today · Update check failed: GitHub answered 403";
  expect(updateCheckFailed({ checkActivities: [failure] })).toBe(true);
  expect(updateCheckFailed({ logs: [failure, "today · ready"] })).toBe(true);
  expect(updateCheckFailed({ logs: [failure, "today · Update check succeeded: already up to date"] })).toBe(false);
  expect(updateCheckFailed({ logs: [failure, "today · Update available: 2.0.0"] })).toBe(false);
  expect(updateCheckFailed({ logs: ["today · Runtime failure: crash"] })).toBe(false);
  expect(updateCheckFailed({})).toBe(false);
});

test("a manual plugin check says what it found, including nothing new", () => {
  const p = (name: string, extra: Record<string, unknown> = {}) => ({ manifest: { name } as never, ...extra });
  expect(pluginCheckResult([p("Processes"), p("Upkeep")])).toEqual({ kind: "current", title: "All plugins are up to date", description: "Processes · Upkeep" });
  expect(pluginCheckResult([p("Processes")]).title).toBe("Processes is up to date");
  expect(pluginCheckResult([p("Processes", { availableVersion: "0.1.3" }), p("Upkeep")])).toEqual({ kind: "updates", title: "Update available for Processes", description: "Processes 0.1.3" });
  expect(pluginCheckResult([p("Processes", { updateFailure: { kind: "quota" } }), p("Upkeep")])).toEqual({ kind: "failed", title: "Couldn’t check Processes", description: "The other plugins are up to date." });
  expect(pluginCheckResult([p("Gone", { removed: true })]).kind).toBe("none");
});
