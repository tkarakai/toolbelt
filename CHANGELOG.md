# Changelog

## Unreleased

- The spike: Toolbelt as an Electrobun app — a main window with a sidebar of tools that
  collapses to icons, each tool's tabs, tables with groups, row actions and an inspector,
  forms and stats, all drawn with shadcn/ui; a menu bar icon whose popover lists the tools and
  shows their quick views; ⌃⌥⇧T opens it from anywhere. Plugins are Bun programs speaking a
  JSON-lines protocol (v0). Two built in: *Processes* (drives
  [running](https://github.com/tkarakai/running)'s engine) and *Showcase*.
- Keyboard everywhere: ⌘1…9 switch tools (hold ⌘ to see the numbers), ⌥⌘1…9 and ⌃⇥ switch
  tabs, ⌘F or / filters, ↑/↓/→/← move through and expand rows, ↵ runs a row's main action,
  `.` opens its menu; the popover works with ↑/↓/↵/←/esc and ⌘↵ opens the window. ⌘W closes it.
- Rows can have children: a command's other processes expand under it.
- The details drawer is resizable; filters, expanded rows and selection are kept per screen.
- The popover shortcut works without extra permissions and can be changed on Toolbelt's page.
- The popover hangs from the menu bar like a macOS menu; the window's header drags it; the
  collapsed sidebar's corner is one continuous bar.
- Plugins can show long-running work: cards with actions, label/value details, progress bars
  (with elapsed time), command logs that follow the newest line, and Markdown (release notes;
  links open in the browser, raw HTML is never interpreted). Plugins can open their own dialogs,
  tables can have checkboxes with actions for the selected rows, and times can be shown
  relative to now ("in 2h 14m"), kept current by Toolbelt. Each plugin gets a data folder
  (`TOOLBELT_DATA_DIR`). The Showcase plugin has a *Tasks* tab with all of these.
- **Upkeep**, a built-in plugin that keeps what you choose up to date
  ([docs/upkeep.md](docs/upkeep.md)).
  - *Discover* scans this Mac (only when you ask) for Homebrew formulae and casks, Sparkle
    apps, Node (nvm), Bun, Deno, uv, Rust, Go, Claude Code, global npm/uv/pipx/cargo packages,
    and git clones. Things installed more than once are flagged.
  - *Watching* checks the items you added every 6 hours (configurable), with a live countdown
    to each item's next check and *Check now* per item.
  - *Review & update* shows the exact commands and the release notes for every version since
    yours.
  - *Queue* streams live output and can cancel. *Activity* is the audit log of every check,
    update, rollback and setting change.
  - Updates are notify-only until you turn automatic updates on, globally and per item.
    Anything that needs a password, quits a running app, or runs your own commands never
    starts by itself.
  - Also: end-of-life warnings, channels (Node LTS, betas), pin, skip a version, rollback for
    Node and git, signature checks for apps, custom recipes, and a menu bar quick view.
