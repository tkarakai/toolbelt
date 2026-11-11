# Toolbelt agent instructions

Read [README.md](README.md), [docs/architecture.md](docs/architecture.md) and
[docs/maintenance.md](docs/maintenance.md) before changing the host. Read
[docs/releases.md](docs/releases.md) before any version/tag/publication work. For SDK, protocol or
plugin work also read [docs/plugins.md](docs/plugins.md). These documents describe the
current system; keep them accurate when behavior or contracts change. Write maintenance
references, not implementation diaries, plans or reasoning transcripts.

## Ownership and workflow

- Never use the no-mistakes tool, plugin, skill or pipeline. Implement, review, validate and
  operate Git/CI directly.
- One agent per checkout. Inspect `git status` first; if unexpected changes belong to
  another session, stop and ask before modifying them.
- Never commit directly to `main`. Use a feature/fix branch and a PR, pass CI, then follow
  the user's merge decision. Do not enable auto-merge, publish releases or replace an
  installed app/data without authorization. The user owns merges for the current PRs.
- Add user-visible behavior to `CHANGELOG.md` under Unreleased. Do not bump versions in
  feature PRs; version changes belong to release PRs.
- Use Bun: `bun install --frozen-lockfile`, `bun <file>`, `bun test`, `bun run <script>`,
  `bunx <package>`. Do not use npm/yarn/pnpm, node or other test runners.
- Workflow actions must use full commit SHAs and minimal permissions. Allowed publishers
  are GitHub, `oven-sh/setup-bun` and `zizmorcore/zizmor-action`.

## Runtime and SDK invariants

- Toolbelt is generic. Plugin implementation, assets, dependencies and behavior tests
  belong to plugin repos; do not copy them into the host or compile them during app builds.
  The app consumes only a verified prebuilt demo seed. SDK and tester belong here.
- Packages run with user privileges in isolated Bun processes, not a security sandbox.
  No plugin JavaScript/HTML/React is injected into WKWebView. Do not add shared dependency
  resolution, ambient source fallbacks or publisher install scripts.
- Treat manifest, protocol, capability, asset and lifecycle changes as public contracts.
  Update runtime schemas, renderer, SDK docs, generic tests and SDK Explorer coverage
  together. Package/protocol/SDK/plugin/schema versions have distinct meanings.
- Validate metadata/compatibility/bytes before execution and readiness before publication.
  Preserve publisher bindings, per-plugin failure containment, transport limits and logs.
- Preserve transactional managed-data recovery, prepare refusal, probe side-effect freedom,
  durable sync ordering, startup journal recovery and approval/helper leases. Never stop a
  busy plugin after it refuses preparation. Rollback does not undo external side effects.
- CLI cleanup belongs to the plugin's confirmed screen. Never dispatch a mutating cleanup
  action behind its confirmation or silently edit dotfiles.
- Kill only owned process groups and wait for descendants, not just the parent. Observed
  processes and independent terminal jobs must survive plugin disable/removal.

## UI conventions

Keep instant state (typing, selection, scroll, widths, zoom) in the renderer. Use declarative
nodes and existing shadcn components. Selection uses `selected`/`selected-foreground`, hover
uses `accent`. Theme changes must pass `test/themes.test.ts` AA checks. Appear/disappear,
position and size changes animate at 200 ms easing out, exits about 150 ms. Respect reduced
motion; avoid animation on continuous values or first paint of long lists. Check narrow
layouts, action wrapping, tab scrolling, dialogs, inspectors and tool details for overflow.

## Verification and safety

Run `bun run typecheck`, `bun test`, and `bun run build` as appropriate. Package/lifecycle
changes need malformed archives/protocol, integrity, concurrency, crash/fault recovery and
real archive execution checks. Build the tester with `bun scripts/build-tester.ts` when its
runtime or packaging changes. Check SDK changes through fake-host tests and the SDK Explorer.

Verify UI through `bun run preview` and `chrome-devtools-axi`, and native behavior with the
standalone tester/debug API. Use isolated profiles, temporary homes, scratch resources,
fake feeds and only disposable processes. Never kill, restart, focus or type into the user's
processes/terminals, run real software updates, or test shell installation against real dotfiles.
Only stop PIDs you started and clean up their tabs, ports and mounted disk images.

Do not stop the user's dev app to obtain its build lock. Use a disposable source copy,
excluding `.git`, `.hutch`, `build`, `build.noindex`, `dist`, `build-seed`, `artifacts` and
`artifacts-tester`, and choose a separate config root/debug port. `bun run build` has the
official app identity: launch via `bun scripts/run-evaluation.ts` to use an isolated copy.
Global shortcuts use Carbon through `hotkey.ts`; avoid Electrobun GlobalShortcut's silent
Accessibility dependency. Release and updater rehearsal details are in maintenance.md.

Release commands must match the runbook and current scripts. The host publication command
creates tags/releases and advances Latest; a passing build/CI does not authorize it. Preserve
immutable published bytes, verify draft assets where publishing manually, and use the documented
retry boundary rather than rerunning a tagged release. Do not assume plugin repos have a
`release` script or that app publication updates their releases/SDK pins.
