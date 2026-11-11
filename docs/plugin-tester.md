# Plugin Tester

ToolBelt Plugin Tester is a standalone macOS app that embeds Bun, the production host,
package manager, renderer and settings. It opens prebuilt plugin archives without an
installed ToolBelt or plugin source checkout. Its identity is
`io.github.tkarakai.toolbelt.tester`; profiles are separate from ToolBelt and ToolBelt Dev.

## Build and launch

```sh
bun install --frozen-lockfile
bunx electrobun prepare
bun scripts/build-tester.ts
```

The build stages a source copy with its own build lock and writes signed app, DMG and tarball
outputs under `artifacts-tester/`. Open the generated tester DMG and launch its app. Named
persistent profiles live at:

```text
~/Library/Application Support/ToolBelt Plugin Tester/profiles/<name>/
```

`TOOLBELT_TESTER_PROFILE` selects a name (letters, digits, underscores and dashes); the default
is `default`. Set it in the environment when launching the app's `Contents/MacOS/launcher`
for a separate test profile. Renderer preferences are profile-scoped too. The tester sets
its own config root even if an app config override is inherited. It does not self-update
or register the app's global shortcut. Plugins still run with normal user privileges.

## Open a package

1. Enter the full local `.tar.gz` path in **Built archive path**.
2. Enter the manifest publisher as `owner/repo` in **Publisher repository**.
3. Approve execution with the checkbox, then click **Open archive**.

This uses the production bounded archive validator, publisher/compatibility checks, migration,
staged startup probe and final readiness transaction. It executes no dependency installation
or plugin source build. Local SHA-256 identifies the chosen bytes; it is not authentication.
Use a fresh profile or a new plugin semantic version when rebuilding changed bytes. The
host intentionally rejects changed bytes for an already installed version.

**Watch built archive** separately approves watching the selected archive for new built
output. Build the plugin in its owning repository; only the resulting archive is watched.
The header marks watch mode and **Stop watch** ends it. Do not use production app profiles
for watch development.

## Exercise surfaces and lifecycle

The embedded main view is the production App: navigate every declared tab, search/filter/sort,
select rows, open inspectors and dialogs, and use actual keyboard shortcuts. **Simulated
popover** embeds the production compact menu-bar surface. **Opt in to native menu bar**
creates a real tester tray/popover using shared placement, highlight, Escape and blur behavior.

The width slider resizes the actual native window. Test narrow layouts, wrapped toolbar
actions, scrollable tabs, long decorated cells, dialogs and expanded tool details. Production
Settings controls palettes and light/dark/system. Use ⌘+ / ⌘− / ⌘0 for zoom and the tester's
**Reduced motion** control to disable transitions. Verify both window and quick-view assets.

Per-plugin **Restart** uses production preparation and verified activation. **Reset data**
asks for confirmation and deletes only that plugin's tester data; reopen the archive to
initialize it. Use separate named profiles for independent scenarios. The diagnostics footer
shows bounded protocol, lifecycle, stderr and event records. Settings → Plugins also exposes
the real manager with installation, removal, update and recovery controls.

Use scratch files, fake feeds/providers, temporary homes and disposable processes. The tester
separates managed data, not filesystem/process/network authority. Never test mutating process,
software-update or shell-install actions against the user's actual jobs/apps/dotfiles.

## Automation

Set `TOOLBELT_DEBUG_PORT` for a local debug server. GET `/state` reports runtime state; POST
`/eval` evaluates an expression in the window (or `?target=popover`). POST `/control` accepts
JSON with an `operation` and its parameters. Operations include archive `load`, `watch`,
`unwatch`, `viewport`, `diagnostics`, plugin `reset`, `nativePopover` and `activateMain`.
`load`/`watch` require explicit `approved: true` and the selected archive/repository. These
controls operate only the tester instance; use a distinct port/profile and clean up owned
processes after automation. `src/bun/tester.ts` is the authoritative request implementation.

## Distribution

`bun scripts/build-tester.ts` builds local artifacts only. The root app version also versions
the tester. The app release command publishes its DMG/tarball alongside the app and SDK;
separate tester publication is a manual `--latest=false` operation. Follow the exact
[release runbook](releases.md#dedicated-tester-release) for tags, draft verification, publication
and retries. CI does not publish or build the tester automatically.
