# Plugin authoring and updates

A ToolBelt plugin is an independently built Bun program with a runtime manifest. It sends
declarative UI trees; ToolBelt renders them in the main window and optional menu-bar quick
view. The plugin owns its dependencies, data schema, migrations, assets, helpers, tests and
GitHub releases. The host never builds plugin source or installs its dependencies.

Use [SDK Explorer](https://github.com/tkarakai/toolbelt-sdk-demo) for UI/capability examples,
[Processes](https://github.com/tkarakai/toolbelt-ps) for helper/TUI packaging, and
[Upkeep](https://github.com/tkarakai/toolbelt-upkeep) for background work and safe upgrade
preparation. Each repository documents its own architecture and maintenance commands.

## Quick-view navigation

The popover previews a selected plugin's declared quick view beside the plugin list. Plugin
hotkeys select without opening a window. Side arrows move keyboard focus between panes;
one selected item per plugin is shared with the main window using stable item IDs. The
active item has a stronger fill, while inactive selections have an intermediate fill.
Quick-view action shortcuts operate only in the focused collection. Inputs and dialogs keep
their standard keyboard behavior.

Enter on either pane opens the plugin's main screen with the shared item selected.
Fresh quick views have no selected item until one is chosen. A main-window selection
preselects the matching quick-view item, and changes or clears in either surface update the
other. If a surface does not contain that item, it shows no selection without clearing the
shared ID. Use stable item IDs across quick and main surfaces to support this handoff; list
and table collection IDs may differ. The host matches IDs, opens ancestor rows/groups and
scrolls to the item. If the item is absent, it preserves the main screen's existing selection
and waits for a matching render. Buttons and action shortcuts continue to dispatch their
normal actions. Only selection identity is shared between renderer surfaces; plugin code and other UI
preferences remain separate.

## Create a plugin

Create a Bun TypeScript repository and pin a public SDK archive as a dependency. The
following dependency identifies the currently published SDK; freeze it in `bun.lock`:

```json
{
  "type": "module",
  "dependencies": {
    "@toolbelt/sdk": "https://github.com/tkarakai/toolbelt/releases/download/sdk-v0.2.0-dev.5/toolbelt-sdk-0.2.0-dev.5.tgz"
  }
}
```

Use Bun to install dependencies. Import from `@toolbelt/sdk` and its public subpaths, never
from a ToolBelt checkout or copied SDK files. Keep implementation code in the plugin repo.

```ts
import { definePlugin, type Node } from "@toolbelt/sdk";

let count = 0;
const view = (): Node => ({
  type: "page",
  actions: [{ id: "increment", label: "Increment", key: "i" }],
  children: [{ type: "text", text: `Count: ${count}` }],
});

definePlugin({
  render: {
    "screen:main": view,
    quick: () => ({
      type: "stats",
      items: [{ label: "Count", value: String(count) }],
    }),
  },
  onEvent: (_surface, name, _payload, context) => {
    if (name === "increment") {
      count++;
      context.invalidate();
    }
  },
});
```

`render` produces complete trees for open surfaces. `invalidate()` coalesces updates; unchanged
trees are not resent. Field/search/sort/action events let the plugin update its model, while
selection, typing and scrolling remain in the renderer. Use stderr for diagnostics; stdout
belongs exclusively to the SDK's JSON-lines transport.

## Manifest

Place `toolbelt.json` at the archive root beside the bundled entrypoint:

```json
{
  "formatVersion": 1,
  "id": "counter",
  "name": "Counter",
  "version": "1.0.0",
  "repo": "example/counter",
  "entry": "index.js",
  "protocol": 1,
  "icon": "plus",
  "requires": {
    "host": ">=0.1.0",
    "bun": ">=1.4.4",
    "platforms": ["portable"]
  },
  "capabilities": {
    "required": ["ui.core", "ui.action-key"],
    "optional": []
  },
  "data": { "schema": 1 },
  "screens": [
    { "id": "main", "title": "Counter", "default": true, "shortcut": "c" }
  ],
  "quickView": true
}
```

`repo` must match the distributing GitHub repository. IDs are stable lowercase letters,
digits and dashes; `toolbelt` and `constructor` are reserved. Keep screen IDs stable so
renderer state survives updates. Screen shortcuts are unique lowercase letters. Use semantic
plugin versions; package/protocol/SDK/host/data-schema versions are distinct.

Declare `portable` only for actually portable output. Packages with platform helpers declare
explicit targets such as `darwin-arm64` or `darwin-x64`; ship every required binary/library.
`requires.host` and `requires.bun` are compatible ranges, not SDK equality checks.

Capabilities are `ui.core`, `ui.action-key`, `ui.terminal`, `ui.conversation`, `assets`,
`lifecycle`, `native.handoff`, `ui.split-action`, `navigate`, `ui.rich-fields`, `ui.row-select`,
`ui.row-reorder`, `ui.modifier-keys`, `ui.timeline`, `ui.row-pane`, `ui.composer`, `ui.sub-sections`, `ui.toast-key` and `ui.options-field`. Require what cannot be omitted. For optional features, test
`context.capabilities.has(name)` and render a working fallback. Unknown required features
prevent activation; declaring a feature optional does not implement its fallback.
`handoffActions` lists plugin action IDs needing host foreground ordering before focusing
another app, and requires a corresponding `native.handoff` declaration.

`agent: { "access": "none" | "read" | "act" }` sets the most AI agents may do with the plugin
through ToolBelt's agent interface ([agent-interface.md](agent-interface.md)). `none` hides it from agents, `read`
lets them read its screens, and `act` is reserved for actions. Without the key, agents can't
see the plugin unless the person allows reading in Settings → Agents, which marks it as not
declared: declare the key so people don't have to guess. Declare `none` when screens show data
agents shouldn't see (command lines, environment values, credentials). The person can lower a
declared level, never raise it. Agents read the same trees
people see, so mark secrets in forms with `sensitive` or `secret` environment entries; other text
reaches agents unchanged. Hosts before the agent interface ignore the key.

`src/shared/package.ts` and `protocol.ts`, exported in the SDK, are authoritative for the
complete metadata/node types and validation limits. Do not infer an API from source comments
that conflict with exported schemas and runtime tests.

## Data, assets and payloads

`dataDir()` is the writable managed directory. Package files are immutable: read them with
`packageRoot()` or `payload("relative-file")`, not source-relative paths or sibling checkouts.
Do not rely on another plugin's dependencies, `NODE_PATH`, host credentials or developer
machine paths. Bundle ordinary JS dependencies; explicitly package dynamic/native dependencies
and helpers under `payload/` with all required local files.

Declare display assets with a manifest mapping such as
`"assets": {"logo":"assets/logo.svg"}` and reference `asset("logo")`. The host namespaces
references by plugin/version, validates file paths/content and rejects unsafe SVGs. Supported
image formats include PNG, JPEG, GIF, WebP and SVG. Lucide icon names and `app:`/`file:` Finder
icons are available without extra bundled images. No executable browser assets are supported.

Optional CLI metadata declares `command`, payload `path` and `cleanupScreen`. ToolBelt preserves
payloads but does not automatically run installers or change the user's shell. Plugin screens
own explicit install/cleanup confirmations. A stable launcher resolves the active package in
`plugins/registry.json`, checks enabled/removal state and creates a live PID lease in
`plugins/leases/<id>/` for payload use. Mirror the current Processes implementation and host
lease validation; do not hard-code a disposable immutable version path in installed launchers.
CLI command collisions are rejected. Active helper leases block version/data changes.

## Lifecycle and migrations

`definePlugin` supports `start`, `prepare`, `stop`, `onOpen`, `onClose` and `onEvent`.
The SDK sends hello and explicit readiness around startup; the host validates negotiation
before exposing trees. Initialization must distinguish `context.mode`:

- `probe`: load staged data and become ready, without timers that run external work,
  login-shell side effects, updates or other external actions.
- `active`: final runtime activation; start approved background work here.

Accept `prepare(reason, context)` only when it is safe to freeze writes and stop. Reasons
include `upgrade`, `restart`, `remove`, `host-upgrade` (app update) and `mode-switch`
(relaunching into or out of plugin development mode); treat unknown reasons like a stop. Return
`{ready:false, reason:"..."}` while an operation cannot safely stop. A software update must
not be interrupted just because a plugin package update is available. After accepting,
quiesce application writes. `stop` closes owned resources/helpers; it must never kill observed
jobs or independently launched terminal sessions. Cleanup can be forced after deadlines,
so keep preparation explicit and owned resources identifiable.

Declare `migration: {"entry":"migrate.js"}` for data initialization/schema changes. Build
that entry as part of the package and use `defineMigration`:

```ts
import { defineMigration } from "@toolbelt/sdk";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

defineMigration(({ targetDir, progress }) => {
  mkdirSync(targetDir, { recursive: true });
  const state = join(targetDir, "state.json");
  if (!existsSync(state)) writeFileSync(state, JSON.stringify({ count: 0 }));
  progress("State initialized");
});
```

Migration receives transaction ID, from/to package versions and schemas, source directory
and staged target directory. Modify only staged managed data. Keep each migration retry-safe
and do not start the normal plugin from its migration entrypoint. The host snapshots, runs
migration, probes staged readiness, promotes data and awaits final readiness before committing.
Failure restores previous managed data/code. No migration is needed when the current schema
is supported. Optional `data.supports` explicitly lists schemas a package can use without
migration. Deleted data initializes afresh even when publisher trust was retained.

Recovery retains three historical selections/snapshots. Code-only downgrade needs compatible
current data; otherwise matching snapshot restoration warns about data lost since that
snapshot. Directory rollback cannot undo external services, dotfiles or software updates.
Never describe it as a general security sandbox or external rollback mechanism.

## Build and validate an archive

A package has no enclosing directory:

```text
toolbelt.json
index.js
migrate.js          # when declared
assets/            # declared display assets
payload/           # optional helpers and local dependencies
LICENSE
NOTICE             # attribution where required
```

A minimal build can use Bun's bundler, copy the manifest/assets/notices, and then call
`validatePackage(outputRoot)` from the SDK. Build every declared executable entry and inspect
dynamic imports. Typecheck, run behavior/fake-host/lifecycle tests, and launch the output
from an extracted temporary directory with no source checkout or ambient `node_modules`.
The SDK's `fakeHost` utility exposes messages, `send` and `close`; use real bounded host
integration as well as the in-memory tests for packaging and readiness.

Archive with portable ustar headers and no macOS metadata:

```sh
COPYFILE_DISABLE=1 tar --format=ustar -czf counter-1.0.0-darwin-arm64.tar.gz -C dist/package .
```

Do not include links, special files, PAX/extended headers, duplicate paths or traversal.
Use safe relative paths for entry, migration, CLI and assets. Respect 64 MiB compressed,
256 MiB expanded and 10,000 entry limits. Keep protocol frames/trees/rates within the SDK's
exported limits. Test the exact `.tar.gz` in ToolBelt's [plugin development mode](plugin-development.md)
(ToolBelt 0.4.0 or later), not just the unpacked author folder. Check every screen and quick view, keyboard actions,
assets, themes, narrow layouts, zoom/motion, prepare refusal and migration failure/recovery.
Mutating tests use disposable resources and temporary homes only.

## Publish and update a plugin

Use the owning repository's exact release runbook:
[Processes](https://github.com/tkarakai/toolbelt-ps/blob/main/docs/releases.md),
[Upkeep](https://github.com/tkarakai/toolbelt-upkeep/blob/main/docs/releases.md), or
[SDK Explorer](https://github.com/tkarakai/toolbelt-sdk-demo/blob/main/docs/releases.md).
Those repos use the shared release CLI from their pinned SDK. Merging a validated release PR authorizes CI publication; local builds do not publish. Host app and SDK publication is in [releases.md](releases.md).

Publish from the plugin's own repository, with frozen dependencies and pinned Bun/actions
in CI. The release must contain the ready-to-run archive plus exactly one
`toolbelt-release.json` descriptor. Its shape is:

```json
{
  "formatVersion": 1,
  "id": "counter",
  "version": "1.0.0",
  "repo": "example/counter",
  "commit": "<full 40-character source commit>",
  "packages": [
    {
      "target": "darwin-arm64",
      "asset": "counter-1.0.0-darwin-arm64.tar.gz",
      "sha256": "<64-character archive SHA-256>",
      "size": 12345
    }
  ]
}
```

Descriptor identity/version must match the archive manifest; target must match the package's
actual support. Avoid overlapping portable/platform choices for the same machine. Asset byte
size/hash must match the uploaded archive and GitHub digest where provided. Upload all assets
to a draft, download and verify those bytes, then publish. Do not overwrite published bytes
under the same plugin version. Source/debug files may be included, but are never host build
inputs. Keep licensing/attribution with redistributed payloads.

For an update:

1. Change behavior in the plugin repo; update its docs/tests and SDK dependency only as needed.
2. Give changed runtime bytes a new semantic plugin version through its release process.
   Update required host/capabilities only when necessary; compatible older hosts continue
   to accept compatible packages.
3. If schema changes, supply the retry-safe migration and supported schema declaration.
   Exercise upgrade, failed migration, busy-operation deferral and matching-data recovery.
4. Build/test/extract the complete archive independently of source and dependencies, then
   publish a new immutable GitHub release with descriptor/hash/target metadata.
5. In ToolBelt, use **Check updates** or **Review release**, review the publisher/version/
   compatibility and approve. Stable is default; enable prereleases or select an explicit
   tag when testing such releases. Automatic checks notify; they do not install.

Users can enter `owner/repo` or its public GitHub URL in Settings → Plugins. Private-repository
authentication is not supported. Publisher identity changes are not followed silently.
Disabling retains code/data; removing retains data unless explicit deletion is selected.
Only development profiles accept locally rebuilt same-version packages; normal profiles keep
rejecting changed bytes for an installed version. Updating plugin implementation requires no ToolBelt source changes; only
a newly required public capability needs corresponding host/SDK/renderer support.

### Group summary columns

`GroupLabel.summary.column` optionally names a table column key. The host renders the
summary in that column with the same alignment and horizontal padding as row values,
including on collapsed groups. A hidden or unknown column hides the summary in the table;
the group inspector retains it. Omit `column` to keep a trailing, full-width summary.

### Group headers and the details drawer

Section headers (the first group level) and declared sub-section headers show their label as
text. Deeper group levels, such as folders, show their label as a blue pill, `sub` as a violet
branch pill and the item count as a neutral pill. Tables whose rows have `details` or groups get a details drawer on the right.
Whether it is open is the person's choice per plugin, set with the panel toggle at the right
end of the pane header (or ⌥⌘B) and remembered across selections and restarts. The drawer has no close
button, and Escape clears the selection without closing it. While open, it shows the selected
row's or group's details, or says that nothing is selected or that the row has no details. The
drawer and its toggle only appear when the table is at least 48 rem wide.
Column-bound summaries require ToolBelt 0.2.2 or newer.

Settings shows the installed release separately from the preference used for future update checks. Allowing prereleases includes stable releases too; each available update reports the channel of the release actually discovered. Existing update preferences survive installation. Release review remains required before plugin or migration execution.

For host/API changes, prepare plugin code early, then pin the published SDK URL and lockfile
before the plugin PR’s final CI. Keep the minimum host range explicit; SDK/app/plugin version
numbers do not need to match. Coordinate publication using the
[release sequencing guidance](releases.md#coordinating-app-sdk-and-plugin-changes).
New SDK release tools require deliberate consumer pins and compatible workflow inputs;
they do not update installed plugins automatically.

### Split buttons

`Action.menu` lists alternatives for the same target. Toolbars, cards, dialog footers, bulk
actions and the details drawer draw the action as a split button: the main part runs the
action and a joined chevron opens the alternatives. In the row menu, alternatives appear
indented under their action. List items show them as extra icon buttons. Picking one sends
its own id with the same payload (`rowId`, `rowIds` or `dialog`). It honors its own `confirm`,
`disabled`, `tone`, `icon` and `key`, and its key works on the selected row. Only one level
is allowed: alternatives cannot have `menu` or `checked`, and a switch (`checked`) cannot have
a menu. Hosts without `ui.split-action` ignore `menu` and show only the main button, so make
the main action a safe default or require the capability.

### Navigating to a screen

`Context.navigate(screen, {select?})` sends `{type: "navigate", screen, select?}`. The host
honors it only for a screen declared in the manifest, and only within 10 s after it delivered
an event (an action, field, search, sort, filter, dialog or toast-button event) to that plugin.
Each event allows one navigation. Opening or closing a surface doesn't count as an event.
Rejected calls are logged as diagnostics. An honored call opens or focuses the main window,
shows the screen and selects `select` there through the same stable-ID handoff as quick-view
Enter. A toast button reaches the
plugin as an event with `surface: "toast"`, so the plugin can respond to it by navigating.

With `ui.toast-key`, a toast button can have a ⌘ shortcut: `key` is `cmd+`, optionally
`shift+`, then a lowercase letter, such as `"cmd+z"` for Undo. While the toast shows, the main
window shows the key on the button (Undo ⌘Z) and pressing it sends the button's event, as a
click would, and dismisses the toast. The newest toast with that key wins, and it wins over
screen shortcuts. It doesn't fire while focus is in a text field, menu or dialog, so ⌘Z there
still undoes typing, and it never fires in the menu-bar quick view, which shows no toasts.
Keys the system or host own with ⌘ (A, C, F, H, M, Q, V, W, X) are refused. Older hosts ignore
`key` and show the plain button, so it needs no fallback; mention the key in the toast's text
only when the capability is present.
Without the `navigate` capability, the SDK method returns false and sends nothing.

### Rich form fields

With `ui.rich-fields`, forms accept five more field types. Each sends `field` with
`{form, field, value}` when the person commits a value; typing stays in the renderer.

| Type | Value | Notes |
| --- | --- | --- |
| `textarea` | text | Several lines; `rows` sets the height. With `markdown: true`, an editor styles Markdown as it's typed (headings, emphasis, code, links) and keeps the source unchanged. Commits on blur and ⌘↵. |
| `datetime` | `""`, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` | Local wall-clock date with an optional time. See [Date and time picker](#date-and-time-picker). `time: false` allows dates only. |
| `color` | a hue | Swatches of the named theme colors, which stay legible in every theme. Arrow keys move the choice. |
| `combobox` | text | A searchable list of `{value, label, sub?}`. `freeform: true` also offers “Use …” for typed text. |
| `tags` | `[{key, value?}]` | Pills, at most one per key, drawn in the key's `color`. `keys` declares each key: `flag` keys have no value, `values` keys pick from a list (any text too with `freeform`), others take free text. Add, change and remove all send the whole array. |

`textarea`, `tags` and `color` take the form's full width under their label. Hosts without the
capability reject these field types, so require it.

### Option lists

With `ui.options-field`, forms accept an `options` field: an editable list of choices, such as a
label's values or a project's statuses. Its value is `OptionItem[]`, and every change sends the
whole list as `field` with `{form, field, value}`.

| `OptionItem` | Meaning |
| --- | --- |
| `key` | The plugin's stable id for the item. Renaming keeps it, so compare keys to tell a rename from a remove and an add. Items the person adds come back without one: give them keys when you render the field again. |
| `text` | What the item says. Never empty in what the host sends. |
| `color` | With `colors: true`, a hue drawn as the item's dot, which opens a swatch popover. New items come back with the color the list uses least (`leastUsedHue`, exported by the SDK). |
| `count` | Optional: how many things use the item, shown beside it. It isn't sent back. |

People rename an item in place (Return or leaving the row commits it; emptying it keeps the
old text), add items from the last row (Return keeps adding, pasting several lines adds one
item per line, and an item already in the list, ignoring case, is pointed at instead of added
twice), remove an item with its × or Backspace in an empty row, and move between rows with ↑ ↓.
With `reorder: true` they drag the grip or press ⌥↑ ⌥↓. `placeholder` is the add row's hint.
Two items can end up with the same text after a rename: decide whether that merges them or is
refused. The host never asks before removing an item, so let a dialog's Cancel undo it, or
confirm when you save. Hosts without the capability reject the field type, so require it.

`TagKey.colors` maps a `tags` key's values to hues: each value's pill and its entry in the
value picker take that color instead of the key's. A key with `colors` and no `color` shows a
rainbow dot in the picker. Older hosts ignore it.

Any field can set `autofocus: true`: it takes focus when the dialog opens instead of the first
field, and when the plugin swaps one form for another in an open dialog (an "edit this note"
form replacing a composer). Give swapped-in fields ids of their own so they mount fresh. Older
hosts ignore it.

### Date and time picker

The `datetime` field reads its value in words on a button ("Fri, Nov 20 · 2:30 PM", with
"in 5 days" beside it) and shows `placeholder` ("No due date"; default "No date") when it has
none. ⌫ on the button clears it; ↓, Space, Return or typing opens the picker:

- a box that reads typed dates: `today`, `tomorrow`, weekdays (`fri`, `next fri`), offsets
  (`+3d`, `in 2 weeks`, `+1m`), `nov 20`, `11/20`, `2026-11-20`, a day of the month (`20`),
  each with an optional time (`fri 5pm`, `tomorrow at 9:30`); a time alone means today.
  Return takes what it reads, shown under the box; ↓ moves to the calendar;
- quick picks: `presets` (`{label, value}`, values like the field's) or Today, Tomorrow, Next
  Monday and In a week. A preset with a time sets both; a date-only preset keeps the time;
- a month in the locale's week order: arrows move by day and week, Page Up/Down by month (with
  ⇧, by year), Home/End to the week's ends, T to today, Return or a click picks;
- with a time, a box that reads `930`, `2pm`, `14:00` or `noon` (↑/↓ step 15 minutes),
  9:00 · 12:00 · 17:00 and No time. Picking a day moves there; Return finishes.

Every pick is sent as a `field` event at once. Esc closes the picker without closing the
dialog.

### Sections, unread rows, selection and drag-to-reorder

Tables can declare `sections`: top-level groups in a fixed order that show even with no rows
(`empty` is shown in the header then) and can start `collapsed`. Rows join one with
`group: "<section id>"`. `Row.unread` and list items' `unread` draw a bold title and a dot for
something new since the person last looked; older hosts ignore them.

With `selectEvents: true` (capability `ui.row-select`), the table sends `select` with
`{table, rowId}` once the selection rests on a row for 400 ms, and `rowId: null` when the
selection is cleared or is on a group header. Use it to mark items read when they are opened.

With `reorder: true` (capability `ui.row-reorder`), people drag top-level rows within and
between sections. A drop sends `reorder` with `{table, rowId, section, before}`: the row goes
into `section` before row `before`, or at the end when `before` is null. A section's `order`
says how it takes drops: `"manual"` (default) at the position shown, `"fixed"` anywhere in it
with the plugin choosing the position (a section sorted by time), `false` not at all.
`dropLabel` and `dropIcon` name what a drop from another section does ("Settle"); the chip
under the pointer shows it. The renderer shows the row in its new place until the next tree,
so apply the move or re-render to undo it. Escape cancels a drag. ⌘↑ / ⌘↓ move the selected row
by keyboard with the same rules and the same `reorder` event: a step within a manual section, or
into the next section that takes drops at its near end (a collapsed one opens). Moves made before
the next tree pile up in the renderer.

### Sub-sections

With `ui.sub-sections`, a declared section can have `sections` of its own: sub-sections, one
level deep (deeper needs `ui.nested-sections`, below). Every section and sub-section id is
unique in the table; validation rejects repeated ids.

```ts
sections: [
  { id: "inbox", label: "Inbox" },
  { id: "progressing", label: "Progressing", sections: [
    { id: "working", label: "Working" },
    { id: "snoozed", label: "Snoozed", empty: "Nothing snoozed", collapsed: true, dropLabel: "Snooze" },
    { id: "watching", label: "Watching" },
  ] },
  { id: "settled", label: "Settled", order: "fixed" },
]
```

A row joins a sub-section with `group: "snoozed"`, or a path starting with it
(`["snoozed", "Folder"]`) for groups inside it; `["progressing", "snoozed"]` means the same.
Rows can still join the parent with `group: "progressing"`; they come first, then the
sub-sections in order, then any other groups in the parent. A sub-section header looks like a
section header, with its icon, label and row count.

Tables indent by one fixed step per level: a child's chevron starts where its parent's content
does, after the parent's chevron. Under a group header that is where the header's icon starts
(or its title, without an icon); the icon never widens the indent. A group's rows put their
chevron or unread slot there, as do its sub-sections and folders, and with bulk actions rows
land in the same place despite the checkbox column. Children of an expanded row start under
the row's text. Rows outside any group start at the edge. It shows even with no rows, with its
`empty` text, and can start `collapsed` (the person's choice is remembered as for sections).
Collapsing the parent hides its sub-sections. The keyboard moves through sub-sections like
any group and skips collapsed ones, and the selection handoff opens a collapsed parent and
sub-section to show the selected row.

With `reorder`, a sub-section takes drops by its own `order`, `dropLabel` and `dropIcon`. A drop
on its header or among its rows sends `reorder` with the sub-section's id as `section`, and
`before` the next row in that sub-section (null at its end). A drop on the parent's header or
among the parent's own rows sends the parent's id.

Hosts without the capability ignore `Section.sections`: a row whose group is a sub-section id
becomes an undeclared top-level group after the declared sections, and drops report only
top-level sections. Require the capability, or when it is absent send a flat layout: either
promote the sub-sections to top-level sections, or keep the rows in the parent with a nested
group path such as `["progressing", { id: "snoozed", label: "Snoozed" }]` (shown as a folder
pill, never when empty, with drops reported as the parent).

### Nested sections

With `ui.nested-sections`, a sub-section can declare `sections` too, and so on, up to
`MAX_SECTION_DEPTH` (10) levels counting the top. Every level works like a sub-section: drawn
with the section-header style, shown even when empty, collapsing on its own, taking drops by its
own `order`, `dropLabel` and `dropIcon`, and named by its id in `reorder`. Rows join one with
`group: "<id>"` or a path starting with it. Ids are unique across the whole table, so a plugin
grouping by several things gives each section an id built from its path (`"web/inbox"`).
Validation rejects an eleventh level and repeated ids at any depth. `Section.muted` dims the
section, its sections and their rows (an archive). When a row moves into a collapsed section
(or one inside a collapsed section), that collapsed header flashes once.

### Filters that group

With `ui.filter-group`, a page's `Filter` can carry `group`: true while it groups the page's
rows, false while it could. When any filter has it, the toolbar arranges the filters in one row:
the grouping ones first, in level order, numbered and joined by ›, a divider, then the others,
then the page's `controls` after another divider. A filter's menu opens with a **Group by**
switch above its search. Turning it on makes the filter the last level; off, the first of the
others. People can also drag a filter to reorder it, or across the divider to group or stop
grouping, and press ⌥← / ⌥→ on a focused filter to step it along the row (over the divider
groups or ungroups). The row shows each move at once, sliding the filters and keeping focus and
an open menu with the moved one, and sends one event:

```ts
{ name: "filter-arrange", payload: { order: string[]; grouped: string[] } }
```

`order` has every filter id in its new order; `grouped` the grouping ones, in level order. The
plugin regroups and sends the filters in that order. Drawing the groups is the plugin's: it
declares sections for them. `groupDisabled` (text) keeps a filter's switch off and says why,
for a plugin with a depth limit; a drag that would group it is refused in place.

`Filter.default` (`{ values, label }`) names a filter's starting selection. While `selected`
matches it, the button shows the label ("Status · Ongoing") without the filtering highlight;
otherwise the menu offers **Reset to <label>** beside Show all. Selection still follows the
usual rule: nothing checked means no filtering.

### Row trees and context rows

With `ui.row-tree`, a table can let people arrange rows into a tree:

- `reorderOnto` (text, with `reorder`) lets rows at any depth be dragged, not only top-level
  ones, and makes the middle half of each row a drop target. A drop there sends `reorder` with
  `onto`: that row's id, its top-level row's section, and `before: null`. The chip under the
  pointer shows the text ("Make it a subtask"). Rows can't be dropped onto themselves or rows
  nested under them. Between rows, drops work as before; a nested row's drop isn't shown early.
  Such tables count every row in a group at any depth.
- `Row.context` (a row id) makes a row stand in for another row, shown here so the rows nested
  under it keep their place (a parent task listed in another group). It's drawn dimmed and in
  italics, isn't counted, can't be dragged or dropped onto as itself (a drop onto it means the
  row it names), and selecting it selects that row when it's shown. Give it no actions.

Nest rows with `Row.children` as usual, `open: true` to start expanded.

With `ui.context-select`, the table's `contextSelect: true` lets people select context rows
like any other, so the keyboard moves through them in place. Give a context row the actions,
`targets` and `pane` of the row it stands for: they show as usual, and every event from it
(actions, pane events, `select`) carries `rowId`: that row's id, so it acts as that row. While
a row or one of its context rows is selected, the others are drawn with a soft version of the
selection color, showing they're the same thing.

### Row dots, section pills and pane buttons

- `ui.row-dot`: `Row.dot` (a `Dot`) sits in the row's leading slot, the one the unread dot uses,
  so the first column's text lines up whether a row has dots or not. With the unread dot too,
  they sit side by side ending where the slot does, this one on the left; on a row whose slot
  holds its expand chevron, dots sit just left of it. A first cell's `dot` still draws before
  its text.
- `ui.section-pill`: `Section.pill` (`{ color?, shade? }`, as on a `Tag`) draws a section's
  label as a colored pill sized to its header: the same look rows give that value as a tag
  (a label's value used as a group).
- `ui.pane-buttons`: the table's `paneButtons: true` moves a pane row's actions from the slim
  bar on top of its drawer to buttons at the bottom, laid out as for `details`: the first
  action group as buttons (the table's `enter` action, else the first inline one, filled with
  ↵), other groups as quieter rows, destructive actions last, apart. Order and group actions
  with that in mind.

- `ui.heading-note`: a `heading` text field's `note` (text) is a small neutral pill above the
  heading, drawn like a cell's `prefix`: an id over the title.
- `ui.cell-prefix`: `Cell.prefix` (a `Tag`) is a pill before the cell's text, on its line: an
  id in front of a title.
- `ui.tag-multiple`: `TagKey.multiple` lets a `tags` field hold a key several times, once per
  value (Blocks: #3, Blocks: #7), for many-valued keys such as relations. The Add menu keeps
  offering it; each value appears once per key.

- `ui.list-open`: a `list`'s `open` (an `Action`) makes its items links: clicking an item, or ↵
  on it, sends that action with `{ list, item }` instead of only selecting it (its own actions
  keep their buttons and keys). Items then also take `prefix` (a pill before the title) and
  `tags` (pills on the second line, before the subtitle). In a drawer pane the event carries
  the pane's `rowId` too; to go to another row, answer with `navigate(screen, { select })`.
- `ui.list-inset`: a `list`'s `inset: true` keeps an icon's space before items without an
  `icon`, so their text starts where it would after one and the list reads as indented.
- `ui.duration-field`: forms accept a `duration` field, a length of time in whole minutes:
  `{ type: "duration", id, label, value, min?, max?, presets?, none?, description? }`. It's
  edited in place as days, hours and minutes, like a native time field: each part is a
  spinbutton (↑/↓ step it and carry into the next part, ⇧ steps by 10, digits type it, ←/→ move
  between parts, ⌫ clears it, Esc puts the value back), and leading parts that are zero stay
  quiet. A menu at its end offers `presets` (`{ label?, value }`, read aloud as "2 days 4 hours"
  without a label). With `none` (such as "Never"), `value` can be `null`, offered first in that
  menu. `min` and `max` bound it (minutes, 0 to 999 days); a typed value is clamped to them,
  and validation refuses a value, preset or `null` that doesn't fit. The `field` event's value
  is the minutes, or `null`, sent on leaving the field, ↵ or a pick. Older hosts refuse the
  field: require the capability.
- `ui.filter-sections`: a filter option's `section` groups the menu the way the plugin
  structures its values. Consecutive options with the same `section` form a group, groups are
  divided by a separator, and a named section shows its name above its options (options without
  one form unnamed groups). With sections the menu keeps the plugin's order and dims options
  counted 0; without, options counted 0 move below a divider. Older hosts ignore `section`.
- `ui.tag-open`: a `tags` field's `open` (an `Action`) makes each pill's value a link: clicking
  it sends that action with `{ form, field, key, value }`. The pill's key ("Blocks:") still opens
  the value picker to change it. A flag pill, having no value, is a link as a whole.

In dialogs, form labels take one column width (7rem) across every form of the dialog, so
stacked forms line up; longer labels wrap.

### Choice controls

With `ui.choice-control`, a page's `controls` can hold `{ type: "choice", id, label, icon?,
value, options }`: a toolbar button reading "<label> · <chosen>" that opens a menu of radio
items. Options with the same `section` sit under that heading, in order of first appearance,
and `description` adds a quieter second line. Changes arrive as `field` events with `form` and
`field` set to the control's id, like a segmented control.

### Modifier shortcuts

With `ui.modifier-keys`, `Action.key` may put `alt+` and/or `shift+` (in that order) before a
key or `up`, `down`, `left`, `right`: `"alt+up"`, `"shift+s"`. They act on the selected row
and are shown as ⌥↑ and ⇧S. Plain keys behave as before. Older hosts reject these keys.

Action keys also work inside an open action menu (the row's ⋯ menu, the drawer's ⋯ menu and a
split button's alternatives): the key runs the action as picking its item would, with its
`confirm`, or asks which target first. Other letters jump to matching items. Older hosts
only moved the highlight there.

### Toolbar action keys

`Action.key` on a page's toolbar actions works too ("n" for New task) and shows as a key hint on
the button. It runs while the page has the keyboard and no field, menu or dialog does. A selected
row's action with the same key comes first. Older hosts show the button without the hint and
ignore the key.

### Page toolbar layout

A page's toolbar is one row. Its search, `controls`, `filters` and `summary` sit in a
strip that scrolls sideways when they don't fit (trackpad, touch, or a control taking focus),
with no scrollbar; a cut-off edge fades and shows a ‹ or › button. Page `actions` stay at the
right. Below 640 px of toolbar width, actions with an `icon` show as icon buttons, their label and
key in a tooltip. Below 480 px (a phone) the toolbar stacks: the search and the actions on one
row, the other controls scrolling on a second. No plugin change is needed; older hosts wrap the
toolbar instead.

On phones and tablets the host also moves screen tabs to a bottom bar (give every screen an
`icon` and a short `title`), opens row details and panes in a bottom sheet when a row is tapped,
and shows dialogs as bottom sheets. See [remote-access.md](remote-access.md), "Narrow screens"
and "Touch".

### Timelines

With `ui.timeline`, a `timeline` node shows dated Markdown notes in the order given (put the
newest first for status updates), down a rail: each `TimelineEntry` has `id`, `at` (epoch ms)
and `text`, and optionally `edited` (shown as "edited …" when later than `at`), `author`,
`title` and `actions` (ids from the timeline's `actions`; default all). Entry actions show as
icon buttons on hover and focus and arrive as events named by the action id with
`{timeline, entryId}`; `confirm` is honored. Keyboard: Tab enters on one entry, ↑/↓ (or J/K)
and Home/End move, Return runs the entry's first action, an action's `key` runs it and ⌫ or
Delete runs its destructive action. Double-clicking an entry runs its first action. `selected`
marks an entry (the one being edited) and scrolls it into view. `empty` is shown with no
entries. Older hosts reject the node, so require the capability.

### Row panes: editing in the details drawer

With `ui.row-pane`, `Row.pane` (a list of nodes) replaces the row's `details` and `stats` in the
details drawer, so the row can be edited where it's shown instead of in a dialog. Above it, a
slim bar shows the row's first action group as icon buttons (with their keys in the tooltips)
and every action in a ⋯ menu. Events from nodes in the pane carry the row's id as `rowId`,
including `field` events, so a form can keep a stable id. A `card` in a pane is drawn as a
titled section without a box; its actions also carry the row's id. Key nodes by `id`: a node
that keeps its id keeps its state (and focus) across renders even when nodes before it come
and go.

A form with `appearance: "inline"` is a dense property sheet: labels in a narrow column, controls
that read as text until hovered or focused, and each field committing on its own (one-line text
on ↵ or leaving, pickers on a pick). A field with an empty `label` spans the width. A `text`
field with `heading: true` is drawn as the title, large and wrapping; Esc puts it back. A
Markdown `textarea` shows the formatted text (or its placeholder) and turns into an editor on
click, ↵ or Space; leaving it or ⌘↵ commits, Esc puts the text back.

Keyboard: → on a row with a pane moves the keyboard into the drawer (its first control),
opening the drawer when it's closed. Esc anywhere in the drawer goes back to the table, unless a
control used it first (an editor putting its text back). `Action.focus` names a pane element (a
composer's id, or a field of a pane form): running the action from its key, the row menu or the
drawer bar focuses that element instead of sending the action. When the drawer can't show (the
window is too narrow), the action is sent as usual, so keep a dialog for that case. The table's
`enter` names the row action ↵ runs instead of the first inline one; with its `focus`, ↵ goes
into the drawer. A row with neither opens its ⋯ menu on ↵, as `.` does.

Moving through rows with the arrow keys, Home or End brings the keyboard into the screen's first
table even if focus was on a toolbar button, so the next keys carry on there. A focused widget
keeps its own keys: ←/→ on screen tabs or a segmented control, arrows in a radio group or menu,
typing in a field. With nothing selected, any arrow selects an end row. → on a row without a
pane moves into the open drawer's first control too.

## Keyboard and accessibility

Every node is keyboard-operable without plugin code: tables and lists hold focus on their
container and announce the selected row or item (`aria-activedescendant`, with grid/treegrid and
listbox roles), timelines rove focus between entries, and forms use native controls. A focused
collection with nothing selected shows a focus ring; a collection without focus shows its
selection in a quieter fill, so the full selection color always marks where keys go. Lists in a
screen answer arrows only while focused (a page that merely contains one still scrolls); the
screen's first table also answers while focus is elsewhere on the screen. F6 / ⇧F6 move between
the sidebar, the screen tabs, the content and the details drawer. Give actions a `key` and
`label`: the key appears as a hint and as the control's `aria-keyshortcuts`, and the label is its
accessible name.
Older hosts ignore `pane`, `focus` and `enter`, and draw an inline form as a boxed one; require
the capability when the pane is the only way to edit.

### Composers and writing in place

With `ui.composer`, a `composer` node is a box for writing something new: an update, a comment,
a quick task. Sending runs its `action` as an event named by the action id with
`{composer, text}` (plus `rowId` in a row pane) and empties the box; an unsent draft is kept,
per row, while the window is open. By default it's a Markdown editor that grows when focused
and sends with ⌘↵. With `single: true` it's one line sent with ↵, which suits quick views (the
menu-bar popover keeps ⌘↵ for itself). `key` (one letter or digit) focuses it from the rest of
the surface when nothing is being typed. Esc, or ↓ in a one-line composer, goes back to the list
or table.

A `timeline` with `edit` (an action) lets people edit an entry's text in place: the action's key,
its button, ↵ or a double-click turns the entry into an editor; ⌘↵ or leaving saves and sends the
action with `{timeline, entryId, text}` (only when the text changed), and Esc cancels.

`Action.input` asks for text before the action is sent; its event carries `text`. In a list (a
quick view) a line opens under the item: ↵ sends, Esc cancels. Elsewhere a small Markdown editor
asks, sent with ⌘↵. `input.placeholder` prompts what to write. `confirm` still applies after.

### Markdown and targeted details

A `DetailItem` with `markdown: true` draws its value as Markdown in the details drawer; long
values fold with Show all. An empty `label` draws no label line. `target` is sent as the
`target` of the item's `actions` (`{rowId, target}`), so an item can stand for one of the row's
things, such as a note to edit. Older hosts show the text and send no target.

### Document tables

A table with `appearance: "document"` drops the lines between rows and the tint of section
headers: the whole table sits on one background, like a page of notes, and hovered and selected
rows are drawn as rounded bars inset slightly from the sides. Column headers, sections, nested
rows, expanding and collapsing, keyboard navigation, dragging and the details drawer work exactly
as in the default `"grid"` appearance. Older hosts ignore it and draw the grid.

### Tag shades

`Tag.shade`, from 0 (lightest) to 1 (the full color), draws a tag as one step of its color's
intensity, for values with an order such as High · Medium · Low. Hosts round it to five steps.
Each step is an opaque background computed per theme with a text color that meets WCAG AA
(4.5:1), so shaded tags stay readable in every theme and on a selected row. `TagKey.shades` maps
a key's values to shades for the `tags` field: its pills and its value picker use them.
`default` and `muted` tags have no shades. Older hosts ignore `shade` and draw the usual tint.

### Text styles and dots

`Cell.style` and list items' `titleStyle` (`TextStyle`) draw text in a `color` (any `Tone` or
`Hue`), `bold` or `italic`, in any combination: an overdue task's title in red, a draft in
italics. A style's `color` wins over a cell's `tone`. Colors stay readable on a selected row or
an active quick-view item. Older hosts ignore both fields.

A list item's `dot` sits right before its title, after its icon, as a cell's `dot` sits before
its text; with `unread` the unread dot comes first.

A dot's color can also be `"rainbow"`: a multicolored dot for something whose parts each have
their own color, such as a label whose values are colored one by one. It arrived with
`ui.options-field`; older hosts refuse it, so require that capability before sending it.

### Dialog keyboard

A dialog focuses its first form field when it opens (else the dialog itself). ⌘Return runs the
primary action from anywhere, Markdown editors included, after committing what is being typed;
its button shows ⌘↵. Return alone never submits: like Space, it opens the focused picker (date,
select, combobox), ticks a checkbox or flips a switch, presses the focused button, and starts a
new line in multi-line fields. Tab moves through every control, including out of Markdown
editors. Inside dialogs, forms drop their card and line up labels in one column and controls,
as wide as the dialog allows, in the other; descriptions sit under their control. A resizable
dialog opens at a reading width and its content's height until the person resizes it.

### Segmented toolbar controls

Pages may provide `controls`, an array of segmented nodes, beside the search box. Each
control has `id`, `value`, optional accessible `label`, and `options` with `value`, `label`,
optional `icon` and optional `tooltip`. Tooltips appear on hover and keyboard focus.
Selection sends `field` with `{form: id, field: id, value}`; the plugin persists meaningful
preferences and returns the selected value. Controls wrap on narrow surfaces.
This additive contract requires a host/SDK containing segmented toolbar support; older
hosts ignore `controls`. Consumers must wait for the public SDK release and declare a
compatible host range before publishing a package using it.

### Table column layout

Columns declare layout constraints; ToolBelt solves them the same way for every plugin and
keeps the person's choices in the renderer. Plugins express importance through these
generic fields, not through host knowledge of what a column means.

| Field | Meaning |
| --- | --- |
| `width` | Normal width in px, or `"content"` (the default): the widest value seen. |
| `grow` | Takes spare space: `true` or a weight shared with other growing columns. |
| `shrink` | Weight for giving up space, down to `minWidth`, before columns hide. Default: the `grow` weight. |
| `minWidth`, `maxWidth` | Limits in px. Growing columns default to a 240 px minimum, others to 40 px. |
| `priority`, `optional` | Drop order when the minimums don't fit: highest `priority` first, `optional` before all others. |
| `resizable` | Dragging its right edge resizes it. Default: true except for growing columns. |
| `reorderable` | Dragging its header moves it. Default: true except for the first declared column. |

Layout order: start at the person's width, else `width`, else measured content; give spare
space to growing columns by weight; take a shortfall from shrinking columns; then, with the
table's `overflow: "hide"` (default), drop columns. Columns without a `priority` drop by their
displayed position, so a column the person moves left outlasts the ones to its right. The first
column and growing columns never drop. `overflow: "scroll"` keeps every column and scrolls
sideways instead.

Header dividers are always visible. A column's right edge is the boundary with the next column, and dragging it keeps the edge
under the pointer. Widening takes any free room after the last column first, then width from
the columns to the right, nearest first, each down to its minimum. Narrowing gives the width to
the nearest column on the right. Columns to the left never move, and growing columns take
whatever remains. When a column grows to fill the table, the last column's right edge is the
table edge and can't be dragged. Double-clicking an edge restores the default widths of the
columns on both sides. Dragging a header elsewhere moves it among movable columns; Escape cancels.
Non-movable columns keep their declared slot. Group summaries follow their column.

ToolBelt saves widths and order per plugin and table `id`. It stores only widths the person
changed, so later default changes still apply. Columns added by a plugin update appear after
their declared neighbour, and removed keys are ignored. Bump the table's `layoutVersion` to
discard saved layouts when columns change meaning. Plugins receive no layout events.

A sparkline draws oldest to newest and sits before the cell's text, so its newest point is
next to the current value. Sparklines and chips appear when a cell has room: always in content-sized columns at their
measured width, and in other cells once the cell is at least 6.5 rem wide. Older hosts ignore
the new fields, except that a numeric `grow` fails their validation; declare a host range
containing table column layout before publishing a package that uses it.

