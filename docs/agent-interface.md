# Agent interface

AI agents (Claude Code, Codex, Claude Desktop, scripts) can read ToolBelt's plugin screens on
this Mac through an MCP server and the `toolbelt` command. Each agent reads its own instance of a
screen and can search, filter and sort it in the same call without changing what the person
sees. The one thing an agent changes is the person's view (`show_screen`), when the person allows
it on their own screens. Agents can't send plugin events, change settings or manage plugins. The
person turns the interface on in **Settings → Agents** and chooses per plugin what agents may
read.

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
| The approval dialog and "Shown by" notice on the person's screens | `src/ui/AgentPrompts.tsx` |
| Views and instances (SDK, host, the person's saved view) | `src/shared/views.ts`, `src/sdk/index.ts`, `src/bun/host.ts`, `src/bun/views.ts`; see [plugins.md](plugins.md#views) |

## Access

- **Master switch.** `settings.json` → `agents.enabled`, off by default. While it is off, no
  socket exists.
- **What the plugin declares.** The manifest's required `agent.access`: `none` hides the
  plugin from agents entirely, `read` lets them read its screens and show the person a screen,
  `act` is reserved for actions. `parseManifest` rejects a manifest without it or with another
  value. The declared level is both the default and the most the person may allow. A registry
  record from before protocol 2 that declares nothing counts as `none` (`declaredAccess`); such
  a plugin can't run on this host anyway.
- **The person's choice.** `agents.access[<plugin id>]` in `settings.json`, set in Settings →
  Agents. Effective access is the choice, else the declaration, never above it
  (`effectiveAccess`). Choosing the declared level clears the entry. Lowering access releases
  instances the agent holds for that plugin and ends resource subscriptions to it.
- A plugin below `read` is absent from every result. Asking for it by id gets the same refusal
  as an unknown plugin. `toolbelt_status` says only how many plugins are hidden.
- Remote access, plugin development mode and Settings → Agents itself are not reachable by
  agents. Paired remote devices are trusted like the Mac: they show Settings → Agents and use
  the same `agents` RPC and `agentsState` updates, so they can turn agents on or off and change
  each plugin's access.

## Transport

`AgentServer` listens on a Unix domain socket, `agent.sock` in ToolBelt's config folder
(`TOOLBELT_AGENT_SOCKET` overrides it). The file is mode `0600`, so only the user can connect.
One ToolBelt process serves a config folder at a time: a socket that still answers belongs to
another process, and the server refuses rather than taking it over. A stale file is replaced.
Turning the switch off or quitting stops the server and removes the file.

Each connection sends a hello line, `{"toolbelt":1,"client":"…","mode":"interactive"|"autonomous","group":"…"}`,
then MCP JSON-RPC 2.0, one message per line (1 MiB limit per line). A connection without a
valid hello is closed. Each connection is one session. Its client name comes from the hello,
then from MCP `clientInfo`. Requests on one connection are answered in order. Connections with
the same client, mode and `group` continue the session id of the last one that ended within 10
minutes, unless that session is still connected, so short connections from one source read as
one session in the audit log. The CLI sends `ppid:<parent process id>`: one shell's or script's
calls group.

`toolbelt mcp` is the stdio shim MCP clients start. It writes the hello and then pipes stdin and
stdout to the socket, with `--autonomous` setting the session's mode and `--client NAME` naming the
session (the hello's `name`): MCP `clientInfo` then doesn't rename it, so a plugin that starts an
agent itself, like an in-app chat, shows up as "Agent · Claude Code" in grants and the audit log.
Plugins get the command for this ToolBelt in `TOOLBELT_AGENT_COMMAND` (a JSON array,
`[bun, cli, "--socket", path]`; the SDK's `agentCommand()`), so they don't depend on the person's
PATH or reach another build or profile. It exits with code 1 if
the socket can't be reached at start. When the socket goes away later (a ToolBelt update or
restart, agents turned off), the shim stays up so the client doesn't mark the server failed: it
answers requests with JSON-RPC error `-32000` (`data.reason: "unreachable"`, saying ToolBelt
is restarting or off), reconnects with backoff from 250 ms to 5 s and right away when a request
arrives, replays the client's `initialize` (its reply swallowed), `notifications/initialized`
and resource subscriptions on the new session, and sends the client
`notifications/resources/list_changed`. The other
commands (`status`, `screens`, `read`, `show`, `search`, `plugins`) make one MCP tool call each and print
its text, or with `--json` ask for `format: "json"` and print the structured content. Each command
accepts only its own options; an unknown option, a missing value or a wrong number is a usage
error. Exit codes: 1 when the socket can't be reached, 2 when the call was refused or failed or
the command line is wrong. `toolbelt skill` prints `SKILL.md`.

The app bundles the CLI as `Contents/Resources/app/cli/toolbelt.js` (`bun run cli`, copied by
`electrobun.config.ts`) and runs it with its own Bun. Without `--socket`,
`TOOLBELT_AGENT_SOCKET` or `TOOLBELT_CONFIG_DIR`, the CLI uses the folder of the app it ships in,
from the bundle's `Resources/version.json` channel (`bundledSettingsFolder`): ToolBelt Dev's CLI
talks to ToolBelt Dev. Outside a bundle it uses ToolBelt's folder. Settings → Agents shows the exact commands
to paste for Claude Code (`claude mcp add|remove --scope user toolbelt`), Codex
(`codex mcp add|remove toolbelt`), other MCP clients (an `mcpServers` JSON entry and the bare
server command), a shell alias and the skill file. Each has an Add and a Remove tab (built in
`src/ui/lib/agent-commands.ts`). The commands stay visible while agents are off, opening on Remove, so the
person can undo a setup without turning agents back on. When the commands run a CLI outside an
installed app (a development build such as a worktree's `build.noindex`, or the source in the
browser preview), `AgentsState.commandWarning` says they stop working once that build or folder
goes, and the Connect tab shows it above the commands. ToolBelt never edits shell profiles or
agent configuration itself.

## MCP surface

The server negotiates protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and
`2024-11-05`, and answers with server instructions. Capabilities: `tools` with
`listChanged: false` (the tool list never changes), and `resources` with `subscribe` and
`listChanged: true`.

| Tool | What it returns |
| --- | --- |
| `toolbelt_status` | The runtime view, where agents start: app name, version, channel and development profile, the app bundle answering and its process id (two builds of one version on one profile are otherwise indistinguishable; the second can't serve the socket and says so in Settings → Agents), app update availability, visible plugins with state, badge (only while running; the description says a badge is the plugin's own attention signal, not a total), screens and available update, and the count of hidden plugins |
| `list_screens` | Readable screens as plugin and screen ids, optionally for one plugin, each with its view schema: search, filters with option values (once the screen has rendered) and defaults, sortable tables with their column keys, page controls |
| `read_screen` | One screen as text (default) or redacted JSON, with `max_rows`, `table` and `offset` paging and `details` (rows' inspector content, off by default), read through the agent's own instance with an optional `view`, or `view: "person"` for the person's |
| `show_screen` | Shows the person a screen, optionally with a view, on every person's screen that is open, after the person allows it; reports devices that don't show it (see Showing the person a screen) |
| `search_screens` | Content lines containing every query word, across readable screens or one plugin, grouped by row (a row's line with its matching details, each shortened to 300 characters); when no line has every word, the closest lines; rows the screens' default filters hide; and the screens that couldn't be read |
| `list_plugins` | The installation view: every installed plugin agents may see, enabled or not, with version, state (the runtime state while enabled, else `disabled`), access, available update, repository and channel |

Every tool is declared `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`,
and `readOnlyHint: true` except `show_screen` (risk `view`: it changes what the person's screens
show, never data).
Every tool takes `format`: `text` (default) or `json`. A text result is one text content item
with everything the agent needs (times, whether a person has the screen open, hints, failed
screens) and no `structuredContent`, because some clients (Claude Code) show `structuredContent`
instead of the text when it is present. A JSON result has `structuredContent`, and its text is
that object serialized, so both carry the same information. Structured times are epoch
milliseconds with an ISO 8601 copy (`renderedAtIso`, `lastCheckedIso`, and `atIso` beside each
`at`, `metaAt` and `edited` in trees). Errors are tool results with `isError: true`, not
JSON-RPC errors.

`read_screen`'s `parent` (a row id in `table`) pages that row's child rows with `offset`, as if
they were the table's rows; an unknown row is refused. Plugin and screen ids match in any case, and by plugin name or screen title. An unknown id gets
close matches among the readable ids and the readable plugins themselves (up to 10, else a
pointer to `list_screens`); hidden plugins are never suggested or listed. A `table`
that isn't on the screen is refused with the screen's table ids, and `offset` without `table`
pages the screen's only table (refused when there are several).

Every readable screen of a running plugin is also a resource, `toolbelt://screens/<plugin>/<screen>` (text/markdown).
Reading one that doesn't exist for agents is `-32002`; reading one whose plugin can't be read
now (crashed, failed render) is `-32603` with the reason. The template
`toolbelt://screens/{plugin}/{screen}{?table,parent,offset,max_rows,details,view,search}` reads a
screen with `read_screen`'s paging and view: `search=…`, `filter.<id>=a,b` (empty for all),
`sort.<table>=-key` and `control.<id>=value`, or `view=person`. An unknown or malformed
parameter, or a view control or option the screen doesn't offer, is `-32602`. A resource read's
paging notes name the URI to read next, keeping its view
(`toolbelt://screens/kit/queue?filter.state=failed&table=jobs&offset=50`), rather than
`read_screen` options.
`resources/subscribe` keeps that URI's instance open for the session and sends
`notifications/resources/updated` at most once a second per URI while that instance's tree
changes; the shim replays subscriptions, views included, after a ToolBelt restart. A change in
plugins or access sends `notifications/resources/list_changed`.

## Reading surfaces

Agents read plugin surfaces through instances ([plugins.md](plugins.md#views)). The person's
screens share one, `PERSON`; the core opens agent instances of its own through
`PluginHost.open(plugin, surface, instance, view)`:

- **Its own view.** `read_screen` without `view` reads `agent:default`: the screen as it starts,
  with the plugin's default search, filters and sort, whatever the person set. With `view`
  (`{ search, filters: { id: [values] }, sort: { table: "key" | "-key" }, controls: { id: value } }`)
  it reads the declared defaults overlaid with those. Each distinct view (canonical JSON) is one
  instance, `agent:<hash>`, shared by every session that asks for it; reads never send events,
  so sharing is safe. The person's screens never change.
- **Names.** A filter, control or sortable column can be named by its id or its label (a column
  by its title), and an option by its value or its label, ignoring case and surrounding spaces
  (`names.ts`). Labels come from the person's or the default agent instance's latest tree; a view
  naming controls on a screen with no tree yet renders the default instance first. A filter and
  its values are read together: of the filters the key could name (an exact id, else any id or
  label equal ignoring case), those offering every value fit. One fit is used; when several fit
  the exact id wins and the result names the other filters; otherwise the call is refused with
  the candidates, as is an option label two options share or a filter named twice. Exact ids and
  values always keep their meaning. When names were read, the header adds `Names read as: …`
  with the ids and values used (JSON `namesRead`; show_screen's result too).
- **Checked against the screen.** View fields the screen doesn't declare are refused with the
  ones it does, by label with the id in brackets where they differ (`ViewRefusal`, kind
  `invalid`, audited as `denied`); after the instance renders, option values, control values and
  sort keys it doesn't offer are refused with the valid ones.
  The result's header says `Your view: …` (the view in words, or "as the screen starts").
- **The person's view.** `view: "person"` reads the person's instance, counting as one more
  viewer of it. Its header lists the view state the person set (a search, a non-default filter,
  an open dialog) and that rows outside it are not listed; JSON carries the same notes as
  `viewState`. `personViewing` says whether someone besides the agent has the person's view open.
- `viewSchema` (in `list_screens`) takes ids and defaults from the plugin's declaration and
  options from the person's or the default agent instance's latest tree, so options appear once
  the screen has rendered.
- A read of an instance nobody has open opens it, waits up to 4 s for its first render and keeps
  it open for 60 s after the last read, so plugins render and poll only while needed.
  Subscriptions keep it open until they end.
- `PluginHost.snapshot(plugin, surface, instance)` returns the instance's cached tree, when it
  arrived and how many viewers have it open. A plugin process that starts again clears its cached
  trees and reopens every instance with its view.
- An instance whose last render the host rejected (see [architecture](architecture.md)) is
  unavailable with the reason; the plugin's other screens and instances still read.
- A plugin that isn't running is reported with its state and first error line, not read. This
  is a failure (`unavailable`, audited as `error`), not a refusal. `toolbelt_status` marks it,
  leaves out its stale badge, and `list_screens` marks its screens unavailable.
- A screen that hasn't rendered within the wait is a successful read with `rendered: false` and
  a hint to try again.

`serialize.ts` turns a tree into text an agent can use:

- Pages: summary, filters (marked as default when they match the filter's `default`), choice
  controls, search highlight, enabled toolbar actions and an open dialog. A filter's id and an
  option's value follow its label in brackets where they differ beyond case
  (`Filter Workflow [workflow-state]`, `No project [__none] 6`). Under a filter that hides rows
  and that the reader didn't choose itself (a default, or the person's), `Hidden by this filter:`
  lists its unchecked options with rows (up to 8, with counts when the plugin gives them; options
  counted 0 are left out) and the view that includes them.
- Tables: sections and groups as headings (a sub-section as `Upcoming › This week`, a
  sub-section named like its parent only once), one line per row with its cells, id and flags,
  children indented, and, with `details: true`, row details, stats and pane content underneath. A stat or detail that
  repeats the row's cell of the same name is left out, as is a long value (40 characters or more,
  such as a command line) that the row line or its parent row's line already shows. Enabled row and bulk action labels appear
  once per table; with details, a row whose `actions` allow fewer lists its own (without, the
  table's list says a row may allow fewer). Empty declared sections are listed when every row was read.
- A row's drawer (`pane`) leaves out what says nothing or repeats the row: empty fields, empty
  timelines and lists (no empty message), a card left with nothing in it, and a field, detail or
  text whose value equals the row's first cell's text, a cell's subtitle or one of the row's
  section labels. The same nodes outside a drawer keep their empty values and messages.
- A timeline or list directly under a heading (a card's title such as `Updates · 3`) adds no
  heading or count of its own.
- Headings use labels, not the plugin's ids: `Timeline`, `List`, an untitled form without a
  heading, and a field without a label shows only its value (or nothing, without one). An empty
  timeline or list shows the plugin's empty message without a count. Table ids stay, because
  `table` pages by them.
- Times as local `YYYY-MM-DD HH:MM` with a relative hint. Line breaks in every value are joined
  with " ⏎ " (not "/", which commands and paths are full of), so each value stays on its line
  and indentation.
- Lists, forms, stats, cards, details, logs and terminals (last 40 lines), conversations (last
  20 messages), timelines, progress and Markdown. Composers are left out. A collapsible card's
  children are read whether the person has it open or not (that state stays in the renderer).
- Tables are paged per table, 50 rows by default, counting child rows. Top-level rows come whole;
  only a first row too big for the page is cut, its remaining children counted
  (`omittedChildren` in JSON) with the `parent` read that pages them. Offsets and "of N" count
  top-level rows; when a table has nested rows, its heading gives both counts
  (`50 rows (412 with nested rows)`) and paging notes say which unit is which. The result names
  the next offset. `max_rows: 0` lists each
  table's size and columns without rows. An offset past the end says so.
- Results have size budgets: 50,000 characters of text, 100,000 of JSON (`TEXT_BUDGET`,
  `JSON_BUDGET`). Tables stop at a row boundary before the budget and name the offset to resume
  from (room is kept for that note, so the final cut never drops it); a later table that no
  longer fits still gets its heading and how to read it. JSON tables
  cut this way get `paging.reason: "size"`. Content outside tables is cut at a line boundary,
  saying after which line. Search reads screens without the budget.
- `details` defaults to false: rows' details, stats, panes and own action lists are left out of
  both text and JSON, and a text table whose rows have any says
  `(rows' details left out: pass details: true to include them)` (`add details=true` for a
  resource read). Search reads screens with details.
- JSON leaves out fields that only affect the UI's look or operation (icons, widths, emphasis,
  placeholders, drag and drop, column hiding, collapsing, keyboard shortcuts, colors and shades;
  `VISUAL_KEYS`), never plugin-named data such as a row's cells. Keys other objects use for data
  are left out only where they are visual (`visualHere`): `color` except on a status dot, an
  action's `key` and `group`, a section's drag `order`, a textarea's `rows`.
- In a row's drawer, JSON choice fields (`select`, `combobox`, `tags`) drop their choices
  (`options`, `keys`), which every row repeats, and carry `valueLabel` (`tags`: `valueLabels`,
  as in text, `Project: Houses`) beside the raw `value`. Forms outside rows keep their choices.
- `text` fields with `sensitive` and `secret` environment entries are masked as `••••••` in both
  text and JSON. Keychain secrets (`secret` text fields, entries of a `secretPrefix` environment
  field) never carry a value: text says `•••••• (saved in Keychain)` or `not set` (`(not set)` for
  an entry), JSON gives `••••••` or `""` beside `stored`. In all other plugin text, `maskSecrets` masks values that look like secrets:
  secret-named flags and variables (`--token=…`, `--api-key …`, `GITHUB_TOKEN=…`, `"api_key": "…"`,
  `password: …`), secret query parameters, `Authorization` and `Bearer` values, passwords in
  URLs, and well-known token formats (GitHub, OpenAI and Anthropic, Slack, AWS access keys,
  GitLab, npm, Google API keys, JWTs). Names stay; only values are masked. This is a safety net,
  not a guarantee: plugins should mark sensitive values themselves.

`search_screens` reads each screen's default agent instance, so the person's search or filters
don't hide matches; screens are searched as they start, so a plugin's default filter may still
leave out, say, archived tasks. The result always ends by naming such rows per screen
(`Not searched, hidden by default filters: …`, JSON `hidden`) and the view that reads them.
When no line contains every word, it retries ignoring word endings (`stem`: words over five
letters lose up to three, keeping five) with every word, then one word fewer at a time, and
shows up to 15 of the lines with the most words under `No line mentions every word of "…".
Closest lines (…)` (JSON `closest`: how many of how many words).

## Showing the person a screen

`show_screen({ plugin, screen?, view?, open_window? })` changes the person's view: it is what an
agent uses when the person asks "show me my overdue tasks". It needs the plugin at `read` access.

- **The person's screens.** The app gives the core `PersonScreens`: the devices (the Mac, showing
  while its window is open, and each paired device, showing while it has ToolBelt open), opening
  the window, navigating every open person's screen (the window and remote views) to a plugin
  screen, and reading and setting the person's view. Setting it applies at once when the person's
  instance is open (`PluginHost.setView`; the plugin echoes the cleaned view and the host saves
  it), else saves it in `views.json` for next time. `view` replaces the person's view: the
  screen's defaults overlaid with it. Without `view` only the screen changes.
- **A view-control grant.** The first call from an agent (by client name) without a grant asks
  on every open person's screen: the dialog (`ViewApprovalDialog`) names the agent and what it
  wants to show, offers how long to allow it (this session, 1 hour, today, 7 days, 30 days;
  default today; never forever) and counts down. The call waits up to 60 s (`approvalMs`). No
  answer or a refusal returns a refusal and changes nothing; the two say so differently (no answer:
  ask whether to try again; refused: don't ask again unless the person asks). Saved grants
  (`settings.json` → `agents.grants`) end at their time; a this-session grant lives in memory and
  ends when the session does (for the CLI, the grouped session of one shell or script). Grants
  are consent, not authentication: the socket is user-only and any of the user's processes can
  claim any client name. Settings → Agents → Access lists them under **Changing your view** with
  Revoke.
- **Nobody to ask.** With no person's screen open and no grant, the call is refused at once,
  saying the window is closed and which devices don't have ToolBelt open, and telling the agent
  to ask the person; `open_window: true` (only when the person asked for it or agreed) opens the
  window on the Mac and asks there.
- **Devices that don't show it.** The result lists the devices showing the screen and the ones
  that don't (the Mac's window closed, a paired device without ToolBelt open), and tells the
  agent to tell the person and ask what to do.
- **Restore.** The page shows "Shown by <agent>" (`ShownNotice`) with **Restore**, which puts
  back the person's view from before the agent's first change, and a close button that keeps the
  view. A later change of the person's own (a view that differs from what the agent set) removes
  the notice. The value checks of `read_screen` apply before anything reaches the person.
- **Audit.** Each question is a `view_grant` entry (`ok` with the duration, `denied` for a
  refusal or no answer), and each call a `show_screen` entry.

## Sessions and audit

Every tool call and resource read appends one line to `agent-audit.jsonl` in the plugin profile
folder (the development profile in development mode): time, session, client, mode, operation,
plugin, screen, outcome (`ok`, `denied` for refusals: unknown or hidden plugins, screens and
tables; `error` for failures such as a crashed plugin) and a short detail for refusals and errors.
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

- **Access:** a status card with the master switch, its state (on, off, starting, error) and
  the socket, and four tiles: active sessions, readable plugins, requests today with refusals
  and failures (counted by an audit query from midnight, up to 1,000), and the last activity.
  The sessions, requests and last-activity tiles open Activity. Under it, **Plugin access**:
  what each plugin declares and the person's choice, then **Changing your view**: the agents
  allowed to change the person's view, until when, each with Revoke.
- **Connect:** **Setup commands** to add ToolBelt to agents and remove it again (see
  Transport).
- **Activity:** **Active sessions** first (client name, mode, how long connected; also
  counted on the tab), then the log (`src/ui/AgentActivity.tsx`) as a table of time,
  activity and detail, plugin and screen, agent and mode, and result. The search box and the Plugin, Result and
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
| Unit | `test/agents.test.ts`, `test/views.test.ts`, `test/sdk.test.ts` | Access levels, the manifest key, grants and their ends, redaction, text and JSON paging, the core against a fake host (hiding, refusals, holds and release, crashed plugins, search, access changes, view instances and checks, show_screen's questions, grants, timeouts, Restore), the socket and CLI; views and instances through a real SDK plugin (the person's saved view, agent instances, restarts, per-instance render errors) and the SDK's view handling |
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
  for a plugin, the `agents` switch, `restore` on a screen an agent changed, or `revoke` a grant
  (`"*"` for every agent's). A `show_screen` call step takes `answer` (`allow`, `duration`): the
  person's answer as soon as they're asked; without it nobody answers.
- `setup.devices`: whether the Mac's window is open (default yes) and paired devices with whether
  each has ToolBelt open, as `show_screen` sees them.
- `expect` on a step: `contains` (facts), `absent` (secrets, hidden plugin ids), `refused`,
  `unreachable` (agents off), `notifications` that must arrive within a time after the step,
  `personView` (the person's saved view of a screen afterwards) and `navigated` (the screens shown
  on the person's screens by the step). Notifications are checked on channels that deliver them.
- `expect` on the scenario: facts and absences over all outputs together, and audit log entries
  in order (operation, outcome, plugin, mode).
- `rubric`: what a good final answer does, for model-based evaluation. Scripted tests ignore it.
- `origin`: where the case came from.

`harness.ts` gives each run its own world: a real `PluginHost` with the fixture plugins in
`test/fixtures/agents`, the agent interface with its socket in a temporary folder, and person
actions applied through the host and the Settings → Agents requests. Adapters in `adapters.ts`
run steps the way clients do: `McpAdapter` starts the stdio shim (`toolbelt mcp`) and speaks
JSON-RPC (a request the shim answers as unreachable counts as unreachable; it starts the shim
again if it exits), and `CliAdapter` maps each tool to its
command (`read_screen` → `toolbelt read`) with exit code 1 as unreachable and 2 as refused.
Structured output is compared in compact JSON, so facts match on both channels. Another MCP
server or CLI needs only another adapter.

The fixtures mirror the shapes real plugins render without depending on any plugin
implementation: `desk` (a task list with sections, sub-sections and empty sections, nested
rows, row panes with an inline form and a timeline, SDK-owned views: a filter with a default,
search with a highlight and a sortable column; and a per-instance dialog), `kit` (updates with status sections and split actions, nested activity
runs, a form with a sensitive field and secret environment entries, a 250-row table beside a
short one) and `vault`, which declares `agent.access: none`. They date content around
`test/fixtures/agents/clock.ts`, and the harness gives the core the same clock (`now` in
`AgentCoreOptions`), so relative times are stable. Scenarios check facts, not whole outputs:
absolute times are local to the machine running the tests.

`bun test/agent-scenarios/convert.ts` regenerates scenarios 01–17 from the first, hand-run
evaluation in `plans/agent-interface-eval/` (its `cases.json`, `steps.json` files and CLI
transcripts). It maps that run's plugins and screens onto the fixtures and adds each case's
facts and rubric from its overlay table. Change the overlay, not the generated files, for those
cases. Its extras add scenarios 18–21: the person's dialog and filter, the agent's own views
(19), showing the person a screen with grants, Restore and refusals (20), and nobody to ask
(21). New scenarios can be added to the converter's extras or written directly as JSON.

`bun run test:agents` runs the three layers. `AGENT_SCENARIOS_OUT=<dir>` also writes each
scenario run as Markdown (`<id>.<channel>.md`: the prompt, every step with what the agent got
back, notifications, failures and the rubric), and `-t <text>` picks scenarios by name, for
example `AGENT_SCENARIOS_OUT=/tmp/runs bun test test/agent-scenarios.test.ts -t 09-watch`.

### Model evaluation

[`evals/agent-models/`](../evals/agent-models/README.md) measures models as the agent: a model
(local, served by oMLX) holds conversations through pi-durable with ToolBelt's MCP tools as its only
tools, against worlds from `createWorld` that run a pinned OnTrack release with seeded data and the
`kit` and `vault` fixtures. It grades answers with deterministic checks and an optional judge model,
and records speed, context and memory. It has its own dependencies and is not part of `bun test`
or CI, except its grading unit tests. `createWorld`'s `WorldOptions` (plugin folders, clock, host
version, data seeding) exist for it; scenarios use the defaults.

`TOOLBELT_MCP_INSPECTOR=1 bun test test/agent-mcp-conformance.test.ts` also runs the MCP
Inspector CLI against the shim. It needs the network for `bunx`, so CI doesn't run it.

The browser preview runs the same interface: `PREVIEW_AGENTS=1` starts it on, and its socket
lives in the preview's config folder unless `TOOLBELT_AGENT_SOCKET` is set. Unix socket paths
are limited to about 100 bytes, so use a short `TOOLBELT_AGENT_SOCKET` with long temporary
config folders.
