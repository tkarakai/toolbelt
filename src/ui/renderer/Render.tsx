// Turns a plugin's UI tree into shadcn/ui components. Every node type in shared/protocol.ts
// has one renderer here; plugins never ship their own components.
//
// Keyboard (tables): ↑/↓ move · →/← expand/collapse (← again: to the parent) · ↵ first action
// · . row menu · esc clear. Pages: ⌘F or / to filter, esc back to the list.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, MoreHorizontal, Search, X } from "lucide-react";
import type { Action, Cell, Column, Dialog as DialogNode, Field, Node, Row, Tone } from "../../shared/protocol";
import { duration, refreshEvery, relative } from "../../shared/time";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/icon";
import { openUrl } from "@/lib/store";
import { isTyping, usePersisted, useUIState } from "@/lib/uistate";
import { parseMarkdown, safeHref, type Block, type Inline } from "./markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type Emit = (name: string, payload?: unknown) => void;

const dotColor: Record<Tone, string> = {
	default: "bg-foreground/40",
	muted: "bg-muted-foreground/40",
	success: "bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15",
	warning: "bg-amber-500 shadow-[0_0_0_3px] shadow-amber-500/15",
	danger: "bg-red-500 shadow-[0_0_0_3px] shadow-red-500/15",
	info: "bg-sky-500 shadow-[0_0_0_3px] shadow-sky-500/15",
};
const textTone: Record<Tone, string> = {
	default: "",
	muted: "text-muted-foreground",
	success: "text-emerald-600 dark:text-emerald-400",
	warning: "text-amber-600 dark:text-amber-400",
	danger: "text-red-600 dark:text-red-400",
	info: "text-sky-600 dark:text-sky-400",
};

// ── search hits ──────────────────────────────────────────────────────────
const HighlightContext = createContext<RegExp | null>(null);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with the page's highlight words marked. */
export function Hl({ text }: { text: string }) {
	const re = useContext(HighlightContext);
	if (!re || !text) return <>{text}</>;
	const parts = text.split(re);
	if (parts.length === 1) return <>{text}</>;
	return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="hit">{p}</mark> : p))}</>;
}

export function Dot({ tone = "default", className }: { tone?: Tone; className?: string }) {
	return <span className={cn("inline-block size-2 shrink-0 rounded-full", dotColor[tone], className)} />;
}

/** A moment shown relative to now ("in 2h 14m"), redrawn as often as its wording changes. */
export function When({ at, className }: { at: number; className?: string }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setTimeout(() => tick((n) => n + 1), refreshEvery(at));
		return () => clearTimeout(t);
	});
	return (
		<time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className={className}>
			{relative(at)}
		</time>
	);
}

/** Time since `at`, counting up. */
function Elapsed({ at }: { at: number }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setTimeout(() => tick((n) => n + 1), 1000);
		return () => clearTimeout(t);
	});
	return <span className="tabular-nums">{duration(Date.now() - at)}</span>;
}

/** Buttons for toolbar, card and dialog actions. */
function ActionButtons({ actions, onRun, size = "sm" }: { actions: Action[]; onRun: (a: Action) => void; size?: "sm" | "default" }) {
	return (
		<>
			{actions.map((a) => (
				<Button key={a.id} size={size} disabled={a.disabled} variant={a.tone === "destructive" ? "destructive" : a.primary ? "default" : "outline"} onClick={() => onRun(a)}>
					{a.icon && <Icon name={a.icon} />}
					{a.label}
				</Button>
			))}
		</>
	);
}

export function Render({ node, emit }: { node: Node; emit: Emit }): ReactNode {
	switch (node.type) {
		case "page":
			return <Page node={node} emit={emit} />;
		case "stack":
			return (
				<div className={cn("flex", node.direction === "row" ? "flex-row" : "flex-col")} style={{ gap: `${(node.gap ?? 4) * 0.25}rem` }}>
					{node.children.map((c, i) => (
						<Render key={i} node={c} emit={emit} />
					))}
				</div>
			);
		case "table":
			return <DataTable node={node} emit={emit} />;
		case "list":
			return <List node={node} emit={emit} />;
		case "stats":
			return <Stats node={node} />;
		case "form":
			return <Form node={node} emit={emit} />;
		case "empty":
			return <EmptyState title={node.title} description={node.description} icon={node.icon} />;
		case "text":
			return <p className={cn("text-sm leading-relaxed whitespace-pre-line", textTone[node.tone ?? "default"], node.mono && "font-mono")}>{node.text}</p>;
		case "card":
			return <CardNode node={node} emit={emit} />;
		case "details":
			return <Details items={node.items} />;
		case "log":
			return <Log node={node} />;
		case "progress":
			return <ProgressNode node={node} />;
		case "markdown":
			return <Markdown text={node.text} />;
		default:
			return <EmptyState title="Unknown component" description={`This Toolbelt can't draw “${(node as { type: string }).type}” yet.`} icon="puzzle" />;
	}
}

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: string }) {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon name={icon ?? "inbox"} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				{description && <EmptyDescription>{description}</EmptyDescription>}
			</EmptyHeader>
		</Empty>
	);
}

// ── page: toolbar + content ──────────────────────────────────────────────
function Page({ node, emit }: { node: Extract<Node, { type: "page" }>; emit: Emit }) {
	// The filter text is remembered per surface; send it whenever the page opens, so the plugin
	// and the box always agree (after a plugin restart, or a reload that forgot the text).
	const [query, setQuery] = useUIState("search", "");
	const input = useRef<HTMLInputElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		if (node.search) emit("search", { query });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const onQuery = (q: string) => {
		setQuery(q);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => emit("search", { query: q }), 120);
	};
	useEffect(() => {
		if (!node.search) return;
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey && e.key === "f") || (e.key === "/" && !isTyping(e))) {
				e.preventDefault();
				input.current?.focus();
				input.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [node.search]);

	const words = (node.highlight ?? []).filter((w) => w.trim().length > 0);
	const highlight = useMemo(() => (words.length ? new RegExp(`(${words.map(escape).sort((a, b) => b.length - a.length).join("|")})`, "ig") : null), [words.join("\n")]);
	const { run, dialog: confirm } = useConfirm(emit);
	const hasToolbar = node.search || node.actions?.length || node.summary;
	// Pages without a table read better as a centered column.
	const narrow = !node.children.some((c) => c.type === "table");
	return (
		<HighlightContext.Provider value={highlight}>
		<div className="flex h-full min-h-0 flex-col">
			{hasToolbar && (
				<div className={cn("flex w-full shrink-0 items-center gap-3 px-6 pt-4 pb-3", narrow && "mx-auto max-w-4xl")}>
					{node.search && (
						<InputGroup className="max-w-sm">
							<InputGroupAddon>
								<Search />
							</InputGroupAddon>
							<InputGroupInput
								ref={input}
								placeholder={node.search.placeholder}
								value={query}
								onChange={(e) => onQuery(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										if (query) onQuery("");
										else input.current?.blur();
									}
									if (e.key === "ArrowDown" || e.key === "Enter") input.current?.blur(); // on to the list
								}}
							/>
							<InputGroupAddon align="inline-end">
								{query ? (
									<InputGroupButton size="icon-xs" onClick={() => onQuery("")} aria-label="Clear">
										<X />
									</InputGroupButton>
								) : (
									<Kbd>/</Kbd>
								)}
							</InputGroupAddon>
						</InputGroup>
					)}
					{node.summary && <span className="truncate text-sm text-muted-foreground tabular-nums">{node.summary}</span>}
					<div className="ml-auto flex items-center gap-2">
						<ActionButtons actions={node.actions ?? []} onRun={(a) => run(a)} />
					</div>
				</div>
			)}
			<div className={cn("min-h-0 flex-1", narrow ? "overflow-auto" : "flex")}>
				<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-6", narrow && "mx-auto w-full max-w-4xl px-6 py-4")}>
					{node.children.map((c, i) => (
						<Render key={i} node={c} emit={emit} />
					))}
				</div>
			</div>
			{confirm}
			<PageDialog dialog={node.dialog} emit={emit} />
		</div>
		</HighlightContext.Provider>
	);
}

/** The plugin's modal: open while the page has one. */
function PageDialog({ dialog, emit }: { dialog?: DialogNode; emit: Emit }) {
	// Keep the last dialog while the close animation plays.
	const last = useRef(dialog);
	if (dialog) last.current = dialog;
	const d = dialog ?? last.current;
	if (!d) return null;
	const close = () => emit("dialog-close", { dialog: d.id });
	return (
		<Dialog open={!!dialog} onOpenChange={(o) => !o && dialog && close()}>
			<DialogContent className={cn("flex max-h-[85vh] flex-col gap-0 p-0", d.wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
				<DialogHeader className="border-b px-6 pt-6 pb-4">
					<DialogTitle>{d.title}</DialogTitle>
					{d.description && <DialogDescription>{d.description}</DialogDescription>}
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4 [&>*]:shrink-0">
					{d.children.map((c, i) => (
						<Render key={i} node={c} emit={emit} />
					))}
				</div>
				<DialogFooter className="mx-0 mb-0 px-6 py-4">
					<Button variant="outline" onClick={close}>
						Cancel
					</Button>
					<ActionButtons size="default" actions={d.actions ?? []} onRun={(a) => emit(a.id, { dialog: d.id })} />
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ── table: groups, nested rows, actions, inspector ───────────────────────
function CellView({ cell, col }: { cell: Cell | undefined; col: Column }) {
	if (cell === undefined || cell === null) return <span className="text-muted-foreground/50">—</span>;
	if (typeof cell !== "object") return <span className={cn(col.mono && "font-mono text-[0.8rem] tabular-nums")}><Hl text={String(cell)} /></span>;
	const mono = cell.mono ?? col.mono;
	return (
		<div className="flex min-w-0 items-center gap-2.5">
			{cell.dot && <Dot tone={cell.dot} />}
			<div className="min-w-0">
				{cell.at !== undefined ? (
					<When at={cell.at} className={cn("block truncate", mono && "font-mono text-[0.8rem] tabular-nums", textTone[cell.tone ?? "default"])} />
				) : cell.text &&
					(cell.badge ? (
						<Badge variant="secondary"><Hl text={cell.text} /></Badge>
					) : (
						<div className={cn("truncate", mono && "font-mono text-[0.8rem] tabular-nums", textTone[cell.tone ?? "default"])}><Hl text={cell.text} /></div>
					))}
				{cell.sub && <div className="truncate text-xs text-muted-foreground"><Hl text={cell.sub} /></div>}
			</div>
			{cell.chips && cell.chips.length > 0 && (
				<div className="flex shrink-0 flex-nowrap gap-1">
					{cell.chips.slice(0, 3).map((c) => (
						<Badge key={c} variant="outline" className="font-mono text-[0.7rem] font-normal">
							<Hl text={c} />
						</Badge>
					))}
					{cell.chips.length > 3 && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge variant="secondary" className="font-mono text-[0.7rem] font-normal">
									+{cell.chips.length - 3}
								</Badge>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs font-mono">{cell.chips.slice(3).join("  ")}</TooltipContent>
						</Tooltip>
					)}
				</div>
			)}
		</div>
	);
}

type Confirm = { action: Action; payload?: Record<string, unknown> } | null;

function useConfirm(emit: Emit) {
	const [pending, setPending] = useState<Confirm>(null);
	const run = useCallback(
		(action: Action, rowId?: string, extra?: Record<string, unknown>) => {
			const payload = { ...(rowId !== undefined && { rowId }), ...extra };
			if (action.confirm) setPending({ action, payload });
			else emit(action.id, payload);
		},
		[emit],
	);
	const dialog = (
		<Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{pending?.action.label}</DialogTitle>
					<DialogDescription>{pending?.action.confirm}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setPending(null)}>
						Cancel
					</Button>
					<Button
						variant={pending?.action.tone === "destructive" ? "destructive" : "default"}
						autoFocus
						onClick={() => {
							if (pending) emit(pending.action.id, pending.payload);
							setPending(null);
						}}
					>
						{pending?.action.label}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
	return { run, dialog };
}

type Run = (a: Action, rowId?: string, extra?: Record<string, unknown>) => void;

function RowActions({ actions, rowId, run, menuOpen, setMenuOpen }: { actions: Action[]; rowId: string; run: Run; menuOpen: boolean; setMenuOpen: (open: boolean) => void }) {
	if (!actions.length) return null;
	const inline = actions.filter((a) => a.inline);
	return (
		<div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
			{inline.map((a) => (
				<Tooltip key={a.id}>
					<TooltipTrigger asChild>
						<Button variant="ghost" size="icon-sm" tabIndex={-1} className="text-muted-foreground opacity-0 group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100 hover:text-foreground group-data-[selected=true]/row:hover:bg-selected-foreground/15 group-data-[selected=true]/row:hover:text-selected-foreground" onClick={() => run(a, rowId)} aria-label={a.label}>
							<Icon name={a.icon} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{a.label}</TooltipContent>
				</Tooltip>
			))}
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" tabIndex={-1} className="text-muted-foreground data-[state=open]:bg-accent group-data-[selected=true]/row:hover:bg-selected-foreground/15 group-data-[selected=true]/row:hover:text-selected-foreground" aria-label="More">
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					{actions.map((a, i) => (
						<div key={a.id}>
							{a.tone === "destructive" && i > 0 && <DropdownMenuSeparator />}
							<DropdownMenuItem variant={a.tone === "destructive" ? "destructive" : "default"} onSelect={() => run(a, rowId)}>
								{a.icon && <Icon name={a.icon} />}
								{a.label}
							</DropdownMenuItem>
						</div>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** A row as displayed: flattened from the tree, with its depth and parent. */
type Visible = { row: Row; depth: number; parent?: string; group?: string };

const TableRow = memo(
	function TableRow({ v, columns, actions, selected, expanded, menuOpen, checked, onSelect, onToggle, onMenu, onCheck, run }: { v: Visible; sig: string; columns: Column[]; actions: Action[]; selected: boolean; expanded: boolean; menuOpen: boolean; checked?: boolean; onSelect: (id: string) => void; onToggle: (id: string) => void; onMenu: (id: string | null) => void; onCheck?: (id: string) => void; run: Run }) {
		const { row, depth } = v;
		const hasChildren = !!row.children?.length;
		return (
			<tr data-row-id={row.id} data-selected={selected} onClick={() => onSelect(row.id)} onDoubleClick={() => hasChildren && onToggle(row.id)} className={cn("group/row cursor-default transition-colors hover:bg-muted/50 data-[selected=true]:bg-selected data-[selected=true]:text-selected-foreground [&>td]:border-b [&>td]:border-border/50", depth > 0 && "bg-muted/20")}>
				{onCheck && (
					<td className="w-0 pl-4" onClick={(e) => e.stopPropagation()}>
						{depth === 0 && <Checkbox tabIndex={-1} checked={!!checked} onCheckedChange={() => onCheck(row.id)} aria-label="Select row" />}
					</td>
				)}
				{columns.map((c, i) => (
					<td key={c.key} className={cn("h-12 px-3 align-middle text-sm", i === 0 && "pl-3", c.align === "right" && "text-right", c.grow ? "w-full max-w-0" : "whitespace-nowrap", c.optional && "hidden @4xl:table-cell")}>
						{i === 0 ? (
							<div className="flex min-w-0 items-center" style={{ paddingLeft: depth * 20 }}>
								<button
									tabIndex={-1}
									aria-label={expanded ? "Collapse" : "Expand"}
									onClick={(e) => (e.stopPropagation(), onToggle(row.id))}
									className={cn("mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground", !hasChildren && "invisible")}
								>
									<ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
								</button>
								<div className="min-w-0 flex-1">
									<CellView cell={row.cells[c.key]} col={c} />
								</div>
							</div>
						) : (
							<CellView cell={row.cells[c.key]} col={c} />
						)}
					</td>
				))}
				<td className="w-0 pr-4 pl-1 whitespace-nowrap">
					<RowActions actions={actions} rowId={row.id} run={run} menuOpen={menuOpen} setMenuOpen={(o) => onMenu(o ? row.id : null)} />
				</td>
			</tr>
		);
	},
	(a, b) => a.sig === b.sig && a.selected === b.selected && a.expanded === b.expanded && a.menuOpen === b.menuOpen && a.checked === b.checked && a.onCheck === b.onCheck && a.columns === b.columns && a.actions === b.actions && a.run === b.run,
);

function DataTable({ node, emit }: { node: Extract<Node, { type: "table" }>; emit: Emit }) {
	const [selected, setSelected] = useUIState<string | null>(`${node.id}:selected`, null);
	const [expandedList, setExpanded] = useUIState<string[]>(`${node.id}:expanded`, []);
	const expanded = useMemo(() => new Set(expandedList), [expandedList]);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const { run, dialog } = useConfirm(emit);
	const columns = useMemo(() => node.columns, [JSON.stringify(node.columns)]);
	const allActions = useMemo(() => node.actions ?? [], [JSON.stringify(node.actions ?? [])]);
	const actionsFor = useMemo(() => {
		const cache = new Map<string, Action[]>();
		return (row: Row) => {
			if (!row.actions) return allActions;
			const k = row.actions.join(",");
			if (!cache.has(k)) cache.set(k, allActions.filter((a) => row.actions!.includes(a.id)));
			return cache.get(k)!;
		};
	}, [allActions]);
	const toggle = useCallback((id: string) => setExpanded((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])), [setExpanded]);

	// Checked rows (tables with bulk actions): only top-level rows that still exist count.
	const bulk = useMemo(() => node.bulkActions ?? [], [JSON.stringify(node.bulkActions ?? [])]);
	const [checkedList, setChecked] = useUIState<string[]>(`${node.id}:checked`, []);
	const rowIds = useMemo(() => new Set(node.rows.map((r) => r.id)), [node.rows]);
	const checked = useMemo(() => new Set(checkedList.filter((id) => rowIds.has(id))), [checkedList, rowIds]);
	const check = useCallback((id: string) => setChecked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])), [setChecked]);
	const allChecked = checked.size > 0 && checked.size === rowIds.size;

	// Groups in order of first appearance; within them, rows flattened with expanded children.
	const groups = useMemo(() => {
		const out: { name: string | undefined; rows: Visible[] }[] = [];
		const byName = new Map<string | undefined, (typeof out)[number]>();
		const walk = (r: Row, depth: number, into: Visible[], parent?: string) => {
			into.push({ row: r, depth, parent, group: r.group });
			if (r.children && expanded.has(r.id)) for (const c of r.children) walk(c, depth + 1, into, r.id);
		};
		for (const r of node.rows) {
			let g = byName.get(r.group);
			if (!g) byName.set(r.group, (g = { name: r.group, rows: [] })), out.push(g);
			walk(r, 0, g.rows);
		}
		return out;
	}, [node.rows, expanded]);
	const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
	const current = flat.find((v) => v.row.id === selected) ?? null;

	const select = useCallback(
		(id: string | null) => {
			setSelected(id);
			if (id) requestAnimationFrame(() => document.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
		},
		[setSelected],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
			const i = flat.findIndex((v) => v.row.id === selected);
			const cur = flat[i];
			switch (e.key) {
				case "ArrowDown":
				case "ArrowUp": {
					e.preventDefault();
					const next = i < 0 ? flat[e.key === "ArrowDown" ? 0 : flat.length - 1] : flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
					if (next) select(next.row.id);
					break;
				}
				case "ArrowRight":
					if (cur?.row.children?.length) {
						e.preventDefault();
						if (!expanded.has(cur.row.id)) toggle(cur.row.id);
						else select(cur.row.children[0].id);
					}
					break;
				case "ArrowLeft":
					if (!cur) break;
					e.preventDefault();
					if (expanded.has(cur.row.id)) toggle(cur.row.id);
					else if (cur.parent) select(cur.parent);
					break;
				case "Enter": {
					const a = cur && actionsFor(cur.row).find((x) => x.inline);
					if (a) (e.preventDefault(), run(a, cur.row.id));
					break;
				}
				case ".":
					if (cur && actionsFor(cur.row).length) (e.preventDefault(), setMenuFor(cur.row.id));
					break;
				case "Escape":
					if (selected) (e.preventDefault(), setSelected(null));
					break;
				case " ":
					if (bulk.length && cur && cur.depth === 0) (e.preventDefault(), check(cur.row.id));
					break;
				case "Home":
				case "End":
					if (flat.length) (e.preventDefault(), select(flat[e.key === "Home" ? 0 : flat.length - 1].row.id));
					break;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [flat, selected, expanded, toggle, select, actionsFor, run, setSelected, bulk, check]);

	if (!node.rows.length) return node.empty ? <EmptyState {...node.empty} /> : null;

	return (
		<div className="@container flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				{checked.size > 0 && (
					<div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-2">
						<span className="text-sm tabular-nums">{checked.size} selected</span>
						<Button variant="ghost" size="sm" onClick={() => setChecked([])}>
							Clear
						</Button>
						<div className="ml-auto flex items-center gap-2">
							<ActionButtons actions={bulk} onRun={(a) => run(a, undefined, { rowIds: [...checked] })} />
						</div>
					</div>
				)}
			<div className="min-h-0 min-w-0 flex-1 overflow-auto">
				<table className="w-full border-separate border-spacing-0 text-left">
					<thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
						<tr>
							{bulk.length > 0 && (
								<th className="w-0 border-b pl-4">
									<Checkbox checked={allChecked ? true : checked.size ? "indeterminate" : false} onCheckedChange={() => setChecked(allChecked ? [] : [...rowIds])} aria-label="Select all" />
								</th>
							)}
							{columns.map((c, i) => (
								<th key={c.key} className={cn("h-9 border-b px-3 text-xs font-medium text-muted-foreground", i === 0 && "pl-9", c.align === "right" && "text-right", c.optional && "hidden @4xl:table-cell")}>
									{c.title}
								</th>
							))}
							<th className="w-0 border-b" />
						</tr>
					</thead>
					{groups.map((g) => (
						<tbody key={g.name ?? ""}>
							{g.name !== undefined && (
								<tr>
									<td colSpan={columns.length + 1 + (bulk.length ? 1 : 0)} className="border-b bg-muted/40 px-6 py-1.5">
										<div className="flex items-center gap-2 text-xs">
											<span className="truncate font-mono font-medium text-foreground/80"><Hl text={g.name} /></span>
											<span className="text-muted-foreground tabular-nums">{g.rows.filter((v) => v.depth === 0).length}</span>
										</div>
									</td>
								</tr>
							)}
							{g.rows.map((v) => (
								<TableRow
									key={v.row.id}
									v={v}
									sig={JSON.stringify(v.row) + v.depth}
									columns={columns}
									actions={actionsFor(v.row)}
									selected={v.row.id === selected}
									expanded={expanded.has(v.row.id)}
									menuOpen={menuFor === v.row.id}
									onSelect={select}
									onToggle={toggle}
									onMenu={setMenuFor}
									checked={checked.has(v.row.id)}
									onCheck={bulk.length ? check : undefined}
									run={run}
								/>
							))}
						</tbody>
					))}
				</table>
			</div>
			</div>
			{current?.row.details && <Inspector row={current.row} actions={actionsFor(current.row)} run={run} onClose={() => setSelected(null)} />}
			{dialog}
		</div>
	);
}

/** The details drawer on the right; drag its left edge to resize (remembered). */
function Inspector({ row, actions, run, onClose }: { row: Row; actions: Action[]; run: Run; onClose: () => void }) {
	const [width, setWidth] = usePersisted("toolbelt.inspectorWidth", 320);
	const title = row.cells[Object.keys(row.cells)[0]];
	const text = title && typeof title === "object" ? title.text : String(title ?? row.id);
	const onPointerDown = (e: React.PointerEvent) => {
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startW = width;
		document.body.style.cursor = "col-resize";
		const move = (ev: PointerEvent) => setWidth(Math.round(Math.max(260, Math.min(720, startW + startX - ev.clientX))));
		const up = () => {
			document.body.style.cursor = "";
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};
	return (
		<aside className="relative hidden shrink-0 flex-col border-l bg-muted/20 @3xl:flex" style={{ width }}>
			<div onPointerDown={onPointerDown} onDoubleClick={() => setWidth(320)} className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors hover:after:bg-ring/60" />
			<div className="flex items-start gap-2 border-b px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="text-xs text-muted-foreground">Details</div>
					<div className="truncate font-medium">{text}</div>
				</div>
				<Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
					<X />
				</Button>
			</div>
			<dl className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4 text-sm">
				{row.details!.map((d) => (
					<div key={d.label} className="space-y-1">
						<dt className="text-xs text-muted-foreground">{d.label}</dt>
						<dd className={cn("break-words select-text", d.mono && "font-mono text-[0.8rem]")}><Hl text={d.value} /></dd>
					</div>
				))}
			</dl>
			{actions.length > 0 && (
				<div className="flex flex-wrap gap-2 border-t p-3">
					{actions.map((a) => (
						<Button key={a.id} size="sm" variant={a.tone === "destructive" ? "destructive" : "outline"} onClick={() => run(a, row.id)}>
							{a.icon && <Icon name={a.icon} />}
							{a.label}
							{a.inline && a === actions.find((x) => x.inline) && <Kbd className="ml-1">↵</Kbd>}
						</Button>
					))}
				</div>
			)}
		</aside>
	);
}

// ── compact list (quick views) ───────────────────────────────────────────
/** ↑/↓ move through the items, ↵ runs the item's first action. `keyboard` turns it on. */
function List({ node, emit, keyboard = true }: { node: Extract<Node, { type: "list" }>; emit: Emit; keyboard?: boolean }) {
	const { run, dialog } = useConfirm(emit);
	const [active, setActive] = useUIState<string | null>(`${node.id}:active`, null);
	useEffect(() => {
		if (!keyboard) return;
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
			const i = node.items.findIndex((it) => it.id === active);
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const next = node.items[i < 0 ? 0 : Math.max(0, Math.min(node.items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
				if (next) {
					setActive(next.id);
					requestAnimationFrame(() => document.querySelector(`[data-item-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" }));
				}
			} else if (e.key === "Enter" && i >= 0) {
				const a = node.items[i].actions?.[0];
				if (a) (e.preventDefault(), run(a, node.items[i].id));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [keyboard, node.items, active, setActive, run]);
	if (!node.items.length) return node.empty ? <EmptyState {...node.empty} /> : null;
	return (
		<div className="flex flex-col">
			{node.items.map((it) => (
				<div key={it.id} data-item-id={it.id} data-active={it.id === active} onMouseEnter={() => setActive(it.id)} className="group/row flex items-center gap-3 rounded-lg px-2.5 py-2 data-[active=true]:bg-selected data-[active=true]:text-selected-foreground">
					{it.dot && <Dot tone={it.dot} />}
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium">{it.title}</div>
						{it.subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{it.subtitle}</div>}
					</div>
					{(it.meta || it.metaAt !== undefined) && <span className="text-xs text-muted-foreground tabular-nums group-data-[active=true]/row:hidden">{it.metaAt !== undefined ? <When at={it.metaAt} /> : it.meta}</span>}
					{it.actions && it.actions.length > 0 && (
						<div className="hidden items-center gap-0.5 group-data-[active=true]/row:flex">
							{it.actions.map((a, i) => (
								<Tooltip key={a.id}>
									<TooltipTrigger asChild>
										<Button variant="ghost" size="icon-xs" tabIndex={-1} className="hover:bg-selected-foreground/15 hover:text-selected-foreground" onClick={() => run(a, it.id)} aria-label={a.label}>
											<Icon name={a.icon} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{a.label}
										{i === 0 && " ↵"}
									</TooltipContent>
								</Tooltip>
							))}
						</div>
					)}
				</div>
			))}
			{dialog}
		</div>
	);
}

function Stats({ node }: { node: Extract<Node, { type: "stats" }> }) {
	return (
		<div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(node.items.length, 4)}, minmax(0, 1fr))` }}>
			{node.items.map((s) => (
				<Card key={s.label} className="gap-1 py-4">
					<CardHeader className="px-4">
						<CardDescription className="text-xs">{s.label}</CardDescription>
						<CardTitle className={cn("text-2xl font-semibold tabular-nums", textTone[s.tone ?? "default"])}>{s.at !== undefined ? <When at={s.at} /> : s.value}</CardTitle>
					</CardHeader>
					{s.hint && <CardContent className="px-4 text-xs text-muted-foreground">{s.hint}</CardContent>}
				</Card>
			))}
		</div>
	);
}

// ── forms (settings) ─────────────────────────────────────────────────────
function Form({ node, emit }: { node: Extract<Node, { type: "form" }>; emit: Emit }) {
	const change = (field: Field, value: string | boolean) => emit("field", { form: node.id, field: field.id, value });
	return (
		<Card>
			{(node.title || node.description) && (
				<CardHeader>
					{node.title && <CardTitle>{node.title}</CardTitle>}
					{node.description && <CardDescription>{node.description}</CardDescription>}
				</CardHeader>
			)}
			<CardContent className="divide-y">
				{node.fields.map((f) => (
					<div key={f.id} className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
						<div className="space-y-1">
							<Label htmlFor={`${node.id}-${f.id}`}>{f.label}</Label>
							{f.description && <p className="text-sm text-muted-foreground">{f.description}</p>}
						</div>
						<FieldControl id={`${node.id}-${f.id}`} field={f} onChange={(v) => change(f, v)} />
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function FieldControl({ id, field, onChange }: { id: string; field: Field; onChange: (v: string | boolean) => void }) {
	switch (field.type) {
		case "select":
			return (
				<Select value={field.value} onValueChange={onChange}>
					<SelectTrigger id={id} className="w-48">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{field.options.map((o) => (
							<SelectItem key={o.value} value={o.value}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		case "switch":
			return <Switch id={id} checked={field.value} onCheckedChange={onChange} />;
		case "text":
			return <TextField id={id} field={field} onChange={onChange} />;
	}
}

function TextField({ id, field, onChange }: { id: string; field: Extract<Field, { type: "text" }>; onChange: (v: string) => void }) {
	const [v, setV] = useState(field.value);
	useEffect(() => setV(field.value), [field.value]);
	return <Input id={id} className="w-64" value={v} placeholder={field.placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== field.value && onChange(v)} onKeyDown={(e) => e.key === "Enter" && onChange(v)} />;
}

// ── cards, details, logs, progress ───────────────────────────────────────
const cardTone: Record<Tone, string> = {
	default: "",
	muted: "bg-muted/30",
	success: "border-emerald-500/40",
	warning: "border-amber-500/50 bg-amber-500/5",
	danger: "border-red-500/50 bg-red-500/5",
	info: "border-sky-500/40 bg-sky-500/5",
};

function CardNode({ node, emit }: { node: Extract<Node, { type: "card" }>; emit: Emit }) {
	const { run, dialog } = useConfirm(emit);
	const hasHeader = node.title || node.description || node.actions?.length;
	return (
		<Card className={cn("gap-3 py-4", cardTone[node.tone ?? "default"])}>
			{hasHeader && (
				<CardHeader className="flex items-start gap-3 px-4">
					<div className="min-w-0 flex-1 space-y-1">
						{node.title && <CardTitle className="text-sm">{node.title}</CardTitle>}
						{node.description && <CardDescription className="text-xs">{node.description}</CardDescription>}
					</div>
					{node.actions && node.actions.length > 0 && (
						<div className="flex shrink-0 items-center gap-2">
							<ActionButtons actions={node.actions} onRun={(a) => run(a, node.id)} />
						</div>
					)}
				</CardHeader>
			)}
			{node.children.length > 0 && (
				<CardContent className="flex flex-col gap-3 px-4">
					{node.children.map((c, i) => (
						<Render key={i} node={c} emit={emit} />
					))}
				</CardContent>
			)}
			{dialog}
		</Card>
	);
}

function Details({ items }: { items: Extract<Node, { type: "details" }>["items"] }) {
	return (
		<dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-2 text-sm">
			{items.map((d) => (
				<div key={d.label} className="contents">
					<dt className="text-muted-foreground">{d.label}</dt>
					<dd className={cn("min-w-0 break-words select-text", d.mono && "font-mono text-[0.8rem]", textTone[d.tone ?? "default"])}>{d.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Command output. With `follow`, stays scrolled to the newest line unless the person scrolled up. */
function Log({ node }: { node: Extract<Node, { type: "log" }> }) {
	const box = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	useLayoutEffect(() => {
		const el = box.current;
		if (el && node.follow && pinned.current) el.scrollTop = el.scrollHeight;
	}, [node.lines, node.follow]);
	if (!node.lines.length) return <p className="text-sm text-muted-foreground">{node.empty ?? "No output."}</p>;
	return (
		<div
			ref={box}
			onScroll={(e) => {
				const el = e.currentTarget;
				pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}
			className="max-h-80 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-[0.75rem] leading-relaxed select-text"
		>
			{node.lines.map((l, i) => (
				<div key={i} className={cn("break-all whitespace-pre-wrap", textTone[l.tone ?? "default"])}>
					{l.at !== undefined && <span className="mr-2 text-muted-foreground/70">{new Date(l.at).toLocaleTimeString(undefined, { hour12: false })}</span>}
					{l.text}
				</div>
			))}
		</div>
	);
}

function ProgressNode({ node }: { node: Extract<Node, { type: "progress" }> }) {
	const known = typeof node.value === "number";
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<span className={cn("min-w-0 flex-1 truncate", textTone[node.tone ?? "default"])}>{node.label ?? "Working…"}</span>
				{known && <span className="tabular-nums">{Math.round(node.value! * 100)}%</span>}
				{node.at !== undefined && <Elapsed at={node.at} />}
			</div>
			{known ? (
				<Progress value={Math.max(0, Math.min(1, node.value!)) * 100} />
			) : (
				<div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
					<div className="absolute inset-y-0 w-1/3 animate-[tb-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
				</div>
			)}
		</div>
	);
}

// ── markdown ─────────────────────────────────────────────────────────────
function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return <div className="space-y-3 text-sm leading-relaxed break-words select-text">{blocks.map((b, i) => <MdBlock key={i} b={b} />)}</div>;
}

const headingSize = ["", "text-lg font-semibold", "text-base font-semibold", "text-sm font-semibold", "text-sm font-medium", "text-sm font-medium", "text-xs font-medium uppercase text-muted-foreground"];

function MdBlock({ b }: { b: Block }): ReactNode {
	switch (b.t) {
		case "heading":
			return (
				<div role="heading" aria-level={b.level} className={cn(headingSize[b.level], "pt-1")}>
					<MdInline nodes={b.children} />
				</div>
			);
		case "paragraph":
			return (
				<p>
					<MdInline nodes={b.children} />
				</p>
			);
		case "code":
			return <pre className="overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[0.75rem]">{b.text}</pre>;
		case "quote":
			return (
				<blockquote className="space-y-3 border-l-2 pl-3 text-muted-foreground">
					{b.children.map((c, i) => (
						<MdBlock key={i} b={c} />
					))}
				</blockquote>
			);
		case "rule":
			return <hr className="border-border" />;
		case "list": {
			const Tag = b.ordered ? "ol" : "ul";
			return (
				<Tag start={b.ordered ? b.start : undefined} className={cn("space-y-1 pl-5", b.ordered ? "list-decimal" : "list-disc")}>
					{b.items.map((item, i) => (
						<li key={i} className="space-y-1 [&>p]:inline">
							{item.map((c, j) => (
								<MdBlock key={j} b={c} />
							))}
						</li>
					))}
				</Tag>
			);
		}
		case "table":
			return (
				<div className="overflow-auto">
					<table className="w-full border-collapse text-left text-xs">
						<thead>
							<tr>
								{b.head.map((c, i) => (
									<th key={i} className="border-b px-2 py-1 font-medium">
										<MdInline nodes={c} />
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{b.rows.map((r, i) => (
								<tr key={i}>
									{r.map((c, j) => (
										<td key={j} className="border-b border-border/50 px-2 py-1">
											<MdInline nodes={c} />
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
	}
}

function MdInline({ nodes }: { nodes: Inline[] }): ReactNode {
	return nodes.map((n, i) => {
		switch (n.t) {
			case "text":
				return n.text;
			case "code":
				return (
					<code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em]">
						{n.text}
					</code>
				);
			case "strong":
				return (
					<strong key={i} className="font-semibold">
						<MdInline nodes={n.children} />
					</strong>
				);
			case "em":
				return (
					<em key={i}>
						<MdInline nodes={n.children} />
					</em>
				);
			case "del":
				return (
					<del key={i}>
						<MdInline nodes={n.children} />
					</del>
				);
			case "link":
				return safeHref(n.href) ? (
					<a
						key={i}
						href={n.href}
						title={n.href}
						className="text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
						onClick={(e) => {
							e.preventDefault();
							openUrl(n.href);
						}}
					>
						<MdInline nodes={n.children} />
					</a>
				) : (
					<MdInline key={i} nodes={n.children} />
				);
		}
	});
}
