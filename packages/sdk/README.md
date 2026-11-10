# @toolbelt/sdk

Versioned Bun SDK for Toolbelt protocol 1. Import `definePlugin`, UI types, `dataDir`, `packageRoot`, `payload`, `asset`, `defineMigration` from `@toolbelt/sdk`; search helpers from `@toolbelt/sdk/search`; fake-host test utility from `@toolbelt/sdk/testing`.

Packages have formatVersion 1 and protocol 1. `requires` declares host/Bun semver ranges and explicit platforms (`darwin-arm64` or `portable`); capabilities have required and optional lists. Unknown required capabilities prevent activation; unknown optional capabilities are ignored and authors must provide their own fallback. SDK version is diagnostic.

`prepare(reason, context)` returns `{ready, reason?}` and may defer disable, removal or upgrade. Once ready, freeze application writes until shutdown. `stop(context)` releases owned helpers; never terminate independently launched user jobs. `defineMigration` runs only on the staged managed directory and reports bounded lifecycle completion. Directory rollback does not undo external side effects.

Manifest schema and limits are exported from `@toolbelt/sdk/package`; runtime message validation from `@toolbelt/sdk/validation`. No runtime sandbox is provided: plugin code executes with the user's privileges.

Candidate SDK dev.3 adds `validatePackage(root)` for built-output validation and `Context.mode` (`probe` / `active`). Probe startup loads data and declares readiness but must not schedule external software updates or other external side effects. Host probes staged data before committing final activation.

CLI declarations use `{command, path, cleanupScreen}`: path points to a packaged payload; cleanupScreen names an existing screen with the plugin's own confirmed cleanup UI. Toolbelt never dispatches a mutating cleanup action behind that confirmation. Optional `data.supports` declares schemas usable without migration; schema-incompatible recovery restores the matching managed-data snapshot after a data-loss warning. The host retains the three most recent successful snapshots/code selections. CLI launchers resolve the active registry entry and pin live payloads with PID leases under `plugins/leases/<id>/`.
