# Wave B1: guarded actions (specification)

Agents can perform the actions a plugin's screens offer, as the person would, with the person
approving wherever it matters. This is roadmap item 10 of
[agent-interface.md](agent-interface.md#53-roadmap). It replaces that document's B1 parts of R1–R5,
R7 and R9–R12 wherever the two differ. Plugin management by agents (install, remove, update,
channel) is not in this wave.

## Decisions (2026-11-27)

- **Approvals are answered only on ToolBelt's own screens.** These are the Mac window and paired
  devices. MCP elicitation is not used: its answer comes back over the agent's own connection,
  so the agent's process could approve its own request. Approval dialogs are drawn by the host,
  never by a plugin (a plugin could draw a fake one). This includes the Agent plugin's chat.
- **The approval shows what the host resolved,** not what the agent says it is doing: the plugin,
  screen, action label, target rows (or their count) and their titles, the plugin's `confirm`
  text, and for a dialog's main action, the dialog's current field values. After the person
  approves, the host resolves the action again and refuses it if anything changed.
- **Risk is declared once per action id, next to the views** (the SDK's `actions`), not on each
  action in each tree. A tree may only use declared action ids.
- **Writes ask, with an optional timed grant per agent and plugin.** Destructive actions,
  external effects and actions with `confirm` ask every time.
- **Forms are filled in the agent's own instance.** An agent opens a dialog, fills it in and
  presses its main action. Each step happens in a private instance of that session, and the
  approval happens at the action that has an effect. Typed `params` on actions (one-call
  operations) come later, per plugin.
- **Side effects of an agent's event go back to the agent.** Navigation and clipboard text are
  returned to it, never shown on the Mac window or written to the Mac clipboard. Toasts from
  agent writes are returned to the agent and also shown to the person, so Undo stays theirs.
- **A call waits up to 60 s for its approval, then is denied,** as `show_screen` does. The
  non-blocking `pending_approval` queue is wave B2.
- **No plugin management by agents in this wave.**
- **A change journal records every change, by people and agents alike** (see B1.2). People
  stop reading approvals they see too often, so knowing who changed what, and when, can't
  depend on the approvals.
- **History and reversibility are a wave of their own, right after B1** (roadmap item 11, to be
  specified then): snapshots of plugin data, per-record history and revert. Once changes can be
  undone, the approval rules are revisited so that reversible changes ask less (item 12).

## Trust model

The agent socket is reachable only by the person's user account, and an agent's name is what it
claims (the hello's `name` or MCP `clientInfo`). Grants bind to that name. Approvals protect
the person from an agent that makes a mistake or is misled by what it reads, for example a task
title imported from a GitHub issue that says "delete all tasks". They do not protect against
malware running as the person, which could change a plugin's data files directly. Everything
on a screen is untrusted input to the agent. That is why approvals show the host's resolution
and never text the agent supplies.

## Milestones

| | Milestone | Contract | Ships as |
| --- | --- | --- | --- |
| B1.1 | Action resolver: the host checks every event, from every client | None (host only) | App patch/minor |
| B1.2 | Protocol 3: action and form declarations, event ids and results, origin, per-instance hooks, wave A's SDK gaps; the change journal | Protocol 3, SDK major | SDK + app, then every plugin |
| B1.3 | Agents act: `run_action`, `fill_form`, approvals, write grants, result routing, audit, CLI | Agent interface (MCP, CLI) | App minor |
| B1.4 | Plugin upgrades: OnTrack and Upkeep move to `act`; the others move to protocol 3 | Plugins | Plugin releases |

B1.1 can ship on its own. B1.2 and B1.3 can be built together but are reviewed separately.
B1.2's SDK and host publish first (per [docs/releases.md](../docs/releases.md)). After that, each
plugin releases for protocol 3: OnTrack, Upkeep, Processes, SDK Explorer (the demo seed) and
Agent.

---

## B1.1 Action resolver

Today, payloads are built in React (`src/ui/renderer/Render.tsx`) and the host forwards any
event (`PluginHost.event`, `personEvent`) after checking only its size. An invented, disabled or
unoffered action, or a wrong row, reaches the plugin.

**`src/shared/actions.ts` (pure, shared by the renderer, host and agent core):**

```ts
/** Where an action or field event points in a tree. */
type Address =
  | { kind: "action"; action: string; row?: string; rows?: string[]; table?: string; dialog?: string;
      card?: string; target?: string; timeline?: string; entry?: string; composer?: string; text?: string }
  | { kind: "field"; form: string; field: string; row?: string; value: FieldValue }
  | { kind: "dialog-close"; dialog: string }
  | { kind: "reorder"; table: string; row: string; section: string; before: string | null; onto?: string };

type Resolved = {
  name: string;          // the event name sent to the plugin
  payload: unknown;      // exactly what the renderer sends today
  action?: Action;       // the definition found in the tree
  place: string;         // "row menu of 'Fix login' in Tasks", for approvals, audit and refusals
  rows: { id: string; title: string }[];
  confirm?: string;
};

function resolve(tree: Node, address: Address): Resolved | { refused: string };
function payloadFor(...): unknown;  // the renderer builds payloads through this too
```

- **Resolution:** an action must be offered at its address and not `disabled`. Row actions must be
  on that row, or on that row's context row with the renderer's rewriting (`c<id>@<group>`).
  Bulk actions must be among the table's bulk actions, and every row must be present. A
  `target` must be one of the action's or detail item's targets. `text` is allowed only for
  `input` actions and composers. A field's form and field must exist (in the row's `pane` when
  `row` is given), and the value's shape must match the field type.
- **The renderer and remote clients build payloads through `payloadFor`.** This makes the
  `EventPayloads` contract complete and documented: `filter-arrange`, `reorder.onto`, list
  items and tags.
- **The host resolves every person's event** against the PERSON instance's current tree before
  sending it. A refused event is dropped and logged with its reason, and the person sees a
  quiet toast ("That item changed. Try again."). View events (`search`, `filter`,
  `filter-arrange`, `sort`, page-control `field`) are checked against the view declaration, as
  the SDK already does. `select` is checked against the table's rows.
- **Risks:** races between the renderer's tree and the host's newer tree. The renderer's
  tree is never newer than the host's, so a refusal means the target really changed.
  Scenario tests cover context rows, split buttons, composers, timelines, row panes, toasts and
  dialogs, across the window and remote paths.

## B1.2 Protocol 3

`PROTOCOL_VERSION` becomes 3, and the SDK has a major release. A plugin built for protocol 2
shows as needing an update. There is no compatibility layer (agent-interface.md 5.4).

### Declarations

```ts
type Effect = "view" | "write" | "external" | "destructive";

type ActionDeclaration = {
  /** What running it does. */
  effect: Effect;
  /** False: agents never see or run this action, whatever the access level. */
  agent?: boolean;
  /** One line for agents when the label isn't enough ("Hides the task until the date"). */
  describe?: string;
};

type FormDeclaration = {
  /** `view`: edits a draft or this instance only (a dialog before Save). `write`: saves as it changes (a row pane, settings). */
  effect: "view" | "write";
  agent?: boolean;
};

definePlugin({
  views: { … },
  actions: { done: { effect: "write" }, delete: { effect: "destructive" }, "new-task": { effect: "view" }, … },
  forms: { "task-draft": { effect: "view" }, "task-pane": { effect: "write" }, … },
  …
});
```

- **Effects:**
  - `view` changes only the sending instance: it opens or closes a dialog, expands something,
    or copies to the clipboard (an agent gets the text back).
  - `write` changes the plugin's data.
  - `external` reaches outside the plugin: it opens an app or URL, starts a process, runs an
    update, or sends a message.
  - `destructive` deletes, or can't be undone.
- `actions` and `forms` are plugin-wide maps (action ids are shared across surfaces), static or
  functions like `views`. The hello carries them. The `views` message becomes `declarations`:
  `{ views, actions, forms }`. `ctx.declareViews()` becomes `ctx.declare()`.
- **The host rejects a render** (the instance shows the render error) whose tree uses an
  undeclared action id (row, bulk, toolbar, card, detail, dialog, timeline, toast or
  split-button alternative) or an undeclared form. This catches a missing declaration the first
  time the screen renders, in development mode and SDK tests.
- Toast actions are declared too. Only the person runs them in B1.
- **Page controls are view state, not forms.** Secret fields (`secret`, `environment` with
  `secretPrefix`) are always human-only, whatever the form declares.

### Events, results and origin

```ts
// host → plugin
{ type: "event"; id: string; surface: string; instance: string; name: string; payload?: unknown;
  origin: "person" | "agent"; agent?: string /* client name, origin agent only */ }
// plugin → host, once per event, after onEvent settles
{ type: "result"; id: string; handled: boolean; error?: string; data?: Json }
// toast, clipboard and navigate gain `event?: string`: the event being handled when they were sent
```

- `onEvent(surface, name, payload, ctx, event)`:
  - `event` is `{ id, instance, origin, agent?, view }`, so the view comes with every event.
  - The handler returns `void` (handled), `false` (not handled), or `{ data }`, where `data` is
    JSON of at most 64 KiB: created ids, run and job ids. A thrown error becomes `error`.
- **The SDK replies with `result` itself.** The SDK handles messages one at a time, so it tags
  toast, clipboard and navigate messages sent while a handler runs with that event's id.
  Messages sent later (timers, background work) carry no `event`.
- **Routing by event id replaces `lastEvent` and `userEventAt`.** The host knows which view or
  agent session sent each event id:
  - `navigate` goes to the view that sent the event, within the grace window.
  - Clipboard and toasts are routed as described under B1.3.
  - Untagged navigation is ignored, as today. Untagged toasts and clipboard go to the person.
- **The host waits up to 10 s for a `result`.** A plugin that starts longer work returns early
  with ids in `data`. A missing result is reported as "no answer in 10 s (the plugin may still
  act)".
- **Plugins should treat `origin: "agent"` as a person acting through an agent:** same
  validation, no hidden side effects (OnTrack doesn't mark a task read when an agent opens it).

### Change journal

The host records every change made through a plugin's screens, whoever made it. The agent audit
(B1.3) records what agents read and asked for. The journal records what changed data.

- **What is journaled:** every event the host sends to a plugin for an action declared `write`,
  `external` or `destructive`, and every `field` event of a form declared `write`, from any
  actor. Each event writes one entry once its result arrives (or the 10 s wait ends).
  - Consecutive field events on the same field by the same actor within 10 s are one entry.
  - View events, `select`, `view` actions and `view` forms (dialog drafts) are not journaled:
    they change no data. The action that saves a draft is.
  - Changes a plugin makes on its own (timers, sync) can't be attributed to an event and are
    not journaled in B1.
- **Entry:**

  ```ts
  type JournalEntry = {
    seq: number; at: number; event: string;
    actor: { kind: "person"; via: "window" | "popover" | "remote"; device?: string }
         | { kind: "agent"; client: string; session: string; mode: AgentMode };
    plugin: string; surface: string;
    /** The action id, or `form.field` for a field event. */
    name: string;
    effect: "write" | "external" | "destructive";
    rows?: string[];            // ids only, at most 200
    approval?: "none" | "grant" | "once";   // agents only
    outcome: "ok" | "not-handled" | "error" | "no-answer";
    error?: string;
    /** sha256 of the previous entry's hash and this entry's other fields. */
    hash: string;
  };
  ```

  Like the audit, entries never contain `text`, field values, row titles or the plugin's `data`.
- **Storage:** `journal/changes.jsonl` in the profile, outside every plugin's data folder.
  - The host only appends to it, and syncs it at least once a second while entries arrive.
  - The hash chain makes an edited or removed entry detectable: the host checks the chain at
    start and reports a break in diagnostics. It can't prevent edits by the person's own
    account, only reveal them.
  - Removing a plugin keeps its entries.
  - The journal is kept for now. Rotation and retention are decided with the History wave.
- **No tooling changes it.** No operation for agents, the person, the debug API or the CLI edits
  or deletes entries.
- **Who reads it in B1:** the debug API and tests. Agents don't. The person's views of it (a
  change log, a record's history) come with the History wave.

### Per-instance lifecycle and wave A's SDK gaps

From agent-interface.md 5.5:

- `onOpen(surface, ctx, { instance, origin })` and `onClose(…)` fire for every instance.
  `ctx.open` still lists surfaces with at least one instance, for polling.
- `onView` also fires when an instance opens with a view.
- A `views` declaration may give a filter's or control's allowed options. The SDK refuses values
  outside them, and `onView` may return `false` to refuse a change (the instance keeps its
  view; the host reports the refusal to an agent).
- `applyView` fills `sort` for tables in cards and dialogs too. A sort can be cleared (`sort`
  with `key: null` returns a table to unsorted). `cleanView` drops removed filter ids from
  `arrange`.
- Declarations from data loaded in `start` are re-sent after `start` without a manual call.
- Each plugin's release config reads the host version for its packaging probe from the pinned
  SDK instead of a hand-kept value.

### Coverage

Runtime schemas (`validation.ts`), docs/plugins.md, SDK Explorer (every effect, a dialog draft,
a row pane form, a destructive action with `confirm`, a toast with Undo, an `agent: false`
action), fake-host tests (results, errors, tags, refusals, per-instance hooks), journal tests (one entry per change for people, remote devices and agents; coalesced field events; nothing for view events; chain verification and a detected break) and
`test/themes.test.ts` for the approval dialog.

## B1.3 Agents act

### Access

- Effective access `act` (the plugin declares `act`, and the person hasn't lowered it) is needed
  to run actions. Settings → Agents makes `act` selectable.
- Actions declared `agent: false`, secret fields, `select`, `reorder` and toast actions are not
  offered to agents in B1.

### Instances

Reads keep their shared instances (one per distinct view). Acting uses a private instance per
session and screen (`agent:<session>:<screen>`), opened with the view the agent asks for. A
dialog an agent opens, and its draft, belong to that session only. The instance is held while
the session lives, or released after 10 idle minutes. `read_screen` with `acting: true` reads
it (dialogs included).

### Tools

The tool list stays fixed (`listChanged: false`).

```
run_action({ plugin, screen, action, row?, rows?, table?, dialog?, target?, text?, view?, open_window?, format? })
fill_form({ plugin, screen, form, values: { [field]: value }, row?, view?, open_window?, format? })
```

- **Where an action is found:** `row`/`rows` (and `table` when row ids repeat across tables)
  addresses row and bulk actions. Without them, an open dialog in the acting instance is
  searched first, then the page, cards and detail items. An action id offered in several places
  without a row is refused, and the refusal lists the places, with `dialog` to choose one.
- **`fill_form`** sends one `field` event per value, in order, each resolved and validated.
  Values that don't match a field's type are refused before anything is sent. The form's
  declared effect decides approval: a `view` form (a dialog draft) never asks; a `write` form
  asks as a write.
- **`read_screen` lists each offered action with its effect** (`done`, `snooze (write)`,
  `delete (destructive, asks)`, `open (external, asks)`) and each fillable form's fields with
  their types and options. `list_screens` lists declared actions per screen.
- **Annotations:**
  - `run_action`: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`,
    `openWorldHint: true`.
  - `fill_form`: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`,
    `openWorldHint: false`.
- **Result** (text by default, JSON with `format: "json"`):
  - The outcome: done, not handled, the plugin's error, refused (with why), denied, or timed out.
  - Whether it was asked and how it was approved: once, by a grant, or no approval needed.
  - The plugin's `data`.
  - Toasts, navigation (screen and row) and clipboard text the event caused.
  - The acting instance's changes after its next render (up to 2 s): rows added, removed and
    changed, with their titles; dialogs opened or closed; at most 40 lines, then a pointer to
    `read_screen`.
- **CLI:** `toolbelt act <plugin> <screen> <action> [--row id]… [--target id] [--text …] [--dialog id] [--json]`
  and `toolbelt fill <plugin> <screen> <form> field=value… [--row id] [--json]`. Both are
  documented in the skill file.

### Approvals

| Effect | `confirm` | Asks |
| --- | --- | --- |
| `view` | no | Never |
| `write` | no | Unless a write grant covers this agent and plugin |
| `write` | yes | Every time |
| `external`, `destructive` | any | Every time |

- **The dialog** is `AgentPrompts.tsx`, extended. It appears on every person's screen that is
  open, as view approvals do.
  - Header: "Claude Code wants to …".
  - Body: the action's label; the plugin and screen; the target rows' titles (the first 5 and a
    count); the `confirm` text; and for a dialog's main action, the dialog's title with its
    field labels and current values.
  - Buttons: **Deny**, **Allow once** and, for an uncovered write, **Allow changes in OnTrack**
    with a duration (the existing `GRANT_DURATIONS`, default today).
  - Destructive actions use the destructive button tone.
- **Write grants** are `{ client, plugin, granted, until, duration }`, saved beside view grants
  (session ones in memory). They are listed with view grants in Settings → Agents and can be
  revoked. A grant never covers an action that asks every time.
- **Re-resolution:** after "Allow", the host resolves the address again against the acting
  instance's current tree and sends only if the resolution matches what the person approved
  (same action, rows and confirm text; for a dialog, the same field values). Otherwise it
  refuses with what changed.
- **No screen open:** the call is refused at once, as `show_screen` does, with
  `open_window: true` available after the person agrees.
- **Autonomous sessions** run only what needs no approval or what a grant covers. Anything that
  would ask is refused at once, and the refusal points to wave B2.
- **Limits:**
  - One pending approval per session; a second call waits behind the first.
  - At most 30 actions a minute per session.
  - Bulk actions take at most 200 rows.

### Routing an agent's event

- **Toasts** go into the result. For `write`, `external` and `destructive` actions, they are also
  shown to the person with "Claude Code" as their source and their action buttons (Undo) usable
  by the person.
- **Navigation** goes into the result and never moves the person's screens. An agent that wants
  to show the person something uses `show_screen`.
- **Clipboard text** goes into the result and never to the Mac clipboard.

### Audit

Each action or fill writes one entry:

- the operation (`run_action`/`fill_form`), plugin, screen and action or form id;
- the row count;
- the effect;
- the approval (`none`, `grant`, `once`, `denied`, `timed out`, `changed`);
- the outcome and the plugin's error.

Entries never contain `text`, field values, row titles or `data`: the log is kept forever.
An agent's change is also in the change journal (B1.2). Both entries carry the event id.
`OPERATION_LABELS` gains "Ran an action", "Filled in a form" and "Asked to make a change".

### Tests

- **Scenarios:** `run_action`, `fill_form` and approval person actions (`approve` with a
  duration, `approve once`, `deny`, `revoke`); `expect.state` through a fixture debug screen
  (an approved action happens exactly once; a denied, expired or changed one never does);
  `expect.audit` for the approval lifecycle; dialogs filled by two sessions at once staying
  apart.
- **Conformance:** annotations; refusals and denials as `isError` results.
- **Unit:** the resolver against every addressable node type.

## B1.4 Plugin upgrades

- **OnTrack (`act`):**
  - Declarations for every action and form.
  - Create, relate, snooze and watch through its dialogs, and a done toggle.
  - It doesn't mark a task read for agent opens, confirms label edits that remove values, and
    returns created task ids in `data`.
- **Upkeep (`act`):**
  - Declarations; checks the specific `update*` id against the row's offered action (B1.1 also
    refuses it).
  - Confirms `autoUpdates` and Discover `remove`.
  - Returns run and job ids.
  - Never marks recipes reviewed for agent saves.
- **Processes (`none`):** protocol 3 declarations only.
- **SDK Explorer:** the conformance fixture for every new contract (B1.2 coverage).
- **Agent (`none`):** protocol 3. While a tool call waits for approval it shows "Waiting for your
  approval". The host's dialog appears over the floating window.

## Out of scope (later)

- History and reversibility (roadmap item 11) and fewer approvals for reversible changes
  (item 12).
- Typed `params`/`result` on actions and plugin-declared tools (roadmap item 14).
- Plugin management by agents (B1b).
- `pending_approval` and standing grants for autonomous agents (B2).
- Agents running toast actions, `select` and `reorder`.
- ViewHub extraction beyond the routing by event id above.
