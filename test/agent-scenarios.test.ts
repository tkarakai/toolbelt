// Agent scenarios (test/agent-scenarios, docs/agents.md → Testing): life-like prompts with the
// tool calls an agent makes to answer them, run through every channel each one lists against
// the real agent interface and the fixture plugins. Checks facts, refusals, redaction,
// notifications and the audit log; no model is involved.
import { describe, expect, test } from "bun:test";
import { loadScenarios, runScenario } from "./agent-scenarios/harness";
import { validateScenario } from "./agent-scenarios/format";
import { CliAdapter } from "./agent-scenarios/adapters";

const scenarios = loadScenarios();

describe("agent scenarios", () => {
	test("the converted first run is all here", () => {
		expect(scenarios.length).toBeGreaterThanOrEqual(18);
		expect(scenarios.filter((s) => s.origin?.run === "plans/agent-interface-eval")).toHaveLength(17);
	});

	for (const s of scenarios)
		for (const channel of s.channels)
			test(`${s.id} [${channel}]: ${s.title}`, { timeout: 30_000 }, async () => {
				const run = await runScenario(s, channel);
				expect(run.failures).toEqual([]);
			});
});

describe("scenario format", () => {
	const base = { id: "x", title: "X", prompt: "?", persona: "p", channels: ["mcp"], steps: [{ call: "toolbelt_status" }] };
	test("rejects resource steps on channels without resources", () => {
		expect(() => validateScenario({ ...base, channels: ["mcp", "cli"], steps: [{ subscribe: "desk/tasks" }] })).toThrow("resource steps");
		expect(() => validateScenario({ ...base, steps: [{ call: "delete_everything" }] })).toThrow("unknown tool");
		expect(() => validateScenario({ ...base, steps: [{ person: { open: "desk" } }] })).toThrow("plugin/screen");
		expect(validateScenario(base).id).toBe("x");
	});
	test("the CLI maps every tool and refuses arguments it has no option for", () => {
		expect(CliAdapter.argv("read_screen", { plugin: "kit", screen: "queue", table: "jobs", offset: 3, max_rows: 2, details: false }, false)).toEqual(["read", "kit", "queue", "--max-rows", "2", "--table", "jobs", "--offset", "3", "--no-details"]);
		expect(CliAdapter.argv("search_screens", { query: "q4 budget", plugin: "desk" }, false)).toEqual(["search", "q4", "budget", "--plugin", "desk"]);
		expect(CliAdapter.argv("list_plugins", {}, true)).toEqual(["plugins", "--json"]);
		expect(() => CliAdapter.argv("toolbelt_status", { verbose: true }, false)).toThrow("no option");
	});
});
