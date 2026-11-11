# SDK changelog

## Unreleased

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
