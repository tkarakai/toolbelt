# Local models as ToolBelt agents: first evaluation

The first run of [evals/agent-models](../../evals/agent-models/README.md), on 2026-11-25: which of
the models served by oMLX can be the agent that talks to ToolBelt, mostly about OnTrack. Numbers are as regraded
after a check-matching fix on 2026-11-26 (a few moved by one case). This is a
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
| Quick cases passed | 18/18, also with search guidance | 13/18, 15/18 with search guidance |
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
- **gemma-4-12B-it-8bit** is a solid middle (18/18, then 16/18 with guidance, 9/10 turns in the long
  conversation; terse but correct answers, 13 GB) but as slow as the 27B: a dense model's prefill speed is what costs time here.
- **Not recommended as the agent:** Qwen3.5-9B, gemma-4-E4B (often answer without reading
  ToolBelt at all), LFM3-1.7B (not evaluated beyond speed). **Qwen3.5-4B** did surprisingly well
  (15–16/18, ~15 s) and is worth keeping as a "small model" baseline.
- **Thinking doesn't pay off here.** The 27B passed 18/18 with it too, but answers took longer
  (median 56 s instead of 45, p90 94 s; ~630 reasoning tokens per answer). gemma (14/18) and the
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
raised the smaller models: Qwen3.5-9B 10→12/18, Qwen3.5-4B 15→16/18, the MoE 13→15/18; the 27B
stayed at 18/18. gemma-4-12B
went 18→16/18 on its single repeat, which is within the run-to-run noise these one-repeat runs
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

The [second evaluation](#second-evaluation-views-and-shorter-reads) below reruns the two finalists on
the interface with views and shorter reads.

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
- Done 2026-11-26: rerun on the interface with views and `show_screen` (second evaluation, below).
  Still to do: approval cases with a `beforeTool` gate once agents can act.
- Run the judge (`--judge`) with a model stronger than the candidates, and calibrate it against
  these hand reviews.

## Second evaluation: views and shorter reads

2026-11-26, the two finalists on the next interface: `main` at #145 (app 0.6.1 plus "details off by
default"; the installed 0.6.1 still reads with details) and OnTrack 0.15.0, whose Tasks screen
declares its search and filters to agents. New since the first run: `read_screen`'s `view`
(search, filters, sort, controls) and paging, `list_screens` with each screen's view controls,
`show_screen`, and rows read one line each unless an agent passes `details: true`.

Cases changed with it: `archived-unseen` became `archived` (the agent can now look, so "I can't
see it" no longer passes); new cases ask for one project (`finance-project`), two filters at once
(`blocked-high`), a task by other words (`passport-status`), a screen shown (`show-overdue`) and a
show the person declines (`show-declined`). Soft checks record whether the agent used the expected
filter without grading it. 23 quick cases, each run 3 times per variant, plus the 10-turn
conversation once.

| | Quick cases passed | Answer median / p90 | Refused calls | Tool output per answer |
| --- | --- | --- | --- | --- |
| Qwen3.8-27B-4bit | 65/69 | 11.6 s / 31.6 s | 10% | 7.0k chars |
| Qwen3.8-27B-4bit + view guidance | **69/69** | 11.2 s / 18.9 s | 8% | 3.9k chars |
| Qwen3.8-27B-4bit, lenient names | 66/69 | 11.2 s / 30.8 s | 2% | 6.5k chars |
| Qwen3.6-35B-A3B-4bit | 56/69 | 3.2 s / 10.7 s | 25% | 7.8k chars |
| Qwen3.6-35B-A3B-4bit + view guidance | 49/69 | 2.7 s / 6.6 s | 24% | 5.0k chars |
| Qwen3.6-35B-A3B-4bit, lenient names | 57/69 | 2.8 s / 7.2 s | 14% | 6.5k chars |

Both passed the 10-turn conversation (10/10), the 27B in 100 s in all, the MoE in 34 s, ending
at ~13k tokens of context; with guidance the MoE missed one turn.

**The shorter reads are the big win.** The first run's typical answer took 40–45 s on the 27B and
8–12 s on the MoE; now 11 s and 3 s, at the same or better quality. A default OnTrack read is 6k
characters instead of 28k (22k with details), and both models narrow before asking for details:
`view: {search: "budget"}, details: true` returns 3k characters with the full update history.

**Verdict unchanged, and sharper.** The 27B is the agent to use: 65–69/69; its misses were the archived task (below) and,
once, leaving the website launch out of the blocked high-priority tasks. The MoE answers in 3 s but passes 72–83% and makes confident mistakes: it read "overdue" as
Inbox/Working, listed only Working tasks for "high priority without a date", invented plugin ids
(`com.zenigata.OnTrack`) and once two Finance tasks that don't exist, and in 3 of 227 answers emitted a
tool call oMLX couldn't parse ("unrecoverable tool call"), leaving no answer.

### What the models got wrong, and what it says about the interface

- **Filter ids are opaque, and one collides.** The screen text says `Filter Project: all (options:
  Finance 4, …)`, but `view.filters` wants `label:1` and option values (`none`, not `No date`;
  `High`, not `high`; `overdue`, not `Overdue`). Most refusals were these guesses: `Project`,
  `priority`, `isPersonal`, `workflow`. Worse, OnTrack's Workflow filter has the id `status` while
  its Status label filter is `label:4`, so "blocked" went into Workflow. Models recover from the
  refusals (their messages list the right ids and values), which is why resolving names leniently
  (`--lenient`, simulated by `lenient.ts`) cut refusals to 2% and 14% and calls per answer from 3.3
  to 2.7 but barely moved pass rates: it saves round trips, not answers.
- **Search can't see hidden rows.** `search_screens` searches what screens show by default, so it
  never finds an archived task, and models then say it doesn't exist. Without guidance neither model
  thought of the Workflow filter (which shows "Archived 2"); with it the 27B read the archived view
  and found the task every time.
- **An archived row loses its state.** OnTrack 0.15 shows an archived task as "Archived" with a date,
  not that it was settled, so the 27B rightly said it couldn't confirm the laptop was returned. A
  plugin display gap, not a model error.
- **"Didn't allow" was misread.** The MoE took show_screen's "The person didn't allow changing their
  view" as "needs permission" and asked the person to allow it, after they had declined.
- **Sort is tried on tables that can't sort.** Models pass `sort` often; OnTrack's table isn't
  sortable, and nothing in the read says so.
- **Plugin-specific prompt text cut both ways.** The guidance (`prompts/view-guidance.md`) named
  OnTrack's filter ids; it made the 27B perfect and its reads half as large, but the MoE fixated on
  the Workflow filter it named and did worse. Fixes that belong in the interface (names that
  resolve, ids that mean something) help every model; prompt text describing one plugin doesn't.

### Suggestions for the contract

In order of effect:

1. **Resolve view input by name.** Accept a filter's label as well as its id, and an option's label
   as well as its value, case-insensitively; when a key names one filter's id and another's label,
   take the filter that offers the values. Echo the resolved view (`Your view:` already does).
   Generic, no plugin changes; measured above as `--lenient`.
2. **Show ids where models read.** In `read_screen` text, give each filter's id and option values:
   `Filter Project [label:1]: all (options: Finance 4, …, No Project [__none] 6)`. Today only
   `list_screens` has them, and models called it in 20–39% of turns.
3. **Meaningful filter ids (SDK guidance; OnTrack change).** Recommend ids that read as what they
   filter (`project`, `priority`), and in OnTrack rename the Workflow filter's id from `status` to
   `workflow` so it can't collide with the Status label.
4. **Say what search can't see.** In `search_screens`'s description and its empty result: it matches
   lines containing every word, in each screen's default view; rows a default filter hides (such as
   archived tasks) need `read_screen` with that filter. For example: `Nothing on 6 screens mentions
   "laptop". Search covers each screen's default view; OnTrack › Tasks hides some rows by default
   (filter Workflow: Archived 2).`
5. **Unambiguous decline.** `The person declined on their screen; nothing changed. Don't ask again
   unless they ask you to.`
6. **List what exists in "not found" refusals.** An unknown plugin id's refusal says to call
   list_screens; listing the ids (`Plugins agents can read: ontrack (OnTrack), kit (Kit)`) saves the
   round trip, and models invent reverse-DNS ids otherwise.
7. **Say when a table can't sort**, in the read (`Columns: Task · Due · When (not sortable)`).
8. **OnTrack: show an archived task's state** (`Settled 40d ago · archived 30d ago`).

Keep: one line per row by default, and the instructions' "pass details: true … narrowed with a view"
sentence: both models followed it. The refusal messages are good; they are why models recover.

| Run | Folder (in `evals/agent-models/results/`) |
| --- | --- |
| Both models, all cases, once | `v2-baseline/` |
| Both models, quick cases, 2 more repeats | `v2-baseline-r/` |
| With `prompts/view-guidance.md` | `v2-guidance/`, `v2-guidance-r/` |
| `--lenient`, 3 repeats | `v2-lenient/` |

## Third evaluation: through Claude Code, as the Agent plugin runs it

The ToolBelt Agent plugin starts an ACP agent; for a local model that's Claude Code with
environment lines pointing at oMLX's Messages API. `run --agent claude-acp` runs the same cases
the same way (see the eval README). Qwen3.8-27B-4bit, the same host (main #145) and cases:

| Qwen3.8-27B-4bit | Passed | Median / p90 per answer | Output tokens per answer | First prompt |
| --- | --- | --- | --- | --- |
| Lightweight harness (pi-durable), thinking off | 65/69 quick (94%) | 11–13 s / 32 s | ~270 | 2.4k |
| Claude Code, oMLX's thinking default (on) | 29/30 quick (partial run) | 38 s / 96 s | ~1,600 | 4.2k |
| Claude Code, thinking off | 21/23 quick (91%), 10-turn 10/10 in 84 s | 20 s / 44 s | ~520 | 4.2k |

Both Claude Code misses are model errors also seen in the harness: the archived task, and once a
work task listed among personal ones.

What it took, and what's left:

- **Permission mode.** `claude-agent-acp` starts sessions in the person's own
  `permissions.defaultMode` even with `settingSources: []` (it reads their settings itself). In
  Auto, whose safety check runs on Anthropic's servers, every tool call through oMLX was refused.
  The plugin now asks for the default mode after opening a session, where its own permission
  answer allows ToolBelt's tools.
- **Thinking.** Claude Code omits `thinking` when it's off, and oMLX then applies the model's
  `enable_thinking: true`: about 3,500 characters of thinking per answer and twice the time.
  `MAX_THINKING_TOKENS=0` doesn't help; an oMLX profile of the model with thinking off (its own
  model name, for `ANTHROPIC_MODEL`) does.
- **Remaining overhead**, about 7–10 s per answer over the harness: Claude Code's own system prompt
  and the tools' framing (4.2k tokens before the question, against 2.4k), longer answers, and a
  session title generated on each new chat (7–10 s on oMLX, which serves one request at a time;
  it has no switch, but goes to `ANTHROPIC_DEFAULT_HAIKU_MODEL`, which could be a small model).

Run folders: `results/v2-claude-thinking` (stopped after 31 of 72 runs), `results/v2-claude`.
