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
[running](https://github.com/tkarakai/running).

Built with [Electrobun](https://github.com/blackboardsh/electrobun) (Bun + the system web view).

## Development

```sh
bun install
bun run dev        # build and launch Toolbelt (menu bar icon; ⌃⌥⇧T opens the popover)
bun run preview    # the UI in a browser with the real plugins: http://localhost:5174
bun run typecheck && bun test
bun run build      # artifacts/: the .dmg and the update bundle
```

The first run downloads Electrobun's build tool (Hutch) through the pinned `electrobun` npm
package, which checks its SHA-256. `bun run dev` with `TOOLBELT_OPEN_WINDOW=1` also opens the
window.

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
in `TOOLBELT_PLUGINS` (colon-separated).
