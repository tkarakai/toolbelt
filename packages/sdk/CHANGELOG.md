# SDK changelog

## Unreleased
- Add `ui.row-tree`: the table's `reorderOnto` (text) lets rows at any depth be dragged and makes the middle of each row a drop target, sending `reorder` with `onto` (that row's id) and its top-level row's section; the text names the drop. Such tables count rows at any depth. `Row.context` (a row id) makes a row a dimmed stand-in for another row: not counted, not draggable, a drop onto it means the row it names, and selecting it selects that row when shown.
- Add `ui.choice-control`: the `choice` page control, a toolbar button showing "<label> · <chosen>" with a menu of radio options (`section` headings, `description` lines). Changes arrive as `field` events.

## 0.3.12 — 2026-11-24
- Add `ui.nested-sections`: a declared section's `sections` can have their own, up to `MAX_SECTION_DEPTH` (10, exported) levels counting the top, drawn like sections at every depth. Rows join any of them with `group: "<id>"` (or a path starting with it); a drop sends that section's id. Ids stay unique across the table. Validation rejects an eleventh level and repeated ids at any depth. `Section.muted` dims a section and its rows (an archive shelf).
- Add `ui.filter-group`: `Filter.group` (true while the filter groups the page's rows) makes the toolbar arrange the filters: grouping ones first in level order, numbered, with › between them, a divider, then the rest, then `controls` after another divider. A filter's menu opens with a Group by switch; people drag filters to reorder them and across the divider to group or stop grouping, or press ⌥← / ⌥→ on one. Every change is one `filter-arrange` event, `{ order, grouped }`. `Filter.groupDisabled` says why the switch can't turn on; `Filter.default` (`{ values, label }`) names the starting selection: the button shows its label while it's selected, and the menu offers Reset to it.

## 0.3.11 — 2026-11-23
- Add the `options` form field behind the new `ui.options-field` capability: an editable list of choices (`OptionItem`: `key?`, `text`, `color?`, `count?`). People rename items in place, add them from the last row (Return keeps adding; pasting several lines adds one item per line; an existing item typed again is pointed at, not added twice), remove them and, with `reorder`, move them by dragging the grip or with ⌥↑ ⌥↓. With `colors`, each item has a color dot that opens a swatch popover, and new items get the color the list uses least. Renaming keeps an item's `key`, so plugins tell a rename from a remove and an add; added items come back without one. `count` is shown beside an item and isn't sent back. Validation rejects duplicate keys, unknown colors and counts that aren't whole numbers of 0 or more.
- Add `TagKey.colors` (value → hue): a value's own color for its pill and in the `tags` picker, winning over the key's `color`. Older hosts ignore it.
- Add the `"rainbow"` dot color (`DotColor`): a multicolored dot for something whose parts each have their own color. A `TagKey` with `colors` and no `color` shows one in the `tags` picker. Older hosts refuse it; it ships with `ui.options-field`.
- Export `leastUsedHue(used, random?)`: the color the `options` field gives new items (one the list uses least, never a grey, not a wheel neighbour of the last item's color when avoidable), for plugins that add items themselves.

## 0.3.10 — 2026-11-23
- Add `TextStyle` (`color`: a tone or hue, `bold`, `italic`), `Cell.style` and list items' `titleStyle`. A style's `color` wins over a cell's `tone`, and colors stay readable on a selected row or active item. Validation rejects unknown colors and non-boolean `bold`/`italic`. Older hosts ignore them.
- List items draw `dot` before the title (after the icon, after the unread dot), as cells do.

## 0.3.9 — 2026-11-23
- Add `ToastAction.key` behind the new `ui.toast-key` capability: a ⌘ shortcut for a toast's button (`cmd+`, optionally `shift+`, then a lowercase letter, such as `"cmd+z"`). The main window shows it on the button and sends the button's event when it's pressed while the toast shows, except while focus is in a text field, menu or dialog. Keys the system or host own with ⌘ (A, C, F, H, M, Q, V, W, X) are rejected. Older hosts ignore it. `ToastAction` is exported.
- Add `Section.sections` behind the new `ui.sub-sections` capability: declared sub-sections, one level deep, drawn like sections and indented under their parent. Each shows even when empty (with its `empty` text), can start `collapsed` and takes drops by its own `order`, `dropLabel` and `dropIcon`. Rows join one with `group: "<sub id>"` (or a path starting with it); a drop into one sends `reorder` with the sub-section's id as `section`. Validation rejects deeper nesting and section or sub-section ids used twice in a table.

## 0.3.8 — 2026-11-15
- Add `Row.pane` behind the new `ui.row-pane` capability: nodes the details drawer shows instead of `details`, with the row's actions in a slim bar above. Events from inside carry `rowId` (also on `field` events). Forms take `appearance: "inline"` (a property sheet that edits in place) and `text` fields take `heading`. `Action.focus` moves the keyboard to a pane element instead of sending the action, and table `enter` picks the row action ↵ runs.
- Add the `composer` node behind the new `ui.composer` capability: sends its action with `{composer, text}`; Markdown with ⌘↵, or one line with `single`; `key` focuses it. `timeline` takes `edit` for editing an entry's text in place (`{timeline, entryId, text}`), and `Action.input` asks for text before sending (`text`).

## 0.3.7 — 2026-11-15
- Add the `timeline` node and `TimelineEntry` type behind the new `ui.timeline` capability: dated Markdown notes (status updates, comments) with entry actions that arrive with `{timeline, entryId}`, keyboard navigation and a `selected` entry.
- `datetime` fields take `placeholder` (shown while empty) and `presets` (the picker's quick picks). Older hosts ignore them.
- Any form field can set `autofocus` to take focus when its dialog opens or when it replaces another form. Older hosts ignore it.
- `DetailItem.markdown` draws a detail's value as Markdown; `DetailItem.target` is sent as the `target` of the item's actions. Older hosts ignore them.

## 0.3.6 — 2026-11-15
- Add table `appearance` (`"grid"` or `"document"`): a document table has no row lines or tinted section headers, and rounded hovered and selected rows. Older hosts ignore it.
- Add `Tag.shade` (0–1) and `TagKey.shades`: tags drawn as steps of their color's intensity with AA-readable text. Older hosts ignore them.
- Page toolbar actions' `key` now works on hosts with this release and shows on the button.

## 0.3.5 — 2026-11-15
- Add `textarea` (with an optional live Markdown editor), `datetime`, `color`, `combobox` and `tags` form fields behind the new `ui.rich-fields` capability, and the `TagKey`/`TagValue` types.
- Add table `sections` (ordered top-level groups that show even when empty), `Row.unread` and list item `unread`.
- Add table `selectEvents` and the `select` event, behind `ui.row-select`: sent when the selection rests on a row.
- Add table `reorder` and the `reorder` event, behind `ui.row-reorder`: people drag rows within and between sections, and each section says how it takes drops (`order`, `dropLabel`, `dropIcon`).
- `Action.key` accepts `alt+` and `shift+` combinations, including arrows (`alt+up`), behind `ui.modifier-keys`.

## 0.3.4 — 2026-11-15
- Add `Action.menu`, split-button alternatives (one level), behind the new `ui.split-action` capability. Older hosts show only the main button.
- Add `Context.navigate(screen, { select? })` and the `navigate` plugin message, behind the new `navigate` capability. The host honors it only within 10 s after delivering an event to the plugin, for declared screens only. It returns false without sending anything when the host lacks the capability.

## 0.3.3 — 2026-11-14
- Add table column layout: `Column.width` (px or `"content"`), weighted `grow`, `shrink`, `maxWidth`, `minWidth` for every column, `resizable` and `reorderable`, plus table `overflow` (`"hide"`/`"scroll"`) and `layoutVersion`.

## 0.3.2 — 2026-11-12
- Add optional page `controls` (segmented nodes), accessible segmented labels and per-option tooltips.

- Publishing older stable candidates preserves the newer Latest; owning workflows must serialize publication across release tags.

- Release retries accept `--pr` or `--source`, pass the original authorization to CI and refuse recovery that would rebuild tagged, uploaded or expired candidates. Untagged retries require an explicit selector.

- Release product adapters may provide complete product-specific `validate()` checks; existing adapters retain full typecheck/test validation by default.

## 0.3.1 — 2026-11-11
- Add optional `GroupLabel.summary.column` for aggregates aligned with table columns (Toolbelt 0.2.2+).

## 0.3.0 — 2026-11-11

- Promote the development SDK to a stable release, including public plugin types, lifecycle and package/path APIs, runtime validators and fake-host utilities.
- Include the development-only shared release CLI for release PR preparation, archive validation and verified CI publication.

## 0.2.0-dev.5 — 2026-11-10

- Shared release preparation, archive validation and CI publication tooling through the development-only `@toolbelt/sdk/release` entry point and `toolbelt-release` command.
