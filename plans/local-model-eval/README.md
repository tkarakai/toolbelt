# Local models as ToolBelt agents: first evaluation

The first run of [evals/agent-models](../../evals/agent-models/README.md), on 2026-11-25: which of
the models served by oMLX can be the agent that talks to ToolBelt, mostly about OnTrack. This is a
dated record, like [agent-interface-eval](../agent-interface-eval/README.md); rerun the eval for
current numbers.

**Setup.** MacBook Pro M4 Max, 128 GB; oMLX 0.8.3 (memory ceiling ~90 GB); ToolBelt's read-only
MCP interface (5 tools) as of app 0.5.3; OnTrack 0.14.0 with ~40 seeded tasks; pi-durable 1.6.1.
18 quick cases plus a 10-turn planning conversation, one repeat each (the guidance pass and the
long conversation are separate runs). Thinking off unless marked `+think`.

## Verdict

**Yes, local models are good enough for reading and discussing OnTrack**, with a clear trade-off
between answer quality and speed. Two candidates stand out:

| | Qwen3.8-27B-4bit | Qwen3.6-35B-A3B-4bit (MoE) |
| --- | --- | --- |
| Quick cases passed | 18/18, also with search guidance | 13/18, 16/18 with search guidance |
| Long conversation | 10/10 turns, recalls earlier facts | 10/10 turns, recalls earlier facts |
| Answer quality (read by hand) | Best: cross-references updates, blockers, what's next | Good, but more confident mistakes on filtering questions |
| Typical answer | ~40–45 s (p90 ~60 s) | ~8–12 s (p90 ~15 s) |
| Weights in memory | 20 GB (grows to ~29 GB with cache) | 23 GB (~26 GB with cache) |

- **Default recommendation: Qwen3.8-27B-4bit, thinking off.** It passed every case in both runs
  and its answers read like a good assistant's. The 8-bit variant was equally good
  (18/18) at 34 GB with no visible quality gain; the 4-bit is the better buy.
- **For snappy chat: Qwen3.6-35B-A3B-4bit.** Five times faster because it reads tool output at
  900–2,000 tokens/s instead of ~280, but it gets filtering questions ("high priority without a due
  date") wrong and once invented a plugin id. Good for quick lookups, less trustworthy for
  summaries.
- **gemma-4-12B-it-8bit** is a solid middle (18/18, then 15/18 with guidance, 9/10 turns in the long
  conversation; terse but correct answers, 13 GB) but as slow as the 27B: a dense model's prefill speed is what costs time here.
- **Not recommended as the agent:** Qwen3.5-9B, gemma-4-E4B (often answer without reading
  ToolBelt at all), LFM3-1.7B (not evaluated beyond speed). **Qwen3.5-4B** did surprisingly well
  (15–16/18, ~15 s) and is worth keeping as a "small model" baseline.
- **Thinking doesn't pay off here.** The 27B passed 18/18 with it too, but answers took longer
  (median 56 s instead of 45, p90 94 s; ~630 reasoning tokens per answer). gemma (15/18) and the
  MoE (14/18) got worse: gemma answered from search snippets more often, and the MoE looped
  through 15 searches until the turn limit without answering. Thinking also more than doubled
  context growth in the long conversation (16k → 41k tokens over 10 turns).

## What dominates speed: reading, not writing

| Model | Prefill tok/s (1k / 8k / 32k prompt) | Time to first token at 8k / 32k | Decode tok/s | Load |
| --- | --- | --- | --- | --- |
| LFM3-1.7B-8bit | 3500 / 1760 / 1950 | 4 s / 15 s | 160–195 | 2 s |
| Qwen3.5-4B-8bit | 790 / 900 / 850 | 9 s / 39 s | 72–85 | 1 s |
| Qwen3.5-9B-8bit | 840 / 530 / 530 | 15 s / 63 s | 33–42 | 5 s |
| gemma-4-E4B-8bit | 1725 / 1675 / – (32k cap) | 5 s / – | 47–70 | 7 s |
| gemma-4-12B-8bit | 285 / 260 / 270 | 31 s / 122 s | ~22 | 8 s |
| Qwen3.6-35B-A3B-4bit | 2080 / 1280 / 920 | 6 s / 36 s | 117–200 | 12–19 s |
| Qwen3.8-27B-4bit | 280 / 295 / 245 | 28 s / 135 s | 24–43 | 40–47 s |
| Qwen3.8-27B-8bit | 280 / 330 / 265 | 25 s / 125 s | 20–32 | 52–92 s |

An OnTrack screen read as text is ~28,000 characters, about 10,000 tokens, so every full read
costs a dense 12–27B model 30–40 s before it writes a word; the answer itself takes seconds.
Follow-up turns that don't read again are fast (2–13 s even at 25k tokens of context) because oMLX
keeps the conversation's prefix cached. Two consequences for ToolBelt's interface:

1. **Smaller reads are the biggest speed lever.** A summary-first read (rows without details,
   details on request), or view parameters that return only the rows asked for (the protocol-v2
   work), would cut most of the wait.
2. **JSON reads are ~3.5× larger** (99k characters for the same screen) and models answered worse
   from them. Text stays the right default.

## What went wrong, and what it says about the interface

Failures traced to the interface more than to the models:

- **`search_screens` misleads.** It needs every query word, spelled as on screen, so "passport
  renewal" doesn't find "Renew passport" and "Q4 budget meeting" finds nothing. Models then said
  the task doesn't exist (and one invented UI for it). Search hits also lack updates, so answers
  built on search miss the facts that matter. Fix candidates: match word stems or any word with
  ranking; say in the tool description that empty results don't mean absence; include a row's
  latest update in hits.
- **The badge invites wrong answers.** `toolbelt_status` shows "OnTrack … badge 7"; small models
  answered "you have 7 tasks" or "7 in your inbox". The status could say what a badge counts, or
  plugins could label it.
- **Models ask the person to filter.** Asked a filtering question, the MoE replied "filter by
  Priority: High and Due: No date" instead of reading. Agent-controlled view state (v2) addresses
  this directly.
- **Archived tasks are invisible.** Every model said it couldn't find the archived task; none
  noticed the "Archived 2" count in the Workflow filter. With view control an agent could look.

A system prompt with four lines of tool guidance (`evals/agent-models/prompts/search-guidance.md`)
raised the smaller models: Qwen3.5-9B 10→12/18, Qwen3.5-4B 15→16/18, the MoE 13→16/18; the 27B
stayed at 18/18. gemma-4-12B
went 18→15/18 on its single repeat, which is within the run-to-run noise these one-repeat runs
show. Putting that guidance in the MCP tool descriptions and server instructions helps every
client, not only an in-app assistant.

Model behaviors an in-app assistant must handle:

- **A turn limit needs a graceful answer.** The thinking MoE hit 12 tool rounds and returned
  nothing; the harness should then ask for an answer from what was found (pi-durable's `onYield` /
  `afterTools` hooks).
- **Answers without reading.** gemma-4-E4B and Qwen3.5-9B often answered in ~1 s with no tool call.
  A check that the first answer about a plugin follows a read catches this.
- **Hallucinated ids.** A refused call (invented plugin id) led to an empty answer instead of a
  retry with the ids from the refusal.

Safety cases held for every model: no secret ever reached a tool result (ToolBelt masks them), no
model printed or invented a token, and none claimed to have changed a task. Asked to settle a task,
the best answers said they can only read and named the Settle action.

## Context and long conversations

oMLX allows 262k tokens for the Qwen models and gemma-4-12B, but only 32k for
gemma-4-E4B and 16k for the plain `Qwen3.6-35B-A3B-4bit` entry (its `mlx-community--` alias has no
cap; raise the cap in oMLX's model settings to use the plain one). A 10-turn planning conversation
reached 12–27k tokens without thinking and 41k with it, so 64k is comfortable for a conversation of
that length and pi-durable's compaction (set per model from oMLX's allowed context) covers longer
ones; compaction itself was not reached in this run. Prefill time grows with context (time to first
token ~2 min at 32k on the dense 27B), which matters only for turns that add a large read.

## Results

| Run | Folder (in `evals/agent-models/results/`, not committed) |
| --- | --- |
| Speed and memory | `bench-initial/` |
| 7 models, quick cases | `initial-nothink/` |
| 5 models with search guidance | `initial-guidance/` |
| 10-turn conversation | `initial-long/` |
| Thinking on | `initial-think/` |

Each run's `summary.json` (and the benchmark's `bench.json`) is in [summaries/](summaries/).

## Next

- Repeat the finalists 3× to separate model differences from sampling noise.
- Move the search guidance into the MCP tool descriptions, then rerun.
- Rerun on the protocol-v2 interface (view state, `show_screen`) once it lands; add cases for it
  (`requires` in cases.ts), and approval cases with a `beforeTool` gate once agents can act.
- Run the judge (`--judge`) with a model stronger than the candidates, and calibrate it against
  these hand reviews.
