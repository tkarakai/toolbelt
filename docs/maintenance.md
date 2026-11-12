# Maintenance

Start with [architecture.md](architecture.md) for ownership and invariants and
[plugins.md](plugins.md) for public author/update contracts. Keep reference documentation
aligned with current code. Temporary plans, review screenshots and execution logs are not
maintained repository documentation.

## Local development and checks

Use macOS and Bun 1.4.4, matching CI:

```sh
bun install --frozen-lockfile
bunx electrobun prepare
bun run typecheck
bun test
bun run views
```

`bun run dev` starts ToolBelt Dev with its own identity, profile, amber icon and shortcut
⌃⌥⇧⌘T. The official shortcut defaults to ⌃⌥⇧T. `TOOLBELT_CONFIG_DIR` overrides the profile.
`bun run preview` builds the seed/UI and serves the real host/manager at localhost:5174;
`PORT` selects another port. It uses an independent preview profile. `/#popover` chooses
the popover surface on page load, so reload after changing the hash.

`bun run build` creates the official-identity app and update bundle under `build.noindex/`
and `artifacts/`. `bun run dmg` creates a verified disk image from the real update-bundle
app. `bun scripts/run-evaluation.ts` copies a built app outside the checkout and launches
with temporary profile, renderer preferences, TUI installation home and distinct shortcut.
Generated apps are unregistered from Launch Services after builds.

Dev and app builds share a lock. If an existing dev session is running, leave it alone and
build a disposable source copy with separate config/ports. Tester builds stage their own
source tree and emit into `artifacts-tester/`, separate from app artifact cleanup.

## Previewing app updates

In ToolBelt Dev, open Settings → About → Updates and use **Development preview**.
Choose **Check failed / manual guide** to preview the GitHub recovery card and DMG instructions, **Check failed / cached update** for previously discovered availability, or **No update / manual link** for the always-available fallback. Retrying a simulated check preserves its selected scenario. Choose Available to review the confirmation, then select download, verification,
installation, restart or failure stages inside the dialog. Off restores live state.
The browser preview accepts `/update?recovery=quota`, `throttled`, `missing`, `network` or
`service` to exercise recovery cards; quota/throttling simulate a twelve-minute cooldown.
This renderer-only simulation intercepts update actions and never downloads, replaces
or restarts an app. The browser preview also has its existing simulated update flow.

## Tests by boundary

| Change | Checks |
| --- | --- |
| Renderer/layout/theme | Renderer-pure, validation and theme tests; real wide/narrow browser and native screens, dialogs, inspector and tool expansion |
| Manifest/protocol/capabilities | Package, validation, SDK/fake-host and malformed/flood fixtures; update SDK Explorer coverage |
| Installer/lifecycle/data | Packages, activation-integrity, owned-process and power-recovery tests; real package install/prepare/probe/restore/remove with isolated data |
| Assets | Asset-path/content validation tests and rendered icons/images on both surfaces |
| Manager | Real service/RPC/UI review/install, channel/check/cancel/cleanup/remove/recovery and reactive state; backend validation remains authoritative |
| App updater/packaging | Updater unit tests, clean app/tester builds, mounted DMG identity/version/signature and disposable updater rehearsal |

Plugin behavior belongs in plugin repositories. Host tests use generic valid/broken fixtures;
consume real released archives for integration without maintaining duplicate plugin source.
Use fake software providers and scratch commands for mutating actions.

## Debugging

For a disposable native run:

```sh
TOOLBELT_CONFIG_DIR=/tmp/toolbelt-debug-profile TOOLBELT_DEBUG_PORT=47811 bun run dev
curl http://127.0.0.1:47811/state
curl -X POST 'http://127.0.0.1:47811/eval?target=window' -d 'document.title'
```

App controls include `/popover`, `/hide`, `/window?plugin=<id>&screen=<id>` and `/close`.
The debug channel is local and enabled for development, or stable runs with an explicit
update feed/debug setting. `window.__tbEvent(plugin, surface, name, payload)` sends plugin
events; `window.__tbPerf` records render timing. Hidden windows are throttled by WebKit.
The tester has its own `/state`, POST `/eval` and POST `/control` when a debug port is set.
See [plugin-tester.md](plugin-tester.md).

Protocol stdout must remain JSON-lines; diagnostics use stderr. Inspect manager activity,
errors and tester diagnostics before restarting. Never edit active package files: integrity
verification rejects bytes that differ from the approved archive. Use a new plugin version
or a fresh isolated development profile instead of weakening this check.

SDK release-only CI and candidate builds use `bun run sdk:check` for the SDK runtime and
its bundled release-tool dependencies. Changes outside the exact SDK release metadata
allowlist keep full app CI. See [releases.md](releases.md#product-specific-validation).

## Maintaining SDK, renderer and demo

`src/shared/protocol.ts` defines public nodes/events. `src/shared/package.ts` defines package
metadata, capabilities and limits; `validation.ts` implements runtime checks. Keep all three,
the React renderer, SDK exports and tests consistent. Preserve compatible older SDKs; negotiate
optional capabilities through `Context.capabilities` and increment protocol major only for
an incompatible transport contract. The SDK diagnostic version is `SDK_VERSION`.

Build its distributable with `bun run sdk:package`. The archive includes TypeScript sources,
package exports, runtime validators, author package validation and fake-host utilities, and
must work without a ToolBelt checkout. Publish immutable SDK assets and pin them in plugin
repos. Run plugin contract tests and SDK Explorer coverage when changing public behavior.

The seed is an independently built archive from `toolbelt-sdk-demo`. To update it, publish
and verify the demo package in its own repo, then use `bun run seed:update --tag <tag>` to open a PR updating the exact URL/SHA-256 in
`seed.config.json`. `bun run plugins` verifies/materializes it into ignored `build-seed/`.
Never replace that step with source compilation. Verify fresh profile installation and that
removed/disabled/installed selections persist across subsequent app starts and seed versions.

## Plugin update operations

The manager checks public GitHub releases every six hours and on manual request. Stable is
the default; prereleases are explicit. The publisher/id binding, exact archive and compatibility
are reviewed before execution. Updates defer when plugin work cannot safely stop. A running
CLI helper can block version/data changes until it exits. See [plugins.md](plugins.md) for
publishing an update, migrations, immutable versions and schema-aware recovery.

Keep pending approvals leased until install/discard/expiry. Keep live helper leases and
historical packages/snapshots intact during collection. Never manually delete transaction,
backup or registry entries to unblock an upgrade. Use an isolated profile to reproduce
recovery failures and preserve the affected user's data.

For changes spanning the host and plugins, follow the brief sequencing and pinning guidance
in [releases.md](releases.md#coordinating-app-sdk-and-plugin-changes). Release-only PRs
remain separate from implementation PRs, with complete checks for the products released.

## Releases

[releases.md](releases.md) is the authoritative app, SDK and tester runbook. It identifies
which commands publish, exact prerequisites/artifacts, tag/draft/verification/publication
steps, SDK/plugin dependency ordering and failure recovery. Release commands prepare version PRs; merging a validated release PR authorizes CI publication. Local build/package commands do not publish.
Read that runbook before invoking any publication command.

## Updater rehearsal

To rehearse an app update, build old/new versions in a disposable source copy (temporary
version changes only there), copy the old signed app out of its DMG into a temporary folder,
and serve the new DMG plus a GitHub-style JSON feed using `Bun.serve`. Feed fields include
`tag_name`, asset `name`, `size`, `digest` and `browser_download_url`. Launch with
`TOOLBELT_UPDATE_FEED`, `TOOLBELT_CONFIG_DIR` and a distinct `TOOLBELT_DEBUG_PORT`/shortcut.
Check compatibility rejection before download, busy-plugin refusal, bad hash preservation,
signed swap/relaunch and retained managed data. Never use the daily installed app. Stop only
owned PIDs, detach owned mounts and remove owned Launch Services registrations afterward.

App and tester disk-image creation and verification mounts retry only `Resource busy` and
`Resource temporarily unavailable` errors, with five attempts and 1/2/4/8-second delays.
Other errors fail immediately; exhausted retries still require inspecting and retrying the release.
