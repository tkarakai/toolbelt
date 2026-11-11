# Architecture

ToolBelt is a macOS application built with Electrobun: a Bun main process and WKWebView
surfaces rendering React and shadcn/ui. It hosts independent, prebuilt plugin packages.
Each enabled plugin runs in its own Bun process; plugins send declarative UI trees over
JSON-lines and do not inject browser JavaScript, HTML or React components.

## Ownership and source map

| Area | Implementation |
| --- | --- |
| App windows, menu, tray, shortcut, RPC and app updater | `src/bun/index.ts`, `native-popover.ts`, `hotkey.ts`, `updater.ts` |
| Plugin processes, handshake, message bounds, restart and diagnostics | `src/bun/host.ts`, `owned-process.ts` |
| Package storage, verification, transactions and recovery | `src/bun/packages.ts`, `durability.ts` |
| GitHub release selection, downloads and source identity | `src/bun/plugin-github.ts` |
| Manager operations, update schedule and observable state | `src/bun/plugin-manager-service.ts` |
| Seed installation and declared image assets | `src/bun/seed.ts`, `plugin-assets.ts` |
| Protocol, manifest/capabilities and runtime validation | `src/shared/protocol.ts`, `package.ts`, `validation.ts`, `rpc.ts` |
| Public author SDK and fake-host tools | `src/sdk/`, packaged by `scripts/build-sdk.ts` |
| Main window, popover, manager and renderer | `src/ui/App.tsx`, `Popover.tsx`, `PluginManager.tsx`, `renderer/` |
| Standalone visual tester | `src/bun/tester.ts`, `tester-runtime.ts`, `src/ui/Tester.tsx`, `scripts/build-tester.ts` |

Processes, Upkeep and SDK Explorer own their implementation, dependencies, UI definitions,
assets, data schemas and behavior tests in their respective repositories. The host has no
plugin business logic. App assembly downloads a hash-pinned, prebuilt SDK Explorer archive
through `scripts/prepare-seed.ts`; it never builds plugin source or installs plugin dependencies.
Terminal distributions belong to the Processes repository.

## Package boundary

The host accepts public GitHub repositories and release assets, or explicitly selected
local archives in the tester. A release descriptor binds repository, plugin ID, semantic
version, source commit, platform asset, byte size and SHA-256. The runtime manifest declares
package format, protocol, host/Bun/platform support, capabilities, screens, schema and assets.
The package carries a bundled entrypoint and any fully local helpers or dependencies.
No publisher install/build scripts execute during download or extraction.

Format version, protocol major, plugin version, SDK diagnostic version, host version and
managed-data schema are separate contracts. Package format and protocol are currently 1.
Unknown required capabilities reject activation; optional capabilities require plugin-authored
fallbacks using the host's negotiated capability set. Compatibility is checked before the
installed plugin is disrupted. The host provides Bun; it does not install per-plugin runtimes.

Before execution, the host checks metadata, target selection, size, hashes, safe relative
paths and declared files. Extraction accepts bounded ustar gzip archives and rejects links,
traversal, duplicate entries, special files and unsupported metadata headers. Extracted bytes
are compared to the approved cached archive before activation, including enable and restart.
Source bindings prevent an unrelated repository from replacing an installed plugin ID.
Changed bytes under an already approved installed version require a different release version.
Checksums establish byte identity, not publisher trust.

## Profiles and storage

The official profile is `~/Library/Application Support/ToolBelt`. ToolBelt Dev has its own
identity and profile. `TOOLBELT_CONFIG_DIR` selects an explicit app profile. Renderer preferences
are namespaced by profile as well as surface. The tester uses its own named profiles.

| Relative path | Purpose |
| --- | --- |
| `settings.json` | Host appearance and shortcut preferences |
| `plugins/registry.json` | Source bindings, active selections, channel, enabled/removal/data state, history and update schedule |
| `plugins/packages/<id>/<version>-<hash>/` | Verified package files; plugins treat them as immutable |
| `plugins/staging/` | Incomplete package extraction; never runtime discovery |
| `plugins/candidates/` | Expiring pending-approval package leases |
| `plugins/transactions/` | Durable upgrade/deletion journals and staged data |
| `plugins/leases/<id>/` | Live helper PID leases pinning package versions |
| `data/<id>/` | Current writable managed plugin data |
| `backups/<id>/<transaction>/` | Managed-data recovery snapshots |
| `cache/packages/<sha256>` | Verified archive bytes |
| `cache/icons/` | Finder icon cache |

Production discovery uses the registry, not loose plugin-folder scanning. Source files,
sibling repositories and shared `node_modules` are not runtime dependencies. The SDK exposes
`dataDir()`, `packageRoot()`, `payload(relative)` and `asset(name)` for the package/data split.

## Transport and rendering

The host starts a detached process with package-local cwd, selected environment values and
explicit profile/package/data/lifecycle variables. It sends `hello`; the plugin replies with
its protocol/SDK/capabilities and explicit `ready`. No tree is published before readiness.
Surfaces are `screen:<id>` and optional `quick`. Visibility produces `open`/`close`; actions,
fields, search and sort produce `event`. Plugin messages include complete render trees,
badges, toasts and clipboard requests. stdout is protocol only; stderr is diagnostic output.

The host validates every message, tree and host action payload. Limits include a 4 MiB frame,
32 levels, 50,000 tree values/nodes, 120 messages and 16 MiB per second, 30 renders per second,
and 64 KiB bounded log handling. Handshake and prepare deadlines are 10 seconds; migration
completion is bounded to 60 seconds. Archive limits are 64 MiB compressed, 256 MiB expanded
and 10,000 entries. `src/shared/package.ts` is authoritative for limits.

Crashes use bounded backoff and eventually leave the plugin failed. Invalid protocol and
rendering failures are contained per plugin; host settings and other plugins remain usable.
Owned process groups receive graceful termination followed by a bounded forced stop. Parent
exit alone does not establish descendant exit. Observed jobs and independently launched
terminal sessions must not belong to a plugin-owned process group.

`Render.tsx` maps nodes into shared components. `SafeRender`/`Boundary` contain component
failures. Typing, selection, scroll, column sizes and zoom stay in the renderer for immediate
feedback; plugins receive meaningful events. Group summaries can bind to a table column key and share its cells, alignment and visibility.
`renderer/pure.ts` contains testable layout
rules. Themes use separate selection tokens and enforce AA contrast. Motion is 200 ms easing
out, with shorter exits and global reduced-motion support; continuously changing values do
not animate. Native popover positioning and lifecycle are shared by app and tester.

Plugin navigation order is a profile-scoped renderer preference shared between the sidebar and
popover through local storage events. Dragging previews placement locally and saves on drop;
new plugins append to the saved order, which also determines numbered navigation shortcuts.
The popover keeps the selected plugin's quick view open in a neighboring panel. Plugins
without a quick view show only the compact list. Native placement chooses the side with room
and fits both panels within the work area, with a slight overlap and the quick view aligned
to the selected plugin row (clamped above the work-area bottom). Hover, Up/Down, and plugin letter/number
hotkeys select. The arrow toward the quick view transfers focus to its remembered collection
and item; the opposite arrow or Escape returns to the main list. Inputs, dialogs and menus
retain their own keys. Active selections use the full selection fill; inactive selections
use an AA-checked intermediate fill, with a gentle border around the active pane. Keyboard
navigation ignores hover changes caused by layout movement under a stationary pointer.
Popover entrance animations hold their initial pose until two renderer animation frames
after showing, avoiding hidden WKWebView animation-clock advancement. The first quick view
waits 200 ms from that visible-frame start. Its window geometry is reserved before
first paint so revealing it does not move or remount the list. New quick views slide out
from the selected row; old views slide back using inert, noninteractive snapshots for 150 ms
while their live surface subscriptions close immediately. Reduced motion skips the slides.
Click/Enter on the plugin list opens the main window with the plugin's shared selection.
Enter on a quick-view collection carries its selected item ID to the main screen, where matching list/table items are selected and
scrolled into view, opening ancestor rows/groups where needed. Handoff is delivered to both
existing and newly created windows; it applies once after a matching tree arrives. Manual
navigation or input cancels a pending handoff. It does not dispatch a plugin action or infer
item identity from labels. Quick-view subscriptions close when the selected plugin changes. One profile-scoped selected item per plugin is
shared between the main and quick surfaces through local-storage events and a host message
relay (hidden native WebKit views also refresh on focus/show). Collections map
that stable ID into their own tree; an unavailable item has no visible selection there but
does not clear the other surface's selection. Explicit clears propagate to both surfaces.
Fresh plugins begin unselected; legacy main-window selections can seed the shared model.
Keyboard pane/collection focus remains independent of item selection. Command+Enter has
no popover binding or hint.
UI preferences use independent local-storage entries (with legacy aggregate reads), so main
and popover saves cannot overwrite each other's unrelated selections.

Plugin images use namespaced `asset:<id>@<version>/<name>` references resolved only through
the manifest's asset map. The host bounds image bytes, checks supported image content and
rejects unsafe SVG content. Lucide names and Finder `app:`/`file:` icons are also supported.
Assets cannot supply executable webview code.

## Installation, updates and recovery

The manager exposes observable phase, progress, errors and bounded logs. GitHub resolution
and verification happen before publisher execution approval. Approval tokens expire after
10 minutes; safe download cancellation discards incomplete work. Checks run every six hours,
are notify-only, and use the persisted stable/prerelease preference. Installation and updates
require a reviewed candidate; there are no unattended plugin upgrades.

Mutations are serialized per plugin, and registry writes merge current selections. The
upgrade sequence is:

1. Stage and verify the candidate while the old plugin remains active.
2. Ask the old plugin to prepare; refusal leaves its process and ongoing work untouched.
3. Stop owned processes, snapshot managed data and copy it to transaction staging.
4. Run the plugin's declared migration if needed; initialize fresh data independently of
   retained publisher/removal records.
5. Start the candidate against staged data in `probe` mode and await readiness. Plugin
   probe code must not schedule external work or perform external side effects.
6. Sync staged/snapshot trees, journal promotion and rename the previous/current directories
   with synced parent directories. Start final activation in `active` mode.
7. Sync final managed data, commit registry/journal, then retire temporary previous data.

Failure restores the previous selection/data and restarts it where enabled. Startup recovers
interrupted transactions; malformed journals are quarantined per transaction with diagnostics.
The durability helpers sync files/directories as well as atomic JSON; process-crash tests
exercise interruption boundaries. This is managed-directory recovery, not reversal of app
updates, external databases, dotfiles or network side effects performed by a plugin.

Disable retains code and data. Remove retains data by default, with deletion as a separate
explicit choice. Deleted data is initialized on a later install. The host retains three
historical selections/snapshots for recovery. Compatible old code can use the current schema;
incompatible recovery requires its matching snapshot and a warning about newer managed-data
loss. Recovery choices are revalidated on submission. Running helper leases pin package
versions and block managed-data/version changes; expired candidate and stale helper leases
are collected. CLI-name collisions are rejected. Cleanup navigation opens the plugin's own
screen and confirmation; the host never bypasses it by sending a destructive action.

Generic plugin runtime status types live in `src/shared/plugin-state.ts` independently
of native RPC types. This keeps the SDK release verifier typecheckable without a native devkit.

## SDK, tester and app delivery

The SDK is a versioned archive from this repository and can be consumed without a host
checkout. It includes types, lifecycle/path APIs, package/message validators, search helpers
and a fake host. The SDK Explorer lives in its own repository and exercises public features;
its bundled seed is materialized by the same installer once per profile. Removed or disabled
seed selections survive app upgrades, and a seed does not replace an installed version.

The standalone tester embeds Bun and the production host/renderer. Its local-archive approval,
profiles, diagnostics, restart/reset, viewport controls and native menu-bar mode use the same
package and runtime contracts. It does not depend on an installed ToolBelt or plugin sources.

App updates are a separate signed-DMG flow in `updater.ts`, with installed-plugin compatibility
preflight and busy-plugin preparation. The app release contains its DMG and tester DMG/tarball. The SDK has a canonical, independently versioned sdk-v release. Plugin packages and terminal distributions have independent releases. Build and
release procedures are in [releases.md](releases.md); maintenance is in
[maintenance.md](maintenance.md), and author contracts are in
[plugins.md](plugins.md).

## Release tooling

The development-only SDK release entry point and executable are built from `src/release/`.
They reuse the host archive, package, protocol and lifecycle implementation. Runtime SDK
imports and plugin bundles do not load release tooling. Repository-owned `release.config.ts`
adapters supply version/changelog changes and specialized builders; shared code creates
archives, descriptors, hashes, release requests and frozen candidates.

Preparation opens a version PR. CI validates its request; merging authorizes publication from
the actual merged source. Read-only build/native jobs produce and test a candidate, retained
with its source/hash record. A separate publisher verifies uploaded draft bytes before making
the release public. Retries reuse the same candidate, and published assets/tags are immutable.
SDK releases and prereleases leave the app Latest feed unchanged. See [releases.md](releases.md)
for commands, permissions and recovery.

## Update navigation

The popover header keeps the app shortcut beside the ToolBelt name. A neutral Updates
button summarizes available app and plugin releases after 200 ms of pointer hover.
Plugin availability dates record the first successful discovery of the current candidate;
app dates are release publication dates. Keyboard focus clears the plugin row highlight
and does not open the summary. Click or Enter opens `#/toolbelt/updates`, selecting About in Settings and revealing its Updates section. Individual plugin release controls live in Installed Tools.
Settings remembers its last tab. App and plugin update locations share an exclamation badge with the Settings navigation controls.
Settings uses the shared header tabs for Appearance, Plugins, Keyboard and About. About contains app updates and a nested, searchable Legal notice pane.
Settings tabs use ⌘A (Appearance), ⌘P (Plugins), ⌘K (Keyboard) and ⌘I (About), with icons and visible key hints. Text fields retain editing shortcuts.
Settings and plugin headers support ⌥⌘number and ⌃Tab navigation; F6 transfers focus between tabs and content.
Shared tab strips hide scrollbar chrome, reveal the active tab, and expose edge arrows when overflow exists. The strip clips controls to its shared outline; adjacent free header space remains a native window drag target.
Main-window navigation cancels pending popover dismissal and explicitly activates both the application and its target window, including first creation. Keyboard focus is assigned to the actual WKWebView in that window at navigation and initial renderer readiness; Electrobun BrowserView wrapper pointers are never passed as native responder views.
Settings sections share grouped-card and heading components across tabs, with stable scrollbar space and matching content widths. Horizontal tab strips suppress vertical overflow and overscroll.
Plugins starts with Installed Plugins and a single check-all control, followed by Install new plugin. Cards separate identity, runtime status, the installed release, the future update-channel preference and available releases. The installed and available release channels are recorded independently from that preference; legacy records may omit them. Changing preferences clears stale availability, and installing a release preserves the existing update preference. Plugin cards expose the last three timestamped activities; check errors notify through a toast. Installed release metadata distinguishes resolved tags from explicitly requested tags; legacy unknown channels are labeled. Release review failures use toasts. Release reviews move and resize within the viewport with the opposite edge anchored and label approval as Install or Update; check timestamps appear above the global check button after 200 ms.
Enable/disable and destructive removal live in a compact action menu. Checking only records availability, while Update opens the existing release approval flow. Reload uses the host’s prepare-aware restart path.
Legal includes the app Privacy Policy and nested dependency notices. License notices include publisher repository links alongside exact published license files.
Escape dismissal of the popover restores the application captured before activation; blur dismissal does not change focus.
Closing Settings restores a valid prior plugin route, otherwise a remembered installed plugin or the first installed plugin.
Appearance separates illustrated Color scheme choices from Theme palettes. Legal notices filter live and highlight matches with the shared warm amber search style; links open the package license file in the default browser.
About includes build version/source commit and dependency license acknowledgments generated from installed packages at UI build time.
Plugin source commits are retained from verified release descriptors for new installations and updates; older records may omit them. Settings controls
in both surfaces expose a Settings tooltip. Menu bar update badges use neutral contrast.

ToolBelt is the displayed marketing name; `toolbelt` remains the project/CLI name. Existing
profile directories, bundle paths and release asset names retain their compatibility spelling.

Signed distribution and evaluation bundles set both `CFBundleName` and `CFBundleDisplayName`
to ToolBelt (ToolBelt Plugin Tester for the tester). The application menu includes the native
About panel, using the bundle icon and version metadata.
