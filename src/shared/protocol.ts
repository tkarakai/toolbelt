// The Toolbelt plugin protocol (version `PROTOCOL_VERSION`; docs/plugins.md is the full contract).
//
// A plugin is a program Toolbelt starts with Bun. They talk JSON, one object per line:
// the host writes to the plugin's stdin, the plugin writes to its stdout (stderr is its log).
//
//   host → plugin   {"type":"hello", …}            once, right after start
//                   {"type":"open","surface":"…"}  a surface became visible: render it
//                   {"type":"close","surface":"…"} it's hidden: stop rendering it
//                   {"type":"event", …}            someone did something on a surface
//   plugin → host   {"type":"hello", …}            its protocol, capabilities and declarations
//                   {"type":"render","surface":"…","tree":{…}}  the surface's whole UI tree
//                   {"type":"result","id":"…", …}  once per event, after the plugin handled it
//                   {"type":"badge","value":…}     the count next to the plugin's name
//                   {"type":"toast", …}            a short notification in the window
//
// Surfaces are `screen:<id>` (a tab in the window), `quick` (the menu bar quick view) and
// `floating` (a floating plugin's window over the main screen, rendered as a `floating` node).
// The plugin describes *what* to show with the nodes below; Toolbelt decides *how* — every
// node maps to shadcn/ui components, so all plugins look like one app. UI state that has to
// feel instant (typing, selection, scroll, column widths) stays in Toolbelt; the plugin only
// hears about meaningful events.
//
// Times are epoch milliseconds (`at`); Toolbelt shows them relative to now ("in 2h 14m",
// "5m ago") and keeps them current, so a countdown doesn't need a render every second.
//
// Each plugin gets a folder of its own for data: the `TOOLBELT_DATA_DIR` environment variable
// (`~/Library/Application Support/Toolbelt/data/<id>/`).

export const PROTOCOL_VERSION = 3;

/**
 * The instance every person's view shares: the window, the popover and paired devices show the
 * same search, filters and sort, like a remote control. Agents read through instances of their
 * own (`agent:…`), which never change what the person sees.
 */
export const PERSON = "person";

/**
 * What a surface's view shows: its search, filters, sort and page controls. The SDK keeps one per
 * instance, applies the view events itself and renders with it; plugins filter their data by it.
 */
export type ViewState = {
	/** The page's search text. */
	search?: string;
	/** Filter id → checked option values (none: no filtering). */
	filters?: Record<string, string[]>;
	/** Table id → the column it's sorted by, or null: unsorted (even when the table declares a starting sort). */
	sort?: Record<string, { key: string; desc: boolean } | null>;
	/** Page control id (`segmented`, `choice`) → its value. */
	controls?: Record<string, string>;
	/** Filter arrangement (`Filter.group`): every filter id in order, and the grouping ones in level order. */
	arrange?: { order: string[]; grouped: string[] };
};

/**
 * A surface's view controls and where they start: the SDK's `views` declaration, sent in the
 * handshake. Agents see it as the screen's view schema; options come from the rendered tree.
 */
export type ViewDeclaration = {
	/** The page has a search box. */
	search?: boolean;
	/** Filter id → its starting selection. */
	filters?: Record<string, string[]>;
	/** Table id → its starting sort, or null when it starts unsorted. */
	sort?: Record<string, { key: string; desc: boolean } | null>;
	/** Page control id → its starting value. */
	controls?: Record<string, string>;
	/** The filters can be arranged and group rows, starting like this. */
	arrange?: { order: string[]; grouped: string[] };
	/**
	 * The values a filter or control may take. The SDK refuses a view change outside them (the
	 * instance keeps its view) and drops them from a saved view. Without an entry, any value.
	 */
	options?: { filters?: Record<string, string[]>; controls?: Record<string, string[]> };
};

/**
 * What running an action does: `view` changes only the instance that sent it (opens or closes a
 * dialog, expands something, copies to the clipboard); `write` changes the plugin's data;
 * `external` reaches outside the plugin (opens an app or URL, starts a process, sends a message);
 * `destructive` deletes, or can't be undone.
 */
export type Effect = "view" | "write" | "external" | "destructive";

/** An action id's declaration (`definePlugin({ actions })`): one per id, shared by every surface. */
export type ActionDeclaration = {
	effect: Effect;
	/** False: agents never see or run this action, whatever their access. */
	agent?: boolean;
	/** One line for agents when the label isn't enough ("Hides the task until the date"). */
	describe?: string;
};

/**
 * A form id's declaration (`definePlugin({ forms })`). `view`: edits a draft or this instance only
 * (a dialog before Save). `write`: saves as it changes (a row pane, settings).
 */
export type FormDeclaration = { effect: "view" | "write"; agent?: boolean };

/**
 * Everything a plugin declares, sent in its hello and again in a `declarations` message: each
 * surface's view controls, and the plugin-wide action and form ids its trees may use.
 */
export type Declarations = {
	views: Record<string, ViewDeclaration>;
	actions: Record<string, ActionDeclaration>;
	forms: Record<string, FormDeclaration>;
};

/** Built-in event names, which can't be action ids. */
export const RESERVED_EVENTS = ["field", "search", "filter", "filter-arrange", "sort", "select", "reorder", "dialog-close"] as const;

/** Who sent an event: the person (any of their screens) or an agent acting for them. */
export type Origin = "person" | "agent";

/** `toolbelt.json`, next to the plugin's entry file. */
export type Manifest = {
	id: string;
	name: string;
	/** A lucide icon name, kebab-case ("activity", "list-checks"). */
	icon: string;
	version: string;
	description?: string;
	/** Which protocol the plugin speaks. */
	protocol: number;
	/** The program, relative to the manifest; run with Bun. */
	entry: string;
	/**
	 * Tabs in the window. The first one with `default: true` (or the first) opens first. A floating
	 * plugin may have none: it then lives only in its floating window.
	 */
	screens: { id: string; title: string; icon?: string; default?: boolean; shortcut?: string }[];
	/** The plugin offers a compact view in the menu bar popover. */
	quickView?: boolean;
	/**
	 * A floating plugin (capability `ui.floating`): its `floating` surface is a window over the
	 * main screen that the person moves, resizes and minimizes into its sidebar item, at the bottom
	 * of the sidebar. `shortcut` (one lowercase letter) opens and focuses it with ⌘ and that letter
	 * from anywhere in the window; it wins over a screen tab's ⌘ shortcut with the same letter.
	 */
	floating?: { shortcut?: string };
	repo?: string;
	updateFeed?: string;
	/** Action ids that need the host registered frontmost before handing focus to another app. */
	handoffActions?: string[];
	/** The plugin's command line, reachable as `tb <command>`. */
	cli?: { command: string };
	/**
	 * How far AI agents may go with this plugin (docs/agent-interface.md): `none` hides it from agents,
	 * `read` lets them read its screens, `act` is reserved for actions. Required. The person can
	 * lower it in Settings → Agents.
	 */
	agent: { access: "none" | "read" | "act" };
};

export type Tone = "default" | "muted" | "success" | "warning" | "danger" | "info";

/**
 * A color for things that are told apart by color (which agent, which kind of service), not
 * by meaning like a `Tone`. Toolbelt picks shades that read in light and dark themes.
 */
export const HUES = ["red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "slate", "stone"] as const;
export type Hue = (typeof HUES)[number];

/**
 * A status dot: a tone or hue, or one with a label (an instant tooltip), `pulse` (slowly
 * breathing: busy) and `dim` (a darker shade of the color: idle). `"rainbow"` draws a
 * multicolored dot, for something whose parts each have their own color (a label whose values
 * are colored one by one). Older hosts refuse it; require `ui.options-field` before sending it.
 */
export type DotColor = Tone | Hue | "rainbow";
export type Dot = DotColor | { color: DotColor; label?: string; pulse?: boolean; dim?: boolean };

/**
 * A small colored pill (an agent's name, a state). `tooltip` shows instantly on hover.
 * `shade`, from 0 (lightest) to 1 (the full color), draws it as a step of its color's
 * intensity (High · Medium · Low as darker to lighter): opaque, in five steps, with text that
 * stays readable in every theme. Without it, the usual tinted pill. Older hosts ignore it.
 */
export type Tag = { text: string; color?: Tone | Hue; icon?: string; tooltip?: string; shade?: number };

/**
 * How a title or a cell's text is drawn: `color` (a tone or hue, kept readable on a selected row
 * or item), `bold` and `italic`. Older hosts ignore it.
 */
export type TextStyle = { color?: Tone | Hue; bold?: boolean; italic?: boolean };

/** A small icon after a cell's text, with an instant tooltip (a bookmark: "kept as …"). */
export type Mark = { icon: string; tooltip: string; color?: Tone | Hue };

/** A table cell: plain text, or text with decoration. */
export type Cell =
	| string
	| number
	| null
	| {
			text: string;
			/** Second line, smaller and muted. */
			sub?: string;
			mono?: boolean;
			tone?: Tone;
			/** How the text is drawn; its `color` wins over `tone`. Older hosts ignore it. */
			style?: TextStyle;
			/** A small status dot before the text. */
			dot?: Dot;
			/** The part of `text` that matters most (a path's project folder): drawn stronger. */
			strong?: string;
			/** Capability `ui.cell-prefix`: a pill before the text, on its line (an id). */
			prefix?: Tag;
			/** Pills at the start of the second line, before `sub` (agent, state). */
			tags?: Tag[];
			/** Icons right after the text, each with an instant tooltip. */
			marks?: Mark[];
			/** Small outlined chips after the text (ports, tags). */
			chips?: string[];
			/** Render the text as a badge. */
			badge?: boolean;
			/** A small trend line after the text (recent values, oldest first). */
			spark?: number[];
			/** A moment (epoch ms), shown relative to now and kept current; replaces `text`. */
			at?: number;
			/** An icon before the text: a lucide name, or `app:<path>` / `file:<path>` for the
			 *  icon macOS shows for that app bundle or file (Finder's icon). */
			icon?: string;
	  };

/**
 * A button on a toast. Clicking it sends this event with surface "toast".
 * With `ui.toast-key`, `key` is a ⌘ shortcut for the button while the toast shows, such as
 * `"cmd+z"`: `cmd+`, optionally `shift+`, then a letter. The main window shows it on the button
 * (Undo ⌘Z) and leaves it to text fields and dialogs that have focus. Older hosts ignore `key`.
 */
export type ToastAction = { id: string; label: string; payload?: unknown; key?: string };

export type Column = {
	key: string;
	title: string;
	align?: "left" | "right";
	mono?: boolean;
	/**
	 * Its normal width, px — or `"content"` to fit the widest value seen (the default for
	 * columns without one). People can drag it wider or narrower (`resizable`); ToolBelt
	 * remembers their widths per table.
	 */
	width?: number | "content";
	/**
	 * Takes the space that's left: `true`, or a weight when several columns share it (2 gets
	 * twice the share of 1). Growing columns shrink down to `minWidth` before other columns
	 * hide, never hide themselves, and follow the window rather than a remembered width.
	 */
	grow?: boolean | number;
	/**
	 * Gives up space when the table is too narrow, by weight, down to `minWidth`, before columns
	 * start hiding. Default: the `grow` weight (fixed columns don't shrink; they hide).
	 */
	shrink?: number;
	/** The narrowest it gets, px (growing columns: default 240; others: 40). */
	minWidth?: number;
	/** The widest it gets, px, even while growing or dragged. */
	maxWidth?: number;
	/**
	 * Which columns give way when the table gets narrow: the highest `priority` hides first.
	 * Without one, columns further right in the displayed order are less important (priority =
	 * position), so the leftmost column is the last to go — and growing columns never hide.
	 */
	priority?: number;
	/** Hidden first in narrow layouts (same as a high `priority`). */
	optional?: boolean;
	/** People can drag its right edge to resize it. Default: true, except for growing columns. */
	resizable?: boolean;
	/**
	 * People can drag it to another place among the movable columns. Default: true, except for
	 * the first column, which holds the tree (expand chevrons, indentation, group labels).
	 */
	reorderable?: boolean;
	/** Clicking the header sorts by this column: the table's `sort`, and a `sort` event. */
	sortable?: boolean;
	/** The direction of the first click (default: ascending; numbers often want descending). */
	sortDesc?: boolean;
};

export type Action = {
	id: string;
	label: string;
	/** A lucide icon name. */
	icon?: string;
	tone?: "default" | "destructive";
	/** Ask before running: the question to ask. */
	confirm?: string;
	/** Show as a button in the row (otherwise only in the row's menu). */
	inline?: boolean;
	/** The main action of a toolbar, card or dialog: drawn as a filled button. */
	primary?: boolean;
	disabled?: boolean;
	/**
	 * Actions with the same group are shown together: a section of the row menu, a cluster of
	 * buttons in the inspector. Groups appear in the order of their first action; ungrouped
	 * actions form one group. Name groups for what they do ("open", "command", "stop").
	 */
	group?: string;
	/** A switch instead of a button (page toolbars): on when true. Clicking sends the action. */
	checked?: boolean;
	/**
	 * A shortcut for the selected row: one key ("j", "p"), or with the `ui.modifier-keys`
	 * capability, `alt+` and/or `shift+` before a key or `up`/`down`/`left`/`right`
	 * ("alt+up", "shift+s"). Toolbelt shows it in the tooltip, the row menu and the details
	 * drawer's buttons.
	 */
	key?: string;
	/**
	 * A split button: alternatives to this action for the same target, in a menu attached to
	 * the button ("Update" ▾ "Review first…"). The button runs this action; picking an
	 * alternative sends the alternative's id with the same payload and honors its own
	 * `confirm`, `disabled`, `tone`, `icon` and `key`. One level: alternatives have no `menu`.
	 * Needs the `ui.split-action` capability; older hosts show only the main button.
	 */
	menu?: Action[];
	/**
	 * With a row `pane` (capability `ui.row-pane`): instead of sending the action, move the
	 * keyboard into the details drawer at the pane element with this id (a composer's, or a field
	 * of a pane form), opening the drawer. Sent as usual when the drawer can't show.
	 */
	focus?: string;
	/**
	 * Ask for text before sending (capability `ui.composer`): a line under the list item, or a
	 * small editor elsewhere. The action's event carries `text`. ↵ (⌘↵ in an editor) sends, Esc
	 * cancels.
	 */
	input?: { placeholder?: string };
};

/**
 * What a row action can apply to, when there's a choice (a job and the processes it started):
 * the person picks one from a menu, and the action's event carries `target` (the option's id).
 */
export type Target = { id: string; label: string; sub?: string; icon?: string };

/** One level of a row's group: a label, or a label with extras. Rows group by `id ?? label`. */
export type GroupLabel =
	| string
	| {
			id?: string;
			label: string;
			/** The part of `label` that matters most (a path's project folder): drawn stronger. */
			strong?: string;
			/** A git branch, drawn as one after the label. */
			sub?: string;
			/** a small badge ("app", "no terminal") */
			tag?: string;
			/** Informational aggregate, displayed independently of sorting and collapsed state. */
            summary?: { label: string; value: string; description?: string; /** Table column key; hidden with that column. Omit for a trailing summary. */ column?: string };
			/** dimmed (app sections) */
			muted?: boolean;
			icon?: string;
	  };

export type Row = {
	id: string;
	cells: Record<string, Cell>;
	/**
	 * Rows with the same group are shown together under a header. A list makes nested groups:
	 * `["Orca", "~/dev/app"]` is a section with a folder inside; rows indent under both.
	 */
	group?: string | GroupLabel[];
	/** Start expanded (until the person collapses it). */
	open?: boolean;
	/** Row actions; ids of entries in the table's `actions`. Defaults to all. */
	actions?: string[];
	/** Shown in the inspector when the row is selected. */
	details?: DetailItem[];
	/** Small figures at the top of the inspector (CPU, memory, uptime), with optional trends. */
	stats?: { label: string; value: string; spark?: number[]; tone?: Tone }[];
	/** Rows nested under this one (a process's children); the person expands them. */
	children?: Row[];
	/**
	 * Capability `ui.row-tree`: this row stands in for row `context`, shown here so rows nested
	 * under it keep their place (a parent task listed in another group). It's drawn dimmed, isn't
	 * counted or dragged, and selecting it selects that row when it's shown.
	 */
	context?: string;
	/**
	 * Capability `ui.row-dot`: a status dot in the row's leading slot (the one the unread dot
	 * uses), so the first column's text lines up whether or not a row has one. With the unread
	 * dot too, the dots sit side by side, ending where the slot does: this one to the left.
	 */
	dot?: Dot;
	/** Per action id: what it can apply to. With two or more, the action asks which one. */
	targets?: Record<string, Target[]>;
	/** Something happened since the person last looked: a bold title and a dot. */
	unread?: boolean;
	/**
	 * What the details drawer shows for this row, in place of its `details` and `stats`
	 * (capability `ui.row-pane`): forms with `appearance: "inline"` to edit it in place, a
	 * `composer`, a `timeline`, `card`s as titled sections. A slim bar of the row's actions sits
	 * above it. Events from inside carry the row's id as `rowId`. Esc goes back to the table.
	 */
	pane?: Node[];
};

/**
 * A top-level group declared by the table (`sections`): it keeps its place and shows even with
 * no rows. Rows join it with `group: id` (or a path starting with it).
 *
 * A section can declare `sections` of its own (capability `ui.sub-sections`): sub-sections, one
 * level deep, drawn like sections and indented under it, after its own rows. Rows join a
 * sub-section with `group: "<sub id>"` (or a path starting with it). Each sub-section shows even
 * when empty, collapses on its own and takes drops by its own `order`. Every section and
 * sub-section id is unique in the table.
 */
/** How many levels of declared sections a table may nest, counting the top level (`Section.sections`). */
export const MAX_SECTION_DEPTH = 10;

export type Section = {
	id: string;
	label: string;
	icon?: string;
	/** Shown in the section while it has no rows. */
	empty?: string;
	/** Start collapsed (until the person opens it). */
	collapsed?: boolean;
	/** Capability `ui.nested-sections`: draw the section and its rows dimmed (an archive shelf). */
	muted?: boolean;
	/**
	 * Dragging rows (`reorder`): `"manual"` (default) drops between rows at a position;
	 * `"fixed"` takes a drop anywhere in it and the plugin decides the position; `false`
	 * refuses drops. `dropLabel` names what a drop from another section does ("Settle").
	 */
	order?: "manual" | "fixed" | false;
	dropLabel?: string;
	dropIcon?: string;
	/**
	 * Capability `ui.section-pill`: draw the label as a colored pill, sized to the header, the
	 * way rows show the same value as a `Tag` (a label's value as a group). `shade` as on a tag.
	 */
	pill?: { color?: Tone | Hue; shade?: number };
	/**
	 * Sections nested in this one: sub-sections (capability `ui.sub-sections`), which can have
	 * their own with capability `ui.nested-sections`, up to `MAX_SECTION_DEPTH` (10) levels
	 * counting the top. Ids are unique across the whole table.
	 */
	sections?: Section[];
};

/**
 * A label/value pair in the inspector. Items with the same `section` are shown together under
 * that heading, in order of first appearance. `copy` adds a copy button.
 */
export type DetailItem = {
	label: string;
	value: string;
	mono?: boolean;
	tone?: Tone;
	section?: string;
	copy?: boolean;
	/** A dot before the label. */
	dot?: Dot;
	/** Small icon buttons on the item; they send the action with `{ rowId: actionRow }`. */
	actions?: Action[];
	/** The row the item's `actions` apply to (another process than the selected one). */
	actionRow?: string;
	/** Sent as the `target` of the item's `actions`: which of the row's things it acts on (a note's id). */
	target?: string;
	/** Draw `value` as Markdown (headings, lists, emphasis, code, links). Older hosts show the text. */
	markdown?: boolean;
};

/**
 * A dated note in a `timeline`: a status update, a comment, a log entry. `text` is Markdown.
 * `edited` (epoch ms) is shown as "edited …" when it's later than `at`.
 */
export type TimelineEntry = {
	id: string;
	at: number;
	text: string;
	edited?: number;
	/** Who wrote it ("you", "claude"). */
	author?: string;
	/** A short line above the text ("Moved to Working"). */
	title?: string;
	/** Ids from the timeline's `actions`; defaults to all of them. */
	actions?: string[];
};

/**
 * A multi-select filter in a page's toolbar (zero or more options checked; none checked means
 * no filtering). Changes arrive as `filter` events; the plugin applies them and sends `selected`.
 */
export type Filter = {
	id: string;
	label: string;
	icon?: string;
	/**
	 * Capability `ui.filter-sections`: options with a `section` are grouped the way the plugin
	 * structures them. Consecutive options with the same `section` form a group, groups are
	 * divided by a separator, and a named section shows its name above its options; options
	 * without one form unnamed groups. With sections the menu keeps the plugin's order and dims
	 * options counted 0, instead of moving them below a divider. Older hosts ignore `section`.
	 */
	options: { value: string; label: string; dot?: Dot; count?: number; section?: string }[];
	selected: string[];
	/**
	 * Capability `ui.filter-group`: the filter can also group the page's rows, and is grouping
	 * them while true. When any filter has `group`, the toolbar arranges the filters: the
	 * grouping ones first, in level order (numbered, with › between them), a divider, then the
	 * rest. People flip the Group by switch at the top of a filter's menu, drag filters to
	 * reorder them and across the divider to group or stop grouping, or press ⌥← / ⌥→ on one.
	 * Every change arrives as a `filter-arrange` event, `{ order, grouped }`: every filter id in
	 * its new order, and the grouping ones in level order. Grouping is the plugin's to draw.
	 */
	group?: boolean;
	/** Why the Group by switch can't turn on now ("Up to 10 levels"), shown beside it. */
	groupDisabled?: string;
	/**
	 * Capability `ui.filter-group`: the selection the filter starts with and its name
	 * ("Ongoing"). While `selected` matches it the button shows the name without the
	 * filtering highlight; otherwise the menu offers "Reset to <label>".
	 */
	default?: { values: string[]; label: string };
};

/**
 * One variable of an `environment` field. In a field with `secretPrefix` (capability `secrets`),
 * a `secret` entry's value lives in the Keychain as `<secretPrefix>/<key>`: the plugin sends it
 * with `value: ""`, ToolBelt sets `stored` (whether the Keychain has it), and the plugin reads the
 * value with `ctx.secrets.get` when it needs it.
 */
export type EnvironmentEntry = { key: string; value: string; selected: boolean; secret: boolean; stored?: boolean };

export type Field = (
	/**
	 * `secretPrefix` (capability `secrets`): secret entries' values are kept in the Keychain by
	 * ToolBelt under `<secretPrefix>/<key>`, never in the tree or the plugin's events. The prefix
	 * belongs to this field: removing an entry deletes its secret.
	 */
	| { type: "environment"; id: string; label: string; value: EnvironmentEntry[]; description?: string; secretPrefix?: string }
	| { type: "select"; id: string; label: string; value: string; options: { value: string; label: string }[]; description?: string }
	| { type: "switch"; id: string; label: string; value: boolean; description?: string }
	/**
	 * `heading`: the title of what's edited, drawn large (inline forms). `note` (capability
	 * `ui.heading-note`): a small neutral pill above the heading, such as an id (drawn like a
	 * cell's `prefix`).
	 */
	/**
	 * `secret` (capability `secrets`): the name of a secret this field edits. What the person types
	 * goes to the Keychain, not to the plugin: `value` must be "", the `field` event says only
	 * whether the secret is now stored (`value: true | false`, with `secret`), and ToolBelt sets
	 * `stored` itself. Implies masked input.
	 */
	| { type: "text"; id: string; label: string; value: string; placeholder?: string; description?: string; sensitive?: boolean; heading?: boolean; note?: string; secret?: string; stored?: boolean }
	// The fields below need the `ui.rich-fields` capability.
	/** Several lines; with `markdown`, an editor that styles Markdown as it's typed. Sent on blur and ⌘↵. */
	| { type: "textarea"; id: string; label: string; value: string; placeholder?: string; description?: string; markdown?: boolean; rows?: number }
	/**
	 * A local date (`YYYY-MM-DD`), with an optional time (`YYYY-MM-DDTHH:MM`) unless `time: false`;
	 * "" when cleared. `placeholder` is shown while there is no value ("No due date"). `presets`
	 * replace the picker's quick picks (Today, Tomorrow, Next Monday, In a week); a preset with a
	 * time sets both, a date-only preset keeps the time already chosen.
	 */
	| { type: "datetime"; id: string; label: string; value: string; time?: boolean; description?: string; placeholder?: string; presets?: { label: string; value: string }[] }
	/** One of the theme's named colors, as swatches. */
	| { type: "color"; id: string; label: string; value: Hue; description?: string }
	/** A searchable choice; with `freeform`, any typed text is accepted too. */
	| { type: "combobox"; id: string; label: string; value: string; options: { value: string; label: string; sub?: string }[]; freeform?: boolean; placeholder?: string; description?: string }
	/**
	 * Key/value pills, at most one per key. A key with `flag` has no value; with `values`, its
	 * value is picked from them (any text too with `freeform`); otherwise it's free text.
	 */
	/**
	 * With `open` (capability `ui.tag-open`), each pill's value is a link: clicking it sends that
	 * action with `{ form, field, key, value }`. The pill's key still opens the value picker. A
	 * flag pill, having no value, is a link as a whole.
	 */
	| { type: "tags"; id: string; label: string; value: TagValue[]; keys: TagKey[]; description?: string; open?: Action }
	/**
	 * An editable list of choices (capability `ui.options-field`): add, rename, remove and, with
	 * `reorder`, move items; with `colors`, each item has a color of its own. See `OptionItem`.
	 * `placeholder` is the add row's hint ("Add value").
	 */
	| { type: "options"; id: string; label: string; value: OptionItem[]; colors?: boolean; reorder?: boolean; placeholder?: string; description?: string }
	/**
	 * A length of time in whole minutes (capability `ui.duration-field`), edited as days, hours
	 * and minutes. ↑/↓ step the focused part (carrying into the next), digits type it, and a
	 * menu offers `presets`. `min`/`max` (minutes) bound it; a typed value is clamped to them.
	 * With `none` ("Never"), the value can be `null`, offered first in the menu under that label.
	 * Sent as a number of minutes (or `null`) when it changes: on leaving it, ↵ or a pick.
	 * Older hosts refuse the field, so require the capability before sending it.
	 */
	| { type: "duration"; id: string; label: string; value: number | null; min?: number; max?: number; presets?: { label?: string; value: number | null }[]; none?: string; description?: string }
) & {
	/**
	 * Focus this field when it appears in an open dialog (also when the plugin swaps one form for
	 * another), instead of the dialog's first field. Older hosts ignore it.
	 */
	autofocus?: boolean;
};

/**
 * `shades` gives values a `Tag.shade` (value → 0…1), used for their pills and in the picker.
 * `colors` gives values a color of their own (value → hue), which wins over `color`; without a
 * `color`, the key itself shows a rainbow dot. With `multiple` (capability `ui.tag-multiple`), the
 * key can be added again for each of several values (Blocks: #3, Blocks: #7); each value once.
 */
export type TagKey = { key: string; label: string; color?: Tone | Hue; values?: string[]; freeform?: boolean; flag?: boolean; shades?: Record<string, number>; colors?: Record<string, Hue>; multiple?: boolean };

/**
 * One item of an `options` field. `key` is the plugin's stable id for it: renaming keeps the key,
 * so a plugin tells a rename from a remove and an add. Items the person adds come back without
 * a key (and, with `colors`, with the color the host picked: one the list uses least); give
 * them keys when you render the field again. `count` (how many things use it) is shown beside
 * the item and isn't sent back.
 */
export type OptionItem = { key?: string; text: string; color?: Hue; count?: number };
export type TagValue = { key: string; value?: string };

/** A line of output in a `log`. */
export type LogLine = { text: string; at?: number; tone?: Tone };

/**
 * A modal the plugin opens by putting it on its page, and closes by taking it off. Its actions
 * arrive as events with `{ dialog: id }`; Esc, the close button and Cancel send `dialog-close`.
 */
export type Dialog = {
	id: string;
	title: string;
	description?: string;
	children: Node[];
	actions?: Action[];
	/** Room for release notes, logs, tables. */
	wide?: boolean;
	/** The person can resize it (drag its edges) and maximize it to the window; remembered. */
	resizable?: boolean;
};

/** A message in a `conversation`. */
export type Message = {
	role: "user" | "assistant" | "tool" | "system";
	/** Who wrote it ("you", "claude"). */
	author?: string;
	/** Markdown for user/assistant messages; a one-line summary for tools. */
	text: string;
	at?: number;
	/** Tool calls: the tool's name and, optionally, its input/output (shown on request). */
	tool?: { name: string; detail?: string };
};

/**
 * A suggestion an ask bar offers while it's empty: clicking it sends the action `id`. Consecutive
 * suggestions with the same `group` show under it as a heading ("Continue", "Try asking"). `meta`
 * shows at the right, or `metaAt` a moment (epoch ms) relative to now. Older hosts ignore
 * `group`, `meta` and `metaAt` (ToolBelt 0.7.1 or newer shows them).
 */
export type Suggestion = { id: string; label: string; icon?: string; group?: string; meta?: string; metaAt?: number };

export type Node =
	| { type: "stack"; direction?: "row" | "column"; gap?: number; children: Node[] }
	/**
	 * The root of a floating plugin's `floating` surface (capability `ui.floating`). ToolBelt draws
	 * the window around it: the frame, the title bar with the plugin's icon and name, `subtitle`,
	 * `actions` as icon buttons, and the minimize button. `mode: "bar"` draws an ask bar: its
	 * `composer` child becomes the bar's input, `suggestions` show above it while it's focused and
	 * empty, and other children show above the input. `mode: "panel"` draws the title bar and the
	 * children below it. Switching mode animates; the size the person gives the panel is kept.
	 * `busy` spins the sidebar item while the window is minimized, and when it ends while minimized
	 * the item shows a dot until the window opens.
	 */
	| {
			type: "floating";
			mode: "bar" | "panel";
			subtitle?: string;
			actions?: Action[];
			busy?: boolean;
			suggestions?: Suggestion[];
			children: Node[];
	  }
	| {
			type: "page";
			/**
			 * Optional search box. The SDK handles its `search` events and fills `query` from the
			 * instance's view, so every person's screen shows the same text.
			 */
			search?: { placeholder: string; query?: string };
			/** Buttons in the page toolbar. */
			actions?: Action[];
			/**
			 * Segmented choices beside the search box; changes arrive as `field` events. When the
			 * filters are arranged (`Filter.group`), they follow the filters, after a divider.
			 */
			controls?: Extract<Node, { type: "segmented" | "choice" }>[];
			/** Muted text in the toolbar ("12 processes"). */
			summary?: string;
			/** Multi-select filters, after the search box. */
			filters?: Filter[];
			/** Words to mark on the page (search hits), case-insensitive. */
			highlight?: string[];
			children: Node[];
			/** A modal over the page, while present. */
			dialog?: Dialog;
	  }
	| {
			type: "table";
			id: string;
			columns: Column[];
			rows: Row[];
			actions?: Action[];
			/**
			 * Rows get checkboxes, and these actions apply to the checked ones: the event's payload
			 * is `{ rowIds }`. Which rows are checked is Toolbelt's business until then.
			 */
			bulkActions?: Action[];
			/** Shown when there are no rows. */
			empty?: { title: string; description?: string; icon?: string };
			/** The column it's sorted by (see `Column.sortable`). */
			sort?: { key: string; desc: boolean };
			/**
			 * When the columns' minimum widths don't fit: `"hide"` (default) drops columns by
			 * priority; `"scroll"` keeps them all and scrolls sideways.
			 */
			overflow?: "hide" | "scroll";
			/**
			 * Bump it when the columns change meaning, to forget the widths and order people
			 * chose for this table (default 0).
			 */
			layoutVersion?: number;
			/** Top-level groups in order, shown even when empty, with optional sub-sections (see `Section`). */
			sections?: Section[];
			/**
			 * People can drag rows within and between sections (capability `ui.row-reorder`).
			 * A drop sends `reorder` with `{ table, rowId, section, before }`; Toolbelt keeps the
			 * order it shows until the plugin sends the next tree. `section` is the sub-section's
			 * id for a drop into a sub-section, and `before` the next row in it (null: its end).
			 */
			reorder?: boolean;
			/**
			 * Capability `ui.row-tree`: with `reorder`, rows at any depth can be dragged, and a drop
			 * onto a row (its middle) sends `reorder` with `onto`: that row's id (for a context row,
			 * the row it stands for) and its section. This names that drop ("Make it a subtask").
			 */
			reorderOnto?: string;
			/**
			 * Capability `ui.context-select`: context rows (`Row.context`) are selected like other
			 * rows instead of handing the selection to the row they stand for. A context row then
			 * shows its own `actions`, `targets` and `pane` (send that row's), and its events
			 * (actions, pane events, `select`) carry `rowId`: the row it stands for, so it acts as
			 * that row. While either is selected, the row and its other context rows are softly
			 * highlighted.
			 */
			contextSelect?: boolean;
			/**
			 * Capability `ui.pane-buttons`: a row's drawer (`Row.pane`) shows its actions as buttons
			 * at the bottom, as a details drawer does (the first group as buttons, the ↵ action
			 * filled; other groups as quieter rows; destructive ones last, apart), instead of the
			 * slim bar of icons and ⋯ on top.
			 */
			paneButtons?: boolean;
			/**
			 * Send `select` with `{ table, rowId }` (null when cleared) once the person's selection
			 * has rested on a row for a moment (capability `ui.row-select`).
			 */
			selectEvents?: boolean;
			/**
			 * The id of the row action ↵ runs (capability `ui.row-pane`), instead of the first
			 * inline one. With the action's `focus`, ↵ goes into the drawer.
			 */
			enter?: string;
			/**
			 * `"document"`: no lines between rows and no tinted section headers; the table sits on
			 * one background like a page of notes, and hovered and selected rows are rounded.
			 * Column headers, grouping, expanding and the details drawer work as usual. Default
			 * `"grid"`. Older hosts ignore it.
			 */
			appearance?: "grid" | "document";
	  }
	| {
			type: "list";
			id: string;
			/**
			 * `metaAt` shows a moment (epoch ms) relative to now instead of `meta`. `dot` and the
			 * `unread` dot sit before the title, after the icon, the unread one nearest the title
			 * (as `Row.dot` and the unread dot in tables). `titleStyle` draws the title in a
			 * color, bold or italic (older hosts ignore it).
			 */
			items: { id: string; title: string; titleStyle?: TextStyle; subtitle?: string; icon?: string; dot?: Dot; meta?: string; metaAt?: number; actions?: Action[]; unread?: boolean; prefix?: Tag; tags?: Tag[] }[];
			empty?: { title: string; description?: string; icon?: string };
			/**
			 * Capability `ui.list-open`: clicking an item (or ↵ on it) sends this action with
			 * `{ list, item }` (the item's id) instead of only selecting it: a link to what the item
			 * names. Its own `actions` keep their buttons and keys. With it, items also take
			 * `prefix` (a pill before the title) and `tags` (pills on the second line, before the
			 * subtitle), drawn as in tables.
			 */
			open?: Action;
			/**
			 * Capability `ui.list-inset`: items without an `icon` keep its space empty, so their text
			 * starts where an icon's would end: the list reads as indented under its heading.
			 * Older hosts ignore it.
			 */
			inset?: boolean;
	  }
	/** `at` shows a moment (epoch ms) relative to now instead of `value`. */
	| { type: "stats"; items: { label: string; value: string; at?: number; hint?: string; tone?: Tone }[] }
	/**
	 * `appearance: "inline"` (capability `ui.row-pane`): a dense property sheet for a details
	 * drawer. Labels sit in a narrow column, controls look like text until hovered or focused,
	 * and each field commits on its own. A field with an empty label spans the width; a Markdown
	 * `textarea` shows the formatted text and turns into an editor on click or ↵.
	 */
	| { type: "form"; id: string; title?: string; description?: string; fields: Field[]; appearance?: "inline" }
	| { type: "empty"; title: string; description?: string; icon?: string }
	| { type: "text"; text: string; tone?: Tone; mono?: boolean }
	/** A titled box. Its actions arrive with `{ rowId: id }`. */
	| {
			type: "card";
			id?: string;
			title?: string;
			description?: string;
			tone?: Tone;
			actions?: Action[];
			children: Node[];
			/**
			 * Capability `ui.collapsible-cards`: the header (title, description and a chevron)
			 * opens and closes the card's children; its actions stay buttons of their own. Needs
			 * `id` and `title`. Whether it's open is the person's, kept by ToolBelt per card `id`
			 * across renders. Older hosts ignore it and show the card open.
			 */
			collapsible?: boolean;
			/**
			 * With `collapsible`: whether the card starts open (default closed). Afterwards, a render
			 * whose `open` is a boolean different from the previous render's (`undefined` counts as
			 * different) opens or closes the card, such as `true` after a failed check pointing to
			 * the card; otherwise the person's choice stands. Dropping `open` changes nothing.
			 */
			open?: boolean;
	  }
	/** Label / value pairs. */
	| { type: "details"; items: { label: string; value: string; mono?: boolean; tone?: Tone }[] }
	/** Output of a command: monospace, scrolls; `follow` keeps the newest line in view. */
	| { type: "log"; id: string; lines: LogLine[]; follow?: boolean; empty?: string }
	/**
	 * A terminal's screen and scrollback, drawn by a terminal emulator: colors and styles from
	 * ANSI escape codes, long lines wrapped to the width (and re-wrapped when it changes). Send
	 * logical lines, not ones already wrapped. Fills the space it gets; ⌘+ / ⌘- zoom its text.
	 */
	| { type: "terminal"; id: string; lines: string[]; follow?: boolean; empty?: string }
	/** A chat between a person and an agent: messages as bubbles, tool calls as compact rows. */
	| { type: "conversation"; id: string; messages: Message[]; empty?: string }
	/**
	 * Dated Markdown notes in the order given, with a rail down the side (capability
	 * `ui.timeline`). ↑/↓ move between entries and an action's `key` runs it on the focused
	 * entry; ↵ runs the entry's first action. Actions arrive with `{ timeline: id, entryId }`.
	 * `selected` marks an entry (the one being edited) and scrolls it into view.
	 */
	| {
			type: "timeline";
			id: string;
			entries: TimelineEntry[];
			actions?: Action[];
			selected?: string;
			empty?: { title: string; description?: string; icon?: string };
			/**
			 * Edit an entry's text in place (capability `ui.composer`): this action (its key, its
			 * button, or a double-click) turns the entry into an editor; ⌘↵ or leaving it saves
			 * and sends the action with `{ timeline, entryId, text }`, Esc cancels.
			 */
			edit?: Action;
	  }
	/**
	 * A box to write something new: an update, a comment, a quick task (capability
	 * `ui.composer`). Sending runs `action` with `{ composer: id, text }` and empties the box;
	 * an unsent draft is kept while the window is open. Markdown on several lines, sent with ⌘↵;
	 * with `single`, one line sent with ↵. `key` focuses it from the rest of the surface.
	 */
	| { type: "composer"; id: string; action: Action; placeholder?: string; single?: boolean; key?: string }
	/** One choice of a few, as a segmented control; changes arrive as `field` events. */
	| { type: "segmented"; id: string; value: string; label?: string; options: { value: string; label: string; icon?: string; tooltip?: string }[] }
	/**
	 * Capability `ui.choice-control`: one choice from a menu, as a toolbar button showing
	 * "<label> · <chosen>". Options with the same `section` are listed under it as a heading, in
	 * order of first appearance; `description` is a quieter second line. Changes arrive as `field`
	 * events, like `segmented`.
	 */
	| { type: "choice"; id: string; value: string; label: string; icon?: string; options: { value: string; label: string; description?: string; section?: string }[] }
	/** `value` from 0 to 1; without one, "working…". `at`: when it started (shows elapsed time). */
	| { type: "progress"; label?: string; value?: number; at?: number; tone?: Tone }
	/**
	 * Markdown (release notes, descriptions): headings, paragraphs, lists, quotes, code, emphasis,
	 * links (opened in the browser). Raw HTML is shown as text, never interpreted.
	 */
	| { type: "markdown"; text: string };

export type HostMessage =
	| { type: "prepare"; requestId: string; reason: string }
	| { type: "shutdown" }
	| { type: "hello"; protocol: number; capabilities?: string[]; plugin: { id: string }; host: { name: string; version: string } }
	/** An instance of a surface opens, starting with `view` (else the declared defaults). */
	| { type: "open"; surface: string; instance: string; view?: ViewState }
	| { type: "close"; surface: string; instance: string }
	/** The host sets an instance's view (an agent showing the person something, Restore). */
	| { type: "view"; surface: string; instance: string; view: ViewState }
	/**
	 * Someone did something on an instance. `id` is unique per event: the plugin answers it with a
	 * `result`, and tags the toasts, clipboard text and navigation it sends while handling it.
	 * `agent` is the agent's client name, only when `origin` is `"agent"`.
	 */
	| { type: "event"; id: string; surface: string; instance: string; name: string; payload?: unknown; origin: Origin; agent?: string }
	/**
	 * The answer to the plugin's `secret` request (capability `secrets`): `value` for `get` (null
	 * when there's no such secret), `exists` for `has`, or why it failed.
	 */
	| { type: "secret"; requestId: string; ok: boolean; value?: string | null; exists?: boolean; error?: string };

export type PluginMessage =
	/** `declarations`: its views, actions and forms (`Declarations`). */
	| { type: "hello"; protocol: number; sdk: string; capabilities: string[]; declarations: Declarations }
	| { type: "ready" }
	| { type: "prepared"; requestId: string; ready: boolean; reason?: string }
	| { type: "render"; surface: string; instance: string; tree: Node }
	/**
	 * An instance's view changed (a person's search, filter or sort): the host saves the person's.
	 * With `refused`, a change was refused and the instance keeps `view` (the reason says why).
	 */
	| { type: "view"; surface: string; instance: string; view: ViewState; refused?: string }
	/** The declarations changed (`ctx.declare()`, or after `start`), replacing the hello's. */
	| { type: "declarations"; declarations: Declarations }
	/**
	 * The answer to an event, once its handler settled. `handled` false: the plugin didn't act on it
	 * (`error` may say why, such as a refused view change). `handled` with `error`: handling failed.
	 * `data` (JSON, at most `LIMITS.resultBytes`): such as created ids.
	 */
	| { type: "result"; id: string; handled: boolean; error?: string; data?: unknown }
	| { type: "badge"; value: number | string | null }
	/** `event`: the event being handled when it was sent (as on clipboard and navigate). */
	| { type: "toast"; text: string; tone?: "default" | "success" | "error"; action?: ToastAction; event?: string }
	/** Put text on the clipboard. */
	| { type: "clipboard"; text: string; event?: string }
	/**
	 * Show one of the plugin's screens in the main window, optionally selecting an item (a
	 * stable row/list item id). Honored only when tagged with an event (`event`) the host sent
	 * shortly before, on the screen that sent it, so it never steals focus. Needs the `navigate`
	 * capability.
	 */
	| { type: "navigate"; screen: string; select?: string; event?: string }
	/**
	 * Read, write or delete one of the plugin's secrets in the Keychain (capability `secrets`,
	 * declared in the manifest). `value` only for `set`. Answered by a host `secret` message.
	 */
	| { type: "secret"; requestId: string; op: "get" | "has" | "set" | "delete"; name: string; value?: string };

/**
 * Events Toolbelt sends, by `name`. The renderer builds every payload with `payloadFor`
 * (src/shared/actions.ts), and the host checks each person's event against the tree their
 * screens show before the plugin hears it: an event the tree doesn't offer is dropped.
 */
export type EventPayloads = {
	/**
	 * An action: `name` is the action id, a split-button alternative's id (with the main action's
	 * payload), or a floating window's suggestion id. The payload depends on where it was offered:
	 *
	 * - page toolbar, floating title bar, suggestion: `{}`
	 * - table row (inline button, row menu, key, details drawer): `{ rowId }`, with `target` when the
	 *   person picked one of the row's `targets` for the action. In a `contextSelect` table a context
	 *   row's events carry the row it stands for.
	 * - bulk action: `{ rowIds }`, the checked rows
	 * - detail item: `{ rowId: actionRow ?? the row, target? }` (the item's `target`)
	 * - boxed card: `{ rowId: card id }` (`{}` for a card without an id)
	 * - dialog: `{ dialog }`
	 * - list item: `{ rowId: item id }`; the list's `open`: `{ list, item }`
	 * - timeline entry: `{ timeline, entryId }`; its `edit`: `{ timeline, entryId, text }`
	 * - composer: `{ composer, text }`
	 * - a `tags` field's `open`: `{ form, field, key, value }` (no `value` for a flag)
	 * - toast button: surface `"toast"`, the button's own `payload`
	 *
	 * An action with `input` adds `text` (toolbar, rows, bulk, cards, list items, timeline entries).
	 * Inside a row's `pane`, every event also carries that row's id as `rowId`, replacing one it
	 * had (a section's button sends `{ rowId }`, a composer `{ composer, text, rowId }`).
	 */
	action: {
		rowId?: string;
		rowIds?: string[];
		dialog?: string;
		/** the `Target` the person picked, or the detail item's `target` */
		target?: string;
		/** A `timeline` entry's action: the timeline's id and the entry's. */
		timeline?: string;
		entryId?: string;
		/** A `composer`'s id; the text comes in `text`. */
		composer?: string;
		/** A list's `open`: the list's id and the item's. */
		list?: string;
		item?: string;
		/** A `tags` field's `open`: the form, the field, and the pill's key and value. */
		form?: string;
		field?: string;
		key?: string;
		value?: string;
		/** What was written: a composer, a timeline entry edited in place, an action's `input`. */
		text?: string;
	};
	/** The person closed a dialog (Esc, close button, Cancel). */
	"dialog-close": { dialog: string };
	search: { query: string };
	/** A sortable column header was clicked: sort `table` by `key`; `key: null` makes it unsorted. */
	sort: { table: string; key: string | null; desc: boolean };
	/**
	 * A form field changed, or a page control (`segmented`, `choice`: `form` and `field` are the
	 * control's id, `value` the option picked). `value` has the field type's shape: text for
	 * `text`, `textarea`, `datetime`, `select` and `combobox`; a boolean for `switch`; a hue for
	 * `color`; minutes or null for `duration`; `TagValue[]` for `tags`; `OptionItem[]` (without
	 * `count`) for `options`; `EnvironmentEntry[]` for `environment`. `rowId`: the row whose `pane`
	 * holds the form. `secret`: a secret `text` field's name; its `value` is then whether the secret
	 * is stored now (true: saved, false: removed).
	 */
	field: { form: string; field: string; value: string | boolean | number | null | EnvironmentEntry[] | TagValue[] | OptionItem[]; rowId?: string; secret?: string };
	/** A filter's checked options changed. */
	filter: { filter: string; values: string[] };
	/**
	 * The filters were arranged (`Filter.group`): every filter id in its new order, and the
	 * grouping ones in level order.
	 */
	"filter-arrange": { order: string[]; grouped: string[] };
	/** The selection rested on a row (`selectEvents` tables); null when cleared. */
	select: { table: string; rowId: string | null };
	/**
	 * A row was dragged (`reorder` tables) into `section`, before the row `before` (null: at the
	 * end, or anywhere in a `"fixed"` section). `section` is a sub-section's id for a drop into
	 * that sub-section, and `before` then a row in it. With `reorderOnto`, a drop onto a row
	 * carries `onto`: that row's id (for a context row, the row it stands for), with `before` null
	 * and the row's section.
	 */
	reorder: { table: string; rowId: string; section: string; before: string | null; onto?: string };
};

/** Parse a manifest and check the parts Toolbelt relies on. Throws with a readable message. */
export function parseManifest(json: unknown): Manifest {
	const m = json as Partial<Manifest>;
	const need = (ok: unknown, what: string) => {
		if (!ok) throw new Error(`toolbelt.json: ${what}`);
	};
	need(m && typeof m === "object", "not an object");
	need(typeof m.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(m.id), "`id` must be lowercase letters, digits and dashes");
	need(!["toolbelt","constructor"].includes(m.id!),"`id` is reserved by the host");
	need(typeof m.name === "string" && m.name.trim(), "`name` is required");
	need(typeof m.entry === "string" && m.entry, "`entry` is required");
	// Any protocol parses, so a ToolBelt update doesn't lose the plugins installed for the previous
	// one: they stay listed as needing an update. Installing, packing or starting one checks it
	// (requireProtocol).
	need(Number.isSafeInteger(m.protocol) && m.protocol! >= 1, "`protocol` must be a whole number");
	if (m.floating !== undefined) {
		need(!!m.floating && typeof m.floating === "object" && !Array.isArray(m.floating), "`floating` must be an object");
		const shortcut = (m.floating as { shortcut?: unknown }).shortcut;
		if (shortcut !== undefined)
			need(typeof shortcut === "string" && /^[a-z]$/.test(shortcut) && !RESERVED_SHORTCUTS.includes(shortcut), `\`floating.shortcut\` must be one lowercase letter ToolBelt doesn't use itself (not ${RESERVED_SHORTCUTS.join(", ")})`);
	}
	need(Array.isArray(m.screens) && (m.screens.length > 0 || m.floating !== undefined), "at least one screen is required (floating plugins may have none)");
	const shortcuts = new Set<string>();
    for (const s of m.screens!) {
        need(typeof s.id === "string" && typeof s.title === "string", "each screen needs `id` and `title`");
        if (s.shortcut !== undefined) {
            need(typeof s.shortcut === "string" && /^[a-z]$/.test(s.shortcut), "screen shortcut must be one lowercase letter");
            need(!shortcuts.has(s.shortcut), "screen shortcuts must be unique");
            shortcuts.add(s.shortcut);
        }
    }
	if (m.protocol === PROTOCOL_VERSION || m.agent !== undefined)
		need(
			!!m.agent && typeof m.agent === "object" && ["none", "read", "act"].includes((m.agent as { access?: unknown }).access as string),
			"`agent.access` is required: none, read or act",
		);
	return {
		...m,
		icon: typeof m.icon === "string" ? m.icon : "box",
		version: typeof m.version === "string" ? m.version : "0.0.0",
	} as Manifest;
}

/**
 * ⌘ letters ToolBelt or macOS keeps for itself, so a floating plugin can't take them: editing (A, C,
 * V, X, Z), the sidebar (B), find (F), hide (H), minimize (M), the app menu's O, quit (Q) and close (W).
 */
export const RESERVED_SHORTCUTS = ["a", "b", "c", "f", "h", "m", "o", "q", "v", "w", "x", "z"];

/** A plugin that lives only in its floating window: no screens, so no place in the tools list. */
export const floatingOnly = (m: Pick<Manifest, "screens" | "floating">) => !!m.floating && m.screens.length === 0;

/** Refuses a plugin built for another plugin protocol than this ToolBelt speaks. */
export function requireProtocol(m: Pick<Manifest, "protocol">) {
	if (m.protocol !== PROTOCOL_VERSION)
		throw new Error(`Plugin needs an update: it was built for plugin protocol ${m.protocol}, and this ToolBelt speaks protocol ${PROTOCOL_VERSION}`);
}

/** The screen that opens first; undefined for a floating plugin without screens. */
export const defaultScreen = (m: Pick<Manifest, "screens">): string => (m.screens.find((s) => s.default) ?? m.screens[0])?.id as string;

/** Split a JSON-lines stream into messages; keeps the unfinished tail. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}
