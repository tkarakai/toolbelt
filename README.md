# Toolbelt

One app, one menu bar icon, many small tools.

Toolbelt is a macOS app that hosts **plugins**: small tools, each with its own repository and
release cycle. A plugin is a TypeScript program that describes its screens; Toolbelt draws
them with one shared component library (React + [shadcn/ui](https://ui.shadcn.com)), so every
tool looks and behaves like part of the same app.

- **The window** — a sidebar that picks the tool (resizable, collapses to an icon rail), and
  each tool's pane with its own tabs, toolbar, tables, forms and inspector.
- **The menu bar icon** — lists the installed tools; each can offer a compact *quick view*
  right there, without opening the window.
- **The `tb` command** — every plugin can ship a command line too: a TUI for people and
  machine-readable (`--json`) commands for scripts and agents. `tb ps` lists your processes.

Status: early. The first plugin is **Toolbelt Processes**
([toolbelt-ps](https://github.com/tkarakai/toolbelt-ps)), a reimplementation of
[running](https://github.com/tkarakai/running). For now it bundles running itself (vendored in
`plugins/processes/running/`): its engine, and its terminal UI, which Processes › Settings can
put on your PATH as `running` (with its zsh hook in `~/.zshrc`) and remove again.

Built with [Electrobun](https://github.com/blackboardsh/electrobun) (Bun + the system web view).

## Development

```sh
bun install
bun run dev        # build and launch Toolbelt (menu bar icon; ⌃⌥⇧T opens the popover)
bun run preview    # the UI in a browser with the real plugins: http://localhost:5174
bun run typecheck && bun test
bun run build      # artifacts/: the .dmg and the update bundle
```

Toolbelt starts in the menu bar only; click the process-list icon, press the shortcut, or "Open
Toolbelt" for the window. The first run downloads Electrobun's build tool (Hutch) through the
pinned `electrobun` npm package, which checks its SHA-256.

## Writing a plugin

A plugin is a folder with a `toolbelt.json` and a program. The program describes its screens;
Toolbelt draws them.

```ts
import { definePlugin } from "toolbelt/sdk"; // for now: src/sdk in this repo

let count = 0;
definePlugin({
  render: {
    "screen:main": () => ({ type: "page", actions: [{ id: "bump", label: "Bump" }],
                            children: [{ type: "text", text: `Clicked ${count} times` }] }),
    quick: () => ({ type: "stats", items: [{ label: "Clicks", value: String(count) }] }),
  },
  onEvent: (_surface, name, _payload, ctx) => { if (name === "bump") count++; ctx.invalidate(); },
});
```

The protocol and every component are in [`src/shared/protocol.ts`](src/shared/protocol.ts);
[`plugins/showcase`](plugins/showcase) uses all of them. Toolbelt finds plugins in
`~/Library/Application Support/Toolbelt/plugins/<id>/`, in its bundle, and in the folders listed
in `TOOLBELT_PLUGINS` (colon-separated). Each plugin gets its own data folder,
`~/Library/Application Support/Toolbelt/data/<id>/`, as `TOOLBELT_DATA_DIR` (`dataDir()` in
the SDK).

### Development app identity

`bun run dev` runs **Toolbelt Dev** with its own bundle identifier, amber Dock/menu-bar
icons, a DEV badge, and preferences in `~/Library/Application Support/Toolbelt Dev`.
Its default shortcut is **⌃⌥⇧⌘T**, leaving the official app's **⌃⌥⇧T** available.
`TOOLBELT_CONFIG_DIR` still overrides the preferences directory for test runs.
`bun run build` produces the official Toolbelt identity; development builds do not self-update.
Generated apps live under `build.noindex/` and are unregistered after each build, so they
stay out of Spotlight and app launchers. The official app is installed from its release DMG
into `/Applications/Toolbelt.app`.

## Releases

Like Running, each release attaches three Apple silicon downloads: `Toolbelt-X.Y.Z-arm64.dmg`
for the desktop app, `toolbelt-X.Y.Z-macos.tar.xz` for the bundled `running` terminal UI
(requires the Bun version listed in the release notes), and
`toolbelt-X.Y.Z-macos-arm64-standalone.tar.xz` for the same TUI with Bun embedded.
Both archives contain one executable named `running`; its upstream version is separate
from Toolbelt's release version. The app can also install the TUI from Processes › Settings.

Prepare a release PR with the version in `package.json` and a dated `CHANGELOG.md` section.
After CI passes and it is squash-merged, use a clean, up-to-date `main` checkout, with its
dev app stopped: `bun run release --dry-run`, then `bun run release`. Both run typecheck,
tests and builds, mount and verify the DMG's version, identity and signature, and extract
and smoke-test both terminal archives. Publishing pushes the tag, creates a draft, uploads
all three downloads with retries, then marks the release latest. Only the DMG is used by
the app's GitHub updater; Electrobun's intermediate artifacts are not release downloads.
