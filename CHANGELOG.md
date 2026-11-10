# Changelog

## Unreleased

- Bundle Upkeep: discover apps, runtimes, packages and git clones; opt in to watching them,
  check every six hours by default, review updates, and follow the queue and audit logs.
  Automatic updates stay off until enabled. Bulk updates exclude apps and major upgrades.

- Replaced the belt artwork with Running's process-list icons: midnight-blue official and
  amber dev Dock icons, matching menu bar glyphs and a red update badge.
- Releases include three downloads, matching Running: the desktop DMG, the bundled
  `running` terminal UI for Bun, and a standalone terminal UI with Bun embedded.

- App and folder headers show matching-command memory totals (RSS), independent of expansion. Memory sorting ranks groups by their largest command; totals are informational and include nested jobs without recounting expanded child processes.

- Filter selectors match the fixed-width search field’s height. Dropdown searches retain typing focus, scroll only vertically, and stay open when Show all clears selections.

- Fixed selected-row contrast for neutral status pills (including idle), placeholders, path labels, branch pills and open action buttons.

- The menu bar popover fits its tools, up to six rows, then scrolls without a scroll bar.
  Each tool has a visible letter shortcut that opens it in the main window.
- Processes tabs use ⌘P, ⌘K and ⌘S, with visible hints and an inverted active-tab selection.
  Settings in the sidebar is a cog with ⌘,; dialogs and action buttons show their shortcuts.
- Processes includes terminal shell scripts, including commands that do not listen on a port.
- Kept commands support notes and an environment editor with multiple editable variables,
  inclusion controls, removal and secret masking. Saved variables are used when starting commands.
- Kept commands offer Start in the default terminal, a Start in… submenu/dropdown for other
  installed terminals, and Reveal directory in Finder. Settings explains the default terminal.
- Known AI agents have colored badges and bundled logos where available. Codex is blue,
  Claude amber; agents waiting for input have pulsing fuchsia dots.
- Agent and State filters share the row-dot classification, show zero-count options below
  a divider, and support searching options without changing selections. Active filters and
  nonempty search fields have a highlighted border and tinted background.
- CMUX processes show saved workspace/surface names; Jump to terminal targets that surface.
  tmux sessions share one TMUX section, grouped by directory, with session names alongside titles.
- Compact rows show one port plus an overflow count and one ellipsis that opens the standard
  labeled action menu with icons, shortcut hints and submenus. Truncated descriptions expose
  their full text on hover. Removed Refresh; the list updates automatically.
- Selected rows preserve readable semantic colors, tested for contrast in every theme.
  Fixed group-selection styling and switch/checkbox state styling and positioning.
- Row actions support keyboard shortcuts and target selection for individual child processes;
  details list the processes a command started, with Peek/Open actions.
- Folders emphasize their project name; branches have violet pills; heavy CPU and memory
  have warning colors; running kept commands have a bookmark.
- Toolbelt explicitly activates its process before handing focus to a terminal, to retain
  its place in the macOS application switcher.
- Toolbelt Dev has a separate bundle identity, preferences, amber Dock/menu-bar icons,
  a DEV badge and a global shortcut that can coexist with the official app.
- Right-click menus stay available in text fields and selected text. Keyboard navigation
  keeps rows visible below the table header and restores list focus after menus close.

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
- Processes ships running: its engine and its terminal UI are vendored and bundled with the
  app (no checkout needed). Its Settings has one section for the `running` command and its zsh
  hook: where the bundled TUI is, what a new terminal finds (path, version, hook loaded),
  Install (puts `running` on your PATH via `~/.local/bin` and the hook in `~/.zshrc`; an existing
  `running` is moved aside, not overwritten), Remove (deletes exactly what Install added) and
  Check again. Sort, order and "show apps" left Settings: they're on the Processes toolbar.
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
- **Motion is part of the design**: the popover opens and closes with an animation; tabs,
  tools and Toolbelt's page fade in; the details drawer slides open and closed; dialogs, menus,
  newly expanded rows, group chevrons and the zoom indicator all move — 200 ms by default, and
  almost none for people who ask macOS for reduced motion.
- **Zoom**: ⌘+ / ⌘- / ⌘0 (View menu) scale the window's text, with a short-lived indicator in
  the top right. Inside the output dialog they zoom only the terminal (or the conversation).
- **Narrow windows** hide columns from the right and keep the first one; plugins can rank
  columns (`priority`) and set the main column's `minWidth`. Long group headers truncate
  instead of widening the table.
- **Sort by clicking column headers** (again to reverse); the arrow shows the order. Processes'
  toolbar sort buttons are gone, and "Show apps" is a switch.
- **Every row can be selected**, group headers included: ↑/↓ no longer skip them, ←/→ or ↵
  collapse and expand a group, and its drawer shows what it holds.
- **Row menus and the drawer group their actions** (plugins say which belong together:
  `Action.group`). The open "⋯" button no longer turns invisible on a selected row.
- **The details drawer** has a header with the status and ports, small CPU / memory / uptime
  tiles with trends, details in sections (Command, Network, Agent, Process) with copy buttons,
  long values folded, and its actions arranged by group with Stop and Force stop apart.
- **Apps show their macOS icons** — app rows, and sections for apps and terminal apps (Orca,
  Ghostty…). Plugins can use any app's or file's icon (`app:/path`, `file:/path`).
- **Peek** (was "Show output") opens a dialog you can resize and maximize, showing output in a
  real terminal emulator: colors, wrapping that follows the width (or off, scrolling sideways,
  for full-screen programs — the wrap button switches), up to 1,000 lines. Agents get a
  **Conversation** view that looks like a chat: your messages, the agent's answers as
  Markdown, and its tool calls folded into compact rows. "Show in terminal" is now
  **Jump to terminal**.
- **Toolbelt remembers where you were**: each tool's tab, and each screen's selected row,
  expanded rows, collapsed groups, filter and scroll position — across closing the window and
  restarts. Processes remembers "Show apps" and where kept commands start.
- Esc on Toolbelt's page, or its new close button, goes back to the tool you came from.
- Toolbelt updates itself from GitHub releases: it checks at launch and every 6 hours (and
  after waking, and when the window opens if it's been an hour); a newer version puts a red dot
  on the menu bar icon, on *Toolbelt* in the sidebar and in the popover. Toolbelt's page shows
  the version, when it last checked (*Check now*), and what's new; *Update* downloads the disk
  image with progress (cancellable), checks its checksum, bundle id, version and signature,
  swaps the app in place and reopens it. *Check for Updates…* is in the app menu. Dev builds
  don't update themselves.
