# Agent model evaluation

Measures how well a model works as the agent behind ToolBelt's agent interface: how often its
answers about OnTrack and other plugins are right, how fast it answers, how much memory it needs,
and whether it stays honest (reads before answering, invents nothing, admits it can't change
things, leaks no secrets). Built for local models served by [oMLX](https://github.com/jundot/omlx),
so a newly downloaded model can be compared with the ones already tried.

The first evaluation's findings are in [plans/local-model-eval](../../plans/local-model-eval/README.md).

This package is separate from the app: its dependencies aren't ToolBelt's, the app never imports it,
and plugins it runs are fetched into a cache outside the repository.

## How a run works

```
cases.ts ──► agent.ts (pi-durable conversation) ──► recorder proxy ──► oMLX
                │ tools = ToolBelt's MCP tools (tools/list)
                ▼
            world.ts: real PluginHost + agent interface + stdio shim (`toolbelt mcp`)
                ├─ OnTrack release (plugins.json), seeded by seed.ts through OnTrack's own model
                ├─ kit fixture (software updates, secrets that must stay masked)
                └─ vault fixture (hidden from agents)
```

- **One world per conversation.** Every case gets a fresh, isolated ToolBelt
  (`test/agent-scenarios/harness.ts`), so runs never share state, and nothing touches the person's
  ToolBelt, data or processes.
- **The real OnTrack.** The pinned release archive is verified by SHA-256 and run by the real
  plugin host; the data is written through OnTrack's `model.ts` at the release commit, so it is
  valid for that release. Dates are relative to the moment the world starts, so "overdue" and
  "today" hold on any day. `seed.ts` has ~40 tasks with deliberate traps: names that differ from
  how people ask ("Renew passport" vs "passport renewal"), a settled task next to open ones, two
  archived tasks the default view hides, blocking chains, watched tasks, stalled and snoozed tasks,
  and facts only found in update history.
- **The agent harness is [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)**,
  Pi's runtime for apps whose agent conversations must survive restarts. It is the runtime an
  in-app ToolBelt assistant would use, so the eval measures what the product would ship: its
  compaction (per-model token budgets), turn limits, retries, usage accounting and `beforeTool`
  hooks (the place for approval gates once agents can act). The model sees ToolBelt's MCP tools
  exactly as the server lists them, so a new MCP version is evaluated without changes here.
- **The recorder** is a local proxy between pi-ai and oMLX that keeps oMLX's per-request timings
  (time to first token, prefill and decode tokens per second), which pi-ai doesn't expose.
- **Grading** is deterministic first (`checks.ts`): facts the answer must contain, things it must
  not say, tools it must call (with the view filters it should pass), secrets that must never appear
  in tool output, and what show_screen put on the person's screens. Soft checks record how the agent
  got there (did it filter, did it say "archived") without grading it. An optional judge
  model (`judge.ts`) scores each conversation against the case's rubric with ToolBelt's tool
  results as ground truth.

## Use

Requires oMLX running (default `http://127.0.0.1:8000`; `OMLX_URL` overrides) and its API key in
`OMLX_API_KEY` or oMLX's settings file. From this folder:

```sh
bun install --frozen-lockfile
bun run setup                  # fetch and verify the OnTrack release (once; --force refetches)
bun run models                 # oMLX's chat models: size, allowed/native context, thinking levels
bun run bench -- --models Qwen3.8-27B-4bit,gemma-4-12B-it-8bit       # speed and memory
bun run eval -- --models Qwen3.8-27B-4bit,Qwen3.8-27B-4bit:think      # quick set of cases
bun run eval -- --models Qwen3.8-27B-4bit --all --repeat 3            # everything, 3 times
bun run eval -- --models Qwen3.8-27B-4bit --cases budget-status,hiring
bun run report -- results/<run> --judge omlx/Qwen3.8-27B-8bit         # add judge scores later
bun src/cli.ts regrade results/<run>      # apply changed checks to stored transcripts
bun run eval -- --models Qwen3.8-27B-4bit --prompt prompts/view-guidance.md     # a prompt variant
bun run eval -- --models Qwen3.8-27B-4bit --lenient       # an interface variant (lenient.ts)
bun src/calls.ts results/<run> --errors      # tool calls per conversation, refused ones only
bun src/probe.ts                             # what the model sees: instructions, tools, reads, sizes
```

`:think` runs a model with thinking on (oMLX's `enable_thinking` chat template switch); without
it, thinking is off. Without `--models`, `models.json` lists the defaults. Options: `--max-turns`
(tool rounds per answer, 12), `--timeout` (seconds per answer, 600), `--max-output` (tokens per
request, 8192).

Each run writes `results/<timestamp>/` (gitignored): `runs.jsonl` (one conversation per line with
every tool call, answer, check and request timing), `loads.jsonl`, `meta.json`, `summary.json`
and `report.html` (leaderboard, case grid, transcripts). Results contain only synthetic data.

### Adding a model

Download it in oMLX, check `bun run models` for its allowed context (oMLX's per-model
"max context window" caps what conversations can hold; the native length is shown next to it),
then run `bench` and `eval` with it next to the current best, ideally `--repeat 3`. Add it to
`models.json` if it should stay in the default comparison.

### Prompt variants

`--prompt <file>` appends text to the system prompt, for measuring guidance before it moves into
ToolBelt's tool descriptions. `prompts/search-guidance.md` explains search's exact-word matching,
the badge and text reads (written for the first, five-tool interface); `prompts/view-guidance.md` is
for the interface with views: filter ids from list_screens, details narrowed by a view, hidden rows.

### Interface variants

`--lenient` simulates a proposed ToolBelt change before it is built: `lenient.ts` resolves filter
and option labels, plugin names and screen titles to ids, case-insensitively, and lists the
plugins in an unknown-plugin refusal. Compare it with a plain run of the same models to see
what the change would buy. Add other proposals the same way: wrap the tool calls, flag it.

### Through Claude Code (the ToolBelt Agent plugin's setup)

`--agent claude-acp` runs each case through Claude Code's ACP adapter (`claude-agent-acp`, which
must be installed) as the [ToolBelt Agent](https://github.com/tkarakai/toolbelt-agent) plugin
starts it: its isolation (no built-in tools, none of the person's settings or MCP servers), its
preamble in the first message, Claude Code's default permission mode with only ToolBelt's tools
allowed, and the model given as environment lines pointing at the recording proxy (which adds
oMLX's key). Candidates are named `<model>@claude`; checks, regrade and the report are unchanged.
`acp.ts` copies the plugin's preamble and isolation: update them together.

Claude Code leaves `thinking` out of its requests when thinking is off, and oMLX then thinks if the
model's settings enable it. With thinking off, the proxy adds `thinking: {type: "disabled"}`: what
an oMLX profile with thinking off does. Side requests (Claude Code naming the session) are recorded
with `kind` set to the start of their system prompt.

### Through the plugin's Model API agent

`--agent model-api --model-api <path>/model-api.js` runs each case through the ToolBelt Agent
plugin's own Model API agent: the `model-api.js` of a plugin build (`dist/package/`) or of a
release archive. It's started as the plugin starts it, speaking ACP with the plugin's preamble in
the first message, with the oMLX preset pointed at the recording proxy, the candidate's thinking
setting, the model's context and `--max-turns` as its tool steps. Candidates are named
`<model>@model-api`. The agent switches thinking itself (`chat_template_kwargs`), so the proxy
doesn't add anything.

`EVAL_AGENT_ENV_<NAME>=value` adds `NAME=value` to the agent's environment, after the lines above
(so it can replace them): for example `CLAUDE_CONFIG_DIR`, or `HTTPS_PROXY` pointing at a logging
proxy to check that nothing leaves the Mac.

```sh
bun src/cli.ts run --agent claude-acp --models Qwen3.8-27B-4bit --all --out results/claude
```

### Adding a case

Add it to `cases.ts`. A case is one conversation: turns the person types (and actions the person
takes in ToolBelt before a turn), checks per turn, and a rubric. Check for facts, not wording
(a distinctive fragment of a task name, a number from an update), and give alternatives with `|`.
Facts a case relies on belong in `seed.ts` next to the data that makes them true. Mark slow
multi-turn cases `slow` so the quick set stays quick. A case's `setup.answer` is how the person
answers show_screen's question (allow, for how long, or decline); without it nobody answers.
OnTrack's filter ids for the seeded labels are in `F` in cases.ts. A case that needs a newer MCP tool lists
it in `requires` and is skipped on servers without it.

### Reading results

| Column | Meaning |
| --- | --- |
| Cases passed | Conversations where every check passed |
| Checks | Share of checks passed, averaged over conversations |
| Judge | Mean rubric score (1–5) and how many answers the judge found unfaithful |
| Turn median / p90 | Wall time from the person's message to the answer, tool calls included |
| Calls/turn, tool errors | How the model uses tools; errors are refused or invalid calls |
| Failed turns | No answer: turn limit, timeout, model error |
| TTFT, prefill, decode | oMLX's timings, medians over requests; decode counts only responses of 100+ tokens (oMLX overstates it for short tool calls) |
| Thinking tok/turn | Reasoning tokens spent per answer |
| Max context | Largest prompt the model held during a conversation |
| Tool chars/turn | Characters of tool output the model read per answer: what costs prefill time |
| Reads with view / details | Share of read_screen calls that passed a view, or asked for details |
| Soft checks | Share of soft checks passed (used the expected filter, named the state) |
| Memory | What oMLX reports for the model when it's loaded: the weights. oMLX's figure grows once its cache fills (a 20 GB model reads ~29 GB after a run), so treat it as a lower bound |

Checks evolve: when a transcript shows a check was wrong, fix it in `cases.ts` and `regrade` the
stored runs instead of running the models again.

Small differences on one repeat are noise: sampling varies between runs. Compare with
`--repeat 3` or more before concluding. Read failing transcripts before trusting a check: a
failure can be a wrong answer or an over-strict check, and both are worth fixing.

## Limits

- Deterministic checks can't judge reasoning quality or tone; that's what the rubric and the
  transcripts are for.
- The OnTrack data is one persona's. Results say how a model handles this shape of data, not
  every person's.
- Speed depends on what else oMLX is serving; `meta.json` records the loaded models and requests
  in flight when a run starts.
