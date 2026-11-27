// An interface variant (`run --lenient`): simulates a proposed ToolBelt change before it's built, to
// measure whether it helps. ToolBelt today wants exact ids: filter ids such as "label:3", option
// values such as "overdue", plugin and screen ids. Models often send what the screen shows instead:
// "Priority", "High"/"high", "Overdue", "No date", "OnTrack". This adapter resolves such names the
// way the proposal would (id or label, case-insensitively), and when a plugin id is unknown, the
// refusal lists the plugins agents can read. Everything else passes through unchanged.
type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
type Option = { value: string; label: string };
type Filter = { id: string; label: string; options: Option[] | null };
type Screen = { plugin: string; screen: string; title: string; pluginName: string; view: { filters: Filter[] } | null };

const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.toLowerCase();

export function lenient(call: Call): Call {
	let screens: Screen[] | null = null;
	const load = async () => {
		const r = await call("list_screens", { format: "json" });
		return r.isError ? [] : (JSON.parse(r.text).screens as Screen[]);
	};
	return async (name, input) => {
		const args = structuredClone(input);
		if (!["read_screen", "show_screen", "list_screens", "search_screens"].includes(name) || typeof args.plugin !== "string") return call(name, args);
		// Filter labels and options are known once a screen has rendered; the host has the rendered
		// tree when it resolves a view, so render unrendered screens first.
		if (!screens || screens.some((s) => s.view?.filters.some((f) => !f.options))) {
			screens = await load();
			const unrendered = screens.filter((s) => s.view?.filters.some((f) => !f.options));
			for (const s of unrendered) await call("read_screen", { plugin: s.plugin, screen: s.screen, max_rows: 0 });
			if (unrendered.length) screens = await load();
		}
		const plugins = [...new Map(screens.map((s) => [s.plugin, s.pluginName])).entries()];
		const plugin = plugins.find(([id, label]) => same(args.plugin, id) || same(args.plugin, label));
		if (!plugin) {
			const r = await call(name, args);
			return r.isError ? { ...r, text: `${r.text} Plugins agents can read: ${plugins.map(([id, label]) => `${id} (${label})`).join(", ")}.` } : r;
		}
		args.plugin = plugin[0];
		const mine = screens.filter((s) => s.plugin === plugin[0]);
		const screen = typeof args.screen === "string" ? mine.find((s) => same(args.screen, s.screen) || same(args.screen, s.title)) : undefined;
		if (screen) args.screen = screen.screen;
		const view = args.view as { filters?: Record<string, unknown> } | undefined;
		const declared = (screen ?? mine.find((s) => s.view))?.view;
		if (view && typeof view === "object" && view.filters && typeof view.filters === "object" && declared) {
			const filters: Record<string, unknown> = {};
			for (const [key, values] of Object.entries(view.filters)) {
				// A key can name one filter's id and another's label (OnTrack: id "status" is Workflow, label
				// "Status" is label:4): take the one that offers every value asked for.
				const named = declared.filters.filter((x) => same(key, x.id) || same(key, x.label));
				const resolve = (f: Filter, v: unknown) => f.options?.find((o) => same(v, o.value))?.value ?? f.options?.find((o) => same(v, o.label))?.value;
				const f = Array.isArray(values) ? (named.find((x) => values.every((v) => resolve(x, v) !== undefined)) ?? named[0]) : undefined;
				if (!f || !Array.isArray(values)) {
					filters[key] = values;
					continue;
				}
				filters[f.id] = values.map((v) => resolve(f, v) ?? v);
			}
			view.filters = filters;
		}
		return call(name, args);
	};
}
