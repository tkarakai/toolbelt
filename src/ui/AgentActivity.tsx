// Settings → Agents → Activity (docs/agent-interface.md): the agent audit log as a table, newest
// first. The host filters and pages it (search, plugin, result, agent mode, time range); new
// entries are added at the top as they happen, and "Display more" adds older ones at the end.
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { cn } from "./lib/utils";
import { pillClass } from "./renderer/colors";
import { ENTERING, enterStyle } from "./renderer/row-motion";
import { ACTIVE_QUERY, FilterMenu } from "./renderer/Render";
import { TimeRangeFilter, rangeBounds, type TimeRange } from "./components/time-range-filter";
import { agentAudit } from "./lib/store";
import { OPERATION_LABELS, type AgentMode, type AgentPlugin, type AuditEntry, type AuditFilter, type AuditRecord } from "../shared/agents";

const PAGE = 50;
const HOUR = 3_600_000;
const OUTCOMES: Record<AuditEntry["outcome"], string> = { ok: "Allowed", denied: "Refused", error: "Failed" };
/** How an agent's change was allowed, in words. */
const APPROVALS: Record<NonNullable<AuditEntry["approval"]>, string> = {
	none: "no approval needed",
	grant: "allowed by a grant",
	once: "you allowed it",
	denied: "not allowed",
	"timed out": "no answer in time",
	cancelled: "withdrawn by the agent",
	changed: "the screen changed first",
};
const RESULTS: Record<NonNullable<AuditEntry["result"]>, string> = { ok: "done", "not-handled": "not handled", error: "failed", "no-answer": "no answer from the plugin" };
/** An action or fill's entry in a line: what, how many rows, its effect, how it was allowed and what the plugin did. */
const change = (e: AuditEntry) =>
	e.action || e.form
		? [
				e.action ? `Action ${e.action}` : `Form ${e.form}`,
				e.rows ? `${e.rows} row${e.rows === 1 ? "" : "s"}` : "",
				e.effect && e.effect !== "view" ? e.effect : "",
				e.approval ? APPROVALS[e.approval] : "",
				e.result ? RESULTS[e.result] : "",
				e.error ?? "",
			]
				.filter(Boolean)
				.join(" · ")
		: "";
const MODES: Record<AgentMode, string> = { interactive: "Interactive", autonomous: "Autonomous" };
type Filters = { query: string; plugins: string[]; outcomes: AuditEntry["outcome"][]; modes: AgentMode[]; range: TimeRange };
const NO_FILTERS: Filters = { query: "", plugins: [], outcomes: [], modes: [], range: null };

/** "2m ago", "3h ago", "Yesterday 14:05", "12 Nov 09:30". */
function relative(at: number, now: number) {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 45) return "Just now";
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
	if (s < 6 * 3600) return `${Math.floor(s / 3600)}h ago`;
	const d = new Date(at);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const today = new Date(now);
	const yesterday = new Date(now - 24 * HOUR);
	if (d.toDateString() === today.toDateString()) return `Today ${time}`;
	if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
	return `${d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) })} ${time}`;
}

function useNow(ms: number) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

function useDebounced<T>(value: T, ms: number) {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

/** Newest first, each entry once. */
const merge = (a: AuditRecord[], b: AuditRecord[]) => {
	const seen = new Set<number>();
	return [...a, ...b].filter((e) => !seen.has(e.id) && (seen.add(e.id), true)).sort((x, y) => y.id - x.id);
};

export function AgentActivity({ plugins, newest }: { plugins: AgentPlugin[]; newest: number | undefined }) {
	const [filters, setFilters] = useState<Filters>(NO_FILTERS);
	const query = useDebounced(filters.query.trim(), 200);
	const filter = useMemo<AuditFilter>(
		() => ({
			...(query ? { query } : {}),
			...(filters.plugins.length ? { plugins: filters.plugins } : {}),
			...(filters.outcomes.length ? { outcomes: filters.outcomes } : {}),
			...(filters.modes.length ? { modes: filters.modes } : {}),
			...rangeBounds(filters.range),
		}),
		[query, filters.plugins, filters.outcomes, filters.modes, filters.range],
	);
	const [rows, setRows] = useState<AuditRecord[]>([]);
	const [next, setNext] = useState<number | null>(null);
	const [loading, setLoading] = useState<"first" | "more" | null>("first");
	const [error, setError] = useState<string | null>(null);
	/** Entries that arrived while the table was showing: they fade in. */
	const [fresh, setFresh] = useState<Set<number>>(new Set());
	// Results of a request made for an older filter are dropped.
	const generation = useRef(0);
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const now = useNow(30_000);
	const names = useMemo(() => new Map(plugins.map((p) => [p.id, p.name])), [plugins]);
	// Installed plugins, plus ones the log mentions that are gone now (and any already picked).
	const pluginOptions = useMemo(() => {
		const ids = new Set([...plugins.map((p) => p.id), ...rows.flatMap((r) => (r.plugin ? [r.plugin] : [])), ...filters.plugins]);
		return [...ids].map((id) => ({ value: id, label: names.get(id) ?? id })).sort((a, b) => a.label.localeCompare(b.label));
	}, [plugins, rows, filters.plugins, names]);
	const active = filters.query !== "" || filters.plugins.length > 0 || filters.outcomes.length > 0 || filters.modes.length > 0 || filters.range !== null;

	useEffect(() => {
		const g = ++generation.current;
		setLoading("first");
		setError(null);
		agentAudit({ limit: PAGE, filter })
			.then((page) => {
				if (g !== generation.current) return;
				setRows(page.entries);
				setNext(page.next);
				setFresh(new Set());
			})
			.catch((e) => g === generation.current && setError(e instanceof Error ? e.message : String(e)))
			.finally(() => g === generation.current && setLoading(null));
	}, [filter]);

	// Live: when the log grows, fetch what's newer than the top row, with the same filter.
	useEffect(() => {
		const top = rowsRef.current[0]?.id;
		if (newest === undefined || loading === "first" || (top !== undefined && newest <= top)) return;
		const g = generation.current;
		agentAudit(top === undefined ? { limit: PAGE, filter } : { after: top, limit: 200, filter })
			.then((page) => {
				if (g !== generation.current || !page.entries.length) return;
				setRows((r) => merge(page.entries, r));
				if (top === undefined) setNext(page.next);
				setFresh(new Set(page.entries.map((e) => e.id)));
			})
			.catch(() => {});
	}, [newest]);

	const more = async () => {
		if (next === null) return;
		const g = generation.current;
		setLoading("more");
		try {
			const page = await agentAudit({ before: next, limit: PAGE, filter });
			if (g !== generation.current) return;
			setRows((r) => merge(r, page.entries));
			setNext(page.next);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (g === generation.current) setLoading(null);
		}
	};

	const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
	/** A renderer filter menu's `filter` event → this filter's values. */
	const pick = (key: "plugins" | "outcomes" | "modes") => (_name: string, payload?: unknown) => set(key, ((payload as { values: string[] }).values ?? []) as never);

	return (
		<section aria-label="Activity" className="min-w-0 space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3 px-1">
				<h2 className="text-base font-semibold">Activity</h2>
				<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="New activity appears as it happens">
					<span className="tb-pulse size-1.5 rounded-full bg-emerald-500" aria-hidden />
					Live
				</span>
			</div>
			<p className="px-1 text-sm text-muted-foreground">Everything agents asked ToolBelt for, newest first. It’s kept for good in agent-audit.jsonl in ToolBelt’s folder.</p>

			<div className="flex flex-wrap items-center gap-2">
				<InputGroup data-view-control data-filtering={!!filters.query} className={cn("h-8 w-full min-w-48 flex-1 transition-colors duration-200 sm:w-auto", !!filters.query && ACTIVE_QUERY)}>
					<InputGroupAddon>
						<Search />
					</InputGroupAddon>
					<InputGroupInput value={filters.query} onChange={(e) => set("query", e.target.value)} onKeyDown={(e) => e.key === "Escape" && filters.query && (e.preventDefault(), set("query", ""))} placeholder="Search activity" aria-label="Search activity" />
					{filters.query && (
						<InputGroupAddon align="inline-end">
							<InputGroupButton size="icon-xs" onClick={() => set("query", "")} aria-label="Clear search">
								<X />
							</InputGroupButton>
						</InputGroupAddon>
					)}
				</InputGroup>
				<FilterMenu filter={{ id: "plugins", label: "Plugin", icon: "puzzle", options: pluginOptions, selected: filters.plugins }} emit={pick("plugins")} />
				<FilterMenu
					filter={{ id: "outcomes", label: "Result", icon: "circle-check", options: (Object.keys(OUTCOMES) as AuditEntry["outcome"][]).map((o) => ({ value: o, label: OUTCOMES[o], dot: o === "ok" ? "success" : o === "denied" ? "warning" : "danger" })), selected: filters.outcomes }}
					emit={pick("outcomes")}
				/>
				<FilterMenu filter={{ id: "modes", label: "Agent mode", icon: "bot", options: (Object.keys(MODES) as AgentMode[]).map((m) => ({ value: m, label: MODES[m] })), selected: filters.modes }} emit={pick("modes")} />
				<TimeRangeFilter value={filters.range} onChange={(range) => set("range", range)} />
				{active && (
					<Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
						Clear filters
					</Button>
				)}
			</div>

			<div className="@container min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
				{error && <p className="border-b px-5 py-3 text-sm text-destructive">{error}</p>}
				{loading === "first" && !rows.length ? (
					<p className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Reading activity…
					</p>
				) : rows.length === 0 ? (
					<div className="space-y-3 px-5 py-8 text-center">
						<p className="text-sm font-medium">{active ? "No activity matches" : "No agent has used ToolBelt yet"}</p>
						<p className="text-sm text-muted-foreground">
							{active ? (next !== null ? "Nothing in the most recent activity. Older activity hasn’t been searched yet." : "Try other filters or a shorter search.") : "Activity appears here as soon as an agent connects."}
						</p>
						<div className="flex justify-center gap-2">
							{next !== null && (
								<Button variant="outline" size="sm" onClick={() => void more()} disabled={loading === "more"}>
									{loading === "more" && <Loader2 className="animate-spin" />}Search older activity
								</Button>
							)}
							{active && (
								<Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
									Clear filters
								</Button>
							)}
						</div>
					</div>
				) : (
					<>
						<Table aria-label="Agent activity" aria-busy={loading !== null} className={cn("transition-opacity duration-200", loading === "first" && "opacity-60")}>
							<TableHeader className="bg-muted/40">
								<TableRow className="hover:bg-transparent">
									<TableHead className="w-32 pl-5">Time</TableHead>
									<TableHead>Activity</TableHead>
									<TableHead className="hidden @xl:table-cell">Plugin</TableHead>
									<TableHead className="hidden @md:table-cell">Agent</TableHead>
									<TableHead className="w-24 pr-5 text-right">Result</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((e) => (
									<TableRow key={e.id} className={cn("align-top", fresh.has(e.id) && ENTERING)} style={fresh.has(e.id) ? enterStyle : undefined}>
										<TableCell className="pl-5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
											<time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
												{relative(e.at, now)}
											</time>
										</TableCell>
										<TableCell className="max-w-0 min-w-40 whitespace-normal">
											<div className="font-medium">{OPERATION_LABELS[e.operation] ?? e.operation}</div>
											{/* Narrow: the hidden columns' content, under the activity. */}
											<div className="truncate text-xs text-muted-foreground @xl:hidden">
												{[e.plugin && (names.get(e.plugin) ?? e.plugin) + (e.screen ? ` › ${e.screen}` : ""), `${e.client}${e.mode === "autonomous" ? " (autonomous)" : ""}`].filter(Boolean).join(" · ")}
											</div>
											{change(e) && <div className="mt-0.5 text-xs break-words text-muted-foreground">{change(e)}</div>}
											{e.detail && <div className="mt-0.5 text-xs break-words text-muted-foreground">{e.detail}</div>}
										</TableCell>
										<TableCell className="hidden text-sm @xl:table-cell">
											{e.plugin ? (
												<>
													{names.get(e.plugin) ?? e.plugin}
													{e.screen && <span className="text-muted-foreground"> › {e.screen}</span>}
												</>
											) : (
												<span className="text-muted-foreground">—</span>
											)}
										</TableCell>
										<TableCell className="hidden text-sm @md:table-cell">
											<div className="flex max-w-56 items-center gap-1.5">
												<span className="truncate" title={e.client}>{e.client}</span>
												{e.mode === "autonomous" && <span className={cn("shrink-0 rounded px-1.5 text-[11px] leading-4", pillClass("info"))}>Autonomous</span>}
											</div>
										</TableCell>
										<TableCell className="pr-5 text-right">
											<span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", pillClass(e.outcome === "ok" ? "success" : e.outcome === "denied" ? "warning" : "danger"))}>
												{OUTCOMES[e.outcome]}
											</span>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
							<span>
								{rows.length} {rows.length === 1 ? "entry" : "entries"}
								{active ? " matching" : ""}
								{next === null ? " · the beginning of the log" : ""}
							</span>
							{next !== null && (
								<Button variant="outline" size="sm" onClick={() => void more()} disabled={loading === "more"}>
									{loading === "more" && <Loader2 className="animate-spin" />}
									Display more…
								</Button>
							)}
						</div>
					</>
				)}
			</div>
		</section>
	);
}
