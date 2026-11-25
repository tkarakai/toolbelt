---
name: toolbelt
description: Read the person's ToolBelt (Mac menu bar app) plugin screens — tasks and to-dos (OnTrack), software updates (Upkeep), and whatever other plugins they installed — with the `toolbelt` command. Use when the person asks about their tasks, what needs updating on their Mac, or anything they track in ToolBelt.
---

# ToolBelt

ToolBelt is a Mac menu bar app. Its plugins show the person's own information: tasks
(OnTrack), software updates (Upkeep), and others. The `toolbelt` command reads what those
plugins show, through the running app. Access is **read-only**: you can look things up and
explain them, but you can't change anything. When the person wants something done, tell them
where to do it in ToolBelt (plugin › screen › action).

## Commands

```sh
toolbelt status                      # app version, plugins, their screens — start here
toolbelt screens [plugin]            # screen ids for `read`
toolbelt read <plugin> [screen]      # one screen as text (default screen if omitted)
toolbelt read <plugin> <screen> --max-rows 20 --no-details   # smaller
toolbelt read <plugin> <screen> --table <id> --offset 100    # next page of a long table
toolbelt search <words…> [--plugin <id>]   # lines mentioning all words, across screens
toolbelt plugins                     # installed plugins and available plugin updates
```

Add `--json` for structured output. Exit code 2 means the request was refused (unknown
plugin or screen, plugin not running); 1 means ToolBelt couldn't be reached.

## Reading screens

- Tables print as `- cell · cell · cell  {id: …}` under `### section` headings, followed by
  indented row details. Times are absolute local time with a relative hint.
- `Filter`, `Search` and `Dialog open` lines describe view state the person set. The view is
  shared with them, so rows outside a filter are not listed: say so rather than claiming
  something doesn't exist.
- `Row actions` and `Toolbar actions` name what the person can do on that screen.
- Values marked `••••••` are secrets ToolBelt keeps from agents.

## Limits

- Some plugins are not available to agents (the plugin opted out, or the person turned access
  off in Settings → Agents). `status` says how many; don't guess their contents.
- If ToolBelt isn't reachable, ask the person to open ToolBelt and turn on Settings → Agents →
  "Let agents use ToolBelt".
