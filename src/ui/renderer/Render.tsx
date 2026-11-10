// Turns a plugin's UI tree into shadcn/ui components. Every node type in shared/protocol.ts
// has one renderer here; plugins never ship their own components.
//
// Keyboard (tables): ↑/↓ move · →/← expand/collapse (← again: to the parent) · ↵ first action
// · . row menu · esc clear. Pages: ⌘F or / to filter, esc back to the list.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, Copy, Maximize2, Minimize2, MoreHorizontal, Search, X } from "lucide-react";
import type { Action, Cell, Column, DetailItem, Dialog as DialogNode, Field, GroupLabel, Node, Row, Tone } from "../../shared/protocol";
import { duration, refreshEvery, relative } from "../../shared/time";
import { cn } from "@/lib/utils";
import { Icon, isFileIcon } from "@/lib/icon";
import { openUrl } from "@/lib/store";
import { isTyping, SurfaceContext, uiState, usePersisted, useUIState } from "@/lib/uistate";
import { TerminalView } from "./Terminal";
import { detailSections, fitColumns, groupActions } from "./pure";
import { ConversationView } from "./Conversation";
import { parseMarkdown, safeHref, type Block, type Inline } from "./markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/** Buttons for toolbar, card and dialog actions; `checked` actions are switches. */
function ActionButtons({ actions, onRun, size = "sm" }: { actions: Action[]; onRun: (a: Action) => void; size?: "sm" | "default" }) {
	return (
		<>
			{actions.map((a) =>
				a.checked !== undefined ? (
					<label key={a.id} className={cn("flex cursor-default items-center gap-2 rounded-md px-1.5 text-sm whitespace-nowrap", a.disabled && "opacity-50")}>
						<Switch checked={a.checked} disabled={a.disabled} onCheckedChange={() => onRun(a)} aria-label={a.label} />
						{a.label}
					</label>
				) : (
					<Button key={a.id} size={size} disabled={a.disabled} variant={a.tone === "destructive" ? "destructive" : a.primary ? "default" : "outline"} onClick={() => onRun(a)}>
						{a.icon && <Icon name={a.icon} />}
						{a.label}
					</Button>
				),
			)}
		</>
	);
}

/** A segmented control (one of a few); its changes arrive as `field` events. */
function Segmented({ node, emit }: { node: Extract<Node, { type: "segmented" }>; emit: Emit }) {
	return (
		<Tabs value={node.value} onValueChange={(v) => emit("field", { form: node.id, field: node.id, value: v })}>
			<TabsList>
				{node.options.map((o) => (
					<TabsTrigger key={o.value} value={o.value} className="gap-1.5 px-3">
						{o.icon && <Icon name={o.icon} />}
						{o.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
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
		case "terminal":
			return <TerminalView node={node} />;
		case "conversation":
			return <ConversationView node={node} />;
		case "segmented":
			return <Segmented node={node} emit={emit} />;
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
			{d.resizable ? <ResizableDialog key={d.id} d={d} emit={emit} close={close} /> : <DialogBody d={d} emit={emit} close={close} />}
		</Dialog>
	);
}

/** Nodes that fill the space they get (and scroll themselves). */
const FILLS = new Set(["terminal", "conversation"]);

function DialogBody({ d, emit, close, className, style, header, children }: { d: DialogNode; emit: Emit; close: () => void; className?: string; style?: React.CSSProperties; header?: ReactNode; children?: ReactNode }) {
	const fills = d.children.some((c) => FILLS.has(c.type));
	return (
		<DialogContent
			className={cn("flex max-h-[85vh] flex-col gap-0 p-0 duration-200", d.wide ? "sm:max-w-3xl" : "sm:max-w-lg", className)}
			style={style}
			// Focus the dialog itself, not its first button (a ring on "Maximize" reads as a state).
			onOpenAutoFocus={(e) => {
				e.preventDefault();
				(e.currentTarget as HTMLElement | null)?.focus();
			}}
		>
			<DialogHeader className="border-b px-6 pt-6 pb-4 pr-20">
				{header}
				<DialogTitle className="truncate">{d.title}</DialogTitle>
				{d.description && <DialogDescription>{d.description}</DialogDescription>}
			</DialogHeader>
			<div className={cn("flex min-h-0 flex-1 flex-col gap-4 px-6 py-4", fills ? "[&>*:not(.flex-1)]:shrink-0" : "overflow-auto [&>*]:shrink-0")}>
				{d.children.map((c, i) => (
					<Render key={i} node={c} emit={emit} />
				))}
			</div>
			<DialogFooter className="mx-0 mb-0 flex-wrap gap-y-2 px-6 py-4">
				<Button variant="outline" onClick={close}>
					{d.actions?.some((a) => a.primary) ? "Cancel" : "Close"}
				</Button>
				<ActionButtons size="default" actions={d.actions ?? []} onRun={(a) => emit(a.id, { dialog: d.id })} />
			</DialogFooter>
			{children}
		</DialogContent>
	);
}

/**
 * A dialog the person can resize (drag any edge or corner) and maximize to the window (the
 * button, or double-click the title). Size and maximized state are remembered per dialog id.
 */
function ResizableDialog({ d, emit, close }: { d: DialogNode; emit: Emit; close: () => void }) {
	const [size, setSize] = usePersisted<{ w: number; h: number } | null>(`toolbelt.dialog.${d.id}`, null);
	const [max, setMax] = usePersisted(`toolbelt.dialog.${d.id}.max`, false);
	const [dragging, setDragging] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const w = size?.w ?? Math.min(960, window.innerWidth - 64);
	const h = size?.h ?? Math.min(680, window.innerHeight - 64);

	// The dialog is centered, so an edge moves half as far as its size changes: grow by 2×.
	const startResize = (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const rect = box.current!.getBoundingClientRect();
		const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
		if (max) setMax(false);
		setDragging(true);
		const move = (ev: PointerEvent) => {
			const nw = dx ? start.w + 2 * dx * (ev.clientX - start.x) : start.w;
			const nh = dy ? start.h + 2 * dy * (ev.clientY - start.y) : start.h;
			setSize({ w: Math.round(Math.max(420, Math.min(window.innerWidth - 32, nw))), h: Math.round(Math.max(280, Math.min(window.innerHeight - 32, nh))) });
		};
		const up = () => {
			setDragging(false);
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};
	const edge = "absolute z-20";
	return (
		<DialogBody
			d={d}
			emit={emit}
			close={close}
			className={cn("max-h-none sm:max-w-none", !dragging && "transition-[width,height] duration-200 ease-out")}
			style={max ? { width: "calc(100vw - 2rem)", height: "calc(100vh - 2rem)" } : { width: w, height: h, maxWidth: "calc(100vw - 2rem)", maxHeight: "calc(100vh - 2rem)" }}
			header={
				<>
					<div ref={box} className="pointer-events-none absolute inset-0" />
					<div className="absolute inset-x-0 top-0 h-14" onDoubleClick={() => setMax(!max)} />
					<Button variant="ghost" size="icon-sm" className="absolute top-2 right-10 z-10" onClick={() => setMax(!max)} aria-label={max ? "Restore size" : "Maximize"} title={max ? "Restore size" : "Maximize"}>
						{max ? <Minimize2 /> : <Maximize2 />}
					</Button>
				</>
			}
		>
			<div onPointerDown={startResize(1, 0)} className={cn(edge, "inset-y-3 -right-1 w-2 cursor-ew-resize")} />
			<div onPointerDown={startResize(-1, 0)} className={cn(edge, "inset-y-3 -left-1 w-2 cursor-ew-resize")} />
			<div onPointerDown={startResize(0, 1)} className={cn(edge, "inset-x-3 -bottom-1 h-2 cursor-ns-resize")} />
			<div onPointerDown={startResize(0, -1)} className={cn(edge, "inset-x-3 -top-1 h-2 cursor-ns-resize")} />
			<div onPointerDown={startResize(1, 1)} className={cn(edge, "-right-1 -bottom-1 size-4 cursor-nwse-resize")} />
			<div onPointerDown={startResize(-1, 1)} className={cn(edge, "-bottom-1 -left-1 size-4 cursor-nesw-resize")} />
			<div onPointerDown={startResize(1, -1)} className={cn(edge, "-top-1 -right-1 size-4 cursor-nesw-resize")} />
			<div onPointerDown={startResize(-1, -1)} className={cn(edge, "-top-1 -left-1 size-4 cursor-nwse-resize")} />
		</DialogBody>
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
			{cell.icon && <Icon name={cell.icon} className={cn("shrink-0", isFileIcon(cell.icon) ? "size-6" : "size-4 text-muted-foreground")} />}
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
			{cell.spark && cell.spark.length > 1 && <Spark values={cell.spark} tone={cell.tone} />}
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

/** A tiny trend line (recent values, oldest first), scaled to its own range. */
function Spark({ values, tone, fill }: { values: number[]; tone?: Tone; fill?: boolean }) {
	const w = 44, h = 14;
	const max = Math.max(...values), min = Math.min(...values, 0);
	const span = max - min || 1;
	const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - min) / span) * (h - 2)).toFixed(1)}`).join(" ");
	return (
		<svg width={fill ? "100%" : w} height={fill ? 16 : h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={fill ? "none" : undefined} className={cn("shrink-0 opacity-70", fill && "mt-1 block", textTone[tone ?? "default"])} aria-hidden>
			<polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
		</svg>
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

/** Put text on the clipboard from the web view. */
export async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		return;
	} catch {}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	document.execCommand("copy");
	ta.remove();
}

/** Ghost icon buttons inside rows: muted, and legible on the selection color too. */
const ROW_BUTTON =
	"text-muted-foreground hover:text-foreground group-data-[selected=true]/row:hover:bg-selected-foreground/15 group-data-[selected=true]/row:hover:text-selected-foreground";

function RowActions({ actions, rowId, run, menuOpen, setMenuOpen }: { actions: Action[]; rowId: string; run: Run; menuOpen: boolean; setMenuOpen: (open: boolean) => void }) {
	if (!actions.length) return null;
	const inline = actions.filter((a) => a.inline);
	const groups = groupActions(actions);
	return (
		<div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
			{inline.map((a) => (
				<Tooltip key={a.id}>
					<TooltipTrigger asChild>
						<Button variant="ghost" size="icon-sm" tabIndex={-1} className={cn(ROW_BUTTON, "opacity-0 transition-opacity duration-200 group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100")} onClick={() => run(a, rowId)} aria-label={a.label}>
							<Icon name={a.icon} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{a.label}</TooltipContent>
				</Tooltip>
			))}
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						tabIndex={-1}
						className={cn(
							ROW_BUTTON,
							// Open: a visible pressed state, on plain rows and on the selection color alike.
							"data-[state=open]:bg-muted data-[state=open]:text-foreground group-data-[selected=true]/row:data-[state=open]:bg-selected-foreground/20 group-data-[selected=true]/row:data-[state=open]:text-selected-foreground",
						)}
						aria-label="More actions"
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					{groups.map((g, gi) => (
						<div key={gi}>
							{gi > 0 && <DropdownMenuSeparator />}
							<DropdownMenuGroup>
								{g.map((a) => (
									<DropdownMenuItem key={a.id} variant={a.tone === "destructive" ? "destructive" : "default"} disabled={a.disabled} onSelect={() => run(a, rowId)}>
										{a.icon && <Icon name={a.icon} />}
										{a.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</div>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** A row as displayed: flattened from the tree, with its depth, parent, and how many group
 *  headers it sits under (for indentation). */
type Visible = { row: Row; depth: number; parent?: string; indent: number; group?: string };

type GroupLevel = { key: string; label: string; sub?: string; tag?: string; muted?: boolean; icon?: string };
const groupPath = (g: Row["group"]): GroupLevel[] =>
	g === undefined ? [] : (typeof g === "string" ? [g] : g).map((l: GroupLabel) => (typeof l === "string" ? { key: l, label: l } : { key: l.id ?? l.label, label: l.label, sub: l.sub, tag: l.tag, muted: l.muted, icon: l.icon }));

/** Group headers are selectable too; their ids can't clash with row ids. */
const HEADER = "\u0001group:";
const headerId = (key: string) => HEADER + key;

/** What a table body shows, in order: group headers and rows. */
type Item =
	| { kind: "header"; id: string; level: number; group: GroupLevel; count: number; key: string; muted: boolean; parent?: string; collapsed: boolean; firstChild?: string }
	| { kind: "row"; id: string; v: Visible; muted: boolean };

const TableRow = memo(
	function TableRow({ v, muted, columns, actions, selected, expanded, menuOpen, checked, onSelect, onToggle, onMenu, onCheck, run, ready }: { v: Visible; muted?: boolean; sig: string; columns: Column[]; actions: Action[]; selected: boolean; expanded: boolean; menuOpen: boolean; checked?: boolean; onSelect: (id: string) => void; onToggle: (id: string) => void; onMenu: (id: string | null) => void; onCheck?: (id: string) => void; run: Run; ready: { current: boolean } }) {
		const { row, depth } = v;
		const hasChildren = !!row.children?.length;
		// Rows that appear after the table is up (expanded, new processes) fade in.
		const [fresh] = useState(() => ready.current);
		return (
			<tr
				data-row-id={row.id}
				data-selected={selected}
				onClick={() => onSelect(row.id)}
				onDoubleClick={() => hasChildren && onToggle(row.id)}
				className={cn(
					"group/row cursor-default transition-colors duration-200 hover:bg-muted/50 data-[selected=true]:bg-selected data-[selected=true]:text-selected-foreground [&>td]:border-b [&>td]:border-border/50",
					depth > 0 && "bg-muted/20",
					muted && "text-muted-foreground",
					fresh && "animate-in fade-in-0 slide-in-from-top-1 duration-200",
				)}
			>
				{onCheck && (
					<td className="w-0 pl-4" onClick={(e) => e.stopPropagation()}>
						{depth === 0 && <Checkbox tabIndex={-1} checked={!!checked} onCheckedChange={() => onCheck(row.id)} aria-label="Select row" />}
					</td>
				)}
				{columns.map((c, i) => (
					<td key={c.key} className={cn("h-12 px-3 align-middle text-sm", i === 0 && "pl-3", c.align === "right" && "text-right", c.grow ? "w-full max-w-0" : "whitespace-nowrap")}>
						{i === 0 ? (
							<div className="flex min-w-0 items-center" style={{ paddingLeft: v.indent * 16 + depth * 20 }}>
								<button
									tabIndex={-1}
									aria-label={expanded ? "Collapse" : "Expand"}
									onClick={(e) => (e.stopPropagation(), onToggle(row.id))}
									className={cn("mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground", !hasChildren && "invisible")}
								>
									<ChevronRight className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")} />
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
	(a, b) => a.sig === b.sig && a.muted === b.muted && a.selected === b.selected && a.expanded === b.expanded && a.menuOpen === b.menuOpen && a.checked === b.checked && a.onCheck === b.onCheck && a.columns === b.columns && a.actions === b.actions && a.run === b.run,
);

function DataTable({ node, emit }: { node: Extract<Node, { type: "table" }>; emit: Emit }) {
	const surface = useContext(SurfaceContext);
	const [selected, setSelected] = useUIState<string | null>(`${node.id}:selected`, null);
	// Expanded rows: the person's choices, on top of what the plugin opens (`row.open`).
	const [overrides, setOverrides] = useUIState<Record<string, boolean>>(`${node.id}:expanded`, {});
	// Collapsed group headers (by group key path).
	const [collapsedGroups, setCollapsedGroups] = useUIState<Record<string, boolean>>(`${node.id}:collapsed`, {});
	const openIds = useMemo(() => {
		const out = new Set<string>();
		const walk = (rows: Row[]) => {
			for (const r of rows) {
				if (r.children?.length && (overrides[r.id] ?? r.open ?? false)) out.add(r.id);
				if (r.children) walk(r.children);
			}
		};
		walk(node.rows);
		return out;
	}, [node.rows, overrides]);
	const expanded = openIds;
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const { run, dialog } = useConfirm(emit);
	const allColumns = useMemo(() => node.columns, [JSON.stringify(node.columns)]);
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
	const toggle = useCallback((id: string) => setOverrides((o) => ({ ...o, [id]: !openIds.has(id) })), [setOverrides, openIds]);
	const toggleGroup = useCallback((key: string) => setCollapsedGroups((c) => ({ ...c, [key]: !c[key] })), [setCollapsedGroups]);

	// Checked rows (tables with bulk actions): only top-level rows that still exist count.
	const bulk = useMemo(() => node.bulkActions ?? [], [JSON.stringify(node.bulkActions ?? [])]);
	const [checkedList, setChecked] = useUIState<string[]>(`${node.id}:checked`, []);
	const rowIds = useMemo(() => new Set(node.rows.map((r) => r.id)), [node.rows]);
	const checked = useMemo(() => new Set(checkedList.filter((id) => rowIds.has(id))), [checkedList, rowIds]);
	const check = useCallback((id: string) => setChecked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])), [setChecked]);
	const allChecked = checked.size > 0 && checked.size === rowIds.size;

	// ── which columns fit ──
	const wrap = useRef<HTMLDivElement>(null);
	const headRow = useRef<HTMLTableRowElement>(null);
	const [available, setAvailable] = useState(Infinity);
	const measured = useRef<Record<string, number>>({});
	const [, remeasure] = useState(0);
	useLayoutEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
		ro.observe(el);
		setAvailable(el.clientWidth);
		return () => ro.disconnect();
	}, [node.rows.length > 0]);
	const hiddenCols = fitColumns(allColumns, available, (c) => measured.current[c.key] ?? 96, (measured.current["\u0001actions"] ?? 72) + (bulk.length ? 40 : 0));
	const hiddenKey = [...hiddenCols].join(",");
	const columns = useMemo(() => allColumns.filter((c) => !hiddenCols.has(c.key)), [allColumns, hiddenKey]);
	// Natural widths of the columns on screen (the widest seen), for deciding what fits.
	useLayoutEffect(() => {
		const ths = headRow.current?.querySelectorAll<HTMLElement>("th[data-col]");
		let changed = false;
		ths?.forEach((th) => {
			const k = th.dataset.col!;
			const col = allColumns.find((c) => c.key === k);
			if (col?.grow) return;
			const w = th.offsetWidth;
			if (w && Math.abs((measured.current[k] ?? 0) - w) > 4 && w > (measured.current[k] ?? 0)) {
				measured.current[k] = w;
				changed = true;
			}
		});
		if (changed) remeasure((n) => n + 1);
	});

	// Group headers (nested, in order of first appearance) and rows with their expanded children.
	// Rows of one group needn't be adjacent in `rows`: they're gathered under the first header.
	const items = useMemo(() => {
		type GNode = { group: GroupLevel; key: string; level: number; rows: Row[]; kids: Map<string, GNode>; order: GNode[]; muted: boolean; parent?: GNode };
		const root: GNode = { group: { key: "", label: "" }, key: "", level: -1, rows: [], kids: new Map(), order: [], muted: false };
		for (const r of node.rows) {
			let at = root;
			for (const [i, g] of groupPath(r.group).entries()) {
				let next = at.kids.get(g.key);
				if (!next) {
					next = { group: g, key: `${at.key}\u0000${g.key}`, level: i, rows: [], kids: new Map(), order: [], muted: at.muted || !!g.muted, parent: at };
					at.kids.set(g.key, next);
					at.order.push(next);
				}
				at = next;
			}
			at.rows.push(r);
		}
		const count = (n: GNode): number => n.rows.length + n.order.reduce((s, k) => s + count(k), 0);
		const out: Item[] = [];
		const add = (n: GNode) => {
			const collapsed = n.level >= 0 && !!collapsedGroups[n.key];
			if (n.level >= 0) {
				const firstChild = n.rows[0]?.id ?? (n.order[0] ? headerId(n.order[0].key) : undefined);
				out.push({ kind: "header", id: headerId(n.key), level: n.level, group: n.group, count: count(n), key: n.key, muted: n.muted, parent: n.parent && n.parent.level >= 0 ? headerId(n.parent.key) : undefined, collapsed, firstChild });
				if (collapsed) return;
			}
			const indent = n.level + 1;
			const groupId = n.level >= 0 ? headerId(n.key) : undefined;
			const walk = (r: Row, depth: number, parent?: string) => {
				out.push({ kind: "row", id: r.id, v: { row: r, depth, parent, indent, group: groupId }, muted: n.muted });
				if (r.children && expanded.has(r.id)) for (const c of r.children) walk(c, depth + 1, r.id);
			};
			for (const r of n.rows) walk(r, 0);
			for (const k of n.order) add(k);
		};
		add(root);
		return out;
	}, [node.rows, expanded, collapsedGroups]);
	const current = items.find((it) => it.id === selected) ?? null;

	const select = useCallback(
		(id: string | null) => {
			setSelected(id);
			if (id) requestAnimationFrame(() => wrap.current?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
		},
		[setSelected],
	);

	// Coming back to this table: where it was scrolled to, and the selection in view.
	const ready = useRef(false);
	useLayoutEffect(() => {
		if (ready.current || !items.length || !wrap.current) return;
		const top = uiState.get<number>(surface, `${node.id}:scroll`);
		if (top) wrap.current.scrollTop = top;
		if (selected) wrap.current.querySelector(`[data-row-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
		requestAnimationFrame(() => (ready.current = true));
	});

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
			const i = items.findIndex((it) => it.id === selected);
			const cur = items[i];
			switch (e.key) {
				case "ArrowDown":
				case "ArrowUp": {
					e.preventDefault();
					const next = i < 0 ? items[e.key === "ArrowDown" ? 0 : items.length - 1] : items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
					if (next) select(next.id);
					break;
				}
				case "ArrowRight":
					if (cur?.kind === "header") {
						e.preventDefault();
						if (cur.collapsed) toggleGroup(cur.key);
						else if (cur.firstChild) select(cur.firstChild);
					} else if (cur?.v.row.children?.length) {
						e.preventDefault();
						if (!expanded.has(cur.v.row.id)) toggle(cur.v.row.id);
						else select(cur.v.row.children[0].id);
					}
					break;
				case "ArrowLeft":
					if (!cur) break;
					e.preventDefault();
					if (cur.kind === "header") {
						if (!cur.collapsed) toggleGroup(cur.key);
						else if (cur.parent) select(cur.parent);
					} else if (expanded.has(cur.v.row.id)) toggle(cur.v.row.id);
					else if (cur.v.parent) select(cur.v.parent);
					else if (cur.v.group) select(cur.v.group);
					break;
				case "Enter": {
					if (cur?.kind === "header") {
						e.preventDefault();
						toggleGroup(cur.key);
						break;
					}
					const a = cur && actionsFor(cur.v.row).find((x) => x.inline);
					if (a) (e.preventDefault(), run(a, cur.v.row.id));
					break;
				}
				case ".":
					if (cur?.kind === "row" && actionsFor(cur.v.row).length) (e.preventDefault(), setMenuFor(cur.v.row.id));
					break;
				case "Escape":
					if (selected) (e.preventDefault(), setSelected(null));
					break;
				case " ":
					if (bulk.length && cur?.kind === "row" && cur.v.depth === 0) (e.preventDefault(), check(cur.v.row.id));
					break;
				case "Home":
				case "End":
					if (items.length) (e.preventDefault(), select(items[e.key === "Home" ? 0 : items.length - 1].id));
					break;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [items, selected, expanded, toggle, toggleGroup, select, actionsFor, run, setSelected, bulk, check]);

	if (!node.rows.length) return node.empty ? <EmptyState {...node.empty} /> : null;

	const sortBy = (c: Column) => {
		const desc = node.sort?.key === c.key ? !node.sort.desc : (c.sortDesc ?? false);
		emit("sort", { table: node.id, key: c.key, desc });
	};

	return (
		<div className="@container flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				{checked.size > 0 && (
					<div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-2 animate-in fade-in-0 slide-in-from-top-1 duration-200">
						<span className="text-sm tabular-nums">{checked.size} selected</span>
						<Button variant="ghost" size="sm" onClick={() => setChecked([])}>
							Clear
						</Button>
						<div className="ml-auto flex items-center gap-2">
							<ActionButtons actions={bulk} onRun={(a) => run(a, undefined, { rowIds: [...checked] })} />
						</div>
					</div>
				)}
				<div ref={wrap} onScroll={(e) => uiState.set(surface, `${node.id}:scroll`, e.currentTarget.scrollTop)} className="min-h-0 min-w-0 flex-1 overflow-auto">
					<table className="w-full border-separate border-spacing-0 text-left">
						<thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
							<tr ref={headRow}>
								{bulk.length > 0 && (
									<th className="w-0 border-b pl-4">
										<Checkbox checked={allChecked ? true : checked.size ? "indeterminate" : false} onCheckedChange={() => setChecked(allChecked ? [] : [...rowIds])} aria-label="Select all" />
									</th>
								)}
								{columns.map((c, i) => {
									const sorted = node.sort?.key === c.key;
									const Arrow = sorted && node.sort!.desc ? ArrowDown : ArrowUp;
									return (
										<th
											key={c.key}
											data-col={c.key}
											aria-sort={sorted ? (node.sort!.desc ? "descending" : "ascending") : undefined}
											style={c.grow ? { minWidth: c.minWidth ?? 240 } : undefined}
											className={cn("h-9 border-b px-3 text-xs font-medium whitespace-nowrap text-muted-foreground", i === 0 && "pl-9", c.align === "right" && "text-right")}
										>
											{c.sortable ? (
												<button
													onClick={() => sortBy(c)}
													title={`Sort by ${c.title.toLowerCase()}`}
													className={cn("group/sort -mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors duration-200 hover:bg-muted hover:text-foreground", sorted && "text-foreground", c.align === "right" && "flex-row-reverse")}
												>
													{c.title}
													<Arrow className={cn("size-3 transition-[opacity,transform] duration-200", sorted ? "opacity-100" : "opacity-0 group-hover/sort:opacity-40")} />
												</button>
											) : (
												c.title
											)}
										</th>
									);
								})}
								<th data-col={"\u0001actions"} className="w-0 border-b" />
							</tr>
						</thead>
						<tbody>
							{items.map((it) =>
								it.kind === "header" ? (
									<GroupHeader key={it.id} item={it} colSpan={columns.length + 1 + (bulk.length ? 1 : 0)} selected={it.id === selected} onSelect={() => select(it.id)} onToggle={() => toggleGroup(it.key)} />
								) : (
									<TableRow
										key={it.v.row.id}
										v={it.v}
										muted={it.muted}
										sig={JSON.stringify(it.v.row) + it.v.depth + it.v.indent}
										columns={columns}
										actions={actionsFor(it.v.row)}
										selected={it.v.row.id === selected}
										expanded={expanded.has(it.v.row.id)}
										menuOpen={menuFor === it.v.row.id}
										onSelect={select}
										onToggle={toggle}
										onMenu={setMenuFor}
										checked={checked.has(it.v.row.id)}
										onCheck={bulk.length ? check : undefined}
										run={run}
										ready={ready}
									/>
								),
							)}
						</tbody>
					</table>
				</div>
			</div>
			<Inspector
				item={current?.kind === "row" && current.v.row.details ? current : current?.kind === "header" ? current : null}
				actions={current?.kind === "row" ? actionsFor(current.v.row) : []}
				run={run}
				onToggleGroup={toggleGroup}
				onClose={() => setSelected(null)}
			/>
			{dialog}
		</div>
	);
}

/** A group header: a section (level 0: where jobs run) or a group inside it (a folder). It can be
 *  selected (and moved through with the keyboard) and collapsed. */
function GroupHeader({ item, colSpan, selected, onSelect, onToggle }: { item: Extract<Item, { kind: "header" }>; colSpan: number; selected: boolean; onSelect: () => void; onToggle: () => void }) {
	const { group: g, level, count, muted, collapsed } = item;
	const top = level === 0;
	return (
		<tr data-row-id={item.id} data-group-level={level} data-selected={selected} onClick={onSelect} onDoubleClick={onToggle} className="group/row cursor-default">
			<td
				colSpan={colSpan}
				className={cn(
					"border-b transition-colors duration-200 group-data-[selected=true]/row:bg-selected group-data-[selected=true]/row:text-selected-foreground",
					top ? "bg-muted/60 py-1.5 hover:bg-muted" : "bg-background py-1 hover:bg-muted/50",
				)}
				style={{ paddingLeft: 12 + level * 16, paddingRight: 24 }}
			>
				{/* w-0 + min-w-full: the header never makes the table wider than the window; long
				    labels truncate instead. */}
				<div className={cn("flex w-0 min-w-full items-center gap-2", top ? "text-[13px]" : "text-xs", muted && !selected && "opacity-70")}>
					<button
						tabIndex={-1}
						aria-label={collapsed ? "Expand group" : "Collapse group"}
						onClick={(e) => (e.stopPropagation(), onToggle())}
						className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronRight className={cn("size-3.5 transition-transform duration-200", !collapsed && "rotate-90")} />
					</button>
					{g.icon && <Icon name={g.icon} className={cn("shrink-0 text-muted-foreground", isFileIcon(g.icon) ? "size-5" : "size-4")} />}
					<span className={cn("truncate", top ? "font-semibold" : "font-mono font-medium text-group group-data-[selected=true]/row:text-selected-foreground")}>
						<Hl text={g.label} />
					</span>
					{g.sub && (
						<span className="flex min-w-0 shrink-[2] items-center gap-1 font-mono text-xs text-muted-foreground">
							<Icon name="git-branch" className="size-3 shrink-0" />
							<span className="truncate">
								<Hl text={g.sub} />
							</span>
						</span>
					)}
					{g.tag && (
						<Badge variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">
							{g.tag}
						</Badge>
					)}
					<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
				</div>
			</td>
		</tr>
	);
}

type InspectorItem = Extract<Item, { kind: "row" }> | Extract<Item, { kind: "header" }>;

/**
 * The details drawer on the right: slides open when something is selected, closed when not;
 * drag its left edge to resize (remembered). A row shows its title, figures, sectioned details
 * and grouped actions; a group header shows what it holds and collapse / expand.
 */
function Inspector({ item, actions, run, onToggleGroup, onClose }: { item: InspectorItem | null; actions: Action[]; run: Run; onToggleGroup: (key: string) => void; onClose: () => void }) {
	const [width, setWidth] = usePersisted("toolbelt.inspectorWidth", 340);
	const [dragging, setDragging] = useState(false);
	// Keep the last item while the drawer slides closed.
	const last = useRef<{ item: InspectorItem; actions: Action[] } | null>(null);
	if (item) last.current = { item, actions };
	const shown = item ? { item, actions } : last.current;
	const open = !!item;
	const onPointerDown = (e: React.PointerEvent) => {
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startW = width;
		document.body.style.cursor = "col-resize";
		setDragging(true);
		const move = (ev: PointerEvent) => setWidth(Math.round(Math.max(280, Math.min(720, startW + startX - ev.clientX))));
		const up = () => {
			document.body.style.cursor = "";
			setDragging(false);
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};
	return (
		<aside
			aria-hidden={!open}
			className={cn("relative hidden shrink-0 overflow-hidden bg-muted/20 @3xl:flex", open && "border-l", !dragging && "transition-[width] duration-200 ease-out")}
			style={{ width: open ? width : 0 }}
		>
			{open && <div onPointerDown={onPointerDown} onDoubleClick={() => setWidth(340)} className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px after:transition-colors after:duration-200 hover:after:bg-ring/60" />}
			{shown && (
				<div className={cn("flex h-full shrink-0 flex-col transition-opacity duration-200", open ? "opacity-100" : "opacity-0")} style={{ width }}>
					{shown.item.kind === "header" ? <GroupSummary item={shown.item} onToggle={() => onToggleGroup((shown.item as Extract<Item, { kind: "header" }>).key)} onClose={onClose} /> : <RowDetails row={shown.item.v.row} actions={shown.actions} run={run} onClose={onClose} />}
				</div>
			)}
		</aside>
	);
}

function DrawerHeader({ icon, dot, title, sub, onClose, children }: { icon?: string; dot?: Tone; title: string; sub?: string; onClose: () => void; children?: ReactNode }) {
	return (
		<div className="flex items-start gap-3 border-b px-4 py-3.5">
			{icon ? (
				<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
					<Icon name={icon} className="size-4.5" />
				</div>
			) : (
				dot && <Dot tone={dot} className="mt-2" />
			)}
			<div className="min-w-0 flex-1">
				<div className="line-clamp-2 font-medium break-words select-text">
					<Hl text={title} />
				</div>
				{sub && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{sub}</div>}
				{children}
			</div>
			<Button variant="ghost" size="icon-sm" className="-mt-0.5 -mr-1.5 shrink-0" onClick={onClose} aria-label="Close details">
				<X />
			</Button>
		</div>
	);
}

function GroupSummary({ item, onToggle, onClose }: { item: Extract<Item, { kind: "header" }>; onToggle: () => void; onClose: () => void }) {
	const g = item.group;
	return (
		<>
			<DrawerHeader icon={g.icon ?? "folder"} title={g.label} sub={item.level === 0 ? "Section" : "Group"} onClose={onClose}>
				{(g.sub || g.tag) && (
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						{g.sub && (
							<Badge variant="outline" className="gap-1 font-mono font-normal">
								<Icon name="git-branch" className="size-3" />
								{g.sub}
							</Badge>
						)}
						{g.tag && <Badge variant="secondary" className="font-normal">{g.tag}</Badge>}
					</div>
				)}
			</DrawerHeader>
			<div className="min-h-0 flex-1 overflow-auto p-4">
				<div className="grid grid-cols-2 gap-2">
					<StatTile label="Items" value={String(item.count)} />
					<StatTile label="State" value={item.collapsed ? "Collapsed" : "Expanded"} />
				</div>
			</div>
			<div className="border-t p-3">
				<Button size="sm" variant="outline" onClick={onToggle}>
					<ChevronRight className={cn("transition-transform duration-200", !item.collapsed && "rotate-90")} />
					{item.collapsed ? "Expand" : "Collapse"}
					<Kbd className="ml-1">↵</Kbd>
				</Button>
			</div>
		</>
	);
}

function StatTile({ label, value, spark, tone }: { label: string; value: string; spark?: number[]; tone?: Tone }) {
	return (
		<div className="min-w-0 rounded-lg border bg-background px-3 py-2">
			<div className="truncate text-[11px] text-muted-foreground">{label}</div>
			<div className={cn("truncate text-sm font-semibold tabular-nums", textTone[tone ?? "default"])}>{value}</div>
			{spark && spark.length > 1 ? <Spark values={spark} tone={tone} fill /> : spark && <div className="h-4" />}
		</div>
	);
}

function RowDetails({ row, actions, run, onClose }: { row: Row; actions: Action[]; run: Run; onClose: () => void }) {
	const first = row.cells[Object.keys(row.cells)[0]];
	const title = first && typeof first === "object" ? first.text : String(first ?? row.id);
	const sub = first && typeof first === "object" ? first.sub : undefined;
	const icon = first && typeof first === "object" ? first.icon : undefined;
	const dot = first && typeof first === "object" ? first.dot : undefined;
	const chips = Object.values(row.cells).flatMap((c) => (c && typeof c === "object" && c.chips ? c.chips : []));
	const groups = groupActions(actions);
	const main = actions.find((a) => a.inline);
	return (
		<>
			<DrawerHeader icon={icon} dot={dot} title={title.replace(/^⤷ /, "")} sub={sub} onClose={onClose}>
				{chips.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1">
						{chips.map((c) => (
							<Badge key={c} variant="outline" className="font-mono text-[0.7rem] font-normal">
								{c}
							</Badge>
						))}
					</div>
				)}
			</DrawerHeader>
			<div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4">
				{row.stats && row.stats.length > 0 && (
					<div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, row.stats.length)}, minmax(0, 1fr))` }}>
						{row.stats.map((s) => (
							<StatTile key={s.label} {...s} />
						))}
					</div>
				)}
				{detailSections(row.details ?? []).map((s, i) => (
					<section key={s.title ?? i} className="space-y-1.5">
						{s.title && <h3 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{s.title}</h3>}
						<dl className="divide-y overflow-hidden rounded-lg border bg-background">
							{s.items.map((d) => (
								<DetailRow key={d.label} d={d} />
							))}
						</dl>
					</section>
				))}
			</div>
			{groups.length > 0 && <InspectorActions groups={groups} main={main} run={(a) => run(a, row.id)} />}
		</>
	);
}

/**
 * The drawer's actions, by group: the first group as buttons (the main action filled, ↵), the
 * other everyday groups as one quieter row split by dividers, destructive groups last, apart.
 */
function InspectorActions({ groups, main, run }: { groups: Action[][]; main?: Action; run: (a: Action) => void }) {
	const risky = (g: Action[]) => g.every((a) => a.tone === "destructive");
	const [first, ...rest] = groups.filter((g) => !risky(g));
	const middle = rest;
	const danger = groups.filter(risky).flat();
	const button = (a: Action, variant: "default" | "outline" | "ghost" | "destructive") => (
		<Button key={a.id} size="sm" disabled={a.disabled} variant={variant} onClick={() => run(a)} className={cn(variant === "ghost" && "px-2 text-muted-foreground hover:text-foreground")}>
			{a.icon && <Icon name={a.icon} />}
			{a.label}
			{a === main && <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">↵</Kbd>}
		</Button>
	);
	return (
		<div className="space-y-2 border-t p-3">
			{first && <div className="flex flex-wrap gap-1.5">{first.map((a) => button(a, a === main ? "default" : "outline"))}</div>}
			{middle.length > 0 && (
				<div className="-ml-2 flex flex-wrap items-center gap-x-3 gap-y-0.5">
					{middle.map((g, gi) => (
						<div key={gi} className="flex flex-wrap items-center">
							{g.map((a) => button(a, "ghost"))}
						</div>
					))}
				</div>
			)}
			{danger.length > 0 && <div className="flex flex-wrap justify-end gap-1.5 border-t border-dashed pt-2">{danger.map((a) => button(a, "destructive"))}</div>}
		</div>
	);
}

function DetailRow({ d }: { d: DetailItem }) {
	const [copied, setCopied] = useState(false);
	const [all, setAll] = useState(false);
	const canCopy = d.copy ?? d.mono;
	const long = d.value.length > 200;
	return (
		<div className="group/detail relative px-3 py-2">
			<dt className="text-[11px] text-muted-foreground">{d.label}</dt>
			<dd className={cn("pr-6 text-sm break-words select-text", d.mono && "font-mono text-[0.8rem]", long && !all && "line-clamp-4", textTone[d.tone ?? "default"])}>
				<Hl text={d.value} />
			</dd>
			{long && (
				<button onClick={() => setAll((a) => !a)} className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
					{all ? "Show less" : "Show all"}
				</button>
			)}
			{canCopy && (
				<Button
					variant="ghost"
					size="icon-xs"
					className="absolute top-1.5 right-1.5 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/detail:opacity-100 focus-visible:opacity-100"
					aria-label={`Copy ${d.label}`}
					title="Copy"
					onClick={() => {
						void copyText(d.value);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					}}
				>
					{copied ? <Check className="text-emerald-500" /> : <Copy />}
				</Button>
			)}
		</div>
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
export function Markdown({ text }: { text: string }) {
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
