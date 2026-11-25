# Agent interface

AI agents (Claude Code, Codex, Claude Desktop, scripts) can read ToolBelt's plugin screens on
this Mac through an MCP server and the `toolbelt` command. Access is read-only: agents can't
send plugin events, change settings or manage plugins. The person turns the interface on in
**Settings → Agents** and chooses per plugin what agents may read.

The plan for later phases (actions with approvals, autonomous agents, an in-app chat) is in
[plans/agent-interface.md](../plans/agent-interface.md); this document describes what exists.

| Part | Implementation |
| --- | --- |
| Shared types: access levels, settings, sessions, audit entries, Settings → Agents requests | `src/shared/agents.ts` |
| Core: access, the agent's view of surfaces, operations, sessions, audit | `src/bun/agent/core.ts`, `audit.ts` |
| Trees as text and JSON, redaction, paging | `src/bun/agent/serialize.ts` |
| MCP over the agent socket | `src/bun/agent/mcp.ts`, `server.ts` |
| Wiring for the app and the browser preview | `src/bun/agent/index.ts`, `src/bun/index.ts`, `scripts/preview.ts` |
| `toolbelt` CLI, stdio MCP shim, skill file | `src/cli/toolbelt.ts`, `src/cli/SKILL.md` |
| Settings → Agents | `src/ui/Agents.tsx` |

## Access

- **Master switch.** `settings.json` → `agents.enabled`, off by default. While it is off, no
  socket exists.
- **Plugin ceiling.** The manifest's optional `agent.access`: `none` hides the plugin from
  agents entirely, `read` lets them read its screens, `act` is reserved for actions. A plugin
  that declares nothing is `read`. `parseManifest` rejects other values. Older hosts keep the
  key without acting on it.
- **The person's choice.** `agents.access[<plugin id>]` in `settings.json`, set in Settings →
  Agents, can only lower the ceiling. Effective access is the lower of the two. Lowering it
  releases surfaces the agent holds for that plugin and ends resource subscriptions to it.
- A plugin below `read` is absent from every result. Asking for it by id gets the same refusal
  as an unknown plugin. `toolbelt_status` says only how many plugins are hidden.
- Remote access, plugin development mode and Settings → Agents itself are not reachable by
  agents. The `agents` RPC is excluded from remote connections (`REMOTE_EXCLUDED`), and remote
  devices don't show the tab.

## Transport

`AgentServer` listens on a Unix domain socket, `agent.sock` in ToolBelt's config folder
(`TOOLBELT_AGENT_SOCKET` overrides it). The file is mode `0600`, so only the user can connect.
One ToolBelt process serves a config folder at a time: a socket that still answers belongs to
another process, and the server refuses rather than taking it over. A stale file is replaced.
Turning the switch off or quitting stops the server and removes the file.

Each connection sends a hello line, `{"toolbelt":1,"client":"…","mode":"interactive"|"autonomous"}`,
then MCP JSON-RPC 2.0, one message per line (1 MiB limit per line). A connection without a
valid hello is closed. Each connection is one session. Its client name comes from the hello,
then from MCP `clientInfo`. Requests on one connection are answered in order.

`toolbelt mcp` is the stdio shim MCP clients start. It writes the hello and then pipes stdin and
stdout to the socket unchanged, with `--autonomous` setting the session's mode. The other
commands (`status`, `screens`, `read`, `search`, `plugins`) make one MCP tool call each and print
its text, or its structured content with `--json`. Exit codes: 1 when the socket can't be
reached, 2 when the call was refused or failed. `toolbelt skill` prints `SKILL.md`.

The app bundles the CLI as `Contents/Resources/app/cli/toolbelt.js` (`bun run cli`, copied by
`electrobun.config.ts`) and runs it with its own Bun. Settings → Agents shows the exact commands
to paste for Claude Code (`claude mcp add|remove --scope user toolbelt`), Codex
(`codex mcp add|remove toolbelt`), other MCP clients (an `mcpServers` JSON entry and the bare
server command), a shell alias and the skill file. Each has an Add and a Remove tab (built in
`src/ui/lib/agent-commands.ts`). The commands stay visible while agents are off, opening on Remove, so the
person can undo a setup without turning agents back on. ToolBelt never edits shell profiles or
agent configuration itself.

## MCP surface

The server negotiates protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and
`2024-11-05`, and answers with server instructions. Capabilities: `tools` and `resources` with
`subscribe` and `listChanged`.

| Tool | What it returns |
| --- | --- |
| `toolbelt_status` | App name, version, channel and development profile, app update availability, visible plugins with state, badge and screens, and the count of hidden plugins |
| `list_screens` | Readable screens as plugin and screen ids, optionally for one plugin |
| `read_screen` | One screen as text (default) or redacted JSON, with `max_rows`, `table` and `offset` paging and `details` |
| `search_screens` | Content lines containing every query word, across readable screens or one plugin |
| `list_plugins` | Installed plugins agents may see: version, repository, phase, channel, available update |

Every tool is declared `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`.
Results carry text content and, on success, `structuredContent`. Refusals are tool results with
`isError: true`, not JSON-RPC errors.

Every readable screen is also a resource, `toolbelt://screens/<plugin>/<screen>` (text/markdown).
`resources/subscribe` keeps that surface open for the session and sends
`notifications/resources/updated` at most once a second per screen while its tree changes. A
change in plugins or access sends `notifications/resources/list_changed`.

## Reading surfaces

The core keeps its own view of plugin surfaces next to the window, popover and remote views. It
counts as a viewer through `PluginHost.open`/`close`:

- A read of a surface nobody has open opens it, waits up to 4 s for its first render and keeps it
  open for 60 s after the last read, so plugins render and poll only while needed. Subscriptions
  keep it open until they end.
- `PluginHost.snapshot` returns the cached tree, when it arrived and how many viewers have the
  surface open. A plugin process that starts again clears its cached trees.
- A plugin that isn't running is reported with its state and first error line, not read.

`serialize.ts` turns a tree into text an agent can use:

- Pages: summary, filters (marked as default when they match the filter's `default`), choice
  controls, search highlight, enabled toolbar actions and an open dialog.
- Tables: sections and groups as headings (a sub-section as `Upcoming › This week`), one line per row with its cells, id and flags,
  children indented, and row details, stats and pane content underneath. Enabled row and bulk
  action labels appear once per table, and empty declared sections are listed.
- Times as local `YYYY-MM-DD HH:MM` with a relative hint, line breaks in values joined with
  " / ".
- Lists, forms, stats, cards, details, logs and terminals (last 40 lines), conversations (last
  20 messages), timelines, progress and Markdown. Composers are left out.
- Tables are paged per table, 100 rows by default, and the result names the next offset. Text is
  capped at 60,000 characters.
- `text` fields with `sensitive` and `secret` environment entries are masked as `••••••` in both
  text and JSON. Other plugin text passes through unchanged.

Search, filters, sort and dialogs are plugin view state shared by every viewer. A read
therefore shows what the person's view shows, and the result says so when a search, a
non-default filter or a dialog applies. Agents never send view events.

## Sessions and audit

Every tool call and resource read appends one line to `agent-audit.jsonl` in the plugin profile
folder (the development profile in development mode): time, session, client, mode, operation,
plugin, screen, outcome (`ok`, `denied`, `error`) and a short detail for refusals and errors.
The log is append-only and never pruned.

`AuditLog.query` reads it back newest first, in pages. An entry's id is the byte offset of its
line, so paging stays stable while entries are appended: `before` continues with older entries
(the previous page's `next`), and `after` fetches entries newer than the newest one shown. It
reads the file backwards in 256 KB chunks and filters with `auditMatches`: words across
operation and its label, plugin, screen, agent and detail; lists of plugins, outcomes and modes
(any of each); and a time range (`since`, `until`). Entries are appended in time order, so a
range that ends in the past starts by bisecting the file for its end, and a scan stops once it
passes the range's start (both allow 5 minutes of clock adjustment). Otherwise a filtered query
stops after scanning 8 MB and returns a cursor to go on from, so a rare search in a large log
never blocks the host. The `agentsState` message carries the newest 50 entries, unfiltered.

Settings → Agents has three sub-tabs (`src/ui/Agents.tsx`), the chosen one remembered:

- **General:** a status card with the master switch, its state (on, off, starting, error) and
  the socket, and four tiles: active sessions, readable plugins, requests today with refusals
  and failures (counted by an audit query from midnight, up to 1,000), and the last activity.
  The sessions and activity tiles open their tabs. Under it, **Plugin access**: each plugin's
  ceiling and the person's choice; choosing the plugin's own level clears the choice.
- **Connect:** **Active sessions** (client name, mode, how long connected; also counted on the
  tab), then **Setup commands** to add ToolBelt to agents and remove it again (see Transport).
- **Activity** (`src/ui/AgentActivity.tsx`): the log as a table of time, activity and detail,
  plugin and screen, agent and mode, and result. The search box and the Plugin, Result and
  Agent mode filters are the renderer's page search and multi-select `FilterMenu`, as plugin
  pages use them. Plugin lists installed plugins and any others the log mentions. Time
  (`src/ui/components/time-range-filter.tsx`, logic in `src/ui/lib/time-range.ts`) offers quick
  ranges (last 15 minutes to last 30 days, today, yesterday) and a From–To range made of two
  renderer datetime fields in `past` mode, where a typed "nov 20" or "fri" is the latest past
  one. A date alone covers its whole day and a time its whole minute. The host applies every
  filter. New entries matching the filters fade in at the top when `agentsState` shows the log
  grew, and "Display more…" adds older pages at the end. Narrow windows fold the plugin and
  agent columns into the activity cell.

## Testing

Three layers run in `bun test` (and so in CI), without a model:

| Layer | Where | What it checks |
| --- | --- | --- |
| Unit | `test/agents.test.ts` | Access levels, the manifest key, redaction, text and JSON paging, the core against a fake host (hiding, refusals, holds and release, crashed plugins, search, access changes), the socket and CLI |
| Scenarios | `test/agent-scenarios.test.ts`, `test/agent-scenarios/` | Life-like prompts with the tool calls an agent makes to answer them, run through every channel each lists, against real plugin processes |
| MCP conformance | `test/agent-mcp-conformance.test.ts` | Version negotiation (also unsupported versions), tool input schemas compiled as JSON Schema 2020-12 in strict mode, annotations, JSON-RPC error codes (-32601, -32602, -32600, -32700), refusals as `isError` results, in-order answers, hello-less connections, resources (list, read, templates, subscribe and unsubscribe, `list_changed`) |

### Scenarios

A scenario (`test/agent-scenarios/format.ts`, one JSON file per case in
`test/agent-scenarios/scenarios/`) is transport-neutral:

- `id`, `title`, `prompt`, `persona`, `mode` (interactive or autonomous) and `channels`
  (`mcp`, `cli`).
- `setup`: the master switch, the person's per-plugin access, and person actions before the agent
  starts.
- `steps`: tool calls (`call`, `args`, `structured` for MCP `structuredContent` or CLI
  `--json`), resource steps (`read`, `subscribe`, `unsubscribe`, MCP only) and person actions:
  `open` and `close` a screen, a UI `event` such as `search`, `filter` or an action id, `access`
  for a plugin, or the `agents` switch.
- `expect` on a step: `contains` (facts), `absent` (secrets, hidden plugin ids), `refused`,
  `unreachable` (agents off), and `notifications` that must arrive within a time after the step.
  Notifications are checked on channels that deliver them.
- `expect` on the scenario: facts and absences over all outputs together, and audit log entries
  in order (operation, outcome, plugin, mode).
- `rubric`: what a good final answer does, for model-based evaluation. Scripted tests ignore it.
- `origin`: where the case came from.

`harness.ts` gives each run its own world: a real `PluginHost` with the fixture plugins in
`test/fixtures/agents`, the agent interface with its socket in a temporary folder, and person
actions applied through the host and the Settings → Agents requests. Adapters in `adapters.ts`
run steps the way clients do: `McpAdapter` starts the stdio shim (`toolbelt mcp`) and speaks
JSON-RPC, restarting it after the socket goes away, and `CliAdapter` maps each tool to its
command (`read_screen` → `toolbelt read`) with exit code 1 as unreachable and 2 as refused.
Structured output is compared in compact JSON, so facts match on both channels. Another MCP
server or CLI needs only another adapter.

The fixtures mirror the shapes real plugins render without depending on any plugin
implementation: `desk` (a task list with sections, sub-sections and empty sections, nested
rows, row panes with an inline form and a timeline, a filter with a default, search with a
highlight and a dialog), `kit` (updates with status sections and split actions, nested activity
runs, a form with a sensitive field and secret environment entries, a 250-row table beside a
short one) and `vault`, which declares `agent.access: none`. They date content around
`test/fixtures/agents/clock.ts`, and the harness gives the core the same clock (`now` in
`AgentCoreOptions`), so relative times are stable. Scenarios check facts, not whole outputs:
absolute times are local to the machine running the tests.

`bun test/agent-scenarios/convert.ts` regenerates scenarios 01–17 from the first, hand-run
evaluation in `plans/agent-interface-eval/` (its `cases.json`, `steps.json` files and CLI
transcripts). It maps that run's plugins and screens onto the fixtures and adds each case's
facts and rubric from its overlay table. Change the overlay, not the generated files, for those
cases. New scenarios can be added to the converter's extras or written directly as JSON.

`bun run test:agents` runs the three layers. `AGENT_SCENARIOS_OUT=<dir>` also writes each
scenario run as Markdown (`<id>.<channel>.md`: the prompt, every step with what the agent got
back, notifications, failures and the rubric), and `-t <text>` picks scenarios by name, for
example `AGENT_SCENARIOS_OUT=/tmp/runs bun test test/agent-scenarios.test.ts -t 09-watch`.

`TOOLBELT_MCP_INSPECTOR=1 bun test test/agent-mcp-conformance.test.ts` also runs the MCP
Inspector CLI against the shim. It needs the network for `bunx`, so CI doesn't run it.

The browser preview runs the same interface: `PREVIEW_AGENTS=1` starts it on, and its socket
lives in the preview's config folder unless `TOOLBELT_AGENT_SOCKET` is set. Unix socket paths
are limited to about 100 bytes, so use a short `TOOLBELT_AGENT_SOCKET` with long temporary
config folders.
