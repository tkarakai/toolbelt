# Toolbelt architecture v2 — implementation source of truth

Status: approved direction; detailed implementation contract. Planning only in this commit.
Date: 2026-11-10.
Work branch in every participating repository: **feat/architecture2**.
Do not merge this work to main, enable auto-merge, publish stable releases, install over
the user's working app, or delete the legacy Running repository. Final integration and
main merges require a later explicit user decision.

## 1. Product intent and authoritative decisions

Preserve the working Toolbelt experience while correcting ownership and distribution.
Toolbelt is a generic host. Independently developed plugins publish ready-to-run packages
on their own GitHub releases. Users choose which repositories/plugins to install; there
is no central catalog or Toolbelt-maintainer allowlist. The GitHub repository is the
distribution source, not an implicit assertion of trust.

User-approved requirements:

- Each plugin owns its implementation, dependencies, UI definitions and packaged assets.
- Toolbelt never builds plugin source, installs plugin dependencies, or maintains vendored
  plugin implementation copies. Consuming an ignored downloaded package is not vendoring.
- Dependencies and execution are isolated per plugin process. A runtime security sandbox
  is explicitly absent and accepted; do not represent this as malicious-code containment.
- Users can install, load, disable, update and remove plugins at runtime without restarting
  Toolbelt. Incompatible/broken plugins must not take down the host or other plugins.
- Plugin releases are GitHub release assets. No custom catalog service is required.
- A plugin package can carry opaque payloads (TUI, helpers, installers, other files).
  Toolbelt copies/preserves these and exposes paths; the plugin decides their purpose.
- Plugins own data schemas/migrations. Toolbelt orchestrates migration lifecycle and recovery.
- Toolbelt releases a standalone visual plugin tester using its real renderer and host.
  It covers main-window AND menu-bar/quick-view behavior, independent of an installed Toolbelt.
- Toolbelt ships a single removable SDK demonstrator covering every SDK capability.
  Processes and Upkeep are user-installed packages, not hidden built-ins.
- Plugin behavior is tested in plugin repos; Toolbelt tests its generic SDK/runtime,
  installation and lifecycle contracts, without duplicating plugin business logic.
- All v2 work remains on long-lived feat/architecture2 branches until explicitly approved
  for final integration. Preserve the current main/official release workflow for daily use.

Operational defaults for the first implementation: one host-provided Bun runtime;
declarative host-rendered UI (no arbitrary plugin React/JS injected into the webview);
stable-channel update checks and user-confirmed upgrades; managed-directory migrations
with recoverable snapshots. These defaults limit scope without removing runtime installation.

This document supersedes the older .lavish/plugin-delivery-plan.html proposal and any
VENDORED.md/README passages that describe manual source refresh as the future architecture.
Existing instructions still govern the current v1 implementation until it is replaced.

## 2. Repositories, baselines and scope

| Repository | Ownership in v2 | Starting point |
| --- | --- | --- |
| tkarakai/toolbelt | Host app, renderer, SDK/protocol, package/lifecycle manager, tester, generic tests | 229bd64b20599f621589e03e17d36ee72c604ff5 |
| tkarakai/toolbelt-ps | Entire Processes plugin, engine, TUI, its CLI artifacts/tests | 1a7fe18ef135d9bb3503177babeb923d9544baae (bootstrap only) |
| tkarakai/toolbelt-upkeep | Entire Upkeep plugin, providers, update engine, tests/packages | 5ee37e24b766f690aed005ae2f3863ad2b86eaf4 (origin/feat/upkeep) |

Upkeep origin/main was bootstrap-only at planning time. Do NOT merge its old PR as a
shortcut to this migration. Its old implementation is a starting point, not current parity.
Toolbelt's pinned baseline is the authoritative source for CURRENT shipped plugin behavior.
Inventory later fixes on all branches/remotes before extraction; never overwrite concurrent
work or assume the separate plugin repositories already contain current behavior.

Already merged on Toolbelt main:
- PR #12, e8c4b32: Sparkle bundle-version ordering, visible build identity and build-only notes.
- PR #13, f91734e: Upkeep table action shortcuts and SDK action-key type.
- PR #14, 229bd64: GUI-hosted agent-harness detection. Preserve this too.

The legacy repository is tkarakai/running (sometimes called runner in conversation).
No new v2 branch/work is required there. Transfer the COMPLETE currently patched engine/TUI
from Toolbelt into toolbelt-ps as owned code, preserve authorship/provenance, and eliminate
all build/runtime/source-refresh dependencies on running. Do not rewrite that engine.
Preserve existing executable names, shell hook and data locations during extraction.

A separate tkarakai/toolbelt-sdk-demo repository is the planned home for the demonstrator,
so the host has no maintained real-plugin implementation. Provision that repository during
implementation, with the same security/PR policies and feat/architecture2 branch. Do not
create another repo for the SDK or tester by default: both belong in Toolbelt and have
explicit versioned release outputs. Host-only malicious/malformed test fixtures are allowed
inside Toolbelt; they are contract tests, not copies of Processes/Upkeep.

## 3. Runtime boundary and dependency ownership

Each enabled plugin runs as its own Bun child process with its own cwd/package root,
environment context and writable data directory. Communicate with the host over framed/
bounded JSON-lines stdin/stdout; stderr is diagnostic output. Toolbelt renders UI trees.

Authors resolve/freeze dependencies in their own CI and bundle ordinary JS dependencies.
Unbundleable modules/native libraries must ship fully inside the plugin package. No
Toolbelt-side dependency resolution/install, shared node_modules, NODE_PATH injection,
or fallback to another plugin's dependency directory. Reject incomplete packages clearly.
Test artifacts without source checkouts, ambient dependency directories or developer paths.
Some dynamically loaded modules need explicit packaging rather than automatic bundling.

Toolbelt provides a supported Bun version; plugin declares a compatible range. Do not
manage arbitrary Bun versions per plugin in the initial scope. Helpers may be packaged,
including target-specific binaries, but a plugin requiring a different primary runtime
must be rejected until a deliberate extension to this contract.

The isolated process limits module-state/dependency/crash coupling. It does NOT prevent
filesystem access, process control, network use, global-machine resource conflicts or
malicious behavior. Do not add a pretend permission system. Installation clearly explains
publisher identity and user-level execution before the first plugin/migration code runs.
Do not pass host credentials/secrets to plugin processes unnecessarily.

Host lifecycle owns termination of plugin-owned descendants. Killing/unloading Processes
must not kill the USER jobs it observes or launched as independent terminal sessions.

## 4. Public SDK and compatibility contract

Publish a versioned SDK package from the Toolbelt repository. Plugin authors do not need
a Toolbelt source checkout. Include types, runtime schemas, lifecycle helpers, asset/path
APIs, packaging validator, fake-host/contract testing utilities and documented examples.
Publish a pinned package asset usable with Bun; npm distribution can be additive, not a
requirement for plugin delivery. Do not vendor SDK source into each plugin repository.

Separate:
1. Package format version.
2. Transport/protocol major version and negotiated capabilities.
3. Plugin semantic version.
4. SDK build version (diagnostic, NOT an exact equality requirement).
5. Minimum host/host API support and Bun/platform requirements.

New host versions should continue accepting compatible older SDKs. The current protocol
number 0 is too coarse: record required capabilities for features such as Action.key,
terminal/conversation, assets and migration lifecycle. Unknown required capabilities reject
activation; unknown optional capabilities must have documented fallback behavior.

Validate metadata before executing plugin code. Then perform a bounded handshake checking
actual protocol/capabilities and wait for explicit ready. No unvalidated tree is rendered.
Validate every subsequent message/node, depth/size, asset reference and action payload.
Bound line/tree/log sizes and render rates; contain crashes/restart storms with backoff
and a clear per-plugin error UI. Disabled/quarantined plugins do not auto-restart forever.
Plugin errors cannot destabilize the sidebar, host settings, plugin manager or other tools.

No plugin browser JavaScript/HTML/React components in this version. UI is declarative and
uses the real host component library. Code that computes UI trees runs inside the plugin.

## 5. Package and GitHub release contract

A release contains a prebuilt .tar.gz plus a small release descriptor and SHA-256 metadata.
No runtime package-install scripts; no install/build commands supplied by the publisher are
executed by the host download/extraction step. Migration is a SEPARATE explicit lifecycle.

Example archive root (no extra enclosing folder):
- toolbelt.json — runtime manifest.
- index.js — default bundled entrypoint; manifest can choose a safe relative entry.
- assets/ — icons/images/fonts/other display assets used by this plugin.
- payload/ — opaque files, TUI, helpers and completely local dependency trees.
- LICENSE / NOTICE — provenance and redistribution information.
- sources/ and source maps — optional original source/debugging material, never host build input.

Required manifest semantics: format version; stable id/name/version/repo; entrypoint;
protocol/host/Bun/platform compatibility; required/optional capabilities; screens, tab
shortcuts, quick view; asset mapping; optional CLI declarations; data-schema/migration
declarations. Exact schema names should be finalized once in SDK code and documented.
Every example schema/command here is a contract proposal, not an existing API.

Use immutable release assets where supported; publish draft assets completely, verify,
then publish. Descriptor binds id/version/source commit/target archive and its SHA-256.
Target selection must be explicit: portable JS packages may declare portability; packages
with native helpers declare each supported OS/CPU and minimum OS requirements.
Do not choose "first archive in release"; reject ambiguous/mismatched targets.

Accept user input as GitHub repository URL or owner/repo, optionally a specific release.
Show repo, resolved plugin id/version/channel, compatibility and execution warning before
confirmation. First milestone may support public GitHub repos only; explain private-repo
authentication as unsupported rather than collecting/embedding tokens or leaking them.

Persist the user-approved source binding (repo + plugin id), selected channel, installed
version, release/asset identity and approved hash. Prevent collisions or silent replacement
by an unrelated repo claiming the same id. Changing publisher/source requires explicit
user confirmation; do not auto-follow a repository transfer into a new trust identity.

Cache archives by hash; download to staging, enforce byte limits/timeouts/cancellation,
verify hash before extraction. Reject absolute/traversal paths, escaping links, duplicate
entries, decompression bombs, missing files and mismatched metadata. Reject path escapes
in entrypoint, migration, CLI and asset declarations too. Keep package directories immutable.

Checksums prove byte identity, not publisher trust. Compare descriptor and release digest
when available. Persist approved bytes; never silently reuse an overwritten asset under an
already installed version. Unexpected changed bytes must produce a reviewable error.

## 6. Storage, assets and opaque payloads

Runtime packages belong OUTSIDE the signed Toolbelt.app, e.g. under the selected
TOOLBELT_CONFIG_DIR:
- plugins/registry.json — source bindings, installed versions and enabled state.
- plugins/packages/<id>/<version>-<hash>/ — immutable extracted package.
- plugins/staging/ — incomplete installs; never discovered as active plugins.
- plugins/transactions/ — durable transaction journals/recovery state.
- data/<id>/ — current plugin-managed data; keep existing identities/paths where possible.
- backups/<id>/<transaction>/ — recoverable upgrade snapshots.
- cache/packages/<sha256> — verified archives.

Design an atomic registry/active-version pointer update; concurrent install/update/remove
for the same id are serialized. Recover transactions after host/process/system failure.
Do not accidentally load old v1 manually installed plugins through loose directory scanning;
legacy import must be explicit and validated. Dev overrides cannot bypass release checks.

SDK supplies packageRoot, dataDir, payload-relative resolution and asset references.
Namespaced assets identify plugin AND package version so old files cannot be served after
an upgrade or collide across plugins. Constrain references to declared package assets,
validate supported MIME/content, sanitize or reject unsafe SVG and never execute asset JS.
Preserve built-in lucide/app/file icons, while supporting the plugin's own additional icons.

Toolbelt neither interprets nor runs arbitrary opaque payload contents during installation.
The plugin may expose user actions to install its TUI or configure a shell hook. Existing
Processes confirmations/undo/temp-home safety must survive. Installed launchers must use a
stable active-version resolver (not a soon-deleted version path); retain packages that
running plugin/helper processes still use. Detect declared CLI-name collisions.
Removing a plugin must explain any separate machine-level installation; offer its explicit
cleanup while code is still available, never silently delete user dotfiles or unknown files.

## 7. Lifecycle, migration and recovery

Provide generic user-facing states: not installed, downloading, verifying, installed/
disabled, starting, migrating, ready, stopping, updating, failed/quarantined, removing.
Main window and menu-bar list react to runtime installation/removal immediately.
Disabling retains code/data but removes active UI/processes. Removing uninstalls code;
retaining data is the default and data deletion requires a separate explicit user choice.

All execution (including migration) requires installation trust approval. Updates are
checked automatically on a modest documented schedule, with manual Check now. Default is
notify-only/user-initiated upgrade. Pre-releases are opt-in for normal users; explicit local
packages/prerelease feeds are supported for development. No unattended upgrades initially.

Upgrade transaction:
1. Resolve, download, verify and extract candidate while old plugin remains active.
2. Validate static compatibility; incompatible candidates leave old version running.
3. Ask plugin to prepare for shutdown; block/defer if an operation cannot safely stop.
   Never interrupt an actual software update simply because a new Upkeep package arrived.
4. Stop old plugin and owned helpers; freeze writes to managed data; snapshot it.
5. Migrate a staged COPY of managed data using a declared versioned migration entrypoint.
   Plugin implements schema changes; host supplies from/to versions, source/target schema,
   transaction ID, paths, progress/logging and a bounded completion protocol.
6. Start candidate on staged data and await handshake + explicit ready. Do not publish its
   screens as healthy while migration/startup is incomplete.
7. Promote data/package/registry using a journaled recoverable transaction. Launch candidate
   with the final managed-data path as needed; commit only after successful final readiness.
8. On failure restore previous package/data selection and restart old version; show logs.
   Interrupted/crashed transactions recover deterministically at next launch.

Initial install uses the same lifecycle for data initialization. Unchanged schema is an
explicit no-op. Migrations must be retry-safe/idempotent within their transaction.
Cancellation is permitted only at declared safe boundaries; a timeout/crash is a failed
transaction, not proof external actions were undone.

Plugin owns its schema AND reports migration status. Host understands no application data.
Transactional rollback covers the managed directory only. Upgrades that mutate external
databases/files/services require explicit plugin-managed recovery and user consent; never
promise general rollback. After a successful upgrade, code-only downgrade is allowed only
when the old plugin supports the current schema; otherwise restore the matching snapshot
with a clear warning about data lost since that snapshot. Keep bounded documented retention.

Processes/Upkeep payload versions and TUI handoff must remain consistent with the active
plugin version. Do not silently overwrite separately installed commands on plugin update.

## 8. SDK demonstrator and visual tester

Ship ONE first-party demonstrator as a prebuilt package in Toolbelt's app release.
It must be removable/disableable; persist that choice across app upgrades and do not silently
reinstall it on every launch. On a fresh profile Processes and Upkeep are absent until the
user installs them. Toolbelt has no hard-coded business logic for either plugin.

The demonstrator covers every public SDK node, field, action, icon/asset pathway,
keyboard shortcut pattern, table feature, menu-bar contribution, quick view, dialog,
progress/log output, lifecycle state and supported optional capability. Maintain an
SDK-to-scenario coverage inventory so new features cannot omit conformance coverage.
A bundled seed archive can be materialized through the SAME validated installer on first
run. Existing installed plugin versions are never downgraded by an app's bundled seed.

Release a separate **Toolbelt Plugin Tester.app** from Toolbelt's repo. Reuse the production
renderer, host, lifecycle/package validator and settings components; do not clone a second
UI implementation. Give the tester its own bundle identity, config root, cache/data and
shortcuts so it can run beside both official and dev Toolbelt without interference.

Tester requirements:
- Open a local built archive; optionally watch an explicitly selected plugin development
  output directory, without changing installed Toolbelt registrations or requiring a release.
- Enumerate every screen and quick view and exercise real navigation/actions.
- Main-window mode plus simulated menu-bar/popover mode inside the window; an explicit
  opt-in real menu-bar mode for native positioning/highlight/blur behavior.
- Theme/light/dark, resizing/narrow layouts, zoom, reduced motion, mouse and keyboard.
- Protocol inspector, logs, lifecycle/migration diagnostics, restart/reset and errors.
- Isolated persistent test profiles; fixture/scenario selection; screenshots/UI automation.
- Test actual release archives with identical validation. Fast dev overrides must be
  visibly marked and never accepted by production builds/installs accidentally.

Disposable fixtures are DATA/FAKE RESOURCES, not the tester application. Use scratch
files, throwaway git clones, fake feeds, fake processes and temporary homes. They can run
inside the tester and headless CI to avoid touching real apps/processes/dotfiles.
The tester can execute fully privileged plugin code; isolated data is not a security sandbox.

## 9. Build, test and release ownership

Plugin repos:
- Frozen dependency installation, pinned Bun/tool versions and typechecking.
- Behavior/unit tests; SDK contract/lifecycle checks; migration/rollback tests.
- Build/package; unpack in clean environment without repo/node_modules access.
- Launch with supported Bun versions; handshake/screens/quick view/asset/helper/CLI tests.
- Visual and keyboard tests through the released tester, with screenshots of real rendering.
- Tag/release ready-to-run archives and metadata; independently version plugin/CLI artifacts.

Toolbelt repo:
- Generic renderer, schema, negotiation, plugin manager, installer, asset routing, lifecycle,
  transaction/crash recovery and tester tests. Deliberately broken fixtures are required.
- SDK demonstrator/conformance coverage for every public capability.
- App signing/packaging/updater and clean-profile runtime plugin install/remove tests.
- No importing Processes/Upkeep source or re-running their business logic test suites.
  A bounded migration parity exercise against real packages is necessary during extraction;
  it is not permanent duplicate plugin testing.

SDK/runtime changes: release matching SDK, host support and tester compatibility. A plugin
may require a new capability, but old hosts must reject it BEFORE disrupting an installed
compatible version. Host upgrades must check installed-plugin compatibility and expose a
clear resolution path; do not silently strand user plugins or stop the whole app.

Terminal archives are built/tested/published by toolbelt-ps. Toolbelt must stop compiling
the TUI or reading its source package.json. Preserve existing download behavior during
migration using verified prebuilt artifacts if needed; do not rename commands as part of
this change. Final stable release/download naming is an explicit later integration decision.

For architecture2 evaluation use local artifacts or explicit prereleases/dev feeds.
Do not publish stable tags or move the public latest/stable app updater feed. Development
app/tester must not open or migrate the user's official plugin data directories.

## 10. Ordered implementation plan and exit gates

A. Inventory and freeze a parity baseline. Record all bundled patches, later fixes and
   process/data/CLI/UI contracts. Preserve code history where practical.
B. Publish draft SDK/package/lifecycle schemas and implement generic validation/tests.
   Define package size/message/time limits in code with documented defaults.
C. Extract complete Processes and Upkeep implementation/tests to their repositories.
   No feature removals or behavior rewrites. Eliminate legacy running dependency.
D. Produce clean runnable plugin archives; validate in headless fake host.
E. Build standalone tester from shared production renderer/host; exercise all plugins.
F. Implement user plugin manager, GitHub resolver, runtime activation/deactivation,
   asset routing, staged upgrades, migration/recovery and removal UI.
G. Implement/publish removable SDK demo; change app assembly to consume only its prebuilt
   artifact. Remove maintained source copies and plugin-specific compilation from Toolbelt.
H. Exercise full parity and failure matrix; prepare cross-repo handoff/review.
I. STOP. Do not merge main, release stable or replace official installation without approval.

A-C may iterate with B; do not remove old source/build paths before their replacement
packages have demonstrated parity. Work across repository feature branches; no main merges
are needed to coordinate. Pin evaluation packages by exact commit/version/hash.

Mandatory exit checks:
- All current Processes/Kept/Settings/Peek behavior, grouping/search/filters/agent detection,
  keyboard actions, terminal jumps, notes/env editor, TUI install/undo and shell hook work.
- All Upkeep screens, countdown/scheduling, dialogs, queue/cancel, notifications/audit,
  providers, auth boundaries, bulk-update safety, Sparkle build versions/notes and keys work.
- Existing plugin/screen IDs and state survive an explicit DEV import of copied v1 data.
  Never automatically migrate the actual working v1 installation during development.
- Installing/removing/enabling/upgrading a plugin updates window/popover with no app restart.
- Conflicting dependency versions coexist. Missing external dependency, unsupported Bun,
  malformed protocol/tree, unknown required capability and crashing/flooding plugins fail
  visibly without affecting the host or other plugins.
- Bad hash/archive/path traversal/duplicate ID/wrong target/offline download leave current
  installation intact. Canceled/failed first install leaves no active half-installation.
- Migration failure, timeout, host crash and power-loss-style interruption recover. Running
  Upkeep work can defer upgrade. Retained data and schema-aware downgrade are demonstrated.
- User-removed demo stays removed after app upgrade. Empty-plugin host remains usable.
- Clean builds and plugin executions succeed with legacy Running repo unavailable.
- SDK, both plugin packages, demo, tester and app are usable without sibling source checkouts.
- No runtime code is imported from plugin source into host, no vendoring refresh workflow,
  no plugin code/scripts executed as part of app build/package extraction.
- Real app menu bar, quick views, shortcut handling, themes/accessibility/motion, app updater
  and release artifacts are verified using disposable test installations.
- All test/build results and remaining limitations recorded before requesting final merge.

## 11. Handoff rules for the implementing agent

Read this file and the role handoff in each plugin repo first. Then inspect current
AGENTS.md, git status, branch tips and remotes in all repos. If another agent has edits,
stop before touching its checkout. Never use the no-mistakes tool/plugin/pipeline.

This planning task intentionally changes only documentation and branch references.
Do not infer an instruction to implement from this document: implementation is assigned
separately by the user. Once assigned, commit/push meaningful milestones on feat/architecture2.
Draft PRs may be used for review if requested; never merge or enable auto-merge unasked.
Use native tools directly for review, validation and Git/CI work.

Record evidence and deviations in docs/architecture2-progress.md on Toolbelt's feature
branch. Link exact plugin/demo/tester/SDK candidate versions and hashes. Every deviation
from user-approved ownership/runtime-installation/no-vendoring requirements needs a user
decision; do not turn a convenient spike into the final architecture again.

