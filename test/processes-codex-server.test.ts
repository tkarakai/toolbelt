/// <reference path="../plugins/processes/running/src/text.d.ts" />
import { expect, test } from "bun:test";
import { isCodexAppServer } from "../plugins/processes/running/src/codex-server";
import { agentInfo } from "../plugins/processes/running/src/agents";
import type { Row } from "../plugins/processes/running/src/procs";

test("recognizes stdio and managed Codex hosts, excluding maintenance and helpers", () => {
  expect(isCodexAppServer(["/vendor/bin/codex", "app-server"])).toBe(true);
  expect(isCodexAppServer(["codex", "app-server", "--listen", "unix://"])).toBe(true);
  expect(isCodexAppServer(["codex", "app-server", "daemon", "pid-update-loop"])).toBe(false);
  expect(isCodexAppServer(["codex-code-mode-host"])).toBe(false);
  expect(isCodexAppServer(["echo", "codex", "app-server"])).toBe(false);
  expect(isCodexAppServer(["codex", "resume", "thread"])).toBe(false);
});

test("shared hosts have no inferred thread, resume command, or conversation status", () => {
  const argv = ["/vendor/bin/codex", "app-server"];
  expect(agentInfo({ pid: -100, argv, displayArgv: argv, exe: argv[0], leaderGone: false } as Row))
    .toEqual({ harness: "codex" });
});
