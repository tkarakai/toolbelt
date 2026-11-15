# SDK changelog

## Unreleased

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
