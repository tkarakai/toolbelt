# Agent interface: proposal and feasibility

Status: **proposal**, not implemented. Nothing in this document describes current behavior
except where it says "today". Analysis date: 2026-11-24.

Analyzed versions (each repository's `main` equals its latest release):

| Product | Version |
| --- | --- |
| ToolBelt host | 0.3.24 (`main` at `5b872b9`) |
| Processes (`toolbelt-ps`) | 0.1.7 |
| Upkeep (`toolbelt-upkeep`) | 0.2.0 |
| OnTrack (`toolbelt-ontrack`) | 0.14.0 |
| SDK Explorer (`toolbelt-sdk-demo`) | 0.2.1 |

## Goal

Make ToolBelt agent-native: an LLM can read and operate the app and every plugin, either for a
person chatting with it or as an autonomous agent acting on the person's behalf. The
foundation has to be complete (it covers every plugin without per-plugin glue), safe (it keeps
the confirmations, approvals and data-recovery guarantees people rely on today) and robust
(results are explicit, concurrent people and agents don't corrupt each other's work).

## Why MCP and not WebMCP

WebMCP (W3C Web Machine Learning Community Group draft; Chrome origin trial from Chrome 149)
lets a web page register tools for the browser's own agent while a tab is open. It doesn't fit
ToolBelt:

- ToolBelt renders in WKWebView. WebKit's standards position on WebMCP is "oppose", and
  neither Safari nor the remote web client running in iOS Safari implements it.
- Nothing inside the app would consume the tools. WebMCP serves a browser-resident agent,
  not Claude Code, Codex or an in-app chat.
- ToolBelt's state (plugin processes, trees, the package manager, settings) lives in the Bun
  main process. The WebView is one view among several (window, popover, remote clients).

The Model Context Protocol (spec 2026-07-28: stateless core, extensions for Tasks and MCP
Apps, elicitation) is supported by every major agent and maps directly onto ToolBelt's
structure. A CLI complements it for coding agents and scripts.

## The steps

| # | Step | Delivers on its own | Depends on |
| --- | --- | --- | --- |
| 1 | Internal agent API in Bun: screens as tools plus host operations | One place that defines addressing, serialization, risk, approval, audit and redaction. An in-process LLM loop, a command palette, cross-plugin search and semantic tests can use it directly | — |
| 2 | Loopback MCP server plus a stdio shim | Any MCP client (Claude Code, Claude Desktop, Codex, IDEs) can operate ToolBelt. Surfaces become MCP resources with change notifications; risk maps to tool annotations; approvals use elicitation where the requester is the person | 1 |
| 3 | `toolbelt` CLI and a skill file | Token-cheap, scriptable access for coding agents and humans (`toolbelt screen read processes`, `--json`) | 1 (same socket as 2) |
| 4 | In-app chat as an ACP client | The person plugs in Claude Code, Codex or Gemini CLI through the Agent Client Protocol; ToolBelt hosts the conversation and points the agent at its own MCP server. ToolBelt doesn't own model choice, keys or the agent loop | 1, 2 |
| 5 | Plugin-declared tools in the SDK | High-level, parameterized operations with typed results (`ontrack.addTask`, `upkeep.plan`) instead of driving screens | 1; the core moves into phase 1c (see 5.3) |
| 6 | *Optional, added later:* ToolBelt-hosted autonomous agents | Scheduled agent sessions that ToolBelt starts itself through ACP and that run within standing grants the person defined (R13) | 1, 4 |

The rest of this document is the feasibility analysis of step 1: the inventory of what exists,
the obstacles, and the remedies, including the re-architecture they need.

---

# Part 1: Inventory

## 1.1 Host operations today

The renderer, the popover and remote clients call the Bun main process through the RPC schema
in `src/shared/rpc.ts`. Remote clients use the same handlers minus `REMOTE_EXCLUDED`
(`popoverLayout`, `development`, `setShortcut`, `pauseShortcut`).

Risk classes used throughout:

| Class | Meaning |
| --- | --- |
| `read` | No effect |
| `view` | Changes only what a surface shows (search, filter, sort, dialog open/close) |
| `write` | Reversible change to ToolBelt or plugin data |
| `external` | Visible on the Mac but not data: focus a window, open a URL, write the clipboard, start a command in a terminal |
| `destructive` | Kills processes, deletes data, changes software |
| `trust` | Supply chain: installing, removing or updating plugins and the app. An agent may request these; the person approves every one (never covered by a standing grant) |
| `human-only` | Network exposure and remote access, pairing, dotfiles, managed-data recovery, running user-authored shell: never offered to agents |

```ts
// Plugins (host.ts, plugin-state.ts)
plugins(): { manifest; state: "starting"|"running"|"crashed"|"stopped"; badge; error? }[]   // read
restartPlugin({ plugin })                                                                   // write
open({ plugin, surface }): Node | null   /  close / event({ plugin, surface, name, payload }) // see 1.2

// Plugin manager (plugin-manager-service.ts handle())
resolve({ repo, release?, prerelease? }) → { candidate: { token, manifest, publisher, commit, asset, size, sha256 } }  // read (network)
install({ token })            // trust: the token is the only approval, minted by resolve, valid 10 min
discard({ token })            // write
enable({ id, enabled })       // write
remove({ id, deleteData })    // trust
checkUpdates() / setChannel({ id, channel }) / cancel({ operationId })   // read / trust / write
cleanup({ id }) → { navigate }   // human-only: the plugin's confirmed cleanup screen edits dotfiles
recover({ id, choiceId })     // human-only (managed-data recovery)
read() / list()               // read

// App
settings() → { shortcut, shortcutLabel, shortcutError, theme, mode, badgePlugins }   // read
setAppearance({ theme?, mode? }) / setShortcut({ accelerator }) / pauseShortcut      // write
updateState / checkForUpdates / cancelUpdate / dismissUpdate                         // read / write
installUpdate                                                                        // trust (relaunch ends the agent's own session)
remoteAccess(*)                                                                      // human-only, including reads
development(state|diagnostics | choose|enter|exit|load|watch|reset)                  // read | write (dev profiles; choose opens a native file dialog)
openUrl({ url: http|https|mailto })                                                  // external
showWindow / hidePopover / closeWindow / quit (messages)                             // external; quit has no host-side confirmation
fileIcon / pluginAsset / popoverLayout / initialNavigation / buildId                 // renderer plumbing, not exposed
```

Settings, updates, remote access, development mode and the plugin manager are React screens,
not plugin trees. An agent reaches them only through these operations.

## 1.2 The plugin pipeline today

- **Trees.** `PluginProcess.trees` caches the last valid tree per surface and broadcasts every
  render to every view. Plugins render only surfaces with an open viewer (SDK `open` set).
  Without a viewer the cached tree goes stale. Trees aren't cleared on restart.
- **Viewers.** `open`/`close` are reference-counted per view. A view (window, popover, remote
  client) is a `{ send }` object in module-local `views`/`opened` maps in `src/bun/index.ts`.
  Remote clients are already "virtual views" (`remoteSender` proxies `send.*` onto a
  WebSocket), which is the pattern an agent view would reuse.
- **Events.** `event` checks name and surface length and that the payload is plain JSON under
  64 KiB, sets `userEventAt` and the global `lastEvent`, activates the window for
  `handoffActions`, and writes the line. It returns `true` immediately, even when the plugin has
  crashed. Nothing links an event to the renders or toasts it causes.
- **Checks only the renderer performs.** `confirm` (`useConfirm`), `disabled`, which actions a
  row offers, targets and split-button alternatives, `input` prompts, dialog scoping, toast
  action ids, commit-on-blur, and the payload shapes (`rowId` rewriting for context rows,
  `{dialog}`, `{composer,text}`, `{rowIds}`, list/tag open, `filter-arrange`, `reorder.onto`).
  `EventPayloads` in `protocol.ts` is missing `filter-arrange` and `reorder.onto`.
- **Plugin messages.** Toasts go to every view (and are lost when only the popover exists).
  Clipboard writes always hit the Mac clipboard. `navigate` is honored within 10 s of the
  plugin's last event and goes to the view in `lastEvent` if it is remote, otherwise
  `showWindow()` focuses the Mac window.
- **Identity and audit.** None. `lastEvent.view` exists only to route navigation; plugins get no
  origin; development-mode diagnostics are a 200-entry ring buffer without actors.
- **Shared view state.** Search, filters, sort, segmented/choice values and dialogs are held by
  the plugin per surface and shared by every viewer. Search text is re-sent by every page
  mount, so a window opening overwrites a remote client's search and vice versa. Selection,
  bulk checks, expansion, drafts, scroll and column layout live only in each renderer.
- **Secrets.** `sensitive` fields and `secret` environment entries are plain text in trees; the
  renderer masks them.
- **Debug channel.** Dev-gated, loopback plus Origin check, no token; sends plugin events only
  via `/eval` into the WebView. Not a foundation.

## 1.3 Plugins

### Processes 0.1.7 (`processes`)

Lists terminal jobs, servers and coding agents, and keeps a list of commands to start again.
Screens `processes` (default), `kept`, `settings`; quick view (top 8). CLI `running`
(`cleanupScreen: settings`). Data: `prefs.json`, `running/kept.yaml`,
`running/settings.json`, `commands.log` (zsh preexec log). Reads T3 Code's SQLite,
`~/.claude/sessions`, CMUX state and agent transcripts.

| Event | Risk | `confirm` | Notes |
| --- | --- | --- | --- |
| `search`, `filter` (agent, service), `sort`, `field` process-view/process-scope, `refresh` | view (filters, view, sort persisted) | — | |
| `focus` (handoff), `t3-open`, `open`, `reveal-kept`, `focus-kept` | external | — | `open` passes any `://` target to `open` without checking it against the row's targets |
| `output` (peek dialog), `field` output-source, `output-copy` | read / external | — | Output exists only as a dialog node; source switching needs the dialog open |
| `why` | read | — | Result only as a toast |
| `copy`, `copy-init` | external (clipboard) | — | Kept `copy` includes env values |
| `restart` | destructive | yes | A member row restarts the whole parent job; `planRestart` (dry run) exists in the engine but isn't used |
| `stop`, `kill` | destructive | yes | "Stopped" toast before the survivor check (2.5 s later) |
| `keep`, `edit-kept`, `add-kept`, `edit` → `field` keep → `keep-save` | write | — | Draft in a single in-memory dialog |
| `start`, `start-in` | external (runs a command in a new terminal) | **no** | Success = osascript returned |
| `up`, `down`, `forget` (+ toast `undo-forget`) | write | forget: yes | Kept rows are identified by **position**; `undo-forget` trusts any object in its payload |
| `tui-install`, `tui-remove`, `tui-check`, `field` terminal | trust / read / write | install/remove: yes | Edits `~/.zshrc` and `~/.local/bin` |

Programmatic backend: the `running-core` engine speaks JSON-lines (`hello`, `snapshot`,
`setSort`, `kill`, `whyAlive`, `openUrl`, `focus`, `peek`, `planRestart`, `restart`,
`keepDraft`, `keep`, `edit`, `forget`, `restoreKept`, `move`, `start`, `copyLine`). The
`running` CLI is an interactive TUI plus `init`, with no JSON or non-interactive subcommands.

Secrets: kept rows show `k.line` (env prefix plus command) in full in the row subtitle and
Command detail, which defeats the masked Environment section; the `undo-forget` toast payload
and keep drafts carry raw env values; process commands and peek output are raw. The plugin
and engine use two different secret-name patterns.

### Upkeep 0.2.0 (`upkeep`)

Discovers installed software across 13 providers (brew, sparkle, nvm, bun, deno, uv, rustup,
go, claude, npm, uv-tool, pipx, cargo, git, custom), checks for updates on a schedule and
updates on request or automatically. Screens `monitored` (Updates), `discover`, `activity`,
`settings`; quick view. No CLI. Data: `items.json`, `settings.json`, `discovered.json`,
`audit.jsonl`, `logs/<job>.log`, `askpass.sh`.

| Event | Risk | `confirm` | Notes |
| --- | --- | --- | --- |
| `search`, `filter` (kind, what, by), `dialog-close`/`dialog-done` | view | — | |
| `check`, `check-many`, `check-all` | external (network, `brew update`, `git fetch --prune`, custom recipe commands) | — | |
| `update`, `update-app`, `update-major`, `update-auth`, `update-own`, `update-open` | destructive (installs; may quit apps, prompt for a password, open apps) | all but `update` | **All six ids run the same handler**, so a bare `update` bypasses the stricter confirmations |
| `update-safe`, `update-many` | destructive | — | |
| `review`/`notes` → dialog → `update-now`, `terminal`, `cancel-dialog-job`, `skip` | read / destructive / external | `update-now`: no (the dialog is the confirmation) | Plans and release notes exist only in the transient review dialog; `skip` uses the dialog's item, not `rowId`, while a review is open |
| `settings` → `field` item (policy, channel, interval, pinned) | write | — | Only while the item dialog is open; values aren't validated (UI-forbidden policies accepted) |
| `pin`, `unpin`, `history`, `log` | write / read | — | |
| `rollback` | destructive | yes | |
| `remove`, `remove-many` | destructive (watch list) | Updates: yes; Discover: **no** | |
| `scan`, `monitor`, `monitor-many`, `monitor-new` | read / write + checks | — | `monitor` only accepts candidates from the last scan |
| `run-cancel`, `cancel`, `run-dismiss`, `run-activity`, `run-discover`, toast `show-run` | destructive / view | cancel of waiting jobs: no | Runs and jobs are in memory (40 runs, 60 jobs) and their ids are never returned |
| `field` settings (`autoUpdates`, `intervalHours`, `acOnly`, `window`, `folders`, `useGh`) | write; `autoUpdates` enables unattended installs | — | |
| `add-recipe` → `field` recipe → `recipe-save` | trust (stores and immediately runs user shell; auto-marks as reviewed) | button label only | |

A single global `ui.dialog` serves every surface. The scheduler ticks every 30 s and may
update automatically. Programmatic backend: the in-process `Engine` (add, remove, update,
setSettings, enqueue, batch, cancel, plan, …) and pure rules (`hasUpdate`, `bulkUpdatable`,
`autoBlocker`, `planBlocker`).

### OnTrack 0.14.0 (`ontrack`)

A personal task tracker: tasks move through inbox → working/stalled/snoozed/watching →
settled (plus archived), with labels, due dates, relations and subtasks, Markdown updates, and
a timer that wakes snoozes, runs watch check-ins and stalls idle tasks. Screens `tasks`
(default), `labels` (titled Settings); quick view (first 15 open tasks, quick-add composer).
Data: one `ontrack.json` (schema 8). No network, no spawns, no clipboard.

| Event | Risk | `confirm` | Notes |
| --- | --- | --- | --- |
| `search`, `filter`, `filter-arrange`, `field` subtasks, `dialog-close` | view (filters persisted) | — | `open-task` fails when search or filters hide the target |
| `select` | **write** (marks the task read after 1.6 s) | — | Selecting is not side-effect free |
| `work`, `done`, `wake`, `unwatch`, `reopen`, `unstall`, `stall`, `settle`, `snooze:<preset>`, `archive` | write | — | Undo (8 s, latest change only, token in toast payload) |
| `snooze`, `watch`, `resume` | view (open a dialog) | — | From the quick view they `navigate` to the window |
| `reorder` (section path encodes labels/due/state), `indent`/`outdent` (target = task above), `up`/`down` | write | — | Visual mechanics with encoded section ids |
| `field` task + `rowId` (inline drawer: name, state, due, labels, related, desc) | write | — | No undo for name/due/desc/labels |
| `new-task`/`edit`/`relate`/`new-label`/`edit-label`/… → `field` drafts → `save` | write | — | Draft in a single in-memory dialog; `field` is ignored without the matching dialog; new task id only via toast text or navigate |
| `add-update` (with `text`), `quick-task`, `edit-update-text` | write | — | No undo |
| `delete`, `delete-update`, `delete-label`, `delete-relation-type` | destructive | yes | A label edit that removes values strips them from tasks without confirmation |
| `field` stall (on, after, warnAfter, remindEvery, weekends) | write | — | No undo |

Every event first runs the timer catch-up (`tick`), which may change data. Programmatic
backend: pure functions in `model.ts`/`lifecycle.ts`/`display.ts` and an injectable
`ontrack({ load, save, now })` factory already driven headlessly by its tests.

### SDK Explorer 0.2.1 (`sdk-demo`)

The fixture plugin. Screens `gallery`, `table`, `forms`, `output`, `lifecycle`; quick view.
Only `{count}` in `demo.json` is persisted; everything else is in-memory fixtures. It
exercises nested and sectioned tables, targets, bulk actions, modifier keys, reorder with
refused drops, `select` events, every field type, filters, segmented and toolbar controls,
composer, timeline (with `delete-note`: destructive tone, no confirm), log, terminal,
conversation, toast with action, badge, handoff and `prepare` deferral. It does **not**
exercise split-button menus, `input` actions, row panes or `navigate`.

---

# Part 2: Challenges

Each challenge lists where it shows up. H = host, P = Processes, U = Upkeep, O = OnTrack,
S = SDK Explorer.

| # | Challenge | Evidence |
| --- | --- | --- |
| C1 | **Safety checks live only in the renderer.** Nothing on the host checks an event against the current tree: an invented, disabled or unoffered action, a wrong row, or a skipped `confirm` all reach the plugin, and handlers don't re-check | H `host.ts` `event`; P stop/kill/restart; U six `update*` ids share a handler; O delete; S `destructive` |
| C2 | **No actor identity or audit.** Host and plugins can't tell a person from an agent; nothing records who did what | H `lastEvent`, `userEventAt`; no origin in the protocol |
| C3 | **Approvals are UI conventions.** Install approval is a bearer token; quit, remove, pairing, revoke and updates have no host-side confirmation; the only method filter is `REMOTE_EXCLUDED` | H plugin manager, `quit`, `remoteAccess` |
| C4 | **Risk isn't declared.** Trees only carry `tone: destructive` and `confirm`. External effects (open, start, focus, clipboard, quitting apps, password prompts) and writes without confirmation are invisible to a policy engine | P `start` (no confirm), `open`; U `autoUpdates`, `remove` on Discover, cancel waiting; O label edit strips values; S `delete-note` |
| C5 | **Events are fire-and-forget.** No ack, no result, no error, no link to the renders and toasts they cause; `true` even when the plugin crashed | H `event`; P stop toast before survivor check, focus/open results dropped; U run/job ids never returned; O new task id only in toast text |
| C6 | **View state is shared between all viewers.** Search, filters, sort, choice controls and dialogs belong to the surface, not the viewer; page mounts re-send search | H SDK one tree per surface; P query/filters; U one global dialog; O view.query, filters (persisted) |
| C7 | **Important flows are dialog-coupled.** Open dialog → field edits into a draft → save; drafts are single, in-memory and silently ignored without the right dialog | P keep/edit/peek; U review → update-now, item settings, recipes; O create, relate, snooze, watch, labels |
| C8 | **Some data isn't in any tree, or only as formatted text, or trimmed** | P `planRestart`, peek only in a dialog, trimming under 50k values; U plans and notes, raw item data, pruned runs; O raw times, sessions, archived hidden by default, quick caps |
| C9 | **Unstable or visual addressing.** Positional ids, pid reuse, encoded section paths, relative moves, context-row ids, action ids whose meaning depends on renderer context | P kept index, pids; O `reorder` section paths, `indent` target, `c<id>@<group>`; H context-row `rowId` rewriting |
| C10 | **Secrets in trees and payloads** | H `sensitive`/`secret` plain text; P `k.line`, `undo-forget` payload, keep drafts, raw commands |
| C11 | **Reading has side effects and staleness.** Opening a surface starts plugin polling; without a viewer trees are stale; trees survive restarts; some plugins act on `select` | H trees cache; P polls every 2 s while open; O `select` marks read, `tick` on every event |
| C12 | **Effects land on the Mac whoever acted.** `navigate` falls back to `showWindow()`, handoff activates the window, clipboard writes the Mac clipboard, toasts go to whichever UIs exist (or nowhere) | H `index.ts` navigate/handoff/clipboard/toast routing |
| C13 | **Payload construction lives in React components; the event contract is incomplete** | H `Render.tsx`; `EventPayloads` missing `filter-arrange`, `reorder.onto`, list/tag open |
| C14 | **Host operations are not a registry.** They are ad-hoc RPC handlers inside `index.ts`, with view wiring module-local; React screens aren't trees | H `requestHandlers`, `views`, `opened`, `remoteViews` |
| C15 | **Inconsistent per-plugin safety details** that host fixes can't fully cover | P `open` any URL, member → parent restart, no-confirm `start`, trusting undo payload; U unvalidated fields, auto-reviewed recipes; O no-undo edits |

---

# Part 3: Remedies

Each remedy names its options and a recommendation. "Contract" marks changes to the public
protocol, manifest or SDK (they need runtime schemas, renderer, SDK docs, fake-host tests and
SDK Explorer coverage together, per AGENTS.md).

### R1: Host-side action resolver (C1, C13, C9)

- **Options:** (a) re-check in each plugin; (b) a host resolver that indexes the current tree
  per surface and accepts only offered actions; (c) both.
- **Recommendation: (b) for every client, plus plugin hardening where cheap.** Extract the
  payload rules from `Render.tsx` into a pure `src/shared/actions.ts`: an *action address*
  (`plugin, surface, scope: page|table|row|bulk|dialog|card|detail|list|timeline|toast, ids`)
  resolves against the cached tree to the action definition (disabled, confirm, input,
  targets, alternatives) and builds the exact payload the renderer would send, including
  context-row rewriting. The renderer, remote clients and agents all go through it. Unknown,
  disabled, unoffered or stale addresses are refused before the plugin sees them. Complete
  `EventPayloads` (contract, documentation-only). This also closes Upkeep's `update` bypass:
  `update` isn't among that row's offered actions.

### R2: Actors, sessions and audit (C2, C12)

- **Recommendation:** every request carries an `Actor` (`window`, `popover`, `remote:<device>`,
  `agent:<client>/<session>`). The host keeps an append-only `agent-audit.jsonl` in the profile
  (actor, address, risk, approval, outcome) and shows it in Settings → Agents (R12).
  Optionally (contract, capability `event.origin`) events tell plugins `origin: "person" | "agent"`
  so a plugin can refuse or adapt. Replace the global `lastEvent` with per-actor routing.

### R3: Risk declaration and agent policy (C4, C3)

- **Options:** infer risk from `tone`/`confirm` only; declare it.
- **Recommendation: declare it (contract).** Add `Action.effect: "read" | "view" | "write" |
  "external" | "destructive"` and `Action.agent: "allow" | "confirm" | "deny"`; the manifest can
  set defaults per action id. Undeclared actions default to `write` with confirmation for
  agents. Map to MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`). A host policy (per plugin, per actor, editable in Settings) decides
  allow / ask / deny. `trust` operations always ask, whatever the policy or grant says;
  `human-only` operations are never offered to agents.

### R4: Approval broker (C1, C3)

- **Recommendation:** one host service turns "needs confirmation" into a pending approval with
  the action's `confirm` text, the plugin, the target row and (when available) a dry-run plan.
  It resolves from the ToolBelt UI (a notification or popover prompt the person answers),
  from MCP elicitation when the requesting client is the person's own interactive session, or
  times out as denied. The same broker makes host operations like `remove`, `quit` and
  `setChannel` confirmable server-side. Plugin management is open to agents with approval: an
  agent may `resolve` a repository and request `install`, but the token it gets back is inert
  until the person approves the install review (publisher, commit, permissions) in ToolBelt.
  The approval is bound to that token and that actor. How approvals work when no person is
  watching is covered in R13.

### R5: Event acknowledgments and results (C5)

- **Recommendation (contract, capability `event.result`):** the host gives each event an id; the
  SDK replies `{ type: "result", id, handled: boolean, error?, data?, renders: [surface] }` after
  `onEvent` resolves (OnTrack already returns `false` for unknown events; thrown errors become
  `error`). Older plugins get a host-synthesized result: "delivered", plus the next render of the
  surface within a bounded wait. The agent API returns `{ approval, result, toasts, navigated,
  after }` where `after` is a tree diff. Plugins that start background work return ids
  (Upkeep runs/jobs, Processes restart progress) in `data`.

### R6: Per-viewer view state (C6, C11)

This is the deepest change.

- **Options:**
  - (a) Agents never touch view controls; they read whatever the person's view shows,
    disclosed as "filtered by search 'x'". Cheap, but incomplete and confusing.
  - (b) **Surface instances (contract):** `open` carries an `instance` id; the SDK keeps
    view state (query, filters, sort, choice values, dialog) per instance and renders per
    instance; plugin state remains shared. Search re-send on mount stops clobbering others.
    Requires plugin refactors where view state is a module global (all four plugins).
  - (c) Agents use parameterized reads (R7) instead of view controls.
- **Recommendation: (c) for agents now, (b) as the long-term protocol fix.** (b) also fixes
  today's window-versus-phone conflicts.
- **Interim rule until (b) ships.** Example of the problem: you have Processes open and an agent
  types "node" into Processes' search to find a server. Because search belongs to the surface,
  your window's search box also changes to "node" and your list filters under you. So: an
  agent's view-control events (search, filter, sort, choice controls, opening dialogs) are
  refused while a person has that surface open, and allowed when nobody does; the host restores
  the previous view state when the agent releases the surface.

### R7: Parameterized actions and semantic tools (C7, C8, C9)

- **Options:** keep dialog round trips; plugin-declared global tools only (step 5); actions
  that accept typed parameters.
- **Recommendation (contract):** generalize `Action.input` (text today) to
  `Action.params: JSONSchema` plus an optional `Action.result` schema. The renderer turns
  params into a form (replacing many plugin-built dialogs over time); agents call the action in
  one step with structured params. Manifest-level tools (`tools: [{ id, title, params, result,
  effect }]`) cover operations without a row context (`ontrack.addTask`, `upkeep.plan`,
  `processes.list`). This pulls the core of step 5 into step 1, because without it C7 makes
  agents drive drafts through shared dialogs. Plugins replace positional and encoded ids with
  stable ids in params (Processes kept ids, OnTrack `section` semantics as explicit fields).

### R8: Redaction (C10)

- **Recommendation:** the agent serializer masks `sensitive` fields and `secret` environment
  entries, never forwards toast action payloads (the agent gets an opaque handle the host
  resolves), and adds a tree-level `secret: true` marker for cells, details and log lines
  (contract). Plugin fixes: Processes stops putting env values into `k.line`, the row
  subtitle, `copy` and the undo payload, and uses one secret-name pattern.

### R9: Agent view and read freshness (C11, C12, C14)

- **Recommendation:** extract a `ViewHub` from `index.ts` (views, opened sets, fan-out,
  release) and make window, popover, remote and agent all views. The agent view opens surfaces
  on demand and releases them after an idle TTL, so plugin polling is bounded. Clear cached
  trees on crash/restart and mark trees with a sequence number and age. Route plugin
  `navigate`, toasts and handoff for agent-caused events to the agent view (returned in the
  result), not to `showWindow()`; activate the Mac window only when the person is chatting
  in-app and asked for it. Return clipboard text to the agent alongside writing it, and let
  policy decide whether agent-caused clipboard writes reach the Mac clipboard.

### R10: Host command registry (C14, C3)

- **Recommendation:** replace ad-hoc `requestHandlers` with a registry: each host operation
  declared once with `name`, params/result schemas, risk class and actor policy. The renderer
  RPC, remote clients, the agent API, MCP and the CLI are adapters over it. `REMOTE_EXCLUDED`
  becomes policy data. Native React screens stay as they are; agents use their registry
  operations.

### R11: Per-plugin fixes (C15)

Owned by the plugin repositories, sequenced per `docs/releases.md`:

- **Processes:** declare `agent.access: "none"` (R12) in its next release, before any agent
  surface ships. The fixes below matter for its own UI and remote clients, and for later if it
  ever opts in: validate `open` against the row's offered targets; refuse member rows for
  `restart`/`keep`/`focus` instead of acting on the parent; confirm or declare `start`/`start-in`
  as `external` with agent confirmation; stable kept ids; validate `undo-forget` against a
  server-side token; show `planRestart` in the restart confirmation; secret handling (R8); a
  non-interactive `running --json` is optional once ToolBelt's CLI exists.
- **Upkeep:** check the specific `update*` id against `updateActionFor`; per-surface dialogs;
  validate `field` values; confirm `autoUpdates` and Discover `remove`; return run/job ids;
  expose `plan` and notes as a parameterized read; never auto-mark recipes reviewed for
  agent-originated saves.
- **OnTrack:** parameterized `addTask`/`relate`/`snooze`/`watch`/label operations over its
  existing pure model; return created ids; don't mark read on agent `select`; confirmation
  when a label edit strips values.
- **SDK Explorer:** add split-button, `input`, row pane, `navigate` and every new contract
  (access levels, params, effect, result, instances) so it remains the conformance fixture.

### R12: Agent access levels and Settings → Agents (C3, C4, C10)

- **Plugin ceiling (contract, manifest).** `agent: { access: "none" | "read" | "act" }`.
  `none` hides the plugin from agents entirely (it doesn't appear in `screens.list` or
  `tools.list`); `read` exposes screens and read tools only; `act` also exposes actions,
  subject to policy and approvals. An undeclared plugin is treated as `read`. Processes is the
  first `none`. Later, finer control (per screen, per action id, per tool) fits under the same
  key, e.g. `agent: { access: "act", deny: ["kill", "start"] }`.
- **Person's choice (host setting).** Settings → Agents lists every plugin with its ceiling and
  lets the person pick an equal or lower level. Effective access = the lower of the two. The
  host enforces it in the serializer and resolver, so a plugin never sees an event from an
  agent above its level.
- **Settings → Agents** is the one home for agent controls: per-plugin access, policy
  (allow / ask / deny per risk class), connected clients and sessions, standing grants for
  autonomous agents (R13), pending approvals and the audit log (R2). The view still needs to be
  designed.
- **Compatibility.** `parseManifest` (`src/shared/protocol.ts`) keeps unknown keys, so
  hosts from 0.3.24 onward accept the field and ignore it. Processes can declare `none` now,
  before any host enforces it. Hosts released before the agent interface don't need it,
  since they have no agent surface.

### R13: Autonomous agents (C3)

An autonomous agent runs with no person watching: a scheduled routine, a background job driving
the CLI, or a long task left running. Approvals can't assume someone will answer within
seconds. Proposed model:

- **Two modes per agent session,** recorded on the actor:
  - *Interactive:* a person is talking to the agent (in-app chat, Claude Code in a terminal).
    Approvals are asked right away, through MCP elicitation or a ToolBelt prompt, and the tool
    call waits for the answer.
  - *Autonomous:* nobody is assumed present. The agent works inside a **standing grant**: a set
    the person defined in Settings → Agents (which plugins, which risk classes or action ids,
    optional time window and expiry). Anything inside the grant runs without asking.
- **Outside the grant, the call doesn't block.** It returns `pending_approval` with an approval
  id, and the request is queued in Settings → Agents with a notification on the Mac (and on a
  paired phone, which is the person approving, not an agent using remote access). The agent can
  keep doing other work and check the approval later, or stop and report. With the MCP Tasks
  extension the same thing appears as a task in the `input_required` state. Unanswered
  approvals expire as denied after 24 hours.
- **Never granted:** `destructive` and `trust` actions always queue for the person; `human-only` operations are
  never offered.
- **Where autonomous agents come from.** Initially from outside ToolBelt (Claude Code routines,
  cron plus the CLI), connecting through steps 2–3 and declaring autonomous mode. ToolBelt
  running its own scheduled agents through ACP would be a later step 6.

---

# Part 4: Target architecture for step 1

```
                ┌──────────── adapters ────────────┐
 window/popover │ renderer RPC │ remote WS │ agent │ MCP (step 2) │ CLI (step 3) │ ACP chat (step 4)
                └──────┬───────┴─────┬─────┴───┬───┴──────┬───────┴──────┬───────┘
                       ▼             ▼         ▼          ▼              ▼
              ┌─────────────────────────────────────────────────────────────┐
              │ Interaction core (Bun main process)                         │
              │  Actor + session      Policy (risk × actor × plugin)        │
              │  Command registry     Approval broker      Audit log        │
              │  ViewHub (views, instances, fan-out)                        │
              │  Action resolver (tree index → payload)   Redaction         │
              │  Tree serializer (text/JSON, diff, paging)                  │
              │  Access levels (R12)  Standing grants (R13)                 │
              └───────────────┬─────────────────────────────────────────────┘
                              ▼
              PluginHost (processes, trees, events + results, navigate rules)
                              ▼
              Plugins (SDK: agent.access, instances, params, results, effect declarations)
```

Agent-facing API (in-process, transport-neutral):

```ts
host.call(name, params): Result                         // registry operations, policy-checked
screens.list(): { plugin; screen; title; quick: boolean }[]
screens.read({ plugin, screen, format?: "text"|"json", table?, cursor?, maxRows? }): Snapshot
screens.act({ address, params? }): ActResult            // R1 resolver, R3 policy, R4 approval, R5 result
screens.watch({ plugin, screen }): AsyncIterable<SnapshotDiff>
tools.list(): ToolSpec[]                                // R7 manifest tools + parameterized actions
tools.call({ plugin, tool, params }): ActResult
approvals.get(id)                                       // agents: state of their own pending_approval (R13)
approvals.pending() / approvals.resolve(id, decision)   // Settings → Agents and notifications only, never agents
audit.read({ since?, actor? })                          // Settings → Agents
session.open({ client, mode: "interactive"|"autonomous" }): Session   // actor + mode; autonomous binds a standing grant
```

---

# Part 5: Feasibility and roadmap

Step 1 is feasible. The read side needs only host work. Safe actions need host work and no
protocol change. Completeness and robustness need protocol additions that touch the SDK and
all four plugins.

Step 1 is too large to ship at once, so it is split into phases 1a–1d. Each remedy (or part of
one) belongs to exactly one phase. The roadmap then interleaves those phases with steps 2–6.

## 5.1 Remedies by phase

| Remedy | 0 (plugins now) | 1a Read-only | 1b Guarded actions | 1c Protocol v-next | 1d Instances |
| --- | --- | --- | --- | --- | --- |
| R1 Action resolver | | | ✔ | | |
| R2 Actors and audit | | Actors, audit log | Per-actor routing replaces `lastEvent` | `event.origin` | |
| R3 Risk and policy | | | Policy with defaults inferred from `tone`/`confirm` | `effect`/`agent` declarations | |
| R4 Approval broker | | | ✔ (including plugin management) | | |
| R5 Event results | | | Host-synthesized result (delivered + next render) | `event.result` from the SDK | |
| R6 View state | | | Interim rule (no agent view controls while a person views) | Parameterized reads via R7 | Surface instances |
| R7 Params and tools | | | | ✔ | |
| R8 Redaction | | Serializer masking | | `secret` marker | |
| R9 ViewHub, agent view | | ViewHub, agent view, freshness | Navigate/toast/handoff/clipboard routing | | |
| R10 Command registry | | Read operations | Write operations | | |
| R11 Plugin fixes | Processes declares `none` | | | Upkeep, OnTrack, SDK Explorer fixes | Plugin refactors for instances |
| R12 Access levels | Plugins declare `agent.access` | Enforcement, Settings → Agents (access, audit) | Settings → Agents (policy, approvals) | Finer-grained access | |
| R13 Autonomous agents | | | Modes, `pending_approval`, standing grants | | |

## 5.2 Phases

| Phase | Contract change | Resolves | What an agent can do afterwards |
| --- | --- | --- | --- |
| 0. Plugin opt-outs | Manifest key, ignored by today's host | — | Nothing yet; Processes is excluded in advance |
| 1a. Read-only | `agent.access` becomes enforced | C8 (partly), C10 (host side), C11, C14 (partly) | Read every screen of every plugin that allows it, plus host state. Every read is audited |
| 1b. Guarded actions | None (`EventPayloads` completion is documentation) | C1, C2, C3, C12, C13 | Perform any action a screen offers, and plugin management, with the person approving wherever the UI would ask. Autonomous agents work within standing grants |
| 1c. Protocol v-next | Optional capabilities with fallbacks | C4, C5, C7, C8, C9, C10, C15 | Call typed operations in one step (`ontrack.addTask`) and get real results and errors instead of driving dialogs |
| 1d. Surface instances | Yes | C6 | Search, filter and sort without affecting anyone else's view |

## 5.3 Roadmap

One ordered sequence. "Step" refers to the steps at the top of this document; "phase"
refers to 5.2.

| # | Work | Phase / step | Remedies | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Processes release declaring `agent.access: "none"` | Phase 0 | R11, R12 | — |
| 2 | Read-only agent API in the host | Phase 1a (step 1, read side) | R2, R8, R9, R10, R12 | — |
| 3 | MCP server and stdio shim, read-only, interactive sessions only | Step 2 | — | 2 |
| 4 | `toolbelt` CLI and skill file, read-only, on the same socket | Step 3 | — | 3 |
| 5 | Guarded actions; MCP and CLI gain actions; external autonomous agents can connect | Phase 1b (step 1, action side) | R1–R6, R9, R10, R12, R13 | 2 |
| 6 | Protocol v-next in SDK, SDK Explorer and plugins. Most of the original step 5 lands here | Phase 1c (step 1 + core of step 5) | R2, R3, R5, R6, R7, R8, R11, R12 | 5 |
| 7 | In-app chat as an ACP client | Step 4 | — | 5 (approvals in the app); better after 6 |
| 8 | Surface instances | Phase 1d | R6, R11 | 6 |
| 9 | Remaining plugin-declared tools, per plugin | Rest of step 5 | R7 | 6 |
| 10 | ToolBelt-hosted autonomous agents (scheduled ACP sessions under standing grants) | New step 6, optional | R13 | 5, 7 |

## 5.4 Decisions

- **Remote access is human-only.** No remote-access operation is offered to agents, reads
  included (R3 `human-only`).
- **Plugin management is open to agents, with approval every time.** Install, remove, update and
  channel changes are `trust`. They always go through the approval broker and are never covered
  by a standing grant (R4, R13). Managed-data recovery and dotfile cleanup stay human-only.
- **Plugins can opt out or limit themselves to read-only** with `agent.access`. The person can
  lower the level further in Settings → Agents. Finer-grained control comes later under the
  same key (R12). Processes opts out.
- **Agent controls live in Settings → Agents:** access, policy, sessions, grants, approvals and
  the audit log. The view is still to be designed (R12).
- **Autonomous agents** get their own mode with standing grants and non-blocking approvals
  (R13), and an optional step 6.
- **Undeclared plugins are read-only** for agents until they declare `agent.access: "act"`.
- **Standing grants never cover `destructive` or `trust` actions.** Those always queue for the
  person.
- **Retention:** unanswered approvals expire as denied after 24 hours. The audit log is kept
  forever (append-only, in the profile).
- **Pending approvals are shown in Settings → Agents**, alongside access levels and the audit
  log.
- **View-control conflicts:** until surface instances exist (phase 1d), agents can't change
  search, filters or sort on a surface a person has open (R6 interim rule).

## 5.5 Status

Roadmap items 1–4 are implemented and described in [docs/agents.md](../docs/agents.md). The
evaluation, with 17 life-like requests answered through MCP and the CLI, is in
[agent-interface-eval/report.html](agent-interface-eval/report.html).

Built differently from the plan:

- **No ViewHub extraction yet (R9).** The agent's view lives in the agent core and counts as a
  viewer through `PluginHost.open`/`close`. Window, popover and remote views are unchanged.
  Extraction moves to phase 1b, where per-actor routing needs it.
- **The registry covers agent operations only (R10).** Five read operations feed MCP and the
  CLI. The renderer's RPC handlers are not migrated.
- **Pending approvals are not in Settings → Agents yet.** Reads never need approval. The section
  arrives with the approval broker in 1b.
- **Freshness (R9).** Trees carry their arrival time, a new plugin process clears its cached
  trees, and the agent opens unwatched surfaces on demand (4 s render wait, 60 s idle hold).

The evaluation found two gaps that later phases should close (findings O1 and O2):

- reads that follow the person's search and filters (C6);
- whole-screen reads where a row read or a change summary would do.

## 5.6 Open questions

None blocking phases 0–1a and steps 2–3. The Settings → Agents view still needs a full design
once actions and approvals exist (phase 1b).
