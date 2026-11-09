// Turns a plugin's UI tree into shadcn/ui components. Every node type in shared/protocol.ts
// has one renderer here; plugins never ship their own components.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Search, X } from "lucide-react";
import type { Action, Cell, Column, Field, Node, Row, Tone } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
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

export function Dot({ tone = "default", className }: { tone?: Tone; className?: string }) {
	return <span className={cn("inline-block size-2 shrink-0 rounded-full", dotColor[tone], className)} />;
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
			return <p className={cn("text-sm leading-relaxed", textTone[node.tone ?? "default"], node.mono && "font-mono")}>{node.text}</p>;
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
	const [query, setQuery] = useState("");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const onQuery = (q: string) => {
		setQuery(q);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => emit("search", { query: q }), 120);
	};
	const hasToolbar = node.search || node.actions?.length || node.summary;
	// Pages without a table read better as a centered column.
	const narrow = !node.children.some((c) => c.type === "table");
	return (
		<div className="flex h-full min-h-0 flex-col">
			{hasToolbar && (
				<div className={cn("flex w-full shrink-0 items-center gap-3 px-6 pt-4 pb-3", narrow && "mx-auto max-w-4xl")}>
					{node.search && (
						<InputGroup className="max-w-sm">
							<InputGroupAddon>
								<Search />
							</InputGroupAddon>
							<InputGroupInput placeholder={node.search.placeholder} value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onQuery("")} />
							{query && (
								<InputGroupAddon align="inline-end">
									<InputGroupButton size="icon-xs" onClick={() => onQuery("")} aria-label="Clear">
										<X />
									</InputGroupButton>
								</InputGroupAddon>
							)}
						</InputGroup>
					)}
					{node.summary && <span className="truncate text-sm text-muted-foreground tabular-nums">{node.summary}</span>}
					<div className="ml-auto flex items-center gap-2">
						{node.actions?.map((a) => (
							<Button key={a.id} variant="outline" size="sm" onClick={() => emit(a.id)}>
								{a.icon && <Icon name={a.icon} />}
								{a.label}
							</Button>
						))}
					</div>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto">
				<div className={cn("flex min-h-full flex-col gap-6", narrow && "mx-auto w-full max-w-4xl px-6 py-4")}>
					{node.children.map((c, i) => (
						<Render key={i} node={c} emit={emit} />
					))}
				</div>
			</div>
		</div>
	);
}

// ── table with groups, row actions and an inspector ──────────────────────
function CellView({ cell, col }: { cell: Cell | undefined; col: Column }) {
	if (cell === undefined || cell === null) return <span className="text-muted-foreground/50">—</span>;
	if (typeof cell !== "object") return <span className={cn(col.mono && "font-mono text-[0.8rem] tabular-nums")}>{cell}</span>;
	const mono = cell.mono ?? col.mono;
	return (
		<div className="flex min-w-0 items-center gap-2.5">
			{cell.dot && <Dot tone={cell.dot} />}
			<div className="min-w-0">
				{cell.text &&
					(cell.badge ? (
						<Badge variant="secondary">{cell.text}</Badge>
					) : (
						<div className={cn("truncate", mono && "font-mono text-[0.8rem] tabular-nums", textTone[cell.tone ?? "default"])}>{cell.text}</div>
					))}
				{cell.sub && <div className="truncate text-xs text-muted-foreground">{cell.sub}</div>}
			</div>
			{cell.chips && cell.chips.length > 0 && (
				<div className="flex shrink-0 flex-nowrap gap-1">
					{cell.chips.slice(0, 3).map((c) => (
						<Badge key={c} variant="outline" className="font-mono text-[0.7rem] font-normal">
							{c}
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

type Confirm = { action: Action; rowId?: string } | null;

function useConfirm(emit: Emit) {
	const [pending, setPending] = useState<Confirm>(null);
	const run = useCallback(
		(action: Action, rowId?: string) => {
			if (action.confirm) setPending({ action, rowId });
			else emit(action.id, { rowId });
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
							if (pending) emit(pending.action.id, { rowId: pending.rowId });
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

function RowActions({ actions, rowId, run }: { actions: Action[]; rowId: string; run: (a: Action, rowId?: string) => void }) {
	if (!actions.length) return null;
	const inline = actions.filter((a) => a.inline);
	return (
		<div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
			{inline.map((a) => (
				<Tooltip key={a.id}>
					<TooltipTrigger asChild>
						<Button variant="ghost" size="icon-sm" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100 hover:text-foreground" onClick={() => run(a, rowId)} aria-label={a.label}>
							<Icon name={a.icon} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{a.label}</TooltipContent>
				</Tooltip>
			))}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" className="text-muted-foreground data-[state=open]:bg-accent" aria-label="More">
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-48">
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

const TableRow = memo(
	function TableRow({ row, columns, actions, selected, onSelect, run }: { row: Row; sig: string; columns: Column[]; actions: Action[]; selected: boolean; onSelect: (id: string) => void; run: (a: Action, rowId?: string) => void }) {
		return (
			<tr data-row-id={row.id} data-selected={selected} onClick={() => onSelect(row.id)} className="group/row cursor-default transition-colors [&>td]:border-b [&>td]:border-border/50 hover:bg-muted/50 data-[selected=true]:bg-accent">
				{columns.map((c, i) => (
					<td key={c.key} className={cn("h-12 px-3 align-middle text-sm", i === 0 && "pl-6", c.align === "right" && "text-right", c.grow ? "w-full max-w-0" : "whitespace-nowrap", c.optional && "hidden @4xl:table-cell")}>
						<CellView cell={row.cells[c.key]} col={c} />
					</td>
				))}
				<td className="w-0 pr-4 pl-1 whitespace-nowrap">
					<RowActions actions={actions} rowId={row.id} run={run} />
				</td>
			</tr>
		);
	},
	(a, b) => a.sig === b.sig && a.selected === b.selected && a.columns === b.columns && a.actions === b.actions && a.run === b.run,
);

function DataTable({ node, emit }: { node: Extract<Node, { type: "table" }>; emit: Emit }) {
	const [selected, setSelected] = useState<string | null>(null);
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

	const groups = useMemo(() => {
		const out: { name: string | undefined; rows: Row[] }[] = [];
		const byName = new Map<string | undefined, (typeof out)[number]>();
		for (const r of node.rows) {
			let g = byName.get(r.group);
			if (!g) byName.set(r.group, (g = { name: r.group, rows: [] })), out.push(g);
			g.rows.push(r);
		}
		return out;
	}, [node.rows]);
	const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
	const current = flat.find((r) => r.id === selected) ?? null;

	// ↑/↓ move the selection, Esc clears it.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.target as HTMLElement)?.closest("input, textarea, [role=dialog], [role=menu]")) return;
			if (e.key === "Escape") setSelected(null);
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			e.preventDefault();
			const i = flat.findIndex((r) => r.id === selected);
			const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
			if (next) {
				setSelected(next.id);
				document.querySelector(`[data-row-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [flat, selected]);

	if (!node.rows.length) return node.empty ? <EmptyState {...node.empty} /> : null;

	return (
		<div className="@container flex min-h-0 flex-1">
			<div className="min-w-0 flex-1">
				<table className="w-full border-separate border-spacing-0 text-left">
					<thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
						<tr>
							{columns.map((c, i) => (
								<th key={c.key} className={cn("h-9 border-b px-3 text-xs font-medium text-muted-foreground", i === 0 && "pl-6", c.align === "right" && "text-right", c.optional && "hidden @4xl:table-cell")}>
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
									<td colSpan={columns.length + 1} className="border-b bg-muted/40 px-6 py-1.5">
										<div className="flex items-center gap-2 text-xs">
											<span className="truncate font-mono font-medium text-foreground/80">{g.name}</span>
											<span className="text-muted-foreground tabular-nums">{g.rows.length}</span>
										</div>
									</td>
								</tr>
							)}
							{g.rows.map((r) => (
								<TableRow key={r.id} row={r} sig={JSON.stringify(r)} columns={columns} actions={actionsFor(r)} selected={r.id === selected} onSelect={setSelected} run={run} />
							))}
						</tbody>
					))}
				</table>
			</div>
			{current?.details && <Inspector row={current} actions={actionsFor(current)} run={run} onClose={() => setSelected(null)} />}
			{dialog}
		</div>
	);
}

function Inspector({ row, actions, run, onClose }: { row: Row; actions: Action[]; run: (a: Action, rowId?: string) => void; onClose: () => void }) {
	const title = row.cells[Object.keys(row.cells)[0]];
	const text = title && typeof title === "object" ? title.text : String(title ?? row.id);
	return (
		<aside className="sticky top-0 hidden h-[calc(100svh-6.5rem)] w-80 shrink-0 flex-col border-l bg-muted/20 @3xl:flex">
			<div className="flex items-start gap-2 border-b px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="text-xs text-muted-foreground">Details</div>
					<div className="truncate font-medium">{text}</div>
				</div>
				<Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
					<X />
				</Button>
			</div>
			<dl className="flex-1 space-y-3 overflow-auto px-4 py-4 text-sm">
				{row.details!.map((d) => (
					<div key={d.label} className="space-y-1">
						<dt className="text-xs text-muted-foreground">{d.label}</dt>
						<dd className={cn("break-words select-text", d.mono && "font-mono text-[0.8rem]")}>{d.value}</dd>
					</div>
				))}
			</dl>
			{actions.length > 0 && (
				<div className="flex flex-wrap gap-2 border-t p-3">
					{actions.map((a) => (
						<Button key={a.id} size="sm" variant={a.tone === "destructive" ? "destructive" : "outline"} onClick={() => run(a, row.id)}>
							{a.icon && <Icon name={a.icon} />}
							{a.label}
						</Button>
					))}
				</div>
			)}
		</aside>
	);
}

// ── compact list (quick views) ───────────────────────────────────────────
function List({ node, emit }: { node: Extract<Node, { type: "list" }>; emit: Emit }) {
	const { run, dialog } = useConfirm(emit);
	if (!node.items.length) return node.empty ? <EmptyState {...node.empty} /> : null;
	return (
		<div className="flex flex-col">
			{node.items.map((it) => (
				<div key={it.id} className="group/row flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-accent">
					{it.dot && <Dot tone={it.dot} />}
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium">{it.title}</div>
						{it.subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{it.subtitle}</div>}
					</div>
					{it.meta && <span className="text-xs text-muted-foreground tabular-nums group-hover/row:hidden">{it.meta}</span>}
					{it.actions && it.actions.length > 0 && (
						<div className="hidden items-center gap-0.5 group-hover/row:flex">
							{it.actions.map((a) => (
								<Tooltip key={a.id}>
									<TooltipTrigger asChild>
										<Button variant="ghost" size="icon-xs" onClick={() => run(a, it.id)} aria-label={a.label}>
											<Icon name={a.icon} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{a.label}</TooltipContent>
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
						<CardTitle className="text-2xl font-semibold tabular-nums">{s.value}</CardTitle>
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
