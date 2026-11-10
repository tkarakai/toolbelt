// The Toolbelt plugin protocol, version 0 (the spike).
//
// A plugin is a program Toolbelt starts with Bun. They talk JSON, one object per line:
// the host writes to the plugin's stdin, the plugin writes to its stdout (stderr is its log).
//
//   host → plugin   {"type":"hello", …}            once, right after start
//                   {"type":"open","surface":"…"}  a surface became visible: render it
//                   {"type":"close","surface":"…"} it's hidden: stop rendering it
//                   {"type":"event", …}            the person did something on a surface
//   plugin → host   {"type":"render","surface":"…","tree":{…}}  the surface's whole UI tree
//                   {"type":"badge","value":…}     the count next to the plugin's name
//                   {"type":"toast", …}            a short notification in the window
//
// Surfaces are `screen:<id>` (a tab in the window) and `quick` (the menu bar quick view).
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

export const PROTOCOL_VERSION = 1;

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
	/** Tabs in the window. The first one with `default: true` (or the first) opens first. */
	screens: { id: string; title: string; icon?: string; default?: boolean; shortcut?: string }[];
	/** The plugin offers a compact view in the menu bar popover. */
	quickView?: boolean;
	repo?: string;
	updateFeed?: string;
	/** The plugin's command line, reachable as `tb <command>`. */
	cli?: { command: string };
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
 * breathing: busy) and `dim` (a darker shade of the color: idle).
 */
export type Dot = Tone | Hue | { color: Tone | Hue; label?: string; pulse?: boolean; dim?: boolean };

/** A small colored pill (an agent's name, a state). `tooltip` shows instantly on hover. */
export type Tag = { text: string; color?: Tone | Hue; icon?: string; tooltip?: string };

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
			/** A small status dot before the text. */
			dot?: Dot;
			/** The part of `text` that matters most (a path's project folder): drawn stronger. */
			strong?: string;
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

export type Column = {
	key: string;
	title: string;
	align?: "left" | "right";
	/** This column takes the remaining width. */
	grow?: boolean;
	mono?: boolean;
	/**
	 * Which columns give way when the table gets narrow: the highest `priority` hides first.
	 * Without one, columns further right are less important (priority = position), so the
	 * leftmost column is the last to go — and the `grow` column never hides.
	 */
	priority?: number;
	/** The narrowest the `grow` column may get before other columns hide (px, default 240). */
	minWidth?: number;
	/** Hidden first in narrow layouts (same as a high `priority`). */
	optional?: boolean;
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
	 * A one-key shortcut for the selected row ("j", "p"; no modifiers). Toolbelt shows it in
	 * the tooltip, the row menu and the details drawer's buttons.
	 */
	key?: string;
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
            summary?: { label: string; value: string; description?: string };
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
	/** Per action id: what it can apply to. With two or more, the action asks which one. */
	targets?: Record<string, Target[]>;
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
};

/**
 * A multi-select filter in a page's toolbar (zero or more options checked; none checked means
 * no filtering). Changes arrive as `filter` events; the plugin applies them and sends `selected`.
 */
export type Filter = { id: string; label: string; icon?: string; options: { value: string; label: string; dot?: Dot; count?: number }[]; selected: string[] };

export type EnvironmentEntry = { key: string; value: string; selected: boolean; secret: boolean };

export type Field =
    | { type: "environment"; id: string; label: string; value: EnvironmentEntry[]; description?: string }
	| { type: "select"; id: string; label: string; value: string; options: { value: string; label: string }[]; description?: string }
	| { type: "switch"; id: string; label: string; value: boolean; description?: string }
	| { type: "text"; id: string; label: string; value: string; placeholder?: string; description?: string; sensitive?: boolean };

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

export type Node =
	| { type: "stack"; direction?: "row" | "column"; gap?: number; children: Node[] }
	| {
			type: "page";
			/** Optional search box; changes arrive as `event` named `search`. */
			search?: { placeholder: string };
			/** Buttons in the page toolbar. */
			actions?: Action[];
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
	  }
	| {
			type: "list";
			id: string;
			/** `metaAt` shows a moment (epoch ms) relative to now instead of `meta`. */
			items: { id: string; title: string; subtitle?: string; icon?: string; dot?: Dot; meta?: string; metaAt?: number; actions?: Action[] }[];
			empty?: { title: string; description?: string; icon?: string };
	  }
	/** `at` shows a moment (epoch ms) relative to now instead of `value`. */
	| { type: "stats"; items: { label: string; value: string; at?: number; hint?: string; tone?: Tone }[] }
	| { type: "form"; id: string; title?: string; description?: string; fields: Field[] }
	| { type: "empty"; title: string; description?: string; icon?: string }
	| { type: "text"; text: string; tone?: Tone; mono?: boolean }
	/** A titled box. Its actions arrive with `{ rowId: id }`. */
	| { type: "card"; id?: string; title?: string; description?: string; tone?: Tone; actions?: Action[]; children: Node[] }
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
	/** One choice of a few, as a segmented control; changes arrive as `field` events. */
	| { type: "segmented"; id: string; value: string; options: { value: string; label: string; icon?: string }[] }
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
	| { type: "open"; surface: string }
	| { type: "close"; surface: string }
	| { type: "event"; surface: string; name: string; payload?: unknown };

export type PluginMessage =
	| { type: "hello"; protocol: number; sdk: string; capabilities: string[] }
	| { type: "ready" }
	| { type: "prepared"; requestId: string; ready: boolean; reason?: string }
	| { type: "render"; surface: string; tree: Node }
	| { type: "badge"; value: number | string | null }
	| { type: "toast"; text: string; tone?: "default" | "success" | "error"; /** a button on the toast; clicking sends this event, surface "toast" */ action?: { id: string; label: string; payload?: unknown } }
	/** Put text on the clipboard. */
	| { type: "clipboard"; text: string };

/** Events Toolbelt sends, by `name`. */
export type EventPayloads = {
	/** A table/list/card/dialog action: `name` is the action id. */
	action: { rowId?: string; rowIds?: string[]; dialog?: string; /** the `Target` the person picked */ target?: string };
	/** The person closed a dialog (Esc, close button, Cancel). */
	"dialog-close": { dialog: string };
	search: { query: string };
	/** A sortable column header was clicked: sort `table` by `key`. */
	sort: { table: string; key: string; desc: boolean };
	/** A form field changed. */
	field: { form: string; field: string; value: string | boolean | EnvironmentEntry[] };
	/** A filter's checked options changed. */
	filter: { filter: string; values: string[] };
};

/** Parse a manifest and check the parts Toolbelt relies on. Throws with a readable message. */
export function parseManifest(json: unknown): Manifest {
	const m = json as Partial<Manifest>;
	const need = (ok: unknown, what: string) => {
		if (!ok) throw new Error(`toolbelt.json: ${what}`);
	};
	need(m && typeof m === "object", "not an object");
	need(typeof m.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(m.id), "`id` must be lowercase letters, digits and dashes");
	need(typeof m.name === "string" && m.name.trim(), "`name` is required");
	need(typeof m.entry === "string" && m.entry, "`entry` is required");
	need(m.protocol === PROTOCOL_VERSION, `\`protocol\` must be ${PROTOCOL_VERSION} (got ${m.protocol})`);
	need(Array.isArray(m.screens) && m.screens.length > 0, "at least one screen is required");
	const shortcuts = new Set<string>();
    for (const s of m.screens!) {
        need(typeof s.id === "string" && typeof s.title === "string", "each screen needs `id` and `title`");
        if (s.shortcut !== undefined) {
            need(typeof s.shortcut === "string" && /^[a-z]$/.test(s.shortcut), "screen shortcut must be one lowercase letter");
            need(!shortcuts.has(s.shortcut), "screen shortcuts must be unique");
            shortcuts.add(s.shortcut);
        }
    }
	return {
		...m,
		icon: typeof m.icon === "string" ? m.icon : "box",
		version: typeof m.version === "string" ? m.version : "0.0.0",
	} as Manifest;
}

/** The screen that opens first. */
export const defaultScreen = (m: Manifest) => (m.screens.find((s) => s.default) ?? m.screens[0]).id;

/** Split a JSON-lines stream into messages; keeps the unfinished tail. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}
