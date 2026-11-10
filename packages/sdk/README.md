# @toolbelt/sdk

Versioned Bun SDK for Toolbelt protocol 1. Import `definePlugin`, UI types, `dataDir`, `packageRoot`, `payload`, `asset`, `defineMigration` from `@toolbelt/sdk`; search helpers from `@toolbelt/sdk/search`; fake-host test utility from `@toolbelt/sdk/testing`.

Packages have formatVersion 1 and protocol 1. `requires` declares host/Bun semver ranges and explicit platforms (`darwin-arm64` or `portable`); capabilities have required and optional lists. Unknown required capabilities prevent activation; unknown optional capabilities are ignored and authors must provide their own fallback. SDK version is diagnostic.

`prepare(reason, context)` returns `{ready, reason?}` and may defer disable, removal or upgrade. Once ready, freeze application writes until shutdown. `stop(context)` releases owned helpers; never terminate independently launched user jobs. `defineMigration` runs only on the staged managed directory and reports bounded lifecycle completion. Directory rollback does not undo external side effects.

Manifest schema and limits are exported from `@toolbelt/sdk/package`; runtime message validation from `@toolbelt/sdk/validation`. No runtime sandbox is provided: plugin code executes with the user's privileges.
