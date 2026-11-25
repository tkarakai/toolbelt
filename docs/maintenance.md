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
build a disposable source copy with separate config/ports.

## Testing remote access

The browser preview simulates Tailscale: it never runs the real CLI. Its pretend remote server
listens on `REMOTE_PORT` (default 47389, away from the app's 47380/47381), and
`/remote?scenario=ok|missing|stopped|nohttps|conflict` chooses what the pretend CLI reports.
To see devices, connect WebSockets to the pretend server's `/rpc` with
`Tailscale-User-Login: owner@example.com` and an `X-Forwarded-For` tailnet IP (100.64.0.2 and
100.64.0.3 are known peers). Check phone layouts with `chrome-devtools-axi emulate --viewport
"390x844x3,mobile,touch"` (also 375×667): no popover, no key hints, the **Show tools** sheet
and its edge swipe, the bottom tab bar, stacked toolbars, details and dialogs as bottom sheets,
no horizontal overflow or squeezed text, the connection banner when the server stops. Check
every plugin screen and Settings tab with real data (a copy of a Dev profile in a temporary
`TOOLBELT_CONFIG_DIR`), and check the wide window and the popover haven't changed. Gestures can
be driven from `chrome-devtools-axi eval` with synthetic `PointerEvent`s (`pointerType:
"touch"`) and `TouchEvent`s. Add `--user-agent` with an iPhone or
Android string and open `/?install` to see the install card; desktop Chrome fires
`beforeinstallprompt` on localhost, so Android shows the button (don't press it in the
automation browser).

For a native check, run ToolBelt Dev with a temporary `TOOLBELT_CONFIG_DIR` whose
`settings.json` has `"remote": {"enabled": true, "port": <free port>}` and a distinct debug port.
`/state` reports `remote`; requests to the port need the owner's login header. Never create,
change or remove Serve rules on a real Tailscale configuration in tests; `test/` uses fake
runners, and only the owner creates rules, from the Remote Access tab.

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
| Development mode | Development tests; preview with `TOOLBELT_DEVELOPMENT_PROFILE`; isolated native enter/exit relaunch, refusal, local load/watch/reset |
| Remote access | Tailscale, remote-server, remote-access and remote-client tests; preview Tailscale scenarios and phone emulation; isolated native server and owner-check probe |
| Agent interface | Agents unit tests, agent scenarios over MCP and the CLI, MCP conformance; optional MCP Inspector smoke check (`TOOLBELT_MCP_INSPECTOR=1`). Serializer or tool changes: add or update a scenario ([docs/agents.md](agents.md#testing)) |
| App updater/packaging | Updater unit tests, clean app builds, mounted DMG identity/version/signature and disposable updater rehearsal |

Plugin behavior belongs in plugin repositories. Host tests use generic valid/broken fixtures;
consume real released archives for integration without maintaining duplicate plugin source.
Use fake software providers and scratch commands for mutating actions.

## Debugging

Host GitHub traffic is retained in `cache/github-history.json` within the profile
(normally `~/Library/Application Support/Toolbelt`). One record is persisted before
each release metadata request, asset download and redirect hop, then updated when response
headers arrive or a network error occurs. Records include a UUID, local start/response epoch
milliseconds, process ID, trigger, sanitized endpoint, conditional/authenticated flags,
HTTP status, and an allowlist of GitHub date/request ID/quota/retry headers. Bodies,
credentials and query strings are excluded; custom feed paths remain visible. Failed
logging never blocks checks. Missing responses remain visible after restart.

History keeps every call from the rolling last 24 hours, pruning on load, write and read,
plus once per minute while the profile client is running. There is no older rotation.
The app and plugin recovery warnings share the same history. The quota timeline shows
remaining quota samples, one table row per HTTP call, response details, and changes in
GitHub used count beside ToolBelt calls started between comparable responses. Comparisons
require the same origin, authentication mode, resource, limit and reset window. Shared
lookups and cooldown refusals make no call and add no row. Headers absent from downloads
or failures remain unknown, never zero. Older rows also expire in the renderer without
network requests. The first version starts a new history; old checks cannot be reconstructed.

GitHub anonymous quota belongs to the public IP. A larger usage rise than recorded calls
can suggest outside traffic, but overlapping requests, IP changes and regional routing
prevent exact attribution. Plugin-owned requests and other applications are outside this
host history. Diagnostics send no additional GitHub requests.

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
`/state` reports the mode and plugin profile; POST `/development` drives plugin development
mode (see [plugin-development.md](plugin-development.md#automation)).

Protocol stdout must remain JSON-lines; diagnostics use stderr. Inspect manager activity,
errors and development-mode diagnostics before restarting. Never edit active package files: integrity
verification rejects bytes that differ from the approved archive. Use a new plugin version
or a fresh isolated development profile instead of weakening this check.

SDK release-only CI and candidate builds use `bun run sdk:check` for the SDK runtime and
its bundled release-tool dependencies. Changes outside the exact SDK release metadata
allowlist keep full app CI. See [releases.md](releases.md#product-specific-validation).

CI runs on Linux except where macOS is required. The Linux `Test` job validates the release
request, selects the scope, runs the SDK checks or the SDK typecheck and every test but
`test/hotkey.test.ts`, and packages the SDK. The `macOS app` job runs only the macOS-bound
work: the Electrobun devkit and app typecheck, the Carbon hotkey tests, the app build with its
signature check and the disk image; it is skipped for SDK release-only diffs. Keep new tests
platform-neutral (fake `hdiutil`, injected executables) so they run on Linux; tests that load
macOS frameworks belong in the macOS job's explicit list.

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

[releases.md](releases.md) is the authoritative app and SDK runbook. It identifies
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

App disk-image creation and verification mounts retry only `Resource busy` and
`Resource temporarily unavailable` errors, with five attempts and 1/2/4/8-second delays.
Other errors fail immediately; exhausted retries still require inspecting and retrying the release.
