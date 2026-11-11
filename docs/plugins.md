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
`lifecycle` and `native.handoff`. Require what cannot be omitted. For optional features, test
`context.capabilities.has(name)` and render a working fallback. Unknown required features
prevent activation; declaring a feature optional does not implement its fallback.
`handoffActions` lists plugin action IDs needing host foreground ordering before focusing
another app, and requires a corresponding `native.handoff` declaration.

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

Accept `prepare(reason, context)` only when it is safe to freeze writes and stop. Return
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
exported limits. Test the exact `.tar.gz` through the released [Plugin Tester](plugin-tester.md),
not just the unpacked author folder. Check every screen and quick view, keyboard actions,
assets, themes, narrow layouts, zoom/motion, prepare refusal and migration failure/recovery.
Mutating tests use disposable resources and temporary homes only.

## Publish and update a plugin

Use the owning repository's exact release runbook:
[Processes](https://github.com/tkarakai/toolbelt-ps/blob/main/docs/releases.md),
[Upkeep](https://github.com/tkarakai/toolbelt-upkeep/blob/main/docs/releases.md), or
[SDK Explorer](https://github.com/tkarakai/toolbelt-sdk-demo/blob/main/docs/releases.md).
Those repos use the shared release CLI from their pinned SDK. Merging a validated release PR authorizes CI publication; local builds do not publish. Host SDK/tester publication is in [releases.md](releases.md).

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
For locally rebuilt same-version packages, use a fresh tester profile rather than disabling
integrity checks. Updating plugin implementation requires no ToolBelt source changes; only
a newly required public capability needs corresponding host/SDK/renderer support.

### Group summary columns

`GroupLabel.summary.column` optionally names a table column key. The host renders the
summary in that column with the same alignment and horizontal padding as row values,
including on collapsed groups. A hidden or unknown column hides the summary in the table;
the group inspector retains it. Omit `column` to keep a trailing, full-width summary.
Column-bound summaries require ToolBelt 0.2.2 or newer.

Settings shows the installed release separately from the preference used for future update checks. Allowing prereleases includes stable releases too; each available update reports the channel of the release actually discovered. Existing update preferences survive installation. Release review remains required before plugin or migration execution.

For host/API changes, prepare plugin code early, then pin the published SDK URL and lockfile
before the plugin PR’s final CI. Keep the minimum host range explicit; SDK/app/plugin version
numbers do not need to match. Coordinate publication using the
[release sequencing guidance](releases.md#coordinating-app-sdk-and-plugin-changes).
New SDK release tools require deliberate consumer pins and compatible workflow inputs;
they do not update installed plugins automatically.

### Segmented toolbar controls

Pages may provide `controls`, an array of segmented nodes, beside the search box. Each
control has `id`, `value`, optional accessible `label`, and `options` with `value`, `label`,
optional `icon` and optional `tooltip`. Tooltips appear on hover and keyboard focus.
Selection sends `field` with `{form: id, field: id, value}`; the plugin persists meaningful
preferences and returns the selected value. Controls wrap on narrow surfaces.
This additive contract requires a host/SDK containing segmented toolbar support; older
hosts ignore `controls`. Consumers must wait for the public SDK release and declare a
compatible host range before publishing a package using it.
