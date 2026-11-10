# Architecture v2 evaluation

This is a feature-branch evaluation. Do not replace your installed app or merge to main yet.

Build with Bun 1.4.4:

```sh
bun install --frozen-lockfile
bunx electrobun prepare
bun run typecheck
bun test
bun run build
bun scripts/run-evaluation.ts
```

The evaluation launcher copies the app outside the checkout, creates a fresh temporary
profile, separates plugin data and renderer preferences, gives it a different shortcut,
and directs Processes' TUI/shell installation controls to a temporary home. It prints all
paths. The installed daily app and its data stay untouched. Process lists still observe
the actual Mac; automated tests never stop/focus/restart user jobs.

A fresh profile contains only the removable SDK demo. Open Settings → Plugins, enter the
repository, select Allow prereleases and the exact tag, review compatibility/publisher/hash,
then approve execution:

| Plugin | Repository | Evaluation release |
| --- | --- | --- |
| Processes | tkarakai/toolbelt-ps | architecture2-582cd7a |
| Upkeep | tkarakai/toolbelt-upkeep | architecture2-eval-c8d8c1f |
| SDK demo (bundled) | tkarakai/toolbelt-sdk-demo | architecture2-8e8fca9 |

These are immutable development snapshots. Several earlier snapshots share plugin semantic
version 0.0.1, so use a fresh evaluation profile when changing snapshot tags. The host
intentionally rejects changed bytes for an already approved version.

Try runtime install/disable/enable/remove, all screens and menu-bar quick views, keyboard
shortcuts, table filtering/sorting and settings. Removal retains managed data unless the
separate deletion checkbox is explicitly checked. Processes' Review cleanup button opens
its Settings screen; its own confirmation guards shell/PATH cleanup. Plugin updates remain
notify-only and require approval. Snapshot recovery warns when newer managed data is lost.

The standalone tester is built with `bun scripts/build-tester.ts` and emitted separately
under `artifacts-tester/`. It wraps the production renderer, package installer and runtime,
opens local archives after execution approval, supports isolated named profiles, real
viewport resizing, diagnostics, and optional native menu-bar testing. It does not install
or update the daily app. `TOOLBELT_TESTER_PROFILE` selects a persistent profile name;
`TOOLBELT_DEBUG_PORT` optionally enables local `/state`, POST `/eval` and POST `/control`.

Full implementation and verification evidence remains in `architecture2-progress.md` until
the user's review. The requested documentation cleanup is a later pre-main-merge gate.
