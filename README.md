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
