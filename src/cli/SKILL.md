---
name: toolbelt
description: Read the person's ToolBelt (Mac menu bar app) plugin screens — tasks and to-dos (OnTrack), software updates (Upkeep), and whatever other plugins they installed — with the `toolbelt` command. Use when the person asks about their tasks, what needs updating on their Mac, or anything they track in ToolBelt.
---

# ToolBelt

ToolBelt is a Mac menu bar app. Its plugins show the person's own information: tasks
(OnTrack), software updates (Upkeep), and others. The `toolbelt` command reads what those
plugins show, through the running app. You can look things up and explain them, and, when the
person asks to see something, show it on their screens. You can't change their data: when the
person wants something done, tell them where to do it in ToolBelt (plugin › screen › action).

## Commands

```sh
toolbelt status                      # app version, plugins, their screens — start here
toolbelt screens [plugin]            # screen ids for `read`, with each screen's view controls
toolbelt read <plugin> [screen]      # one screen as text (default screen if omitted)
toolbelt read <plugin> <screen> --filter status=done --sort tasks=-due --search budget
                                     # your own view: searched, filtered, sorted in one call
toolbelt read <plugin> <screen> --person   # exactly what the person's screens show now
toolbelt show <plugin> [screen] --filter status=done   # show the person (asks them first)
toolbelt read <plugin> <screen> --max-rows 20 --no-details   # smaller
toolbelt read <plugin> <screen> --table <id> --offset 100    # next page of a long table
toolbelt read <plugin> <screen> --table <id> --parent <row id>   # a row's child rows
toolbelt search <words…> [--plugin <id>]   # lines mentioning all words, across screens
toolbelt plugins                     # installed plugins and available plugin updates
```

Add `--json` for structured output (times also as ISO 8601). `--max-rows 0` shows only each
table's size and columns. Plugin and screen ids match in any case. Exit code 2 means the
request was refused or failed (unknown plugin, screen, table or option, plugin not running);
1 means ToolBelt couldn't be reached.

## Reading screens

- Tables print as `- cell · cell · cell  {id: …}` under `### section` headings, followed by
  indented row details. Times are absolute local time with a relative hint.
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
  allows fewer lists its own `(actions: …)`.
- `search` lists screens it couldn't read: matches there are unknown, not absent.
- Values marked `••••••` are secrets ToolBelt keeps from agents (fields the plugin marks
  sensitive, and anything that looks like a token or password, such as in command lines).

## Limits

- Some plugins are not available to agents (the plugin opted out, or the person turned access
  off in Settings → Agents). `status` says how many; don't guess their contents.
- If ToolBelt isn't reachable, ask the person to open ToolBelt and turn on Settings → Agents →
  "Let agents use ToolBelt".
