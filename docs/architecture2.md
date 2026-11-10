# Toolbelt architecture v2 — implementation contract

Status: agreed design after architecture review; documentation only. Implementation requires
an explicit, separate assignment. Date: 2026-11-10.

This document is the cross-repository source of truth for v2. It replaces earlier delivery,
storage, migration and recovery proposals in full. Existing v1 instructions describe the
current app, not the v2 target. The responsibilities and exclusions below are normative;
implementers must not add excluded platform features as implied safety requirements.

## 1. Product intent and scope

Toolbelt is a generic macOS host for independently developed plugins. Each plugin publishes
a prebuilt, ready-to-run package on its own GitHub releases. Users choose repositories to
install from. Toolbelt downloads packages, validates them, runs their main processes and
renders their declarative interfaces. Plugins own everything their code does.

The intended experience remains one application, one menu-bar icon, a main window with
plugin screens, and plugin quick views in the menu-bar popover. Installation, activation,
disabling, upgrading and removal happen without restarting Toolbelt.

The agreed boundary is:

| Toolbelt owns | Plugin authors own |
| --- | --- |
| Downloading, validating, extracting and selecting plugin packages | Implementation, dependencies and ready-to-run release artifacts |
| Starting, communicating with and stopping each directly launched plugin process | Any subprocesses, engines, TUIs, CLIs, installers and other payload behavior |
| Lifecycle requests, acknowledgments, deadlines and readable errors | Initialization, background work, graceful shutdown and optional uninstall cleanup |
| Shared declarative UI, navigation, settings and plugin manager | UI definitions and plugin business behavior |
| Providing convenient package, asset and default data paths | All data locations, formats, migrations, backups, compatibility and recovery |
| Best-effort host settings persistence and diagnostic logs | Safety of partial operations, interrupted initialization and external side effects |
| A public SDK, generic contract tests, demo and standalone tester | Plugin behavior tests, fixtures and release validation |

Operational scope: one host-provided Bun runtime; declarative host-rendered UI; public
GitHub release packages; notify-only update checks with user-initiated upgrades; no runtime
security sandbox. Processes and Upkeep become user-installed packages. The only bundled
plugin is a removable SDK demonstrator.

## 2. Repositories, parity baseline and working rules

| Repository | Ownership | Extraction baseline |
| --- | --- | --- |
| tkarakai/toolbelt | Host, renderer, SDK/protocol, package manager, shared lifecycle core, tester and generic tests | 229bd64b20599f621589e03e17d36ee72c604ff5 |
| tkarakai/toolbelt-ps | Entire Processes plugin, engine, TUI, CLI artifacts and behavior tests | 1a7fe18ef135d9bb3503177babeb923d9544baae is bootstrap only |
| tkarakai/toolbelt-upkeep | Entire Upkeep plugin, providers, update engine, packages and behavior tests | 5ee37e24b766f690aed005ae2f3863ad2b86eaf4 on origin/feat/upkeep |
| tkarakai/toolbelt-sdk-demo | SDK demonstrator implementation, scenarios, tests and prebuilt package | Provision during implementation |

Toolbelt's baseline defines shipped behavior. The separate plugin repositories are starting
points, not proof of parity. Before extraction, inventory later fixes on all branches and
remotes; preserve concurrent work. In particular, preserve Toolbelt PR #12/e8c4b32 (Sparkle
build ordering/identity/notes), #13/f91734e (Upkeep action shortcuts), and #14/229bd64
(GUI-hosted agent detection), plus later applicable fixes.

Transfer the complete patched Running engine and TUI from Toolbelt into toolbelt-ps as
owned code. Preserve authorship/provenance and existing command names, shell hooks and data
locations. Do not rewrite the engine. Eliminate all build, runtime and source-refresh
dependencies on tkarakai/running; do not delete that legacy repository.

Keep v2 implementation on **feat/architecture2** in participating repositories. Do not merge
to main, enable auto-merge, publish stable releases, move official updater feeds, replace the
user's working installation, or touch official plugin data without a later explicit user
decision. Branch publication is authorized. Read each repository's AGENTS.md and handoff,
inspect status and branch tips, and stop before touching another agent's edits. Never use
the no-mistakes tool, plugin, skill or pipeline.

The SDK and tester belong in Toolbelt; do not create separate repositories for them. Host
contract fixtures may live in Toolbelt, but maintained Processes/Upkeep implementations and
business tests may not. Consuming a downloaded prebuilt package is not source vendoring.

## 3. Execution and trust boundary

Each enabled plugin has one main Bun child process launched directly by Toolbelt. Toolbelt
chooses its package root/cwd, supplies environment context and default data path, and uses
bounded JSON-lines over stdin/stdout. Stderr is diagnostic output. Plugin code computes UI
trees; Toolbelt renders them. Ordinary stdout logging must not corrupt the protocol.

Toolbelt uses its bundled Bun executable, not an ambient Bun from PATH. Launch plugins with
`--no-install`. Plugin authors resolve/freeze dependencies in their own CI, bundle ordinary
JavaScript dependencies, and package any remaining local modules or native libraries.
There is no host dependency install, build step, shared node_modules, NODE_PATH injection
or fallback to another plugin's dependencies. A plugin requiring an unsupported Bun range,
platform or primary runtime is rejected. Packaged programs may use other runtimes on the
plugin author's responsibility; Toolbelt neither provisions nor supervises those runtimes.

Separate processes limit module-state and ordinary crash coupling. They do not restrict
filesystem access, network access, process control, CPU/memory use, credentials accessible
to the user, or other machine-level effects. Metadata, checksums and UI validation are not
a security sandbox. Malicious privileged code can still harm the machine or host.

Before first execution, installation must identify the source repository, release/version
and selected artifact and display a warning with this meaning:

> This package was downloaded from [repository]. Install it only if you trust its source.
> It runs with your user account's access and can change files, run programs or harm your
> computer. Toolbelt does not sandbox it or guarantee its safety.

Updates are also user-approved executions. Downloading and static validation never execute
publisher code. Execution starts only through the lifecycle after approval. Avoid passing
host-specific secrets through the child environment; this is hygiene, not secret isolation.

## 4. SDK, protocol and compatibility

Publish a versioned SDK package from Toolbelt, usable without a Toolbelt checkout. A pinned
GitHub package asset usable with Bun is required; npm publication is optional. Plugin repos
depend on that artifact and must not maintain vendored SDK source.

The SDK provides declarative UI types and runtime schemas, typed protocol messages,
lifecycle callback dispatch, errors/progress/logging, package/data/asset path access,
packaging validation, fake-host contract utilities and examples. Preserve existing useful
UI/search helpers. Do not add a filesystem abstraction, CRUD/query database, text store,
backup manager or migration framework in this version.

Compatibility is mechanical:

- Package format version identifies the archive/manifest contract.
- Protocol major identifies the transport/lifecycle/UI wire contract.
- Required capabilities identify additional host features the plugin needs.
- Optional capabilities have documented behavior when unavailable; the plugin uses only
  capabilities confirmed by the host, or supplies its own fallback.
- Bun version range, OS, CPU and any minimum OS version identify execution requirements.
- Plugin semantic version identifies the plugin release.
- SDK build version is diagnostic only; exact SDK-version equality is never required.

Use protocol/capabilities for host support requirements. A minimum host version is an
exception for a concrete requirement not adequately represented by those checks, not a
second routine compatibility gate. Define capability meanings once in SDK documentation;
unknown required capabilities reject startup before disrupting a compatible running plugin.

Static checks precede execution. A bounded handshake confirms the actual protocol and
capabilities before `init`; it cannot silently add requirements omitted from the manifest.
Validate every message, UI node, surface, asset reference and event envelope. Define finite
limits for line/message/tree depth and size, queues, logs and render rates, with documented
defaults and readable failures. Keep renderer exceptions local to the plugin view. Invalid
or flooding protocol output must not break host navigation, settings or other plugin views.
These bounds protect host handling of messages, not the machine against arbitrary code.

No plugin-supplied browser JavaScript, HTML or React components run in the webview. The
renderer uses the host component library. Action-specific business validation belongs to
the plugin; Toolbelt validates its public event/UI contract, not arbitrary application data.

## 5. GitHub releases and package installation

The initial implementation supports public GitHub repositories. Accept owner/repo or a
repository URL, optionally an explicitly selected published release. Private repository
authentication and other package registries are out of scope.

A plugin release has a release descriptor and one or more prebuilt `.tar.gz` archives. The
descriptor identifies plugin id, semantic version, source commit, target archive(s) and
SHA-256 checksums. It allows exact artifact selection without executing package code. A
portable JavaScript package may declare portability; native payloads declare their supported
targets. Reject ambiguous selection rather than choosing the first archive in a release.
The descriptor, archive manifest and chosen target must agree.

An archive has no extra enclosing folder. Its contents are:

- `toolbelt.json`: runtime manifest.
- Bundled entrypoint, default `index.js`, at a declared safe relative path.
- `assets/`: declared icons, images and other display assets.
- `payload/`: optional opaque files, programs, installers or local dependency trees.
- Licenses/notices, and optionally source maps or original source for debugging. Optional
  source is never host build input.

The manifest defines format, stable id/name/version, source repo, entrypoint, compatibility,
required/optional capabilities, screens/shortcuts/quick view and asset declarations. It has
no host-interpreted data schema, migration entrypoint, CLI installation or helper-supervision
declarations. Finalize exact field and descriptor filenames once in SDK schemas/examples;
these semantics are required, not a claim that the current v1 API already implements them.

The static installation phase performs the following without executing plugin code:

1. Resolve and show the repository/release/version/target and execution warning.
2. Download to temporary staging, with size/time limits and cancellation.
3. Compute SHA-256 and compare it with the release descriptor. Also compare GitHub's asset
   digest when available. A mismatch rejects the package. If GitHub provides no digest,
   state that verification used the publisher-supplied checksum. A locally computed hash
   alone is not an independently published integrity check.
4. Extract safely. Reject absolute/traversal paths, escaping links, duplicate or unsupported
   archive entries, decompression bombs and missing files. Validate manifest/entrypoint and
   asset paths and compatibility. No build/install scripts run during extraction.
5. Register the complete validated package. Startup is a subsequent lifecycle operation,
   described in section 8. Cancellation or validation failure leaves no discoverable
   half-installation.

Store the selected repository, release/asset, version, checksum and enabled state for normal
operation and diagnostics. The source URL is not a verified publisher identity. Checksums
identify downloaded bytes, not trusted authors or unchanged runtime directories. Reject a
new installation whose id is already installed; updates must use that installation's chosen
source. Changing source is an explicit user operation, never a silent id-based replacement.
Do not implement reputation, publisher certification, repository ownership/transfer tracking,
a signature infrastructure, a central catalog or a maintainer allowlist.

For normal update checks, use GitHub's latest published stable release. Prereleases are
opt-in and drafts are never install candidates. Explicit release selections remain pinned
until the user changes them. For an opt-in prerelease channel, select the newest published
compatible candidate by plugin semantic version, including prereleases. Do not silently
downgrade or replace an installed version with different bytes under the same version.

Check automatically on a modest documented schedule and offer Check now. Show available
updates; download/upgrade only after user initiation. There are no unattended upgrades.
Offline, absent-release and incompatible-candidate errors leave the current plugin alone.
Local built archives and explicit development feeds are supported for testing, clearly
identified as local/development sources rather than GitHub-verified downloads.
Opening a local archive does not require a GitHub release descriptor: compute a fingerprint,
compare a separately supplied expected checksum if present, and apply the same archive,
manifest, target and protocol checks. Do not label the computed fingerprint as independent
verification. This explicit local-input mode does not relax the GitHub release contract.

## 6. Paths, assets and complete plugin data ownership

Toolbelt's writable files live outside the signed application bundle, under the selected
`TOOLBELT_CONFIG_DIR`. A simple layout is:

| Path | Purpose and owner |
| --- | --- |
| `plugins/registry.json` | Best-effort host settings: installations, selected packages, sources and enabled state |
| `plugins/packages/<id>/<version>-<hash>/` | Host-installed, disposable package directory |
| `plugins/staging/` | Incomplete downloads/extractions; never scanned as active plugins |
| `data/<id>/` | Convenient persistent default directory; all contents are plugin-owned |
| `logs/host.log` | Bounded host diagnostics, including lifecycle failures and captured plugin diagnostics |

Other caches are implementation conveniences, not a required transactional storage system.
Use safe directory identifiers and host-recorded paths; do not concatenate unvalidated
publisher strings into paths. Do not automatically discover arbitrary folders or old v1
installations as executable plugins. Legacy import is explicit and validated.

The SDK supplies `packageRoot`, payload-relative path resolution, asset references, and
`dataDir()`.

### Per-plugin data directory

`TOOLBELT_DATA_DIR` is plugin-specific, not a shared global data root. For each plugin process,
Toolbelt creates and passes this absolute path in that child's environment:

```text
TOOLBELT_DATA_DIR = <resolved TOOLBELT_CONFIG_DIR>/data/<stable-plugin-id>
```

- Each distinct plugin ID receives a different subdirectory. Do not pass the common `data/`
  parent to every plugin and expect authors to namespace it themselves.
- All versions of the same plugin ID receive the same directory within a Toolbelt profile.
  The data path contains no plugin version, archive hash or SDK version. Upgrading or
  replacing the package does not change it.
- Use the stable manifest ID, not the display name. Duplicate installed IDs are rejected.
- SDK `dataDir()` returns the assigned plugin-specific path directly. Authors must not need
  to append their plugin ID again.
- Different profile/config roots produce different default data directories. Disabling or
  removing a package leaves its data directory in place; reinstalling the same ID in that
  profile receives that retained directory. Its contents/compatibility remain plugin-owned.

For example, Processes receives `<config>/data/processes` and Upkeep receives
`<config>/data/upkeep`. Processes v1 and v2 both receive `<config>/data/processes`.

This namespacing prevents accidental filename collisions by default; it does not enforce
filesystem isolation. Plugins may use the path, ignore it, or use multiple/shared/external
locations. Toolbelt does not know which files comprise a plugin's complete state.

### Package lifetime, plugin data ownership and assets

Package directories can be replaced or deleted on upgrade/removal. Toolbelt does not enforce
read-only access or monitor plugin writes there. Authors may use their runtime files as they
choose, but must put anything that needs to survive package replacement in storage they
manage. The archive hash describes downloaded bytes, not a promise that extracted files
remain unchanged. Toolbelt never writes plugins into the signed app bundle.

Plugin authors own all data safety: formats, schema compatibility checks, initialization,
migrations, backups, rollback if desired, concurrent writers, interrupted operations and
external resources. A plugin must report initialization failure if it cannot safely use its
data. Restoring an older executable does not imply that executable can read current data.
There is no host promise of schema compatibility or recovery after failure.

Toolbelt does not inspect, snapshot, freeze, copy, migrate or restore plugin data. It leaves
the provided data directory and external paths untouched during install/upgrade/removal.
Deleting the disposable package directory does delete anything a plugin chose to write
inside it; that is why persistent storage must live elsewhere. Toolbelt does not require
schema declarations or a separate migration protocol. Central placement makes user backup
convenient; it does not create a Toolbelt backup feature. Data retention is the default for
plugin-authored uninstall behavior too. A cooperative plugin must obtain explicit user
consent before destructive data cleanup; its optional `remove`
callback is not blanket permission to delete data. Arbitrary plugin code can still ignore
that convention because execution is unsandboxed.

Assets are a host-rendering concern, not general data management. Resolve references by
plugin and installed package instance, only to declared supported display assets. Prevent
cross-plugin/path escapes; validate MIME/content and reject or sanitize unsafe SVG. Preserve
built-in lucide/app/file icons. Clear obsolete asset/UI references on replacement. Do not
execute asset JavaScript. Electrobun's built-in file schemes alone do not make arbitrary
plugin files available to the renderer; implement the required host asset routing.

## 7. Lifecycle contract

The lifecycle consists of **init, activate, deactivate and remove**. There is no separate
migration, trial-start, data-commit, rollback, health-check or recovery lifecycle.

A handshake creates the control connection. SDK dispatch must allow lifecycle-only work
without starting background behavior merely because the module was loaded. Arbitrary code
can nevertheless have top-level side effects; the host does not enforce their absence.

| Request | Plugin responsibility | Host behavior |
| --- | --- | --- |
| `init` | Prepare to run, including any plugin-chosen initialization or migration. Resolve when ready; fail with a reason otherwise. | Wait for ready/error within the documented startup deadline. No active plugin UI before successful activation. |
| `activate` | Begin normal operation, including background jobs and user interaction. | Await success, then expose screens/quick view and mark active. Failure stops the main process and displays an error. |
| `deactivate` | Stop accepting work and prepare to exit. Release plugin-owned resources and stop plugin-owned subprocesses as appropriate. | Close plugin UI and disconnect its user-event routing. Await success, busy/deferred or error within a bounded grace period. |
| `remove` | Optional uninstall cleanup owned by the plugin. This is not called on upgrade. | Invoke only for a normal uninstall, while code is still available. Failure cannot prevent force removal. |

The SDK translates resolving a callback into success, rejection/throw into a readable error,
and an explicit busy/deferred result from `deactivate` into a reason for deferral. It handles
wire acknowledgments. Optional callbacks default to successful no-ops; the lifecycle
messages/acknowledgments still occur. Exact wire fields are defined once in the SDK.

`init` receives ordinary privileged execution. It can change anything the plugin can access;
there is no side-effect-free trial. `activate` is an authoring convention for separating
normal work from initialization, not an enforced security gate. Success means only that the
plugin reports readiness/completion; Toolbelt cannot verify application correctness.

Process states should be simple: inactive/disabled, initializing, activating, active,
stopping, failed, plus current download/verification/removal progress. Retain an error reason
and logs. Do not model application schemas, migration stages or external job states in the
host. Serialize lifecycle/package operations for one plugin inside the running host.

On deactivation, close all its screens, quick views and dialogs, discard trees and pending
UI events, and stop accepting renders/user-facing effects. Continue receiving lifecycle
replies and diagnostics until the process is stopped. Then retire the connection entirely.
A replacement connection gets new UI. Late messages from old connections must not reach
the new instance. This is ordinary connection disposal, not a plugin-visible UI transaction
or migration system.

A busy result means the plugin has not deactivated and can continue running. For a normal
upgrade/disable/remove, defer the operation and resume its UI from a fresh render if appropriate.
A callback error may mean partial shutdown: show the error and offer retry/force stop/remove;
do not assume the plugin is healthy or begin a replacement while its main process is alive.
Once deactivation succeeds, the SDK keeps the control channel available for `remove` if
needed; Toolbelt stops the process after the requested lifecycle work.

Missing acknowledgments, initialization/activation failure, malformed protocol or unexpected
exit are visible per-plugin failures. Stop its direct main process as needed. Do not
activate it or repeatedly auto-restart it. Retry/re-enable is an explicit user action;
best-effort persistence should keep a known failed plugin from forming a launch loop.
Plugins handle partial initialization cleanup themselves; a timeout/kill is not cleanup.

## 8. Install, update, disable and removal flows

### Initial install and enable

Install/validate/register the package, launch its main process, handshake, send `init`, wait
for ready, then send `activate`. Expose UI only after activation succeeds. A failed start
leaves the installed package visible but inactive with its reason, logs, Retry and removal
controls. Enabling a disabled plugin uses the same startup sequence.

### Upgrade

For a running plugin:

1. Download and statically validate the candidate while the old plugin remains active.
2. Send `deactivate` to the old plugin. Busy defers; error/timeout is visible and offers force
   controls. Do not run the candidate alongside a still-running old main process.
3. After successful deactivation, stop the old main process and discard its connection/UI.
4. Select the new package in host settings, persist best effort, launch it once at its final
   package path, handshake, `init`, and if ready, `activate`.
5. If initialization or activation fails, leave the new version installed but inactive and
   show the reason. Do not restart the old version, restore data, or claim anything was undone.
6. Delete obsolete host package files as housekeeping. This does not invoke `remove`.

For an inactive/disabled plugin, validate and replace the selected package without launching
either version; retain its inactive/disabled state. Enable/Retry is a separate user action.

There is no staged data copy, double startup, data promotion, commit handshake or automatic
rollback. Changes performed by a failed initializer remain the plugin author's problem.
If Toolbelt fails before candidate execution, do not deliberately remove the old package;
this is ordinary failure handling, not a crash-recoverable transaction guarantee.

### Disable, stop and force stop

Normal disable requests `deactivate`, then stops the direct main process and retains the
package and data. Busy defers. Force stop disables restart/activation, closes the UI,
disconnects the instance, sends termination and escalates to force termination if necessary.
It bypasses lifecycle cooperation and leaves the package installed but inactive.

### Normal uninstall

Deactivate if running, invoke `remove`, stop the direct main process, unregister the plugin,
and delete its downloaded package directory. Removing a disabled/failed plugin may launch a
control-only process to invoke `remove`, without `init` or `activate`; SDK callbacks must not
assume initialization occurred in that process. This executes previously user-approved
plugin code and can fail. Show errors and always make force removal available. Toolbelt
leaves the default data directory and external installations/data untouched.

### Force uninstall

Force removal is available for healthy, busy, failed, incompatible and unresponsive plugins.
It requires no successful handshake, callback, initialization or cleanup:

1. Prevent further host activation/restart and close/disconnect plugin UI.
2. Attempt to terminate the directly launched main process, escalating as needed.
3. Unregister the plugin and persist that choice best effort, regardless of callback outcome.
4. Delete the host-installed package directory where possible.
5. Report surviving known main processes or files that could not be deleted, with PID/path,
   reason and logs. File deletion failure is pending housekeeping, not a reason to re-register
   the plugin or make its force-removal controls unusable.

A plugin never gets a veto over force removal. It is removed from Toolbelt even if the OS
refuses termination or file deletion. Do not promise every related process/file disappeared.
Retain diagnostics after uninstall long enough for ordinary bounded log retention.

## 9. Processes, opaque payloads and quitting

Toolbelt tracks only each main process it directly launches: plugin/version, PID, running or
exited status, exit information and termination errors. Show these in the plugin manager
independently of the plugin's own UI. Use the live process handle for termination; do not
blindly signal an old PID that may have been reused. No general process browser is required.

A "helper" means any engine, worker, CLI, daemon, installer or other process a plugin may
launch. It is not a host-managed concept. Toolbelt neither declares nor discovers helpers,
registers them, follows descendant trees, maintains leases, pins packages for external
processes, or kills arbitrary descendants. Processes observed by the Processes plugin and
independent terminal sessions are never considered Toolbelt-owned jobs.

The plugin owns subprocess cleanup, shell hooks, PATH changes, CLI installations, command
collisions, external runtimes and the consistency/lifetime of its payloads. Toolbelt does
not inspect or execute opaque payloads during installation, maintain stable CLI launchers,
resolve active CLI versions, or undo machine-level changes. Package directories can disappear
on upgrade/removal. An author who needs an independent or surviving CLI must arrange its
installation and upgrade behavior. Processes must preserve its existing user confirmations,
undo and temp-home testing, implemented entirely in its own repository.

Force stopping a main process does not imply its descendants exited. Toolbelt reports what
it actually knows about its direct process and does not claim complete child-process
inventory or cleanup. No process supervision registry or orphan-recovery daemon is required.

Normal app quit shows a confirmation warning that plugin operations may be interrupted.
After confirmation, send `deactivate` to running plugins, allow a short bounded grace period,
then terminate remaining direct main processes and quit. Busy/error cannot veto confirmed
app quit indefinitely. Explicit force quit skips the grace period. Use the same bounded
shutdown path before Toolbelt's own updater relaunches; a user-initiated app update must
communicate interruption risk. Do not continuously poll plugins for "safe to quit" or track
their jobs. Plugin-provided reasons are reports, not verified safety guarantees.

Crashes, OS termination and power loss may bypass all callbacks. An SDK plugin should exit
when its host pipe closes; a killed/unresponsive process may not cooperate. Parent exit alone
does not guarantee child exit. Handle this best effort, without orphan repair or recovery
promises. Plugins own their interrupted work and any surviving subprocesses.

## 10. Best-effort settings and diagnostics

Persist ordinary host settings best effort: installed package selection/source, enabled
state, demo removal choice and existing host/UI preferences. A temporary-file-and-rename
write is sufficient; log write/parse errors and surface them where relevant. On launch,
use valid persisted settings, or show a usable host/plugin manager when settings are missing
or invalid. Never compensate by executing arbitrary package-directory contents.

No transaction journal, power-loss recovery protocol, migration replay, distributed lock or
exactly-once guarantee is required. There is no promised reconstruction of interrupted
updates/removals. Enabled selected plugins receive ordinary startup on the next launch;
plugins must tolerate that, including rejecting incompatible data themselves. Preserve
known failures best effort, but do not claim host settings always survived a crash.

Keep a discoverable, bounded log under the profile configuration directory. Include time,
plugin/version, lifecycle stage, source/package identity, main PID/exit and readable error
information, plus captured protocol/stderr diagnostics. Avoid logging host secrets and full
large payloads. Expose the log path and a way to view/open it from the host plugin manager.
Logging is debugging support, not a durable transaction/audit database.

## 11. SDK demonstrator and thin standalone tester

Ship one first-party SDK demonstrator as a prebuilt seed archive consumed through the same
validated installer. Its implementation lives in toolbelt-sdk-demo, not in host source.
Use the first-run installation/activation disclosure for the seed too; bundling it does not
bypass the execution approval described in section 3.
It is removable and disableable; persist that choice across app upgrades best effort and
do not deliberately reinstall it on each launch. Do not downgrade an installed demo to an
older bundled seed. A fresh profile has no Processes/Upkeep until the user installs them.
An empty-plugin host must remain fully usable.

Maintain an SDK-to-scenario coverage inventory. Cover every public node, field, action,
icon/asset pathway, shortcut pattern, table feature, main screen, quick view, dialog,
progress/log output, lifecycle outcome and optional capability. Host-owned broken fixtures
cover protocol failures and hostile archive input; the demo need not contain business logic.

Release **Toolbelt Plugin Tester.app** from Toolbelt's repository as a thin application
variant. It uses the same host/lifecycle/package core, renderer, SDK schemas and applicable
settings components as Toolbelt. Only identity, profile defaults, launch mode and tester
controls differ. Do not implement a second runtime, installer, lifecycle engine or renderer.

Give official, development and tester variants distinct bundle identities/default config
roots and non-conflicting shortcuts. Tester-created profiles are independent. Existing
`TOOLBELT_CONFIG_DIR` overrides remain available for explicit isolated testing. Profile paths
do not sandbox a plugin that ignores them; first-party plugin fixtures must explicitly
redirect every external/legacy path and resource used by the scenario.

Tester functionality:

- Open and validate a local built archive using the production package/lifecycle path.
- Optionally watch an explicitly selected built output directory in a visibly marked dev
  mode. It may omit release metadata, but must not turn into a production install bypass.
- Enumerate screens/quick views and exercise real navigation and actions.
- Show main-window and simulated popover surfaces inside the window; allow explicit opt-in
  real menu-bar mode for native positioning, highlighting and blur checks.
- Exercise themes, light/dark, narrow/resized layouts, zoom, motion, mouse and keyboard.
- Inspect protocol, lifecycle results, logs and main process status; retry/restart, force
  stop/remove, and reset explicit test profiles.
- Select plugin-provided scenarios/fixtures and support screenshots/UI automation.

Fixtures are fake resources/data, not a different tester application: temporary homes,
scratch files, throwaway clones, fake update feeds and disposable processes. Plugin repos
provide their fixtures and behavior tests. No test action may stop real user jobs, edit real
dotfiles, upgrade real software or migrate official data. The tester remains privileged
plugin execution and is not a security boundary.

## 12. Electrobun support and implementation constraints

The checked project pins are Electrobun **2.0.6** in package.json and hutch.config.ts,
Hutch **0.29.0**, and Electrobun's default bundled Bun **1.4.4**. Keep Bun as the main process;
the current app uses WKWebView, React and shadcn/ui. The SDK's declarative nodes are Toolbelt
protocol types, not Electrobun's separate experimental native UI system.

Documentation/source review found the required primitives available. This is not a substitute
for testing the packaged application:

- Bun subprocesses provide pipes, PID/exit reporting and termination. Lifecycle messages
  are Toolbelt's protocol, not an Electrobun plugin system.
- Existing webview RPC carries host UI updates. Runtime plugin installation is app logic;
  it must not rebuild or relaunch the host.
- Build configuration supplies separate application identities for the shared tester variant.
- `before-quit` handlers are synchronous and do not await promises. Cancel the initial quit,
  finish the bounded asynchronous shutdown path, then explicitly quit. Do not put an async
  callback there and assume Electrobun waits.
- `views://` serves bundled resources. Opt-in `appdata://` serves Electrobun's fixed user-data
  root, which may differ from `TOOLBELT_CONFIG_DIR`; implement routing for the actual plugin
  package assets rather than assuming arbitrary paths are automatically served.
- Retain the existing Carbon global-shortcut and best-effort native tray-highlight code.
  Changing plugin distribution is not an assignment to replace those working integrations.

References checked for this design:

- [Bun subprocesses](https://bun.sh/docs/runtime/child-process)
- [Bun runtime flags, including --no-install](https://bun.sh/docs/runtime)
- [Electrobun 2.0.6 lifecycle events](https://github.com/blackboardsh/electrobun/blob/v2.0.6/docs/src/content/docs/electrobun/apis/events.mdx)
- [Electrobun 2.0.6 webview APIs](https://github.com/blackboardsh/electrobun/blob/v2.0.6/docs/src/content/docs/electrobun/apis/browser-view.mdx)
- [Electrobun 2.0.6 asset schemes](https://github.com/blackboardsh/electrobun/blob/v2.0.6/docs/src/content/docs/electrobun/apis/bundled-assets.mdx)
- [Electrobun build configuration](https://docs.electrobun.dev/electrobun/apis/cli/build-configuration/)
- [Electrobun 2.0.6 Bun version](https://github.com/blackboardsh/electrobun/blob/v2.0.6/package/src/shared/bun-version.ts)

## 13. Explicit non-goals

Do not infer any of the following from "robust plugins", "isolation", "lifecycle", "tester"
or "plugin manager". They are outside this version's agreed platform:

- Runtime security sandbox, permissions broker, malicious-code containment or guaranteed
  filesystem/network/process/resource isolation.
- Publisher vetting, reputation, certification, ownership-transfer monitoring, extra signing
  infrastructure, central plugin catalog or maintainer allowlist.
- Building plugin source, installing its dependencies, runtime auto-install, vendored plugin
  implementation refresh, or shared dependency resolution.
- Per-plugin primary Bun/runtime version provisioning.
- Plugin-injected browser code, arbitrary React components or a separate UI renderer.
- Host-managed plugin data schemas, migrations, snapshots, backups, write freezes, staged
  data copies, restoration, rollback/downgrade safety or external-resource recovery.
- Filesystem/CRUD/query/text-store SDK frameworks or a mandatory persistence API.
- Side-effect-free trial execution or a guarantee that initialization/termination undoes work.
- Journaled installation/data transactions, crash/power-loss recovery, migration replay,
  exactly-once operations or an orphan-recovery service.
- General child-process/helper supervision, recursive process killing, package lifetime
  leases, CLI launchers/installations, command collision management or external cleanup.
- Continuous plugin health/job/safe-exit monitoring or indefinite plugin veto of force actions.
- Unattended plugin upgrades, private GitHub authentication or non-GitHub registries.
- A second runtime implementation for the tester, duplicated plugin business test suites,
  or hidden Processes/Upkeep built-ins.

Basic input validation, safe extraction, bounded protocol handling, per-plugin errors,
best-effort settings/logging and direct process termination remain required. Excluding a
recovery or sandbox system does not remove those ordinary host responsibilities.

## 14. Delivery order, tests and exit gates

Implementation order:

A. Inventory/freeze the parity baseline and all relevant later fixes, data/CLI/UI contracts
   and external paths used in tests. Preserve source history/provenance where practical.
B. Define SDK/package/protocol schemas and the four-callback lifecycle; implement the shared
   package validator, process/lifecycle core, asset handling, settings/logging and generic
   tests first. Document size/rate/time limits. Exact numeric defaults and wire names are
   routine implementation choices; adding excluded platform responsibilities is not.
C. Build the plugin-manager/GitHub UI and thin tester variant on that shared core. They may
   iterate together; the tester must not invent a runtime before the shared one exists.
D. Extract complete Processes/Upkeep code and behavior tests into their repositories. Build
   ready-to-run archives, validate in a clean fake host and exercise through the tester.
E. Publish SDK/demo/tester candidate artifacts on the feature branches or explicit prerelease
   feeds. Consume only the demo's verified prebuilt seed in host assembly. Remove old
   plugin source/build paths only after replacement packages demonstrate parity.
F. Exercise installation, lifecycle failures, force controls, real native surfaces and parity;
   record evidence and remaining limitations for cross-repository review.
G. Stop before main merges, stable release or replacement of the official app/data.

Extraction and core development may iterate, but source removal must not outrun working
replacement packages. Pin evaluation SDK/plugin/demo/tester artifacts by exact version,
commit and checksum. No sibling source checkout may be needed to use a released artifact.

Plugin repositories own frozen dependency installation, typechecks, business/unit tests,
their data safety/migration tests where applicable, clean unpacked execution, payload/CLI
checks, lifecycle cooperation and visual/keyboard tests using the released tester. Toolbelt
owns generic protocol/renderer/compatibility/install/lifecycle/force-control tests and
malformed fixtures. Cross-repo parity validation is a bounded extraction exercise, not a
permanent duplicate business test suite in the host.

Terminal archives are built/tested/published by toolbelt-ps. Toolbelt must stop compiling
the TUI or reading its source package.json. Preserve existing download behavior during the
transition using verified prebuilt artifacts if needed. Preserve command names; final stable
release/download naming remains a later explicit integration decision. Toolbelt's app
signing, DMG/updater and normal release workflow remain its own responsibility.

Mandatory exit checks:

- Processes/Kept/Settings/Peek, grouping/search/filters, agent detection, shortcuts, terminal
  jumps, notes/env editing, TUI install/undo and shell hook preserve baseline behavior.
- Upkeep screens, scheduling/countdowns, dialogs, queue/cancel, notifications/audit,
  providers/auth boundaries, bulk-update safety, Sparkle build versions/notes and keys work.
- Existing plugin/screen IDs and appropriate settings/UI state survive explicit development
  import of copied v1 data; no automatic import or migration of the real working installation.
- Runtime install/enable/disable/update/remove refreshes window/popover without app restart.
- Each plugin receives its own `TOOLBELT_DATA_DIR`; versions of the same ID share that path
  within a profile, SDK `dataDir()` returns it directly, and package removal retains it.
- Missing dependencies fail without downloads; incompatible metadata fails before old-plugin
  deactivation; conflicting bundled dependency versions coexist.
- Bad digest/archive/path/target/id, offline download and canceled extraction leave no active
  half-installation and do not deliberately disrupt the current plugin.
- `init`/`activate` error, timeout or crash leaves a readable inactive failure. No automatic
  old-version restart, data restoration or endless restart loop occurs.
- Busy deactivation can defer a normal upgrade/disable/uninstall. Force stop/remove works
  without cooperation, including malformed, failed and incompatible plugins. Main PID/status,
  termination errors and any undeleted package paths remain reportable.
- Normal uninstall calls `remove`; upgrade never does. Control-only uninstall does not run
  `init`/`activate`. Host cleanup touches only its package directory; the default data
  directory and external resources remain untouched by the host.
- Old UI/dialogs/events/connections disappear on deactivation; stale output is ignored.
- Malformed/flooding protocol and renderer failures stay local to their plugin interface.
- Host settings are preserved best effort and diagnostic logs are accessible. Missing/invalid
  settings leave a usable host. No crash-transaction recovery guarantee is tested or implied.
- A removed demo is not deliberately reinstalled on launch/app upgrade; an empty host works.
- Official/dev/tester identities, profiles and shortcuts coexist. Local archive testing uses
  the same core; scenario fixtures redirect all real/external data and resources explicitly.
- Clean builds/execution work without legacy Running or sibling source/dependency checkouts.
- No maintained Processes/Upkeep source, plugin-specific compilation or extraction-time plugin
  execution remains in Toolbelt. Opaque payloads remain opaque to the host.
- Packaged app/tester execution, downloaded assets, native menu bar/quick views, shortcuts,
  themes/accessibility/motion, graceful/forced quit and app updater are verified using
  disposable installations and processes only.

Once implementation is explicitly assigned, record candidate identities, checks and
limitations in docs/architecture2-progress.md on the feature branch. Commit/push meaningful
milestones there; draft PRs are for review only when requested. No implementation, merge,
stable publication or official data changes are authorized merely by this document.
