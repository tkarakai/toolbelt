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
for Claude Code, other MCP clients, a shell alias and the skill file. ToolBelt never edits shell
profiles or agent configuration itself.

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
- Tables: sections and groups as headings, one line per row with its cells, id and flags,
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

Settings → Agents lists connected sessions with their client name and mode. Every tool call and
resource read appends one line to `agent-audit.jsonl` in the plugin profile folder (the
development profile in development mode): time, session, client, mode, operation, plugin,
screen, outcome (`ok`, `denied`, `error`) and a short detail for refusals and errors. The log is
append-only and never pruned. The tab shows the newest 50 entries and pages back through the
last megabyte of the file.

## Testing

`test/agents.test.ts` covers access levels, the manifest key, redaction, text and JSON paging,
the core against a fake host (hiding, refusals, holds and release, crashed plugins, search,
access changes) and the socket and CLI end to end. The browser preview runs the same interface:
`PREVIEW_AGENTS=1` starts it on, and its socket lives in the preview's config folder unless
`TOOLBELT_AGENT_SOCKET` is set. Unix socket paths are limited to about 100 bytes, so use a short
`TOOLBELT_AGENT_SOCKET` with long temporary config folders.
