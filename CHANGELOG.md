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
- Themes: Graphite, Nord, Solarized, Gruvbox, Catppuccin, Tokyo Night and Rosé Pine, each light
  and dark, with Light / Dark / System — every one checked for WCAG AA contrast. Selected rows
  and items stand out in the theme's selection color.
- Search matches much more (PID, ports, folders, agent, branch, child processes…), tolerates a
  typo, and highlights the hits.
- Processes: AI agents show working / idle time, model and tokens; Restart and Force stop.
- A real app icon. The menu bar icon stays highlighted while the popover is open.
- ⌘Q quits, ⌘, opens Toolbelt's settings, ⌘B toggles the sidebar (menu items); ⌘ hints show
  instantly; double-clicking the title bar zooms the window.
- Plugins can show long-running work: cards with actions, label/value details, progress bars
  (with elapsed time), command logs that follow the newest line, and Markdown (release notes;
  links open in the browser, raw HTML is never interpreted). Plugins can open their own dialogs,
  tables can have checkboxes with actions for the selected rows, and times can be shown
  relative to now ("in 2h 14m"), kept current by Toolbelt. Each plugin gets a data folder
  (`TOOLBELT_DATA_DIR`). The Showcase plugin has a *Tasks* tab with all of these.
- Processes has everything running's TUI has: sections by terminal (Orca, tmux, Detached…),
  folders with their git branch, jobs started from jobs nested under them; output and agent
  conversations; keep / edit / forget (with undo) / reorder kept commands; copy the command
  line; "why is it still running"; jobs whose launcher exited; apps hidden until asked for;
  CPU and memory sparklines; sort from the toolbar; shell integration status.
- Tables group in levels (sections, then folders) with indentation; folders in their own color.
- Quitting asks first (⌘Q, Quit buttons) — ↵ quits, esc stays, ⌘Q twice quits.
- The menu bar icon really stays highlighted while the popover is open.
- Search hits are a warmer yellow and no longer shift monospace text.
