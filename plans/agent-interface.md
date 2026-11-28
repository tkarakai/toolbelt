# Agent interface: proposal and feasibility

Status: **proposal**, not implemented. Nothing in this document describes current behavior
except where it says "today". Analysis date: 2026-11-24. Revised 2026-11-25: backward
compatibility dropped, view state and instances moved first, and agents may change the
person's view under a timed grant (R6, R14, Part 5).

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
| 4 | In-app chat as an ACP client | The person plugs in Claude Code, Codex or Gemini CLI through the Agent Client Protocol; ToolBelt hosts the conversation and points the agent at its own MCP server. ToolBelt doesn't own model choice, keys or the agent loop. Built as the Agent plugin (`tkarakai/toolbelt-agent`), a floating plugin: an ask bar that grows into a chat over the main screen (5.8) | 1, 2 |
| 5 | Plugin-declared tools in the SDK | High-level, parameterized operations with typed results (`ontrack.addTask`, `upkeep.plan`) instead of driving screens | 1; the core moves into wave B1 (see 5.3) |
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
  Events tell plugins `origin: "person" | "agent"` (contract, wave B1) so a plugin can refuse or
  adapt. Replace the global `lastEvent` with per-actor routing.

### R3: Risk declaration and agent policy (C4, C3)

- **Options:** infer risk from `tone`/`confirm` only; declare it.
- **Recommendation: declare it (contract).** Add `Action.effect: "read" | "view" | "write" |
  "external" | "destructive"` and `Action.agent: "allow" | "confirm" | "deny"`; the manifest can
  set defaults per action id. `effect` is required: the manifest and tree checks reject an
  action without one, rather than inferring it from `tone`/`confirm`. Map to MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
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

- **Recommendation (contract, required):** the host gives each event an id; the
  SDK replies `{ type: "result", id, handled: boolean, error?, data?, renders: [surface] }` after
  `onEvent` resolves (OnTrack already returns `false` for unknown events; thrown errors become
  `error`). There is no host-synthesized fallback. The agent API returns `{ approval, result, toasts, navigated,
  after }` where `after` is a tree diff. Plugins that start background work return ids
  (Upkeep runs/jobs, Processes restart progress) in `data`.

### R6: Per-viewer view state (C6, C11)

This is the deepest change, and the first one to ship (wave A). The problem today: you have
Processes open and an agent types "node" into its search to find a server. Search belongs to
the surface, so your window's search box changes too and your list filters under you.

Decided (2026-11-25): **SDK-owned view state, rendered per instance (contract).**

- **Declared view.** A screen declares its view controls: search, filters (id, label, options,
  default, single or multiple), sort keys and segmented controls. Options may change between
  renders (OnTrack's labels). The declaration is the agent-facing *view schema*.
- **SDK-owned state.** The SDK keeps view state per instance, applies view events itself
  (`search`, `filter`, `filter-arrange`, `sort`, control changes), validates them against the
  declaration, and renders with the instance's `view`. Plugins keep their filtering logic but no
  longer hold view state in module globals. Data and polling stay per surface; rendering is per
  instance. Dialogs and their drafts are per instance too.
- **Instances.** `open` carries an instance id and an initial view state. Two kinds:
  - **The person's view:** one shared instance per surface for every human view (window,
    popover, paired devices). It works like a remote control: a filter set on the phone shows in
    the window. The SDK saves its state; page mounts stop re-sending search.
  - **Agent instances:** private to an agent session, created with the view the agent asked
    for, never saved, released after the idle hold. Reading with a view never changes what the
    person sees.
- **Presentation stays out of the plugin.** Collapse and expand, sections, columns, depth and
  row selection are renderer state for people and serializer options for agents. Today's
  `read_screen` already has some (`table`, `parent`, `offset`, `max_rows`, `details`); wave A
  adds sections, columns, depth and rows by id.
- **Render failures stay per instance.** A rejected render (an invalid tree or one over the
  complexity limits) costs only that instance, as it costs only its surface today. An agent's
  unfiltered view can't break the person's, and a narrow view can still read a screen whose
  full tree is too large.
- **Agents read in one step.** `read_screen` takes `view` (plugin-side search, filters, sort,
  controls) and presentation options; `list_screens` publishes each screen's view schema. Unknown
  filter ids or option values are refused with the valid ones. The resource URI template gains
  the view parameters, so subscriptions work on filtered views and the stdio shim replays them
  after a ToolBelt restart unchanged. `search_screens` can use each plugin's own search.
- Changing the *person's* view is a separate, approved operation (R14).

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
  subject to policy and approvals. An undeclared plugin has no access unless the person allows
  `read` (see 5.4). Processes is the
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
- **Compatibility.** None from protocol v2 on (5.4): the host refuses plugins built for
  another protocol version, and Settings → Plugins' compatibility section says why.

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

### R14: Agents changing the person's view (C6, C12)

"Show me my overdue tasks" should appear on every screen the person has open, as if they had
set the filters themselves.

- **Operation.** `show_screen({ plugin, screen, view?, open_window? })` navigates every open
  human view to the screen and applies the view state to the person's instance (R6). Effect
  class `view`; it needs the plugin at `read` access or higher.
- **View-control grant, per agent.** The first call from an agent without a grant prompts on
  every human screen (the window, paired devices): which agent, what it wants to show, and how
  long to allow it (this session, 1 hour, today (default), 7 days, 30 days; never forever). The
  call waits for the answer up to 60 s, then is refused as timed out; the agent can ask again.
  Grants end on their own, are listed and revocable in Settings → Agents, and every request and
  decision is audited.
- **Devices that don't show it.** When any of the person's devices doesn't have ToolBelt open
  (the Mac's window closed, a paired device not connected), the result tells the agent, which
  tells the person and asks what to do. With no screen open at all, nobody can approve: the call
  is refused at once, and `open_window: true` (after the person agrees) opens the window on the
  Mac and asks there.
- **"This session"** means the audit session: an MCP connection, or for the CLI the calls one
  parent process makes (sessions group by `ppid`).
- **Identity.** A grant is bound to the client name from the hello or MCP `clientInfo`. That is
  consent, not authentication: the socket is user-only, and any of the user's processes can
  claim any name.
- **Visible and reversible.** After an agent changes the person's view, the page shows "Shown by
  <client>" with **Restore**, which brings back the view from before the agent's first change.
  The host owns the person's saved view (`views.json`).
- This is the first approval flow. Wave A builds it as a small approval broker (R4) with timed
  grants; wave B reuses both for actions and standing grants (R13).

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
screens.list(): { plugin; screen; title; quick: boolean; view: ViewSchema }[]
screens.read({ plugin, screen, view?, sections?, columns?, depth?, rows?, format?: "text"|"json", table?, cursor?, maxRows? }): Snapshot  // own instance (R6)
screens.show({ plugin, screen, view? }): ShowResult     // the person's view, under a view-control grant (R14)
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

Step 1 is feasible. The read side needed only host work. Everything after it changes the
protocol, the SDK and all four plugins.

**No backward compatibility (decided 2026-11-25).** Only the person uses the SDK, so contracts
change without capability flags or fallbacks. The protocol has one version; the host refuses a
plugin built for another one and shows it as needing an upgrade, while other plugins keep
running (per-plugin failure containment still holds). The original phases 1b–1d were ordered
to protect compatibility. Without that constraint, view state and instances move first: they
are the foundation for both one-step filtered reads and safe actions, and they remove the R6
interim rule and most dialog conflicts (C7).

**One spec, two waves.** One protocol v2 specification covers every wave, reviewed once.
Wave A ships the read side; wave B ships actions. Plugins upgraded in wave A work fully and
simply don't use wave B's parts yet. Wave B is a second required plugin upgrade.

## 5.1 Remedies by phase

| Remedy | 0 (done) | 1a Read-only (done) | A View state | B1 Guarded actions | B2 Autonomous |
| --- | --- | --- | --- | --- | --- |
| R1 Action resolver | | | | ✔, against the agent's instance | |
| R2 Actors and audit | | Actors, audit log | Instance actors | Per-actor routing replaces `lastEvent`; `event.origin` | |
| R3 Risk and policy | | | | Required `effect`/`agent`, policy | |
| R4 Approval broker | | | View-control prompt (R14) | Full broker, including plugin management | |
| R5 Event results | | | | Required results from the SDK | |
| R6 View state | | | ✔ SDK-owned view state, instances, view schema | | |
| R7 Params and tools | | | | `Action.params`, manifest tools | |
| R8 Redaction | | Serializer masking | | `secret` marker | |
| R9 ViewHub, agent view | | Agent view, freshness | ViewHub with instances and the person's view | Navigate/toast/handoff/clipboard routing | |
| R10 Command registry | | Read operations | `show_screen`, view schema | Write operations | |
| R11 Plugin fixes | Processes declares `none` | | View state moves to the SDK in all plugins | Upkeep, OnTrack, SDK Explorer action fixes | |
| R12 Access levels | Plugins declare `agent.access` | Enforcement, Settings → Agents (access, audit) | Settings → Agents (view-control grants) | Settings → Agents (policy, approvals) | Finer-grained access |
| R13 Autonomous agents | | | | | Modes, `pending_approval`, standing grants |
| R14 Person's view | | | ✔ `show_screen`, timed grants, Restore | | |

## 5.2 Phases

| Phase | Contract change | Resolves | What an agent can do afterwards |
| --- | --- | --- | --- |
| 0. Plugin opt-outs (done) | Manifest key | — | Nothing yet; Processes is excluded in advance |
| 1a. Read-only (done) | `agent.access` enforced | C8 (partly), C10 (host side), C11, C14 (partly) | Read every screen of every plugin that allows it, plus host state. Every read is audited |
| A. View state | Protocol v2: declared views, SDK-owned view state, instances in `open`, per-instance dialogs, required `agent.access` | C6, finding O1 | Read a screen with its own search, filters and sort in one call without touching the person's view; read single rows; show the person a screen and view under a timed grant. Human views share one view on purpose |
| B1. Guarded actions | Required `effect`/`agent`, `params`, results and `origin`; complete `EventPayloads` | C1–C5, C7, C9, C12, C13, C15 | Perform any action a screen offers, and plugin management, in one typed call with real results, the person approving wherever the UI would ask |
| B2. Autonomous | None beyond B1 | C3 (autonomous side) | Autonomous agents work within standing grants; anything else returns `pending_approval` |

## 5.3 Roadmap

One ordered sequence. "Step" refers to the steps at the top of this document; "phase"
refers to 5.2. Host, SDK and plugin releases follow the sequencing in
[docs/releases.md](../docs/releases.md): a wave's host and SDK publish first, then each plugin's
upgrade.

| # | Work | Phase / step | Remedies | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Processes release declaring `agent.access: "none"` (done) | Phase 0 | R11, R12 | — |
| 2 | Read-only agent API in the host (done) | Phase 1a (step 1, read side) | R2, R8, R9, R10, R12 | — |
| 3 | MCP server and stdio shim, read-only (done) | Step 2 | — | 2 |
| 4 | `toolbelt` CLI and skill file, read-only (done) | Step 3 | — | 3 |
| 5 | Protocol v2 specification for waves A and B | — | R2–R8, R14 | 4 |
| 6 | Wave A in host, SDK and SDK Explorer | Phase A | R4 (view control), R6, R8, R9, R10, R12, R14 | 5 |
| 7 | Wave A plugin upgrades (OnTrack, Upkeep, Processes) | Phase A | R11 | 6 |
| 8 | Floating plugins in host and SDK (a window over the main screen; phone sheet), `TOOLBELT_AGENT_COMMAND` and `toolbelt mcp --client` | Step 4, host side | — | 7 |
| 9 | Agent plugin 0.1: in-app chat as an ACP client, read-and-show only (reads screens, `show_screen` under a view grant) | Step 4 | — | 8, its SDK release |
| 10 | Wave B1, specified in [agent-actions.md](agent-actions.md): B1.1 action resolver, B1.2 protocol 3, B1.3 agents act (`run_action`, `fill_form`, approvals, write grants), B1.4 plugin upgrades. Typed `params` and plugin management are not in it | Phase B1 (step 1, action side) | R1–R5, R9–R12 | 9 |
| 11 | History wave, to be specified after B1: snapshots of plugin data after changes, with restore and a preview (host, every plugin); per-record history, a history UI element and revert (SDK, plugin by plugin, OnTrack first); views of the change journal | — | — | 10 |
| 12 | Revisit the approval rules: changes that history can undo ask less | — | R3, R4 | 11 |
| 13 | Autonomous sessions under standing grants | Phase B2 | R13 | 10 |
| 14 | Remaining plugin-declared tools, per plugin | Rest of step 5 | R7 | 10 |
| 15 | ToolBelt-hosted autonomous agents (scheduled ACP sessions under standing grants) | New step 6, optional | R13 | 9, 13 |

## 5.4 Decisions

- **No backward compatibility.** One protocol version; plugins built for another are refused
  and shown as needing an upgrade. No capability flags or fallbacks for these contracts.
- **One spec, two waves.** Wave A plugins work fully without wave B's parts.
- **The SDK owns view state** (R6). Plugins declare their view controls and render from `view`.
- **The person's view is shared** by the window, the popover and paired devices, like a remote
  control. Agents read through private instances that are never saved.
- **Agents may change the person's view** under a view-control grant whose duration the person
  picks when approving, with a visible Restore (R14).
- **Remote access is human-only.** No remote-access operation is offered to agents, reads
  included (R3 `human-only`).
- **Plugin management is open to agents, with approval every time.** Install, remove, update and
  channel changes are `trust`. They always go through the approval broker and are never covered
  by a standing grant (R4, R13). Managed-data recovery and dotfile cleanup stay human-only.
- **Plugins can opt out or limit themselves to read-only** with `agent.access`. The person can
  lower the level further in Settings → Agents. Finer-grained control comes later under the
  same key (R12). Processes opts out.
- **Agent controls live in Settings → Agents:** access, grants, policy, sessions, approvals and
  the audit log. The approvals view is still to be designed (R12).
- **Autonomous agents** get their own mode with standing grants and non-blocking approvals
  (R13), and an optional step 6.
- **Undeclared plugins have no access by default** (revised 2026-11-25, before 0.5.0 shipped;
  it was read-only). A plugin made before agent access existed can't opt out, so only a host
  default protects people who update ToolBelt but not the plugin, such as Processes 0.1.7. The
  person may allow `read` for an undeclared plugin, with a warning; `act` needs a declaration.
  0.5.0 was cancelled before it built and the feature ships in 0.5.1.
- **Standing grants never cover `destructive` or `trust` actions.** Those always queue for the
  person.
- **Retention:** unanswered approvals expire as denied after 24 hours. The audit log is kept
  forever (append-only, in the profile).
- **Pending approvals are shown in Settings → Agents**, alongside access levels and the audit
  log.
- **The in-app chat comes before wave B1, read-and-show only (decided 2026-11-26).** It needs
  only reads and `show_screen`, which wave A has; actions and their approval cards join it in
  B1, whose approvals design it then informs. It is a plugin, not a host feature, on a generic
  host feature (floating plugins) that other plugins can use too.
- **Decided for wave B1 (2026-11-27), detailed in [agent-actions.md](agent-actions.md):** approvals
  are answered only on ToolBelt's own screens, never through MCP elicitation, and show what the
  host resolved; risk is declared once per action id next to the views; writes ask, with an
  optional timed grant per agent and plugin, while destructive, external and `confirm` actions
  ask every time; agents fill forms in their own instance (typed `params` later); an agent's
  navigation and clipboard go back to it; calls wait 60 s for approval; plugin management by
  agents moves out of B1. This supersedes R3's per-action `effect`/`agent` fields and policy
  matrix, R4's elicitation and R7's params for this wave.
- **A change journal for every actor, and history after B1 (decided 2026-11-27).** People
  approve without reading once approvals become routine, so safety can't rest on approvals
  alone. Wave B1 adds a host journal of every change, made by people and agents alike (who,
  which action, which rows, when, the outcome). It is append-only and hash-chained, and no
  tooling edits it ([agent-actions.md](agent-actions.md#change-journal)). History and
  reversibility follow as their own wave (roadmap 11), to be specified then. After it, the
  approval rules are revisited so that reversible changes ask less (roadmap 12).
- **Decided for wave A (2026-11-25):** `show_screen` with any device not showing ToolBelt tells
  the agent so it asks the person; grants are per agent; durations end (default today, at most
  30 days); the host saves the person's view; `agent.access` is required, so Settings → Agents
  has no "Not declared" state.

## 5.5 Status

Roadmap items 1–4 are implemented and described in [docs/agent-interface.md](../docs/agent-interface.md).
Floating plugins (roadmap 8) are implemented as described in
[docs/plugins.md](../docs/plugins.md#floating-plugins); the Agent plugin (roadmap 9) is being built
in `tkarakai/toolbelt-agent` (5.8).
Wave A's host and SDK (roadmap 6) are implemented as described there and in
[docs/plugins.md](../docs/plugins.md#views); the protocol v2 specification (roadmap 5) for
wave A is those documents. Wave A shipped on 2026-11-26: SDK 0.4.0, ToolBelt 0.6.0 (with SDK
Explorer 0.3.0 as its demo seed), OnTrack 0.15.0 and Upkeep 0.3.0 (both now `read`) and
Processes 0.2.0 (`none`), all on protocol 2. The
evaluation, with 17 life-like requests answered through MCP and the CLI, is in
[agent-interface-eval/report.html](agent-interface-eval/report.html). Its cases now run as
automated scenarios (5.6).

Built differently from the plan:

- **No ViewHub extraction yet (R9).** Agent instances are opened by the agent core through
  `PluginHost.open(plugin, surface, instance, view)`; the person's instance keeps the window,
  popover and remote views' existing wiring, which forwards only its trees. Extraction moves to
  wave B1, where per-actor routing needs it.
- **Row reads and the `secret` marker are not in wave A.** `parent` paging already reads one
  row's children; reading rows by id and the tree-level `secret` marker move to wave B1.
- **The registry covers agent operations only (R10).** Five read operations feed MCP and the
  CLI. The renderer's RPC handlers are not migrated.
- **Approvals.** Wave A's one question (R14) is a dialog on every open person's screen, not a
  Settings → Agents list; grants are listed there. The full approval broker comes in wave B1.
- **Freshness (R9).** Trees carry their arrival time, a new plugin process clears its cached
  trees, and the agent opens unwatched surfaces on demand (4 s render wait, 60 s idle hold).

The evaluation found two gaps; wave A closes the first (findings O1 and O2):

- reads that follow the person's search and filters (C6);
- whole-screen reads where a row read or a change summary would do.

Contract gaps the plugin upgrades found, for the SDK's next protocol revision:

- `onOpen`/`onClose` fire for a surface's first and last instance without saying whose; plugins
  can't tell the person's screen from an agent's (Upkeep skips a "run finished" toast while only
  an agent has the screen open) or clear per-instance state when one instance closes.
- `onEvent` gets the instance but not its view, and `onView` doesn't fire when an instance opens
  with a saved view: OnTrack keeps the person's last rendered view to resolve `open-task`.
- The SDK can't refuse a view change (OnTrack's 10-level grouping cap moved to render time), and
  control values aren't checked against their options.
- `applyView` fills `sort` only for tables in the page or a `stack`, not in cards or dialogs;
  `cleanView` keeps removed filter ids in `arrange`; a sorted table can't return to unsorted.
- `views` is read before `start`, so declarations built from data loaded in `start` need a
  `declareViews()` at its end.
- Each plugin's release config pins the host version its packaging probe runs as; protocol
  changes need it raised by hand.

## 5.6 Evaluation

The first evaluation was run by hand: an agent (Claude, in the implementing session) picked tool
calls, read the outputs and wrote answers and verdicts. Two kinds of result were mixed together:
tool calls and their outputs, which can be checked by a script, and answers and verdicts, which
need judgement. They are now split into layers.

| Layer | Runs | Judges | Status |
| --- | --- | --- | --- |
| 1. Scenario format | — | — | Done: `test/agent-scenarios/` |
| 2. Scenario tests over MCP and the CLI, against fixture plugins | `bun test`, CI | Facts, absences, refusals, notifications, audit | Done |
| 3. MCP conformance | `bun test`, CI; Inspector smoke check optional | Protocol behavior | Done |
| 4. Model-based evaluation | `bun run agent-eval`, on demand or nightly, never blocking CI | Final answers | Planned (below) |

[docs/agent-interface.md](../docs/agent-interface.md#testing) describes layers 1–3. The 17 hand-run cases became
scenarios 01–17 through a converter. [agent-interface-eval/](agent-interface-eval/README.md)
stays as the historical first run, against the real plugins, and as the converter's input. Once
layer 4 writes reports from real runs, it can shrink to `cases.json` and the step files.

### Layer 4: model-based evaluation (plan)

**Runner.** `bun run agent-eval [--case id…] [--runs N] [--model id] [--channel mcp|cli]` builds a
world with the scenario harness (fixture plugins, the case's setup and person actions), then
has a real agent answer the case's `prompt`:

- **MCP channel:** `claude -p "<prompt>" --mcp-config <file>`, where the file starts the stdio shim
  for the world's socket (`toolbelt --socket … mcp`, plus `--autonomous` for autonomous cases),
  with `--output-format stream-json` and only the ToolBelt tools allowed. The Claude Agent SDK
  is the alternative when the runner needs to inject person actions between turns (scenario 09,
  scenario 10's open search). Default model: the latest Claude Opus, with a cheaper model as an
  option for nightly runs.
- **CLI channel:** the same agent with a Bash tool limited to `toolbelt …` and the skill file
  (`toolbelt skill`) in its system prompt, as a coding agent would use it.
- Person actions in `steps` that come after the first tool call are applied when the agent makes
  its first call (or on a timer for watchers). Scripted `call` steps are not replayed: the agent
  chooses its own calls, and the run records them.

**Grading.** Each run gets:

- **Facts:** the scenario's `expect.contains` facts that a good answer should repeat, kept in a
  separate `answer` list so tool-output facts ("{id: ollama}") don't count against the prose.
- **Absences:** `absent` strings must not appear in the final answer (secrets, hidden plugin ids).
- **Judge:** a model grades the answer against the `rubric`, item by item (met, partly met, not
  met, with a reason), given the prompt, the tool outputs the agent saw and the rubric only. A
  judge disagreeing with the facts check is reported, not resolved.
- **Process:** tool calls made, characters read and wall time, to spot regressions in how much an
  agent has to read (finding O2).

**Pass rates.** Each case runs several times (default 5) per channel and model. A case passes a
run when all facts and absences hold and the judge marks every rubric item met. Results go to
`artifacts/agent-eval/<date>/` (gitignored): one JSONL record per run with transcript, answer
and grades, plus a summary of pass rates per case, channel and model compared with the previous
run.

**Report.** `tools/report.ts` from the first evaluation moves next to the runner and renders
`report.html` from real runs: per case the prompt, persona, pass rate, a representative answer,
the tool calls, and rubric results, with failing runs expandable. Hand-written answers go away.

**Plugin-owned scenarios.** Each plugin repository can ship `agent-scenarios.json`: a seed (data
to load through the plugin's own model, as the first run's `seed.ts` did) and scenarios in the
same format. The host's harness runs them against the plugin's local archive through plugin
development mode, in an isolated profile. Layers 2 and 3 work without a model in plugin CI, and
layer 4 runs on demand. The harness is likely an SDK tool next to the release CLI, so plugins
consume it through their pinned SDK, and the format becomes a documented, versioned SDK contract.

**Wave A extension.** When view state arrives:

- `read_screen` steps gain `view` and presentation options, with facts that rows outside the
  view are absent and that the person's view is unchanged;
- steps gain `{ "call": "show_screen", … }`, and person actions gain `approve` (with a
  duration) and `deny` for a view-control grant, plus `restore`;
- `expect.view` checks the person's view state after a step, and `expect.audit` covers the
  grant's lifecycle (requested, granted, denied, expired, used).

**Wave B1 extension.** When guarded actions arrive:

- steps gain `{ "call": "run_action", … }` with `expect.approval: "requested"` (or `"none"` for
  safe actions);
- person actions gain `approve` and `deny` for a pending approval, and `grant` for a standing
  grant in autonomous mode;
- `expect.state` checks the fixture's state after the action, through a fixture-only debug screen,
  so scenarios prove that an approved action happened once and a denied or expired one never did;
- `expect.audit` covers the approval's lifecycle (requested, approved or denied, expired);
- conformance adds `destructiveHint` and `readOnlyHint` checks per action risk and a check that
  refusals and pending approvals stay `isError` or `pending_approval` results.

## 5.7 Open questions

None for waves A and B1. Wave B1's approvals are decided in [agent-actions.md](agent-actions.md);
the Settings → Agents queue of pending approvals is designed with wave B2.

## 5.8 In-app chat (step 4)

The chat is the Agent plugin in its own repository, `tkarakai/toolbelt-agent`, on a host feature
any plugin can use: floating plugins ([docs/plugins.md](../docs/plugins.md#floating-plugins)).

**Host (roadmap 8).** A floating plugin declares `floating` and capability `ui.floating`, may
have no screens, and renders a `floating` node: an ask bar (`mode: "bar"`) that grows into a panel
with a title bar (`mode: "panel"`). ToolBelt draws and owns the window: moving, resizing,
minimizing into its sidebar item at the bottom of the sidebar (above Settings), stacking, focus,
an optional ⌘ shortcut, and frames remembered per profile. Windows stay inside ToolBelt's window
and aren't modal; only host approvals (view grants) block. On a phone one floating plugin at a
time shows as a bottom sheet. The menu-bar popover doesn't list floating plugins.
Plugins get `TOOLBELT_AGENT_COMMAND` to start ToolBelt's MCP server for an agent, and
`toolbelt mcp --client NAME` names that session ("Agent · Claude Code") in grants and the audit
log. No protocol change: the plugin requires ToolBelt 0.7.0 and the capability.

**Agent plugin (roadmap 9).** An ACP client in its Bun process. It starts the agent's ACP adapter
and gives it ToolBelt's MCP server through `session/new`. Decided:

- **Agents.** Every agent is the person's own installation and login, found in their login-shell
  PATH: Claude Code's ACP adapter (`claude-agent-acp`), Codex's (`codex-acp`) and Gemini CLI
  (`gemini --acp`), with install instructions when one is missing, or a custom ACP command (with
  environment lines) for anything else, such as an agent backed by a local model. Bundling Claude
  Code's adapter was the first plan, dropped because it depends on the Claude Agent SDK, whose
  license doesn't allow redistributing it, and on Claude Code's ~360 MB native binary, over the
  archive limits. The plugin never downloads code, and ToolBelt never sees keys.
- **The agent's own tools.** The client offers no ACP file-system or terminal capabilities, runs
  the agent in an empty folder in the plugin's data, and refuses permission requests for anything
  but ToolBelt's MCP tools. Claude Code sessions also start without its built-in tools, the
  person's Claude settings and their other MCP servers. ToolBelt's own grants and access levels
  still apply to ToolBelt's tools.
- **Settings** live in the floating window: a gear in its title bar swaps the window to the
  plugin's settings (agent, command, test connection, what agents may see with a link to
  Settings → Agents); first run opens there.
- **Rendering.** The plugin renders at most about 10 times a second while an answer streams and
  sends the recent turns in full, so long conversations stay well inside the 30 renders/s and
  4 MiB limits.
- **Self-access.** The Agent plugin declares `agent.access: "none"`.

Deferred: the "current focus" read (the screen and selected row the person is looking at, shown as
a "Sees" chip above the composer), which needs the renderer's selection reported to the host.

