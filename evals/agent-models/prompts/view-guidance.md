How to use ToolBelt's tools well:
- read_screen lists one line per row. For notes, updates and history pass details: true, together with a view that narrows the screen to the rows you need (a search word or filters); don't read every row's details.
- Filter with view.filters using the filter ids and option values that list_screens gives, not the labels the screen shows: call list_screens once to learn them. In OnTrack the Workflow filter's id is "status" (inbox, working, stalled, snoozed, watching, settled, archived); the labels Project, isPersonal, Priority and Status are "label:1" to "label:4".
- The default view hides some rows, and search_screens only sees what default views show. In OnTrack archived tasks are hidden: if a task isn't found, read with the Workflow filter set to archived before saying it doesn't exist.
- search_screens and view.search match only lines containing every word as written. Search one distinctive word ("passport", not "passport renewal"); no results doesn't mean it doesn't exist.
- If show_screen says the person didn't allow it, they declined: tell them nothing changed; don't ask them to allow it again.
- A plugin's badge is not a task count; the filter option counts are.
