---
name: toolbelt
description: Read the person's ToolBelt (Mac menu bar app) plugin screens — tasks and to-dos (OnTrack), software updates (Upkeep), and whatever other plugins they installed — and, in plugins they allow, run actions and fill forms, with the `toolbelt` command. Use when the person asks about their tasks, what needs updating on their Mac, or anything they track or want done in ToolBelt.
---

# ToolBelt

ToolBelt is a Mac menu bar app. Its plugins show the person's own information: tasks
(OnTrack), software updates (Upkeep), and others. The `toolbelt` command reads what those
plugins show, through the running app. You can look things up and explain them, and, when the
person asks to see something, show it on their screens. In plugins the person lets agents act
on, you can also run actions and fill forms (`act`, `fill`); changes ask the person in ToolBelt
first. In other plugins you can't change their data: when the person wants something done, tell
them where to do it in ToolBelt (plugin › screen › action).

## Commands

```sh
toolbelt status                      # app version, plugins, their screens — start here
toolbelt screens [plugin]            # screen ids for `read`, with each screen's view controls
toolbelt read <plugin> [screen]      # one screen as text (default screen if omitted)
toolbelt read <plugin> <screen> --filter status=done --sort tasks=-due --search budget
                                     # your own view: searched, filtered, sorted in one call
toolbelt read <plugin> <screen> --person   # exactly what the person's screens show now
toolbelt show <plugin> [screen] --filter status=done   # show the person (asks them first)
toolbelt show <plugin> <screen> --row <row id>   # show one row selected, its details open
toolbelt read <plugin> <screen> --details   # with each row's details: notes, history, drawer
toolbelt read <plugin> <screen> --table <id> --offset 100    # next page of a long table
toolbelt read <plugin> <screen> --table <id> --parent <row id>   # a row's child rows
toolbelt search <words…> [--plugin <id>]   # lines mentioning all words, across screens
toolbelt plugins                     # installed plugins and available plugin updates
toolbelt act <plugin> <screen> <action> --row <row id>   # run an action (id or label)
toolbelt act <plugin> <screen> <action> --row a --row b  # a bulk action on several rows
toolbelt fill <plugin> <screen> <form> --set Title="Buy milk" --set Store=Bakery
toolbelt read <plugin> <screen> --acting   # your acting copy: dialogs you opened, drafts
```

Add `--json` for structured output (times also as ISO 8601). `--max-rows 0` shows only each
table's size and columns. Plugin and screen ids match in any case. Exit code 2 means the
request was refused or failed (unknown plugin, screen, table or option, plugin not running);
1 means ToolBelt couldn't be reached. Changes the person didn't approve also exit with 2.

## Reading screens

- Tables print as `- cell · cell · cell  {id: …}` under `### section` headings; with
  `--details`, each row is followed by its indented details. Narrow a long table first
  (`--table … --offset …`, `--filter`, `--search`). Times are absolute local time with a relative hint.
- `read` gives you your own copy of the screen as it starts (the plugin's default filters,
  which may hide finished items). Narrow or widen it with `--search`, `--filter` (`ID=` for
  all options), `--sort` and `--control`; `screens` lists each screen's controls and options.
  The person's screens never change when you read.
- `--person` reads what the person sees; its `Filter`, `Search` and `Dialog open` lines are
  what they set, so rows outside them are not listed.
- `show` changes what the person's screens show. Use it only when they ask to see something.
  The first time, ToolBelt asks them to allow it and for how long, and waits up to a minute.
  It reports devices that don't show it (window closed, device without ToolBelt open): tell
  the person and ask what to do; `--open-window` opens the window on the Mac.
- `Row actions` and `Toolbar actions` name what the person can do on that screen; a row that
  allows fewer lists its own `(actions: …)`. In plugins you may act on, each action shows its id
  where it differs (`Snooze [snooze]`) and what it does: `(write)` changes data, `(write, asks)`,
  `(external, asks)` and `(destructive, asks)` always ask the person; no mark only changes your
  copy (opens a dialog, copies text). Fillable forms list each field's id, type and options.

## Acting

- `act` and `fill` work in your own acting copy of the screen, separate from the person's: a
  dialog you open and the draft you fill are yours, for 10 minutes after your last command. One
  script's or shell's commands share it, so open a dialog with `act`, fill it with `fill`, then
  `act` its main action. View flags (or `--person`) on `act`/`fill` change that copy's view first;
  use `--person` to act on a row you found with `read --person`.
- Changes ask the person on their ToolBelt screens and the command waits up to a minute. Run a
  change only when the person asked for it or agreed, and say what you're about to do. Exit code 2
  with "didn't allow": don't ask again unless they ask; "didn't answer": ask whether to try again;
  "the screen changed": read it again first. "Nobody can approve this": ask the person to open
  ToolBelt, or whether to pass `--open-window`.
- A row the view hides is refused with the view that shows it: pass that view. Bulk actions take
  at most 200 rows. Toasts, clipboard text and navigation an action causes come back to you in the
  result; nothing reaches the person's clipboard or moves their screens (use `show` for that).
- `--autonomous` sessions can't ask: only what needs no approval, or what the person allowed for a
  while ("Allow changes in …"), runs.
- `search` lists screens it couldn't read: matches there are unknown, not absent.
- Values marked `••••••` are secrets ToolBelt keeps from agents (fields the plugin marks
  sensitive, and anything that looks like a token or password, such as in command lines).

## Limits

- Some plugins are not available to agents (the plugin opted out, or the person turned access
  off in Settings → Agents). `status` says how many; don't guess their contents.
- If ToolBelt isn't reachable, ask the person to open ToolBelt and turn on Settings → Agents →
  "Let agents use ToolBelt".
