# @toolbelt/sdk

Bun SDK for Toolbelt's declarative plugin protocol. Install a pinned SDK release archive in
your plugin repository; no Toolbelt source checkout is required. The current SDK version is
`0.2.0-dev.4`, package format 1 and protocol 1. SDK build version is diagnostic; host/Bun
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
and [Plugin Tester guide](https://github.com/tkarakai/toolbelt/blob/main/docs/plugin-tester.md),
and the [SDK Explorer](https://github.com/tkarakai/toolbelt-sdk-demo) for complete examples.
