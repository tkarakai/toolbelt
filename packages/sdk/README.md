# @toolbelt/sdk

Bun SDK for Toolbelt's declarative plugin protocol. Install a pinned SDK release archive in
your plugin repository; no Toolbelt source checkout is required. The current SDK version is
`0.2.0-dev.5`, package format 1 and protocol 1. SDK build version is diagnostic; host/Bun
ranges and negotiated capabilities determine compatibility.

```ts
import { definePlugin, dataDir, packageRoot, payload, asset } from "@toolbelt/sdk";
```

| Export | Purpose |
| --- | --- |
| `definePlugin`, `Context`, UI/protocol types | Render open screens/quick view and handle actions/lifecycle |
| `dataDir()`, `packageRoot()`, `payload(relative)`, `asset(name)` | Separate writable data from immutable package files and declared assets |
| `defineMigration` | Initialize/migrate staged managed data and report bounded completion |
| `validatePackage(root)` | Check a built output directory before archiving |
| `@toolbelt/sdk/package` | Manifest types, schema parser, capabilities and limits |
| `@toolbelt/sdk/validation` | Runtime message/tree validation |
| `@toolbelt/sdk/testing` | `fakeHost` in-memory production-SDK transport |
| `@toolbelt/sdk/search` | Search, edit distance and highlighting helpers |

Render keys are `screen:<manifest-screen-id>` and optional `quick`. `Context.invalidate()`
coalesces renders; unchanged trees are not resent. `Context.capabilities` contains negotiated
host support. Declare used features required or implement an actual fallback when optional
capabilities are absent. Keep stdout protocol-only; use stderr for diagnostics.

`Context.navigate(screen, {select?})` shows one of the plugin's declared screens in the main
window and selects a stable row/list item ID there. Call it only in response to an event, such
as a toast button (`surface: "toast"`). The host ignores calls that come more than 10 s after
the last event it delivered, and allows one navigation per event. It requires the `navigate`
capability; without it the method returns false and sends nothing. `Action.menu` turns a
button into a split button with one level of alternatives (`ui.split-action`).

`ui.rich-fields` adds `textarea` (optionally a live Markdown editor), `datetime`, `color`,
`combobox` and `tags` form fields. Tables can declare `sections` and mark rows `unread`;
`selectEvents` sends `select` when the selection rests on a row (`ui.row-select`), and `reorder`
lets people drag rows within and between sections, sending `reorder` (`ui.row-reorder`).
`Action.key` accepts `alt+`/`shift+` combinations such as `alt+up` (`ui.modifier-keys`).
`ui.timeline` adds the `timeline` node: dated Markdown entries with keyboard-driven actions.
`datetime` fields take `placeholder` and `presets`, any field can `autofocus`, and
`DetailItem` takes `markdown` and `target`; older hosts ignore those.
`ui.row-pane` adds `Row.pane`, nodes the details drawer shows to edit the row in place (forms
with `appearance: "inline"`, `text` fields with `heading`), `Action.focus` and table `enter`.
`ui.composer` adds the `composer` node, `timeline` `edit` and `Action.input`.
`ui.toast-key` gives a toast button a ⌘ shortcut (`key: "cmd+z"`), shown on the button and
pressed while the toast shows; older hosts ignore it.
`ui.sub-sections` lets a table section declare `sections` of its own (one level), shown even
when empty; rows join them with `group: "<sub id>"` and `reorder` names them in `section`.
`ui.nested-sections` lets those nest further, up to `MAX_SECTION_DEPTH` (10) levels, and adds
`Section.muted`. `ui.filter-group` lets filters also group (`Filter.group`, `groupDisabled`)
and declare a `default` selection; the toolbar then arranges them and sends `filter-arrange`.
`ui.row-tree` adds `Row.context` (a dimmed stand-in for another row) and the table's
`reorderOnto` (drag rows at any depth, and drop onto a row: `reorder` with `onto`).
`ui.choice-control` adds the `choice` toolbar control, a menu of radio choices with sections.
`ui.context-select` lets context rows be selected in place, acting as the row they stand for
(table `contextSelect`). `ui.row-dot` adds `Row.dot`, in the leading slot beside the unread
dot. `ui.section-pill` adds `Section.pill`, a section label drawn as a colored pill.
`ui.heading-aside` adds a heading field's `aside` (an id at its right end).
`ui.tag-multiple` lets a `tags` key hold several values (`TagKey.multiple`).
`ui.pane-buttons` puts a pane row's actions in buttons at the bottom of its drawer (table
`paneButtons`).
`ui.options-field` adds the `options` form field, an editable list of choices (`OptionItem`)
with optional reordering and a color per item; `leastUsedHue` picks colors for new items the
same way. `TagKey.colors` gives `tags` values colors of their own; older hosts ignore it. A dot can be
`"rainbow"` for something whose parts each have their own color.
Tables with `appearance: "document"` drop row lines and tinted section headers; `Tag.shade`
(0–1) and `TagKey.shades` draw tags as steps of their color's intensity. Older hosts ignore
both. Page toolbar actions can have a `key` too.

`start(context)` must respect `context.mode`: `probe` may load staged data and become ready
but must not schedule external work or cause external side effects; `active` is final runtime
activation. `prepare(reason, context)` returns `{ready, reason?}` and can defer an unsafe stop.
After accepting preparation, freeze application writes until shutdown. `stop(context)` releases
owned helpers; never terminate observed or independently launched user jobs.

`defineMigration` supplies from/to versions and schemas, source/target directories and transaction
ID. Change only staged managed data, keep retries safe, and emit progress via its helper.
`data.supports` lists schemas a package can use without migration. Directory rollback cannot
undo external software updates, dotfiles, services or databases.

CLI metadata is `{command, path, cleanupScreen}`. The cleanup screen contains the plugin's
own confirmation; the host navigates there without dispatching a mutating action. Launchers
resolve the active registry selection and pin live payloads with helper PID leases.
`handoffActions` declares action IDs requiring native foreground ordering; declare
`native.handoff` required or optional with a fallback. IDs `toolbelt` and `constructor` are
reserved. Screen IDs are unique lowercase letters/digits/dashes.

See the host repository's [plugin authoring guide](https://github.com/tkarakai/toolbelt/blob/main/docs/plugins.md)
and [plugin development mode guide](https://github.com/tkarakai/toolbelt/blob/main/docs/plugin-development.md),
and the [SDK Explorer](https://github.com/tkarakai/toolbelt-sdk-demo) for complete examples.

SDK packaging creates a local archive. Canonical SDK assets are published under sdk-v<version> and are separate from app releases. Updating the SDK never changes plugin dependency pins automatically. There is no npm publication.

## Development release tools

`@toolbelt/sdk/release` and the `toolbelt-release` executable provide release preparation,
shared packaging/verification and CI publication. They are separate from the runtime entry
point: import them only in repository build/release scripts, never plugin runtime code.
A typed `release.config.ts` supplies repository/product identity, version/changelog adapters
and specialized builds. A product may provide an optional `validate()` callback with its
complete product-specific checks; without it, the engine runs the repository typecheck
and full test suite before building. The callback is used by both `--check` and CI
candidate builds. The engine supplies archive/descriptor/checksum creation and uses
the same bounded archive and protocol/lifecycle implementation as the host.

Prepare with `bun run release:plugin --version X.Y.Z --channel stable|prerelease`; append
`--check` for a temporary build without GitHub writes. Merging the validated release PR
authorizes CI publication. Before tagging, retry with
`bun run release:plugin:retry --tag vX.Y.Z --pr <merged-release-PR>` or `--source <full-merge-SHA>`.
Once an annotated tag exists, `--tag vX.Y.Z` alone resolves it. Retry reuses frozen files
and never guesses from current main. Consumers adopting this command must update both
the public SDK pin/lockfile and their workflow’s optional string `source` dispatch input. The [release reference](https://github.com/tkarakai/toolbelt/blob/main/docs/releases.md)
covers thin workflow installation, required permissions, targets and immutable-byte recovery.
