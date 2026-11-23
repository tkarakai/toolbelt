# Changelog

## Unreleased

## 0.3.14 — 2026-11-23
- Keyboard first: everything in ToolBelt can now be used without a mouse, and you can always see where the keyboard is.
  - F6 and ⇧F6 move between the sidebar, the tabs, the screen and the details drawer, and come back to where you were in each. A screen takes the keyboard when it opens, so the arrow and Page keys scroll it right away.
  - Focus rings are stronger and show on every control. A list or table you tab into with nothing selected shows a ring, and any arrow key selects its first row (←/→ too, which used to do nothing). A list or table without the keyboard shows its selection in a quieter color, so the full selection color always marks where your keys go.
  - Arrow keys stay with what you're on: ←/→ on screen tabs, a segmented control or a radio group no longer also move the table. Lists on a screen take arrows only once you're in them, so the arrows scroll a page that merely contains a list.
  - The sidebar's tools, the color scheme and the theme choices are one Tab stop each; arrows move between them (and pick a scheme or theme). Tab no longer stops at every row's ⋯ button (`.` opens it).
  - Return on a row without a main action opens its ⋯ menu (as `.` does) instead of doing nothing.
  - Tables: Page Up/Down move a screenful of rows, ⌘↑/⌘↓ move the selected row in tables you can reorder (into the next section at its edge), → goes into the details drawer for any row, and ⌥←/⌥→ move a focused column header. The sidebar, details drawer and column edges can be focused and resized with ←/→ (↵ resets).
  - Closing a dialog puts the keyboard back where it was, also for dialogs opened from a key, a menu or a plugin; when the thing you were on disappears (a deleted row), focus moves to its list instead of getting lost.
  - Fixed: Tab could not leave a terminal output view. Tab, Esc and F6 now leave it, and the arrow and Page keys scroll it.
  - Fixed: the closed details drawer's controls could be reached with Tab although they weren't visible.
  - Tab now reaches every button, link and pop-up menu on every Mac. Before, with macOS's Keyboard navigation setting off (the default), Tab skipped them: the filters, a dialog's buttons, the due date and labels pickers, the details drawer's ⋯ menu and its other buttons.
  - In plugin dialogs, ⌘↵ runs the main button (Save, Snooze, Watch…) from anywhere, and the button shows ⌘↵. Return no longer submits from a field: like Space, it opens the focused picker (a date, a list), ticks a checkbox or flips a switch, presses the focused button, or starts a new line.
  - Column headers and resize edges say what their keys do while they have keyboard focus.
  - Removing a plugin starts on “Keep plugin” rather than on the “delete data” checkbox.
  - Screen readers hear tables, lists and their selected row, row levels and expanded state, and buttons' shortcuts without the key pictures read as part of their names. Settings → Keyboard lists the new keys.
- Fixed: a link to a screen a plugin doesn't have opens its first screen instead of loading forever.
- Grouped tables indent consistently: everything inside a section or group has its open/close arrow (or unread dot) start right where the group's icon, or its title without one, starts, whatever icon the group shows. Tables with checkboxes line up the same way.
- Lists move: when rows are reordered, whether by a plugin, by dragging or with ⌥↑/↓ (a plugin's move keys), they slide to their new places over 300 ms instead of jumping, and a dropped row slides in from where you let go. New rows fade in, removed rows fade out before the others close the gap, and expanding or collapsing a group slides the rows below. This works in tables, lists, timelines and the menu-bar quick view. Searching, filtering and sorting still update at once, and Reduce Motion turns it all off.
- Fixed: the update badge on the sidebar's settings cog is no longer cut off at its top and right edge.
- Quitting from the menu-bar popover now closes the popover and its quick view and asks in their place: the Quit ToolBelt? confirmation appears where the menu was, with its top-left corner in the same spot, and nothing behind it dimmed or blurred.
- Fixed: with the quick view open, clicking the empty space next to it or under the menu (or above the quick view) closes the popover, like clicking anywhere else on the screen.

## 0.3.13 — 2026-11-22
- Grouped tables line up: a section's or group's tasks now start exactly where its title does (the unread dot sits just before them), and a group inside it has its open/close arrow under the title too, instead of fixed steps that lined up with nothing.
- Plugins can give a toast's button a ⌘ shortcut, such as ⌘Z for Undo. The button shows the key, and pressing it while the toast is up works like clicking. In a text field ⌘Z still undoes your typing.
- Plugin development mode: test unreleased plugin archives in ToolBelt itself. Settings → Plugins → Plugin development relaunches ToolBelt with a separate, named development profile where you open a built `.tar.gz`, optionally have rebuilds install automatically (switch it per plugin under Installed Plugins; the same version can be rebuilt there, and the choice is remembered), and read diagnostics. Released plugins don't run while you're in development mode, nothing carries over to your normal plugins, and quitting always brings ToolBelt back in normal mode. This replaces the standalone Plugin Tester app, which is no longer built or published.
- Plugin tables can have sub-sections inside a section, such as Working, Snoozed and Watching under Progressing. They look like sections, indented under their parent, show even when empty (for example “Nothing snoozed”), collapse on their own and remember it, and take rows you drag into them. Collapsing the parent hides them.
- Fixed: a row you select in the menu-bar quick view is now revealed in the main window even inside a section that starts collapsed.
- Fixed: in an open action menu (a row's ⋯ menu, the drawer's ⋯ menu or a split button's alternatives), pressing an action's shown key now runs that action, as clicking it would, instead of only moving the highlight to an item starting with that letter. Other letters still jump to matching items, and an action with several targets asks which one (1…9 pick).

## 0.3.12 — 2026-11-15
- Plugins can let you edit a row right in the details drawer: a title you click to rename, properties that look like text until you hover them, a description that turns into an editor when you click it, and a box to write updates. A slim bar above shows the row's actions as icons, with everything in a ⋯ menu.
- → on a row moves into its details drawer (opening it if it's closed); Esc comes back to the list. Plugins can choose what Return does on a row, such as starting an update in the drawer.
- Plugins can show a box to write something new (an update, a quick task), let you edit a timeline entry's text in place, and ask for a line of text before running an action, such as adding an update from the menu-bar quick view.
- Fixed: after you moved through a list with the arrow keys, ← / → and Tab could still act on the screen tabs (switching screens) because focus had stayed there. Moving through the list now brings the keyboard into it.

## 0.3.11 — 2026-11-15
- A new date and time picker for plugin forms. The field reads its value in words (“Fri, Nov 20 · 2:30 PM”, “in 5 days”) and shows “No date” when there is none, instead of a placeholder that looked like a date. Type dates the way you say them (“fri 5pm”, “+3d”, “next mon”, “nov 20”), pick a quick choice, move through the month with the arrow and Page keys, and type a time as “930”, “2pm” or “14:00” (↑/↓ change it by 15 minutes). ⌫ clears it.
- Plugins can show timelines: dated notes in Markdown, such as a task's status updates. Move through them with ↑/↓, edit with the plugin's key, and delete with ⌫ (after confirming).
- The details drawer can show Markdown, for example a task's description and updates, with their own edit and delete buttons.
- Dialogs can focus a chosen field when they open or when the plugin switches forms, so you can type at once.
- Fixed: Return in a confirmation (such as “Delete this task?”) confirms, as its key hint says; focus used to start on Cancel.

## 0.3.10 — 2026-11-15
- Plugin tables can look like a document: one background, no lines between rows or tinted section headers, and rounded hovered and selected rows. Sections, nesting, the keyboard, dragging and the details drawer work as before.
- Plugin tags can show shades of their color, for example High, Medium and Low from strongest to lightest. Every shade keeps its text readable in every theme.
- Plugin toolbar buttons can have a shortcut key, shown on the button (for example N for New task).
- Dialogs are easier to use from the keyboard: the first field has focus when a dialog opens, Return in a one-line field saves, ⌘Return saves from any field, and Tab no longer gets stuck in Markdown editors. Dialog forms line up their labels and use the dialog's width, and resizable dialogs open at a comfortable size.
- Fixed: an empty section (such as an empty Pinned) couldn't be selected with the arrow keys, so the selection disappeared when you arrowed onto it.
- Fixed: on screens with two tables, the arrow keys moved the selection in both.
- When an action you run removes the selected row or moves it into a collapsed section, the selection moves to the next row instead of disappearing.
- Fixed: rows whose tag list was empty showed a stray “0” under their name.

## 0.3.9 — 2026-11-15
- Plugins can show more kinds of form fields: several lines of text, a Markdown editor that styles what you type as you type it, a date with an optional time, color swatches, a searchable list, and colored label pills you add, change and remove in place.
- Plugin tables can have fixed sections that show even when empty, mark rows unread (a bold title and a blue dot), and let you drag rows to reorder them or move them between sections. While you drag, a line shows where the row will land and a label says what the drop does (for example “Settle”); Escape cancels.
- Plugin shortcuts can use ⌥ and ⇧, for example ⌥↑ to move a row up.

## 0.3.8 — 2026-11-15
- Table rows animate when a plugin's refresh changes them. Rows that change places slide to their new position (200 ms), and removed rows fade out where they were (150 ms) before the rows below close the gap. New rows already faded in. Your own changes (sorting, filtering, typing, collapsing, clicking), the first paint and Reduce motion change the table at once. A refresh that removes more than 30 rows doesn't fade them.
- When a plugin stops with “Invalid protocol message”, the message now says why: the field that was wrong, nesting deeper than the protocol allows, too many values, or output that isn't JSON.

## 0.3.7 — 2026-11-15
- Tables and lists keep your scroll position when the plugin refreshes. They used to scroll the selected row back into view (and reopen its collapsed parents) on every refresh, for example every two seconds in Processes. They now do that only when the selection changes.

## 0.3.6 — 2026-11-15
- Plugin buttons can be split buttons: the button runs the main action and its chevron opens alternatives (for example Update ▾ Review first). Row menus list the alternatives under their action, and their shortcut keys work on the selected row.
- Plugins can take you to one of their screens, with an item selected, right after you act on them (for example a toast's Show button). Plugins can't switch screens or bring the window forward on their own.
- Show or hide the details drawer with ⌥⌘B (View → Toggle Details).
- The sidebar, details drawer and Settings icon buttons in the window no longer show a permanent shortcut hint. Hovering or focusing them shows a card with what clicking will do now ("Collapse sidebar", "Show details", "Open settings") and its keys.
- Column dividers in table headers are always visible, so it's clear where to drag.
- A manual "Check for updates" (app or plugins) now always reports the result, including when everything is up to date.
- Development builds keep their orange menu-bar icon when the update badge shows.
- Dragging a column's edge now moves only that edge, under the pointer: the columns to its right give up or take the width, and nothing to its left shifts. Double-clicking an edge restores both neighbouring columns.
- Table sparklines sit before their value, so the newest point is next to the number it matches.
- Folder group headers show the directory as a blue pill beside the violet branch pill, and group item counts are pills too.
- The details drawer stays open or closed as you leave it for each plugin, whatever you select. Toggle it from the panel button at the top right of the pane. The drawer no longer has its own close button.
- Selection shared between the window and the menu-bar quick view no longer jumps back when copies of an earlier change arrive late, and quick-view hover no longer selects items that move under a still pointer.

## 0.3.5 — 2026-11-14
- Tables size columns from declared widths: only growing columns follow the window, and other columns hide by priority once those reach their minimum. Drag a header edge to resize a column (double-click restores its default) or drag a header to reorder columns; ToolBelt remembers both per plugin table. Sparklines and port chips show again whenever their cells have room.

## 0.3.4 — 2026-11-12
- Allow manual app release checks in development builds after GitHub cooldowns expire, while keeping scheduled app checks and self-installation disabled.

- Align recovery message text and the quota timeline control with the header icon in both ready and warning boxes; use a compact dropdown-style timeline button without its call-count subtitle.

- Expand timeline request details across the full table width, with response fields arranged in columns to reduce scrolling.

- Show the parsed local timestamp beside GitHub’s x-ratelimit-reset value in request details.

- Place Keyboard second in Settings, after Appearance, with tab navigation following the displayed order.

- Collapse the update warning into its title and live retry time, and remove extra explanatory lines and dividers.

- Keep quota analysis collapsed initially with animated, keyboard-accessible disclosures, respecting reduced motion. The failure message shows the latest call’s HTTP status, time and age; response diagnostics live in the timeline.

- Show a rolling 24-hour GitHub quota timeline inside update recovery warnings, with every host release lookup, download and redirect, response quota details, and observed usage changes beside ToolBelt call counts.

## 0.3.3 — 2026-11-12
- Keep Quit and Cancel side by side in the popover quit confirmation.

- Show when GitHub failures were received and their live age, label GitHub-supplied versus fallback retry times, and retain quota and request diagnostics in response details.

- Share GitHub recovery notices across About and Plugins, expire retry/error notices after two hours, and explain rate-limit-disabled request buttons with retry-deadline tooltips. Other GitHub failures stay retryable and show their failure time in a red notice.

- Show one section-wide amber notice while update checks are paused, switching to a green retry notice after the cooldown. Plugin review includes release notes and a publisher link to the exact release; drag dialogs by their header and resize with an unobtrusive corner grip.

- Explain app and plugin release-check failures, show retry timing, and respect GitHub cooldowns. Cache release metadata with ETags, share concurrent lookups, and retain previously found releases with their last successful check time.
- Explain manual app installation and the macOS verification warning in the README and Settings/About manual guide, including copied instructions.

- Retry transient disk-image creation and verification contention for app and Plugin Tester packaging before failing the build.

## 0.3.2 — 2026-11-12
- Collapse the popover quick view before showing quit confirmation to avoid blurring the desktop between panels.

- Give dialog headings framed icons matching the plugin cards in Settings.

- Refine update guidance, plugin card separation, shortcut navigation and reflection, dialog headings, activity controls, and scrolling feedback across app and plugin screens.

## 0.3.1 — 2026-11-12
- Support segmented page toolbar controls with hover and keyboard-focus explanations.

- Copy app and plugin manual update instructions, including their release link, for saving elsewhere.

- Preview failed update checks, cached availability and the always-available manual guide in the development update simulator.

- Offer calm recovery cards for failed app and plugin update checks, with always-available browser release guides and explicit plugin-tag review through the verified installer.

## 0.3.0 — 2026-11-11

- Include app artwork in standalone Plugin Tester build staging so shared update screens bundle successfully.

- Open plugin and app repository links from Settings in the default browser.

- Keep app update release notes in the review dialog instead of repeating them on About.

- Share header tab geometry between Settings and plugins so label-to-shortcut spacing matches.

- Match the sidebar Settings shortcut background to shared keyboard hints.

- Use the app artwork without a redundant Running status, capitalize Install New Plugin, and retain recent check activities across restarts without replaying old error toasts.

- Position update badges at the top right of icons and tab labels, and match the About app release card to installed plugin cards.

- Remember the Settings tab, guide update navigation with consistent exclamation badges, and preview app update stages in development without installation.
- Show release-review errors as toasts, distinguish explicitly requested plugin tags, and resize dialogs from the dragged edge.

- Show recent timestamped plugin activity and update-check error toasts, clarify installed release metadata and Reload controls, and allow moving release review dialogs.

- Separate installed plugin releases, future update preferences and discovered update channels; preserve update preferences when installing another release.
- Add inline channel selectors, delayed check-time tooltips and resizable release reviews with explicit Install/Update actions.

- Keep Settings section geometry stable, lock tab strips to horizontal scrolling, and add a short Privacy Policy.
- Redesign Installed Plugins cards with icons, status pills, independent versions, reload controls and grouped action menus. Check all plugins from the section header; review available updates separately.

- Activate new and existing main windows on navigation, preserve header drag areas beside tabs, and blend tab overflow controls into the strip.
- Use shared grouped sections for Keyboard and Plugins, with project repository links alongside published license files.

- Refine Settings with illustrated color schemes, icon tabs and Command-letter shortcuts; close direct Settings navigation onto the first available plugin.
- Compact license notices, link published license files, and highlight live search matches with the shared search color.

- Organize Settings into Appearance, Plugins, Keyboard and About tabs, consolidate tool management, and route update navigation to About.
- Improve shared hover contrast, keyboard pane navigation, overflow tab scrolling and nested searchable license notices. Escape from the popover restores the preceding application.
- Add dependency acknowledgments, release commit labels and NetSense LLC copyright notices.

- Preserve a newer Latest when recovering an older stable app or plugin release; serialize publication across release tags.

- Retry an untagged release using its original merged PR or exact source commit, even after main advances; refuse conflicting tags and missing or expired frozen candidates.

- Validate SDK release-only PRs and SDK candidates without building native app disk images; retain complete SDK checks and full app CI for implementation changes.

- Start popover and first quick-view entrance animations on visible renderer frames so reopening the native window reliably animates.

- Add About ToolBelt to the macOS app menu, using the standard version and app information panel.
- Standardize the displayed app name as ToolBelt and add a native menu bar tooltip.
- Use neutral update indicators and a compact popover header summary with delayed hover details for app and plugin updates; activation opens Settings at Updates.
- Keep the app shortcut beside its name and add Settings with its shortcut to the popover footer.

## 0.2.2 — 2026-11-11
- Align column-bound group totals with their table values, including when groups are collapsed or columns resize.

## 0.2.1 — 2026-11-11
- Keep the selected plugin’s quick view beside the popover list, aligned to its row with a
  slight overlap on the side with room. Hover, Up/Down and plugin hotkeys select; click or
  Enter opens the main window. Plugins without quick views keep the compact list. Remove
  the redundant Open Toolbelt button from the popover footer.
- Side arrows switch keyboard focus between the list and quick view, restoring each
  selection. Active and inactive selections use distinct fills, with a subtle active-pane
  border. One selected item per plugin stays synchronized between the main window and quick
  view; Enter from either pane carries it into the main window. Remove Command+Enter hints
  and behavior. Delay the first quick view by 200 ms without moving the menu, with directional
  reveal and close transitions from the selected plugin row.
- Drag plugins to reorder them in the menu-bar popover or window sidebar, with animated
  pickup and placement, spring-driven sway, and one saved order shared by both surfaces.

## 0.2.0 — 2026-11-11
- Non-interactive release PR preparation and verified CI publication through the shared SDK release tooling. App updates recognize release candidates and select the exact app DMG.

- Install, enable, disable, update and remove independent prebuilt GitHub plugin packages without restarting Toolbelt.
- Review publisher identity, compatibility and exact package bytes before execution; show lifecycle diagnostics, notify-only updates, channel preferences and safe cancellation.
- Keep plugin data on removal by default, offer explicit deletion and confirmed CLI-cleanup navigation, and recover compatible code or matching managed-data snapshots.
- Ship the removable SDK Explorer and publish the public SDK plus standalone Plugin Tester with the app. Processes and Upkeep are installed separately from their own repositories.
- Render versioned plugin assets and declarative screens with shared main-window and menu-bar components, bounded protocol validation and per-plugin failure containment.
- Generated app bundles stay out of Spotlight and app launchers, preventing duplicate official Toolbelt entries alongside the installed release.

## 0.1.0 — 2026-11-09

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
  JSON-lines protocol (v0). *Processes* drives
  [running](https://github.com/tkarakai/running)'s engine.
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
  (`TOOLBELT_DATA_DIR`).
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
