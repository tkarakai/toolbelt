# Toolbelt Upkeep

Keeps the apps, runtimes, packages and git clones you choose up to date. A plugin for
[Toolbelt](https://github.com/tkarakai/toolbelt).

- **Discover**: scan this Mac (only when you ask) for Homebrew formulae and casks, Sparkle
  apps, Node (nvm), Bun, Deno, uv, Rust, Go, Claude Code, global npm/uv/pipx/cargo packages,
  and git clones, then choose what to watch.
- **Watching**: checks on a schedule (every 6 hours by default) with a live countdown to each
  item's next check and *Check now*. Shows end-of-life warnings and channels (LTS, beta).
  Items can be pinned, have a version skipped, or be rolled back.
- **Review & update**: shows the exact commands and the release notes for every version
  since yours, then runs the update in a queue with live logs and cancel.
- **Activity**: an audit log of every scan, check, update, rollback and setting change.

Nothing is checked or changed until you choose. Updates are notify-only until you turn
automatic updates on. Anything that needs a password, quits a running app, or runs your own
commands never starts by itself. See [docs/design.md](docs/design.md).

Status: first version. It needs a Toolbelt with the protocol additions from
[tkarakai/toolbelt#2](https://github.com/tkarakai/toolbelt/pull/2).

## Development

```sh
bun install
bun run typecheck && bun test
bun run build            # dist/upkeep/: what Toolbelt loads
bun run install-plugin   # build, then copy to ~/Library/Application Support/Toolbelt/plugins/upkeep
```

To run it from this checkout in a Toolbelt checkout, without installing it:

```sh
TOOLBELT_PLUGINS=~/dev/projects/toolbelt-upkeep TOOLBELT_CONFIG_DIR=/tmp/upkeep-trial bun run dev
```

Toolbelt runs `index.ts` directly with Bun. `TOOLBELT_CONFIG_DIR` keeps the trial's data
(watched items, audit log) out of your real Toolbelt folder.

The plugin SDK is vendored in `sdk/` until Toolbelt publishes it as a package. Update it with
`bun scripts/sync-sdk.ts <path to a toolbelt checkout>`.

## Table keyboard shortcuts

Select a row with the arrow keys. Watching: **C** check, **U** review & update,
**N** release notes, **E** settings, **H** history, **S** skip version,
**P** pin/unpin, **R** roll back, **X** stop watching.
Discover: **W** watch, **X** stop watching. Activity: **L** show log.
Only actions available for the selected row run; confirmations still apply.
Shortcuts are shown in row menus and details. **.** opens the row menu,
**Enter** runs the first inline action, and **Space** toggles a bulk selection.
Typing in a search or form field does not trigger row actions.
