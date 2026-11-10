# Plugin manager frontend integration — review evidence

Implementation branch: feat/plugin-manager-ui, targeting feat/architecture-v2 as assigned.
The architecture2 contract was read in full. Only frontend, additive model/tests and review
documentation changed. No host/RPC/App/package or stable release changes.

## Backend connection required

The exact exported contract is `src/ui/plugin-manager-model.ts`. Host owner must call
`registerPluginManagerAdapter(adapter)` before the manager mounts, or pass `adapter` as a
prop. Registration is startup wiring, not a dynamic replacement API. The coordinator was
sent this request promptly during implementation and the complete file location afterward.

- `read` returns authoritative installed records (including lifecycle, error, bounded logs,
  cancellable operation, recovery choices, available version) and notify-only schedule.
- `subscribe` pushes full snapshots after every lifecycle transition. A non-overlapping
  two-second read fallback refreshes runtime installations/removals and reconnects.
- `resolve` returns review token bound to exact repo/id/version/hash/channel/compatibility.
  Tokens must expire and backend must revalidate on install. Incompatible/missing review
  blocks installation. Candidate discovery must not execute plugin code.
- `install` completes only after successful committed readiness, or rejects with useful error.
  Publish downloading/verifying/migrating/updating progress while promise is outstanding.
- `enable`/`remove` refresh authoritative state. Removal passes `deleteData=false` by default;
  explicit checked deletion passes true. Backend must serialize per-plugin mutations.
- `cancel(operationId)` rejects unsafe/stale requests and only stops at declared safe boundaries.
  It remains available while install RPC is awaiting completion. Cancellable flags, never a
  frontend guess based on phase, govern availability. External effects are not rolled back.
- `checkUpdates` performs manual checks without installing. Persist schedule and last/next
  check in host; UI displays actual interval. No invented automatic check schedule.
- `setChannel` persists per-plugin stable/prerelease preference. Form's prerelease checkbox
  affects that search only; approved candidate channel must persist at install.
- `cleanup` opens plugin-owned explicit cleanup confirmation before touching command/shell
  files. The manager offers it before removal while code is available; do not silently
  remove dotfiles. Omit capability if unavailable.
- `recover` receives opaque choice ID. Backend must revalidate schema compatibility or matching
  snapshot and execute trusted recoverable transaction. Snapshot warning requires checkbox
  acknowledgment; clearly limits recovery to managed data. Retention is backend owned.

Legacy fallback calls only existing five RPC operations. It intentionally cannot install
because old candidate response lacks compatibility; automatic checks, persisted channel
editing, lifecycle diagnostics, cancellation, cleanup and recovery await host adapter.
Unavailable controls are disabled/explained or absent, never fake successful operations.
This frontend PR alone does not claim completion of full v2 backend integration.

## Validation

- `bun install --frozen-lockfile`, then build prepared the missing Electrobun devkit.
- `bun run typecheck`: pass after devkit preparation.
- `bun test`: 332 pass, 0 fail, including compatibility/recovery/conflicting-phase guards.
- `bun run build`: pass; local macOS stable bundle only, not published or installed.
- `bun run preview` with disposable `/tmp/toolbelt-manager-ui-review` config, Chrome via
  chrome-devtools-axi: real app empty state, settings navigation and unavailable controls.
- Temporary browser adapter fixture (outside tracked source) exercised failed migration,
  diagnostics, schedule, cleanup offer, removal modal. Confirmed removal invokes exactly
  `{id:"fixture",deleteData:false}` with deletion unchecked and reactive empty list afterward.
- Recovery at 390×844: snapshot date/data-loss/external-effects warning, confirmation disabled
  until acknowledgment, keyboard focus in dialog, no horizontal document overflow.
- Screenshots retained in `docs/evidence/plugin-manager/`. Fixture assets live only in ignored
  dist; they are not shipped source or a production backend. No official data used.

Remaining acceptance: host adapter integration and backend failure/cancellation/cleanup/
recovery tests, then repeat full app end-to-end flows. Feature-target CI availability is
owned by parent. Preserve this evidence until user review; no documentation cleanup yet.
