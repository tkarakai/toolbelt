# Standalone Plugin Tester candidate

Run `bun scripts/build-tester.ts`. This builds in a disposable staging folder without
changing the app config or sharing its build lock. Outputs are copied to
`artifacts/tester/build` and `artifacts/tester/archives`. The native bundle embeds Bun,
production UI assets and host code; plugin archives are selected at runtime, never bundled
from plugin source. No installed Toolbelt or sibling plugin source is required.

Identity: `io.github.tkarakai.toolbelt.tester`. Settings/cache/packages/data are in
`~/Library/Application Support/Toolbelt Plugin Tester/profiles/<name>`, with name selected
by `TOOLBELT_TESTER_PROFILE` (default `default`). Global shortcuts and app updates are
disabled. The production Settings view is included via App. The runtime overwrites any
inherited TOOLBELT_CONFIG_DIR before reading settings. This is data separation, not a
security sandbox: plugins still execute with the user's privileges.

Open a `.tar.gz` archive, specify its publisher repository and approve execution. The real
PackageManager stage/install paths enforce the same archive, compatibility, publisher,
handshake, initialization/migration, rollback and readiness checks as production. Locally
computed SHA-256 identifies selected bytes; it does not authenticate a publisher. Watch
requires a separate explicit click and execution approval; only the selected built archive
is watched. No dependency installation or source building occurs. Immutable same-version
changed-byte rejection remains in force; increment development versions when rebuilding.

The main view mounts production App (all declared screens, keyboard navigation, settings,
zoom); simulated popover mounts production Popover in a 380px window frame. Width control
covers narrow layouts. Production settings cover palettes and light/dark/system. Reduced
motion can be forced in the tester. Diagnostics record bounded validated trees, events,
toasts, lifecycle states, install hashes and failures. Restart uses the real host. Reset
removes only selected tester plugin data through PackageManager; reopen the archive to
initialize again. Select another named profile before launch for independent fixtures.
Use fake resources and temp homes in plugin fixture packages; never run real Upkeep
updates or stop user processes during evaluation.

## Coordinator hooks and remaining exit gates

This candidate deliberately changes no shared runtime contracts or app entry files.
No integration hooks are needed for its standalone build. For normal build integration,
add a package script `"build:tester": "bun scripts/build-tester.ts"` and add the tester
release outputs to the eventual explicit development release workflow. Add the user-facing
CHANGELOG entry in the coordinator PR (this assignment permits additive tester files only).

The following requirements are **not complete** and must not be reported as verified:

- Native menu-bar opt-in currently returns a visible integration-pending error. Extract
  production index.ts's tray/popover factory (position/highlight/blur and 160ms closing
  animation), accepting host/settings/RPC/view URL, then provide it as an opt-in callback
  in tester.ts. Do not clone that lifecycle implementation. Tester UI already calls
  testerControl('nativePopover'). Include #popover routing in tester-main.tsx for that view.
- Raw protocol and stderr inspector: add optional PluginHost diagnostic callback
  `{direction:'in'|'out'|'stderr',plugin,line}` at bounded read/send/log boundaries;
  connect it to runtime.record. Current inspector only shows validated render/events.
- Shared native RPC factory: production index.ts has inline handlers. Extract a reusable
  factory accepting host, package manager, settings and window callbacks. Replace the
  tester adapter with that factory, retaining the extra tester control request.
- Add typed `tester` request to a tester-only RPC extension rather than production RPC;
  current adapter uses a narrow dynamic request bridge. Production RPC remains unchanged.
- Add scenario inventories and release archive parity evidence for demo/Processes/Upkeep
  after coordinator supplies exact package candidates. No actual plugin updates tested.
- Native app launch outside source checkout, UI screenshots, mouse/keyboard, multi-display
  native tray and clean-machine smoke remain unverified. Build success alone is insufficient.

## Evidence retained before user review

`bun test test/tester.test.ts`: 2 passing tests / 10 assertions, disposable temp resources.
Tests cover profile traversal rejection, diagnostic bounds, malformed archive rejection via
production validator, invalid watcher selection and unknown reset rejection.
Native build and typecheck results are reported in the PR; no official app was replaced.

Native build completed and emitted `ToolbeltPluginTester.app` and
`ToolbeltPluginTester-stable.dmg` under artifacts/tester/build/stable-macos-arm64.
Initial build warned that the optional icon source was missing in staging; build script
now copies dev-icon.iconset as well. Typecheck passes. Native launch was not exercised.

Broad `bun test` result: 415 pass, 1 fail (416 tests, 3271 assertions).
Failure is the retained v1 Upkeep integration manifest declaring protocol 0 while the
baseline protocol parser requires 1 (`test/upkeep-integration.test.ts:21`). No changes
were made to that integration fixture or protocol contract in this candidate.
