import { useCollectionSelection, LocalSelectionProvider } from "@/lib/shared-selection";
import { SelectionHandoffContext, SelectionRequestContext } from "@/lib/selection-handoff";
import { PaneActionsContext } from "@/lib/pane-actions";
import { ownsCollectionKeyboard, focusPopoverCollection, canHoverNavigate, pointerTracker } from "@/lib/pane-navigation";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { ColorField, ComboboxField, TagsField, TextAreaField, WIDE_FIELDS } from "./fields";
import { DateTimeField } from "./DateTimeField";
import { Timeline } from "./Timeline";
import { Composer, InlineMarkdown, MarkdownBox, PaneRow, leaveToCollection } from "./compose";
// Turns a plugin's UI tree into shadcn/ui components. Every node type in shared/protocol.ts
// has one renderer here; plugins never ship their own components.
//
// Keyboard (tables): ↑/↓ move · →/← expand/collapse (← again: to the parent) · ↵ first action
// · an action's own key (`Action.key`: J, P…) · . row menu · esc clear. The table is the
// keyboard's home: menus hand focus back to it when they close. Pages: ⌘F or / to filter, esc
// back to the list, toolbar actions' own keys. Dialogs: the first field has focus; ↵ / ⌘↵ save.
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, Maximize2, Minimize2, MoreHorizontal, PanelRight, PanelRightClose, PanelRightOpen, Search, X } from "lucide-react";
import type { EnvironmentEntry, Action, Cell, Column, DetailItem, Dialog as DialogNode, Dot as DotNode, Field, Filter, GroupLabel, Mark, Node, Row, Section, Tag, TagValue, Target, Tone } from "../../shared/protocol";
import { dotClass, dotSpec, pillClass, shadeStyle, textClass } from "./colors";
import { duration, refreshEvery, relative } from "../../shared/time";
import { selectionKey } from "../../shared/navigation";
import { flatSections, sectionGroup, subSectionParents } from "../../shared/sections";
import { EXIT_MS, useRowMotion } from "./row-motion";
import { cn } from "@/lib/utils";
import { Icon, isFileIcon } from "@/lib/icon";
import { openUrl, useCommand } from "@/lib/store";
import { isTyping, SurfaceContext, uiState, usePersisted, useUIState } from "@/lib/uistate";
import { TerminalView } from "./Terminal";
import { actionForEvent, applyMove, formatKey, isNoopMove, resolveDrop, rowSection, type DropSlot, type RowMove, detailSections, dragBoundary, groupActions, withAlternatives, groupSummaryLayout, growOf, hasBoundary, isReorderable, layoutColumns, moveColumn, orderColumns, readSavedLayout, type SavedLayout } from "./pure";
import { createPortal } from "react-dom";
import { ConversationView } from "./Conversation";
import { parseMarkdown, safeHref, type Block, type Inline } from "./markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { KeyHint } from "@/components/key-hint";
import { ShortcutTooltip } from "@/components/shortcut-tooltip";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ACTIVE_QUERY = "border-primary! bg-primary/10! ring-1 ring-primary/30";

export type Emit = (name: string, payload?: unknown) => void;


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

/** A status dot. With a label, hovering it says what it means (instantly). `pulse` breathes
 *  slowly (an opacity animation, so it costs next to nothing). */
export function Dot({ tone, dot, className }: { tone?: Tone; dot?: DotNode; className?: string }) {
	const d = dotSpec(dot ?? tone ?? "default");
	const el = <span aria-label={d.label} className={cn("inline-block size-2 shrink-0 rounded-full", dotClass(d.color, d.dim), d.pulse && "tb-pulse", className)} />;
	if (!d.label) return el;
	return (
		<Tooltip delayDuration={0}>
			<TooltipTrigger asChild>
				{/* A larger hover target than the dot itself. */}
				<span className={cn("-m-1 inline-flex shrink-0 p-1", className)}>{el}</span>
			</TooltipTrigger>
			<TooltipContent>{d.label}</TooltipContent>
		</Tooltip>
	);
}

/** `text` with its `strong` part drawn stronger (and search hits marked). */
/** Something new on this row or item since the person last looked. */
function UnreadDot({ className }: { className?: string }) {
	return <span role="img" aria-label="Unread" className={cn("size-2 shrink-0 rounded-full bg-sky-500 group-data-[selected=true]/row:bg-selected-foreground group-data-[active=true]/row:bg-selected-foreground", className)} />;
}

function Strong({ text, strong }: { text: string; strong?: string }) {
	const at = strong ? text.lastIndexOf(strong) : -1;
	if (!strong || at < 0) return <Hl text={text} />;
	return (
		<>
			<span data-path-context className="opacity-70">
				<Hl text={text.slice(0, at)} />
			</span>
			<span className="font-semibold">
				<Hl text={strong} />
			</span>
			<span data-path-context className="opacity-70">
				<Hl text={text.slice(at + strong.length)} />
			</span>
		</>
	);
}

/** A small colored pill; its tooltip shows instantly. */
function TagPill({ tag }: { tag: Tag }) {
	const shaded = shadeStyle(tag.color, tag.shade);
	const pill = (
		<span style={shaded} className={cn("inline-flex h-4 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] leading-none font-medium whitespace-nowrap", !shaded && pillClass(tag.color))}>
			{tag.icon && <Icon name={tag.icon} className="size-2.5" />}
			<Hl text={tag.text} />
		</span>
	);
	if (!tag.tooltip) return pill;
	return (
		<Tooltip delayDuration={0}>
			<TooltipTrigger asChild>{pill}</TooltipTrigger>
			<TooltipContent>{tag.tooltip}</TooltipContent>
		</Tooltip>
	);
}

/** An icon after a cell's text, explained by an instant tooltip. */
function MarkIcon({ mark }: { mark: Mark }) {
	return (
		<Tooltip delayDuration={0}>
			<TooltipTrigger asChild>
				<span className={cn("inline-flex shrink-0 p-0.5", mark.color ? textClass(mark.color) : "text-muted-foreground", "")} aria-label={mark.tooltip}>
					<Icon name={mark.icon} className="size-3.5" />
				</span>
			</TooltipTrigger>
			<TooltipContent>{mark.tooltip}</TooltipContent>
		</Tooltip>
	);
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

/** Buttons for toolbar, card and dialog actions; `checked` actions are switches, actions with a
 *  `menu` are split buttons. */
function ActionButtons({ actions, onRun, size = "sm", enter, keys }: { actions: Action[]; onRun: (a: Action) => void; size?: "sm" | "default"; enter?: Action; keys?: boolean }) {
	return (
		<>
			{actions.map((a) =>
				a.checked !== undefined ? (
					<label key={a.id} className={cn("flex cursor-default items-center gap-2 rounded-md px-1.5 text-sm whitespace-nowrap", a.disabled && "opacity-50")}>
						<Switch checked={a.checked} disabled={a.disabled} onCheckedChange={() => onRun(a)} aria-label={a.label} />
						{a.label}
					</label>
				) : (
					<SplitButton key={a.id} a={a} size={size} variant={a.tone === "destructive" ? "destructive" : a.primary ? "default" : "outline"} onRun={onRun} hints={a === enter ? <KeyHint keys="↵" /> : keys && a.key && <KeyHint keys={formatKey(a.key)} />} />
				),
			)}
		</>
	);
}

type ButtonVariant = "default" | "outline" | "ghost" | "destructive";

/** An alternative in a split button's menu (or the row menu): its icon, label and key. */
function AlternativeItem({ a, onRun, inset }: { a: Action; onRun: (a: Action) => void; inset?: boolean }) {
	return (
		<DropdownMenuItem disabled={a.disabled} variant={a.tone === "destructive" ? "destructive" : "default"} onSelect={() => onRun(a)} className={cn(inset && "pl-7 text-muted-foreground focus:text-accent-foreground")}>
			{a.icon && <Icon name={a.icon} />}
			{a.label}
			{a.key && <DropdownMenuShortcut>{formatKey(a.key)}</DropdownMenuShortcut>}
		</DropdownMenuItem>
	);
}

/**
 * A button; with `menu`, a split button: the main part runs the action, the joined chevron opens
 * its alternatives. Both halves share the variant and a 1 px divider separates them.
 */
function SplitButton({ a, size, variant, onRun, hints, className }: { a: Action; size: "sm" | "default"; variant: ButtonVariant; onRun: (a: Action) => void; hints?: ReactNode; className?: string }) {
	const main = (
		<Button size={size} disabled={a.disabled} variant={variant} onClick={() => onRun(a)} className={cn(a.menu?.length && "rounded-r-none", className)}>
			{a.icon && <Icon name={a.icon} />}
			{a.label}
			{hints}
		</Button>
	);
	if (!a.menu?.length) return main;
	return (
		<div role="group" aria-label={a.label} data-slot="split-button" className="inline-flex shrink-0 items-stretch">
			{main}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size={size === "sm" ? "icon-sm" : "icon"}
						variant={variant}
						disabled={a.menu.every((m) => m.disabled)}
						aria-label={`Other ways: ${a.label}`}
						className={cn(
							"w-6 rounded-l-none",
							variant === "outline" && "-ml-px",
							variant === "default" && "border-l-primary-foreground/25",
							variant === "destructive" && "border-l-destructive/25",
						)}
					>
						<ChevronDown className="size-3.5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-48" onCloseAutoFocus={toTable}>
					{a.menu.map((m) => (
						<AlternativeItem key={m.id} a={m} onRun={onRun} />
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** A segmented control (one of a few); its changes arrive as `field` events. */
function Segmented({ node, emit }: { node: Extract<Node, { type: "segmented" }>; emit: Emit }) {
	const [value, setValue] = useState(node.value);
	useEffect(() => setValue(node.value), [node.value]);
	return (
		<Tabs value={value} onValueChange={(v) => { setValue(v); emit("field", { form: node.id, field: node.id, value: v }); }}>
			<TabsList aria-label={node.label ?? node.id}>
				{node.options.map((o) => {
					const trigger = <TabsTrigger value={o.value} className="gap-1.5 px-3 aria-selected:bg-selected aria-selected:text-selected-foreground dark:aria-selected:bg-selected dark:aria-selected:text-selected-foreground">
						{o.icon && <Icon name={o.icon} />}{o.label}
					</TabsTrigger>;
					return o.tooltip ? <Tooltip key={o.value} delayDuration={200}>
						<TooltipTrigger asChild><span className="inline-flex">{trigger}</span></TooltipTrigger>
						<TooltipContent className="max-w-xs">{o.tooltip}</TooltipContent>
					</Tooltip> : <span key={o.value} className="contents">{trigger}</span>;
				})}
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
			return <p className={cn("text-sm leading-relaxed whitespace-pre-line", textClass(node.tone ?? "default"), node.mono && "font-mono")}>{node.text}</p>;
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
		case "timeline":
			return <Timeline node={node} emit={emit} />;
		case "composer":
			return <Composer node={node} emit={emit} />;
		case "segmented":
			return <Segmented node={node} emit={emit} />;
		default:
			return <EmptyState title="Unknown component" description={`This ToolBelt can't draw “${(node as { type: string }).type}” yet.`} icon="puzzle" />;
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
    const selectionRequest = useContext(SelectionRequestContext);
    const lastRequest = useRef<number | null>(null);
    useEffect(() => {
        if (!selectionRequest || lastRequest.current === selectionRequest.token) return;
        lastRequest.current = selectionRequest.token;
        if (node.search && query) { setQuery(""); emit("search", { query: "" }); }
    }, [selectionRequest, node.search, query, setQuery, emit]);
	const input = useRef<HTMLInputElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		if (node.search) emit("search", { query: selectionRequest ? "" : query });
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
            const pane = input.current?.closest<HTMLElement>("[data-keyboard-pane]");
            if (pane && pane.dataset.keyboardActive !== "true") return;
			if ((e.metaKey && e.key === "f") || (e.key === "/" && !isTyping(e))) {
				e.preventDefault();
				input.current?.focus();
				input.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [node.search]);

	// Toolbar actions' own keys ("n": New task). A selected row's action with the same key
	// wins: the table sees the key first and claims it, so the page waits until it has.
	const root = useRef<HTMLDivElement>(null);
	const keyed = useMemo(() => (node.actions ?? []).filter((a) => a.key && a.checked === undefined), [JSON.stringify(node.actions ?? [])]);
	const runRef = useRef<(a: Action) => void>(() => {});
	useEffect(() => {
		if (!keyed.length) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.repeat || isTyping(e) || document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
			if (!root.current?.getClientRects().length) return;
			const pane = root.current.closest<HTMLElement>("[data-keyboard-pane]");
			if (pane && pane.dataset.keyboardActive !== "true") return;
			const a = actionForEvent(keyed, e);
			if (a) setTimeout(() => !e.defaultPrevented && runRef.current(a));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [keyed]);

	const words = (node.highlight ?? []).filter((w) => w.trim().length > 0);
	const highlight = useMemo(() => (words.length ? new RegExp(`(${words.map(escape).sort((a, b) => b.length - a.length).join("|")})`, "ig") : null), [words.join("\n")]);
	const { run, dialog: confirm } = useConfirm(emit);
	runRef.current = (a) => run(a);
	const hasToolbar = node.search || node.controls?.length || node.actions?.length || node.summary;
	// Pages without a table read better as a centered column.
	const narrow = !node.children.some((c) => c.type === "table");
	return (
		<HighlightContext.Provider value={highlight}>
		<div ref={root} className="flex h-full min-h-0 min-w-0 flex-col">
			{hasToolbar && (
				<div className={cn("flex w-full min-w-0 shrink-0 flex-wrap items-center gap-3 px-6 pt-4 pb-3", narrow && "mx-auto max-w-4xl")}>
					{node.search && (
						<InputGroup data-filtering={!!query} className={cn("w-64 max-w-full min-w-0 transition-colors duration-200", !!query && ACTIVE_QUERY)}>
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
					{node.controls?.map((control) => <Segmented key={control.id} node={control} emit={emit} />)}
					{node.filters?.map((f) => (
						<FilterMenu key={f.id} filter={f} emit={emit} />
					))}
					{node.summary && <span className="truncate text-sm text-muted-foreground tabular-nums">{node.summary}</span>}
					<div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
						<ActionButtons actions={node.actions ?? []} onRun={(a) => run(a)} keys />
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

/**
 * A multi-select filter: a toolbar button ("Agent", or "Agent · Claude Code" / "Agent · 2") and
 * a menu of checkboxes that stays open while you tick. The choice shows at once; the plugin
 * hears it as a `filter` event and filters.
 */
function FilterMenu({ filter, emit }: { filter: Filter; emit: Emit }) {
	// Ticks show immediately; the plugin's next render confirms them.
	const [picked, setPicked] = useState(filter.selected);
    const searchInput = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const matches = filter.options.filter(o => o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const present = matches.filter(o => (o.count ?? 1) > 0);
    const absent = matches.filter(o => o.count === 0);
	const sent = JSON.stringify(filter.selected);
	useEffect(() => setPicked(filter.selected), [sent]);
	const set = (values: string[]) => {
		setPicked(values);
		emit("filter", { filter: filter.id, values });
	};
	const on = new Set(picked);
	const names = filter.options.filter((o) => on.has(o.value)).map((o) => o.label);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" data-filtering={picked.length > 0} className={cn("h-8 shrink-0 gap-1.5 transition-colors duration-200", picked.length > 0 && ACTIVE_QUERY)}>
					{filter.icon && <Icon name={filter.icon} />}
					{filter.label}
					{names.length > 0 && <span className="max-w-36 truncate font-normal text-muted-foreground">· {names.length === 1 ? names[0] : names.length}</span>}
					<ChevronDown className="size-3.5 opacity-60" />
				</Button>
			</DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 overflow-x-hidden" onCloseAutoFocus={toTable}>
                <div className="px-2 pt-2 pb-1">
                    <Input ref={searchInput} className={cn("min-w-0 transition-colors duration-200", !!query && ACTIVE_QUERY)} autoFocus aria-label={`Search ${filter.label} options`} placeholder="Search options…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
                        if (e.key === "Escape") return;
                        // Stop at the input: stopping on Content is too late to prevent Radix's
                        // typeahead handler on that same element from moving focus to an item.
                        e.stopPropagation();
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            (e.currentTarget.closest('[role=menu]')?.querySelector('[role=menuitemcheckbox]') as HTMLElement)?.focus();
                        }
                    }} />
                </div>
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{filter.label}: show only…</DropdownMenuLabel>
                <div className="max-h-72 min-w-0 overflow-x-hidden overflow-y-auto">
                    {[present, absent].map((group, i) => <div key={i}>
                        {i === 1 && present.length > 0 && absent.length > 0 && <DropdownMenuSeparator />}
                        {group.map(o => <DropdownMenuCheckboxItem key={o.value} checked={on.has(o.value)} onSelect={e => e.preventDefault()} onCheckedChange={c => set(c ? [...picked, o.value] : picked.filter(v => v !== o.value))}>
                        {o.dot && <Dot dot={typeof o.dot === "string" ? o.dot : { ...o.dot, label: undefined }} />}
                        <span className="min-w-0 flex-1 truncate">{o.label}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{o.count}</span>
                    </DropdownMenuCheckboxItem>)}
                    </div>)}
                    {!matches.length && <p className="px-2 py-4 text-sm text-muted-foreground">No matching options.</p>}
                </div>
				{picked.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={e => { e.preventDefault(); set([]); searchInput.current?.focus(); }}>
							<X />
							Show all
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
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

/** What a dialog focuses when it opens: the first of these in a form. */
/** What can take the keyboard in a drawer pane. */
const PANE_FOCUS = "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [contenteditable=true], button:not(:disabled), [tabindex='0']";
const FIRST_FIELD = "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [contenteditable=true], button[role=combobox]:not(:disabled), [role=radio][tabindex='0'], [role=switch]:not(:disabled)";

/** Nodes that fill the space they get (and scroll themselves). */
const FILLS = new Set(["terminal", "conversation"]);

function DialogBody({ d, emit, close, className, style, header, children }: { d: DialogNode; emit: Emit; close: () => void; className?: string; style?: React.CSSProperties; header?: ReactNode; children?: ReactNode }) {
	const fills = d.children.some((c) => FILLS.has(c.type));
	// ↵ runs the main action, wherever focus is — in a one-line field too (its value is committed
	// first) — unless it's on another button, or in a field or terminal that wants the key itself.
	// ⌘↵ runs it from anywhere, Markdown editors included. Esc (Cancel / Close) is the dialog's own.
	const main = d.actions?.find((a) => a.primary && !a.disabled && a.checked === undefined);
	const inside = (e: React.KeyboardEvent) => e.currentTarget.contains(e.target as globalThis.Node) && !(e.target as HTMLElement).closest(".tb-terminal");
	const onKeyDownCapture = (e: React.KeyboardEvent) => {
		if (e.key !== "Enter" || !main || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing || !inside(e)) return;
		e.preventDefault();
		e.stopPropagation();
		// Blurring commits what's being typed (fields send their value on blur) before the action.
		(e.target as HTMLElement).blur?.();
		emit(main.id, { dialog: d.id });
	};
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key !== "Enter" || !main || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing || !inside(e)) return;
		const target = e.target as HTMLElement;
		const oneLine = target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset", "file"].includes(target.type);
		if (!oneLine && target.closest("button, a, input, textarea, select, [contenteditable], [role=switch]")) return;
		e.preventDefault();
		emit(main.id, { dialog: d.id });
	};
	return (
		<DialogContent
			onKeyDownCapture={onKeyDownCapture}
			onKeyDown={onKeyDown}
			className={cn("flex max-h-[85vh] flex-col gap-0 p-0 duration-200", d.wide ? "sm:max-w-3xl" : "sm:max-w-lg", className)}
			style={style}
			// Focus the first form field, so typing can start at once; with none, the dialog itself
			// (not its first button: a ring on "Maximize" reads as a state).
			onOpenAutoFocus={(e) => {
				e.preventDefault();
				const content = e.currentTarget as HTMLElement | null;
				const field = content?.querySelector<HTMLElement>(`[data-autofocus] :is(${FIRST_FIELD})`) ?? content?.querySelector<HTMLElement>(`[data-form-fields] :is(${FIRST_FIELD})`);
				(field ?? content)?.focus();
			}}
		>
			<DialogHeader className="border-b px-6 pt-6 pb-4 pr-20">
				{header}
				<DialogTitle className="truncate">{d.title}</DialogTitle>
				{d.description && <DialogDescription>{d.description}</DialogDescription>}
			</DialogHeader>
			<div className={cn("flex min-h-0 flex-1 flex-col gap-4 px-6 py-4", fills ? "[&>*:not(.flex-1)]:shrink-0" : "overflow-auto [&>*]:shrink-0")}>
                <LocalSelectionProvider>
                    <SelectionHandoffContext.Provider value={null}>
                        <SelectionRequestContext.Provider value={null}>
                            <InDialog.Provider value={true}>{d.children.map((c, i) => <Render key={i} node={c} emit={emit} />)}</InDialog.Provider>
                        </SelectionRequestContext.Provider>
                    </SelectionHandoffContext.Provider>
                </LocalSelectionProvider>
			</div>
			<DialogFooter className="mx-0 mb-0 flex-wrap gap-y-2 px-6 py-4">
				<Button variant="outline" onClick={close}>
					{d.actions?.some((a) => a.primary) ? "Cancel" : "Close"}
					<KeyHint keys="esc" />
				</Button>
				<ActionButtons size="default" actions={d.actions ?? []} enter={main} onRun={(a) => emit(a.id, { dialog: d.id })} />
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
	// Until the person resizes it: a comfortable reading width, and as tall as its content.
	const w = size?.w ?? Math.min(720, window.innerWidth - 64);
	const h = size?.h;

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
			style={max ? { width: "calc(100vw - 2rem)", height: "calc(100vh - 2rem)" } : { width: w, height: h, maxWidth: "calc(100vw - 2rem)", maxHeight: h === undefined ? "85vh" : "calc(100vh - 2rem)" }}
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
const owned=<T,>(record:Record<string,T>|undefined,key:string):T|undefined=>record&&Object.hasOwn(record,key)?record[key]:undefined;
/**
 * A cell's contents. Sparklines and chips need room: they show once the cell is wide enough
 * (`.tb-cell-extra`, a container query on the cell). `measure` draws the cell at its natural
 * width, everything shown, for sizing `width: "content"` columns.
 */
function CellView({ cell, col, measure }: { cell: Cell | undefined; col: Column; measure?: boolean }) {
	if (cell === undefined || cell === null) return <span className="text-muted-foreground/50 tb-tone-muted">—</span>;
	if (typeof cell !== "object") return <span className={cn(col.mono && "font-mono text-[0.8rem] tabular-nums")}><Hl text={String(cell)} /></span>;
	const mono = cell.mono ?? col.mono;
	const spark = cell.spark && cell.spark.length > 1 && <span className={cn("shrink-0", measure ? "inline-flex" : "tb-cell-extra")}><Spark values={cell.spark} tone={cell.tone} /></span>;
	return (
		<div className={cn("flex items-center gap-2.5", measure ? "w-max" : "@container/cell w-full min-w-0", spark && col.align === "right" && "justify-end")}>
			{cell.dot && <Dot dot={cell.dot} />}
			{cell.icon && <Icon name={cell.icon} className={cn("shrink-0", isFileIcon(cell.icon) ? "size-6" : "size-4 text-muted-foreground")} />}
			{/* The trend ends where it meets its value: newest sample on the right, beside the number. */}
			{spark}
			<div className={measure ? "shrink-0" : spark ? "min-w-0" : "min-w-0 flex-1"} title={[cell.text, cell.sub].filter(Boolean).join("\n")}>
				{cell.at !== undefined ? (
					<When at={cell.at} className={cn("block truncate", mono && "font-mono text-[0.8rem] tabular-nums", textClass(cell.tone ?? "default"))} />
				) : cell.text &&
					(cell.badge ? (
						<Badge variant="secondary"><Hl text={cell.text} /></Badge>
					) : cell.marks?.length ? (
						<div className="flex min-w-0 items-center gap-1">
							<div className={cn("truncate", mono && "font-mono text-[0.8rem] tabular-nums", textClass(cell.tone ?? "default"))}><Strong text={cell.text} strong={cell.strong} /></div>
							{cell.marks.map((m) => <MarkIcon key={m.icon + m.tooltip} mark={m} />)}
						</div>
					) : (
						<div className={cn("truncate", mono && "font-mono text-[0.8rem] tabular-nums", textClass(cell.tone ?? "default"))}><Strong text={cell.text} strong={cell.strong} /></div>
					))}
				{(!!cell.sub || !!cell.tags?.length) && (
					<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						{cell.tags?.map((t) => <TagPill key={t.text} tag={t} />)}
						{cell.sub && <span className="truncate"><Hl text={cell.sub} /></span>}
					</div>
				)}
			</div>
			{cell.chips && cell.chips.length > 0 && (
				<div className={cn("shrink-0 flex-nowrap gap-1", measure ? "inline-flex" : "tb-cell-extra")}>
					{cell.chips.slice(0, 1).map((c) => (
						<Badge key={c} variant="outline" className="font-mono text-[0.7rem] font-normal">
							<Hl text={c} />
						</Badge>
					))}
					{cell.chips.length > 1 && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge variant="secondary" className="font-mono text-[0.7rem] font-normal">
									+{cell.chips.length - 1}
								</Badge>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs font-mono">{cell.chips.slice(1).join("  ")}</TooltipContent>
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
		<svg width={fill ? "100%" : w} height={fill ? 16 : h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={fill ? "none" : undefined} className={cn("shrink-0 opacity-70", fill && "mt-1 block", textClass(tone ?? "default"))} aria-hidden>
			<polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

type Confirm = { action: Action; payload?: Record<string, unknown> } | null;

export function useConfirm(emit: Emit) {
	const [pending, setPending] = useState<Confirm>(null);
	const run = useCallback(
		(action: Action, rowId?: string, extra?: Record<string, unknown>) => {
			const payload: Record<string, unknown> = { ...(rowId !== undefined && { rowId }), ...extra };
			if (action.input && typeof payload.text !== "string") setAsking({ action, payload });
			else if (action.confirm) setPending({ action, payload });
			else emit(action.id, payload);
		},
		[emit],
	);
	const confirmButton = useRef<HTMLButtonElement>(null);
	// An action with `input`: what to send, asked in a small editor first.
	const [asking, setAsking] = useState<Confirm>(null);
	const [text, setText] = useState("");
	const sendAsked = (t: string) => {
		if (!asking || !t.trim()) return;
		const next = { ...asking.payload, text: t.trim() };
		setAsking(null);
		setText("");
		if (asking.action.confirm) setPending({ action: asking.action, payload: next });
		else emit(asking.action.id, next);
	};
	const prompt = (
		<Dialog open={!!asking} onOpenChange={(o) => !o && (setAsking(null), setText(""))}>
			<DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
				<DialogHeader>
					<DialogTitle>{asking?.action.label}</DialogTitle>
				</DialogHeader>
				{asking && <MarkdownBox value="" label={asking.action.label} placeholder={asking.action.input?.placeholder} rows={4} autoFocus onChange={setText} onSubmit={sendAsked} />}
				<DialogFooter>
					<Button variant="outline" onClick={() => (setAsking(null), setText(""))}>
						Cancel
						<KeyHint keys="esc" />
					</Button>
					<Button disabled={!text.trim()} onClick={() => sendAsked(text)}>
						{asking?.action.label}
						<KeyHint keys="⌘↵" />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
	const dialog = (
		<>
		{prompt}
		<Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
			<DialogContent
				className="sm:max-w-sm"
				// ↵ confirms, as its hint says: focus the confirming button, not the first one.
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					confirmButton.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>{pending?.action.label}</DialogTitle>
					<DialogDescription>{pending?.action.confirm}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setPending(null)}>
						Cancel
						<KeyHint keys="esc" />
					</Button>
					<Button
						ref={confirmButton}
						variant={pending?.action.tone === "destructive" ? "destructive" : "default"}
						onClick={() => {
							if (pending) emit(pending.action.id, pending.payload);
							setPending(null);
						}}
					>
						{pending?.action.label}
						<KeyHint keys="↵" />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
		</>
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

/** A row's (or group header's) element. Not by selector: header ids hold U+0000, which
 *  CSS.escape turns into U+FFFD, so the selector would never match (and nothing scrolled). */
const rowElement = (wrap: HTMLElement | null, id: string) => [...(wrap?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])].find((el) => el.dataset.rowId === id);

/** The table a menu belonged to gets the keyboard back when the menu closes (↑/↓ keep working). */
const TABLE = "[data-table-focus]";
const refocusTable = (from: Element | null | undefined) => (from?.closest(TABLE) as HTMLElement | null)?.focus({ preventScroll: true });
/** For menus outside the table (filters, the drawer's buttons): back to the page's table. */
const toTable = (e: Event) => {
	e.preventDefault();
	(document.querySelector(TABLE) as HTMLElement | null)?.focus({ preventScroll: true });
};

/** The targets an action can apply to on this row, when there's a choice. */
const choicesFor = (row: Row, a: Action): Target[] | undefined => {
	const t = owned(row.targets,a.id);
	return t?.length ? t : undefined;
};

/** "Which one?" — an action's targets; 1…9 pick one. */
function TargetItems({ a, targets, onPick }: { a: Action; targets: Target[]; onPick: (t: Target) => void }) {
	return (
		<>
			<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{a.label} — which one?</DropdownMenuLabel>
			{targets.map((t, i) => (
				<DropdownMenuItem key={t.id} onSelect={() => onPick(t)}>
					{t.icon && <Icon name={t.icon} />}
					<div className="min-w-0 flex-1">
						<div className="truncate font-mono text-[0.8rem]">{t.label}</div>
						{t.sub && <div className="truncate text-xs text-muted-foreground">{t.sub}</div>}
					</div>
					{i < 9 && <DropdownMenuShortcut>{i + 1}</DropdownMenuShortcut>}
				</DropdownMenuItem>
			))}
		</>
	);
}
const pickByDigit = (targets: Target[], onPick: (t: Target) => void) => (e: React.KeyboardEvent) => {
	const n = Number(e.key);
	if (n >= 1 && n <= 9 && targets[n - 1]) (e.preventDefault(), onPick(targets[n - 1]));
};

function RowActions({ actions, row, run, menuOpen, setMenuOpen, choosing, setChoosing }: { actions: Action[]; row: Row; run: Run; menuOpen: boolean; setMenuOpen: (open: boolean) => void; choosing: string | null; setChoosing: (action: string | null) => void }) {
	const self = useRef<HTMLDivElement>(null);
	if (!actions.length) return null;
	const pending = actions.find(a => a.id === choosing);
	const targets = pending && choicesFor(row, pending);
	const close = () => { setMenuOpen(false); setChoosing(null); };
	const pick = (a: Action, target?: string) => { close(); run(a, row.id, target ? { target } : undefined); };
	return (
		<div ref={self} onClick={e => e.stopPropagation()}>
			<DropdownMenu open={menuOpen || !!targets} onOpenChange={open => { setMenuOpen(open); if (!open) setChoosing(null); }}>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" className={cn(ROW_BUTTON, "data-[state=open]:bg-muted data-[state=open]:text-foreground")} aria-label="Row actions">
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent><span className="flex items-center gap-2">All actions <Kbd>.</Kbd></span></TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end" className={targets ? "w-72" : "w-60"} onCloseAutoFocus={e => { e.preventDefault(); refocusTable(self.current); }} onKeyDown={targets && pending ? pickByDigit(targets, t => pick(pending, t.id)) : undefined}>
					{pending && targets ? <TargetItems a={pending} targets={targets} onPick={t => pick(pending, t.id)} /> : groupActions(actions).map((group, gi) => (
						<DropdownMenuGroup key={gi}>
							{gi > 0 && <DropdownMenuSeparator />}
							{group.map(a => {
								const choices = choicesFor(row, a);
								if (choices) return (
									<DropdownMenuSub key={a.id}>
										<DropdownMenuSubTrigger disabled={a.disabled}>
											{a.icon && <Icon name={a.icon} />}{a.label}
											{a.key && <DropdownMenuShortcut className="mr-1">{formatKey(a.key)}</DropdownMenuShortcut>}
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent className="w-72"><TargetItems a={a} targets={choices} onPick={t => pick(a, t.id)} /></DropdownMenuSubContent>
									</DropdownMenuSub>
								);
								return (
									<div key={a.id} className="contents">
										<DropdownMenuItem disabled={a.disabled} variant={a.tone === "destructive" ? "destructive" : "default"} onSelect={() => pick(a)}>
											{a.icon && <Icon name={a.icon} />}{a.label}
											{a.key && <DropdownMenuShortcut>{formatKey(a.key)}</DropdownMenuShortcut>}
										</DropdownMenuItem>
										{/* Split-button alternatives read as variants of the action above. */}
										{a.menu?.map((m) => <AlternativeItem key={m.id} a={m} onRun={pick} inset />)}
									</div>
								);
							})}
						</DropdownMenuGroup>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** A row as displayed: flattened from the tree, with its depth, parent, and how many group
 *  headers it sits under (for indentation). */
type Visible = { row: Row; depth: number; parent?: string; indent: number; group?: string };

type GroupLevel = { summary?: { label: string; value: string; description?: string; column?: string }; key: string; label: string; strong?: string; sub?: string; tag?: string; muted?: boolean; icon?: string };
const groupPath = (g: Row["group"]): GroupLevel[] =>
	g === undefined ? [] : (typeof g === "string" ? [g] : g).map((l: GroupLabel) => (typeof l === "string" ? { key: l, label: l } : { key: l.id ?? l.label, label: l.label, strong: l.strong, sub: l.sub, tag: l.tag, muted: l.muted, icon: l.icon, summary: l.summary }));

/** The row-actions column (the ⋯ button), and the checkbox column of tables with bulk actions. */
const ACTIONS_WIDTH = 40;
const CHECK_WIDTH = 40;

/** Rows to measure for content-sized columns: those on screen, enough to be representative. */
const MEASURE_ROWS = 200;
const measureRows = (items: Item[]): Visible[] => {
	const out: Visible[] = [];
	for (const it of items) if (it.kind === "row" && out.push(it.v) >= MEASURE_ROWS) break;
	return out;
};

/** `appearance: "document"`: rows round at their ends, inset this far (px) from the table's sides. */
const DOC_INSET = 8;
const DOC_ROW = "*:first:rounded-l-md *:last:rounded-r-md";

/** A row the plugin removed, fading out in place before the rows around it close the gap. */
const LEAVING = "pointer-events-none animate-out fade-out-0 fill-mode-forwards";
const leavingProps = { "aria-hidden": true, "data-leaving": "", style: { animationDuration: `${EXIT_MS}ms` } } as const;

/** A declared section's group key (top-level groups are keyed under the root's empty key; a
 *  sub-section under its parent's). */
const sectionKey = (id: string, parent?: Section) => `${parent ? `\u0000${parent.id}` : ""}\u0000${id}`;
/** How soon after an action its refresh counts as the action's result (see `lastAction`). */
const ACTION_REFRESH_MS = 3_000;
/** How long the selection rests on a row before a `select` event (arrowing past doesn't count). */
const SELECT_SETTLE_MS = 400;

/** Group headers are selectable too; their ids can't clash with row ids. */
const HEADER = "\u0001group:";
const headerId = (key: string) => HEADER + key;

/** What a table body shows, in order: group headers and rows. */
type Item =
	| { kind: "header"; id: string; level: number; group: GroupLevel; count: number; key: string; muted: boolean; parent?: string; collapsed: boolean; firstChild?: string; section?: Section }
	| { kind: "row"; id: string; v: Visible; muted: boolean };

const TableRow = memo(
	function TableRow({ v, muted, leaving, doc, columns, roomy, actions, selected, expanded, menuOpen, choosing, checked, onSelect, onToggle, onMenu, onChoose, onCheck, onDragStart, dragging, run, ready }: { v: Visible; muted?: boolean; leaving?: boolean; doc?: boolean; sig: string; columns: Column[]; roomy: string; actions: Action[]; selected: boolean; expanded: boolean; menuOpen: boolean; choosing: string | null; checked?: boolean; onSelect: (id: string) => void; onToggle: (id: string) => void; onMenu: (id: string | null) => void; onChoose: (c: { row: string; action: string } | null) => void; onCheck?: (id: string) => void; onDragStart?: (e: React.PointerEvent, row: Row) => void; dragging?: boolean; run: Run; ready: { current: boolean } }) {
		const { row, depth } = v;
		const hasChildren = !!row.children?.length;
		// Rows that appear after the table is up (expanded, new processes) fade in.
		const [fresh] = useState(() => ready.current);
		return (
			<tr
				data-row-id={row.id}
				data-selected={selected}
				{...(leaving ? leavingProps : {})}
				onClick={(e) => (onSelect(row.id), refocusTable(e.currentTarget))}
				onDoubleClick={() => hasChildren && onToggle(row.id)}
				onPointerDown={onDragStart && depth === 0 ? (e) => onDragStart(e, row) : undefined}
				data-unread={row.unread || undefined}
				className={cn(
					"group/row cursor-default transition-[background-color,opacity] duration-200",
					dragging && "opacity-40",
					// A document: no lines, and the cells carry the fill so the row's ends can round.
					doc
						? cn(DOC_ROW, selected ? "text-selected-foreground *:bg-selected" : "hover:*:bg-accent")
						: cn("[&>td]:border-b [&>td]:border-border/50", selected ? "bg-selected text-selected-foreground" : "hover:bg-accent", depth > 0 && !selected && "bg-muted/20"),
					muted && !selected && "text-muted-foreground",
					fresh && !leaving && "animate-in fade-in-0 slide-in-from-top-1 duration-200",
					leaving && LEAVING,
				)}
			>
				{onCheck && (
					<td className="pl-4" onClick={(e) => e.stopPropagation()}>
						{depth === 0 && <Checkbox tabIndex={-1} checked={!!checked} onCheckedChange={() => onCheck(row.id)} aria-label="Select row" />}
					</td>
				)}
				{columns.map((c, i) => (
					<td key={c.key} className={cn("h-12 overflow-hidden px-3 align-middle text-sm", i === 0 && "pl-3", c.align === "right" && "text-right", !growOf(c) && "whitespace-nowrap", roomy.split(",").includes(c.key) && "tb-cell-roomy")}>
						{i === 0 ? (
							<div className="flex min-w-0 items-center" style={{ paddingLeft: v.indent * 16 + depth * 20 }}>
								{hasChildren ? (
									<button
										tabIndex={-1}
										aria-label={expanded ? "Collapse" : "Expand"}
										onClick={(e) => (e.stopPropagation(), onToggle(row.id))}
										className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
									>
										<ChevronRight className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")} />
									</button>
								) : (
									// No children: the chevron's slot holds the unread dot.
									<span className="mr-1 flex size-5 shrink-0 items-center justify-center">{row.unread && <UnreadDot />}</span>
								)}
								{hasChildren && row.unread && <UnreadDot className="mr-1.5" />}
								<div className={cn("min-w-0 flex-1", row.unread && "font-semibold")}>
									<CellView cell={owned(row.cells,c.key)} col={c} />
								</div>
							</div>
						) : (
							<CellView cell={owned(row.cells,c.key)} col={c} />
						)}
					</td>
				))}
				<td className="px-1 whitespace-nowrap">
					<RowActions actions={actions} row={row} run={run} menuOpen={menuOpen} setMenuOpen={(o) => onMenu(o ? row.id : null)} choosing={choosing} setChoosing={(a) => onChoose(a ? { row: row.id, action: a } : null)} />
				</td>
			</tr>
		);
	},
	(a, b) => a.sig === b.sig && a.doc === b.doc && a.dragging === b.dragging && a.onDragStart === b.onDragStart && a.leaving === b.leaving && a.muted === b.muted && a.selected === b.selected && a.expanded === b.expanded && a.menuOpen === b.menuOpen && a.choosing === b.choosing && a.checked === b.checked && a.onCheck === b.onCheck && a.columns === b.columns && a.roomy === b.roomy && a.actions === b.actions && a.run === b.run,
);

function DataTable({ node, emit }: { node: Extract<Node, { type: "table" }>; emit: Emit }) {
	const surface = useContext(SurfaceContext);
	const doc = node.appearance === "document";
	const [selected, setSelected, sharedTarget] = useCollectionSelection(`${node.id}:selected`, `table:${node.id}`);
	// Expanded rows: the person's choices, on top of what the plugin opens (`row.open`).
	const [overrides, setOverrides] = useUIState<Record<string, boolean>>(`${node.id}:expanded`, {});
	// Collapsed group headers (by group key path).
	const [collapsedGroups, setCollapsedGroups] = useUIState<Record<string, boolean>>(`${node.id}:collapsed`, {});
	const openIds = useMemo(() => {
		const out = new Set<string>();
		const walk = (rows: Row[]) => {
			for (const r of rows) {
				if (r.children?.length && (owned(overrides,r.id) ?? r.open ?? false)) out.add(r.id);
				if (r.children) walk(r.children);
			}
		};
		walk(node.rows);
		return out;
	}, [node.rows, overrides]);
	const expanded = openIds;
	const [menuFor, setMenuFor] = useState<string | null>(null);
	// An action's "which one?" menu, open on a row.
	const [choosing, setChoosing] = useState<{ row: string; action: string } | null>(null);
	// When the person last ran an action here: if its refresh takes the selected row away
	// (settled into a collapsed section, deleted), the selection moves to its neighbor.
	const lastAction = useRef(0);
	const emitAction = useCallback<Emit>((name, payload) => ((lastAction.current = Date.now()), emit(name, payload)), [emit]);
	const { run, dialog } = useConfirm(emitAction);
	// An action with `focus` goes into the drawer instead, when the drawer can show (set below).
	const focusInPane = useRef<(a: Action, rowId: string) => boolean>(() => false);
	const runRow = useCallback<Run>((a, rowId, extra) => {
		if (a.focus && rowId !== undefined && focusInPane.current(a, rowId)) return;
		run(a, rowId, extra);
	}, [run]);
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
	/** Run a row action — or, when it could apply to several processes, ask which one. Actions
	 *  only in the row menu open that menu instead (their choice is a submenu there). */
	const trigger = useCallback(
		(a: Action, row: Row) => {
			if (!choicesFor(row, a)) return runRow(a, row.id);
			if (a.inline) setChoosing({ row: row.id, action: a.id });
			else setMenuFor(row.id);
		},
		[runRow],
	);
	const toggle = useCallback((id: string) => setOverrides((o) => ({ ...o, [id]: !openIds.has(id) })), [setOverrides, openIds]);
	const sections = useMemo(() => node.sections ?? [], [JSON.stringify(node.sections ?? [])]);
	// Sub-sections (`Section.sections`): which section each belongs to, and every declared
	// section's group key.
	const parents = useMemo(() => subSectionParents(sections), [sections]);
	const declaredKeys = useMemo(() => new Map(flatSections(sections).map((sec) => [sec.id, sectionKey(sec.id, parents.get(sec.id))])), [sections, parents]);
	const startsCollapsed = useMemo(() => new Set(flatSections(sections).filter((sec) => sec.collapsed).map((sec) => declaredKeys.get(sec.id)!)), [sections, declaredKeys]);
	// A section can start collapsed; the person's choice wins once they make one.
	const isCollapsed = useCallback((key: string) => owned(collapsedGroups, key) ?? startsCollapsed.has(key), [collapsedGroups, startsCollapsed]);
	const toggleGroup = useCallback((key: string) => setCollapsedGroups((c) => ({ ...c, [key]: !(owned(c, key) ?? startsCollapsed.has(key)) })), [setCollapsedGroups, startsCollapsed]);
	/** A drop into this section (or sub-section) leaves the row out of sight. */
	const hidesDrops = useCallback((id: string) => {
		const parent = parents.get(id);
		return isCollapsed(declaredKeys.get(id) ?? sectionKey(id)) || (!!parent && isCollapsed(sectionKey(parent.id)));
	}, [parents, declaredKeys, isCollapsed]);

	// Checked rows (tables with bulk actions): only top-level rows that still exist count.
	const bulk = useMemo(() => node.bulkActions ?? [], [JSON.stringify(node.bulkActions ?? [])]);
	const [checkedList, setChecked] = useUIState<string[]>(`${node.id}:checked`, []);
	const rowIds = useMemo(() => new Set(node.rows.map((r) => r.id)), [node.rows]);
	const checked = useMemo(() => new Set(checkedList.filter((id) => rowIds.has(id))), [checkedList, rowIds]);
	const check = useCallback((id: string) => setChecked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])), [setChecked]);
	const allChecked = checked.size > 0 && checked.size === rowIds.size;

	// ── columns: the person's order and widths, and what fits ──
	const wrap = useRef<HTMLDivElement>(null);
	const headRow = useRef<HTMLTableRowElement>(null);
	const measureBox = useRef<HTMLDivElement>(null);
	const [available, setAvailable] = useState(Infinity);
	useLayoutEffect(() => {
		const el = wrap.current;
		if (!el) return;
		// A document's rows are inset from the edges (`DOC_INSET` on each side).
		const measure = () => setAvailable(el.clientWidth - (doc ? 2 * DOC_INSET : 0));
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		measure();
		return () => ro.disconnect();
	}, [node.rows.length > 0, doc]);
	// Saved per plugin and table, so the same table keeps its layout on every screen it's on.
	const layoutKey = `toolbelt.table-layout.${surface.split("/")[0]}.${node.id}.v${node.layoutVersion ?? 0}`;
	const [savedRaw, setSavedRaw] = usePersisted<unknown>(layoutKey, null);
	const saved = useMemo(() => readSavedLayout(savedRaw), [savedRaw]);
	// Widths while a column edge is being dragged; saved when it's let go.
	const [liveWidths, setLiveWidths] = useState<Record<string, number> | null>(null);
	const ordered = useMemo(() => orderColumns(allColumns, saved.order), [allColumns, saved.order]);
	// Natural widths of `width: "content"` columns (the widest seen), from the measuring box below.
	const measured = useRef<Record<string, number>>(Object.create(null));
	const [, remeasure] = useState(0);
	const contentColumns = useMemo(() => ordered.filter((c) => !growOf(c) && typeof c.width !== "number"), [ordered]);
	// The trailing cell is always drawn: the ⋯ button, or just its padding.
	const actionsWidth = allActions.length ? ACTIONS_WIDTH : 8;
	const fixedWidth = actionsWidth + (bulk.length ? CHECK_WIDTH : 0);
	const overflow = node.overflow ?? "hide";
	const layout = layoutColumns(ordered, available, { saved: liveWidths ?? saved.widths, content: (c) => measured.current[c.key], fixed: fixedWidth, overflow });
	const hiddenKey = [...layout.hidden].join(",");
	// Content-sized columns at (or above) their measured width fit their sparklines and chips.
	const roomy = contentColumns.filter((c) => !layout.hidden.has(c.key) && measured.current[c.key] !== undefined && layout.widths[c.key] >= measured.current[c.key] - 1).map((c) => c.key).join(",");
	const columns = useMemo(() => ordered.filter((c) => !layout.hidden.has(c.key)), [ordered, hiddenKey]);
	useLayoutEffect(() => {
		let changed = false;
		measureBox.current?.querySelectorAll<HTMLElement>("[data-measure]").forEach((el) => {
			const k = el.dataset.measure!;
			// Exact width, rounded up, plus a pixel: offsetWidth rounds down and text would truncate.
			const w = Math.ceil(el.getBoundingClientRect().width) + 1;
			if (w > (measured.current[k] ?? 0) + 2) {
				measured.current[k] = w;
				changed = true;
			}
		});
		if (changed) remeasure((n) => n + 1);
	});
	const saveLayout = useCallback((next: Partial<SavedLayout>) => setSavedRaw({ ...saved, ...next }), [saved, setSavedRaw]);

	// Dragging a header: its edge resizes the column, the rest of it moves the column.
	const suppressClick = useRef(false);
	const [moving, setMoving] = useState<{ key: string; title: string; x: number; y: number; drop?: { key: string; after: boolean; edge: number } } | null>(null);
	const endDrag = (cursor: string) => {
		document.body.style.cursor = cursor;
		document.body.style.userSelect = "";
	};
	// A column's right edge is the boundary with the next one: dragging it keeps the edge under
	// the pointer, the columns to its right pay for it, and nothing to its left moves.
	const boundary = (c: Column) => hasBoundary(columns, columns.indexOf(c));
	const startResize = (e: React.PointerEvent, c: Column) => {
		const index = columns.indexOf(c);
		if (e.button !== 0 || !boundary(c)) return;
		e.preventDefault();
		e.stopPropagation();
		const start = { ...layout.widths };
		const spare = overflow === "scroll" && !columns.some((x) => growOf(x)) ? Infinity : Math.max(0, available - layout.total);
		const x0 = e.clientX;
		let last: Record<string, number> = {};
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		const move = (ev: PointerEvent) => {
			last = dragBoundary(columns, start, index, ev.clientX - x0, spare);
			setLiveWidths({ ...saved.widths, ...last });
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			endDrag("");
			setLiveWidths(null);
			if (Object.keys(last).length) saveLayout({ widths: { ...saved.widths, ...last } });
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	};
	/** Double-click an edge: the columns on both sides go back to their own widths. */
	const resetWidth = (c: Column) => {
		const index = columns.indexOf(c);
		const keys = [c, columns[index + 1]].filter((x): x is Column => !!x).map((x) => x.key);
		if (!keys.some((k) => Object.hasOwn(saved.widths, k))) return;
		saveLayout({ widths: Object.fromEntries(Object.entries(saved.widths).filter(([k]) => !keys.includes(k))) });
	};
	const dropAt = (x: number, key: string) => {
		for (const th of headRow.current?.querySelectorAll<HTMLElement>("th[data-col]") ?? []) {
			const r = th.getBoundingClientRect();
			if (x < r.left || x >= r.right) continue;
			const k = th.dataset.col!;
			const i = allColumns.findIndex((c) => c.key === k);
			if (k === key || i < 0 || !isReorderable(allColumns[i], i)) return undefined;
			const after = x > r.left + r.width / 2;
			return { key: k, after, edge: after ? r.right : r.left };
		}
		return undefined;
	};
	const startMove = (e: React.PointerEvent, c: Column) => {
		if (e.button !== 0 || !isReorderable(c, allColumns.indexOf(c))) return;
		const x0 = e.clientX, y0 = e.clientY;
		let active = false, frame = 0, lastX = x0;
		let drop: ReturnType<typeof dropAt>;
		const scrollEdge = () => {
			const el = wrap.current;
			if (el && overflow === "scroll") {
				const r = el.getBoundingClientRect();
				const step = lastX < r.left + 32 ? -12 : lastX > r.right - 32 ? 12 : 0;
				if (step) el.scrollLeft += step;
			}
			frame = requestAnimationFrame(scrollEdge);
		};
		const move = (ev: PointerEvent) => {
			lastX = ev.clientX;
			if (!active) {
				if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
				active = true;
				document.body.style.cursor = "grabbing";
				document.body.style.userSelect = "none";
				frame = requestAnimationFrame(scrollEdge);
			}
			drop = dropAt(ev.clientX, c.key);
			setMoving({ key: c.key, title: c.title, x: ev.clientX, y: ev.clientY, drop });
		};
		const finish = (commit: boolean) => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", key, true);
			cancelAnimationFrame(frame);
			if (!active) return;
			// The pointer comes up over a header: that's not a click on it (no sorting).
			suppressClick.current = true;
			setTimeout(() => (suppressClick.current = false));
			endDrag("");
			setMoving(null);
			if (commit && drop) saveLayout({ order: moveColumn(ordered, allColumns, c.key, drop.key, drop.after) });
		};
		const up = () => finish(true);
		const cancel = () => finish(false);
		const key = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape" || !active) return;
			ev.preventDefault();
			ev.stopPropagation();
			finish(false);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("keydown", key, true);
	};

	// Group headers (nested, in order of first appearance) and rows with their expanded children.
	// Rows of one group needn't be adjacent in `rows`: they're gathered under the first header.
	// A dropped row shows in its new place until the plugin's next tree arrives.
	const [pending, setPending] = useState<{ rows: Row[]; move: RowMove } | null>(null);
	const rows = useMemo(() => (pending && pending.rows === node.rows ? applyMove(node.rows, pending.move, sections) : node.rows), [node.rows, pending, sections]);
	const items = useMemo(() => {
		type GNode = { group: GroupLevel; key: string; level: number; rows: Row[]; kids: Map<string, GNode>; order: GNode[]; muted: boolean; parent?: GNode; section?: Section };
		const root: GNode = { group: { key: "", label: "" }, key: "", level: -1, rows: [], kids: new Map(), order: [], muted: false };
		// Declared sections come first, in order, even without rows; so do their sub-sections
		// inside them.
		const declare = (sec: Section, parent: GNode) => {
			const n: GNode = { group: { key: sec.id, label: sec.label, icon: sec.icon }, key: `${parent.key}\u0000${sec.id}`, level: parent.level + 1, rows: [], kids: new Map(), order: [], muted: false, parent, section: sec };
			parent.kids.set(sec.id, n);
			parent.order.push(n);
			return n;
		};
		for (const sec of sections) {
			const n = declare(sec, root);
			for (const sub of sec.sections ?? []) declare(sub, n);
		}
		for (const r of rows) {
			let at = root;
			// A row in a sub-section goes under its parent too.
			for (const [i, g] of groupPath(sectionGroup(r.group, parents)).entries()) {
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
			const collapsed = n.level >= 0 && isCollapsed(n.key);
			if (n.level >= 0) {
				const firstChild = n.rows[0]?.id ?? (n.order[0] ? headerId(n.order[0].key) : undefined);
				out.push({ kind: "header", id: headerId(n.key), level: n.level, group: n.group, count: count(n), key: n.key, muted: n.muted, parent: n.parent && n.parent.level >= 0 ? headerId(n.parent.key) : undefined, collapsed, firstChild, section: n.section });
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
	}, [rows, sections, parents, expanded, isCollapsed]);
	useEffect(() => setPending((p) => (p && p.rows !== node.rows ? null : p)), [node.rows]);

	const current = items.find((it) => it.id === selected) ?? null;

	// `selectEvents`: tell the plugin which row the person is looking at, once it rests there.
	const selectedRow = current?.kind === "row" ? current.v.row.id : null;
	// Nothing selected at first needs no event.
	const sentSelection = useRef<string | null>(null);
	useEffect(() => {
		if (!node.selectEvents || sentSelection.current === selectedRow) return;
		const t = setTimeout(() => {
			sentSelection.current = selectedRow;
			emit("select", { table: node.id, rowId: selectedRow });
		}, SELECT_SETTLE_MS);
		return () => clearTimeout(t);
	}, [node.selectEvents, node.id, selectedRow, emit]);

	const select = useCallback(
		(id: string | null) => {
			setSelected(id);
			if (id) requestAnimationFrame(() => rowElement(wrap.current, id)?.scrollIntoView({ block: "nearest" }));
		},
		[setSelected],
	);

	// An action took the selected row out of view: select what took its place, the next item
	// still shown, else the previous one. Searching or collapsing doesn't move the selection.
	const previousItems = useRef(items);
	useEffect(() => {
		const before = previousItems.current;
		previousItems.current = items;
		if (!selected || Date.now() - lastAction.current > ACTION_REFRESH_MS || items.some((it) => it.id === selected)) return;
		const i = before.findIndex((it) => it.id === selected);
		if (i < 0) return;
		const shown = new Set(items.map((it) => it.id));
		const next = before.slice(i + 1).find((it) => shown.has(it.id)) ?? before.slice(0, i).reverse().find((it) => shown.has(it.id));
		if (next) select(next.id);
	}, [items, selected, select]);

	// ── dragging rows within and between sections (`reorder`) ──
	type RowDropTarget = (Omit<RowMove, "rowId"> & { whole: boolean }) | null;
	const [rowDrag, setRowDrag] = useState<{ rowId: string; title: string; x: number; y: number; target?: RowDropTarget; label?: string; mark?: { top: number; left: number; width: number; height: number } } | null>(null);
	const live = useRef({ items, rows, nodeRows: node.rows, sections, columns: allColumns, hidesDrops });
	live.current = { items, rows, nodeRows: node.rows, sections, columns: allColumns, hidesDrops };
	const suppressRowClick = useRef(false);
	const startRowDrag = useCallback(
		(e: React.PointerEvent, row: Row) => {
			if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, [role=checkbox], [role=menuitem]")) return;
			const x0 = e.clientX, y0 = e.clientY;
			let active = false, frame = 0, x = x0, y = y0;
			let target: RowDropTarget | undefined;
			const firstKey = live.current.columns[0]?.key;
			const firstCell = firstKey ? owned(row.cells, firstKey) : undefined;
			const title = typeof firstCell === "object" && firstCell ? firstCell.text : String(firstCell ?? row.id);
			const from = rowSection(row, live.current.sections);
			const elements = () => [...(body.current?.querySelectorAll<HTMLElement>(":scope > tr[data-row-id]") ?? [])].filter((el) => !el.hasAttribute("data-leaving"));
			const update = () => {
				const els = elements();
				const byId = new Map(live.current.items.map((it) => [it.id, it]));
				const slots: DropSlot[] = els.map((el) => {
					const it = byId.get(el.dataset.rowId!);
					// Sections and sub-sections take drops; groups inside them don't.
					if (it?.kind === "header") return it.section ? { kind: "header", section: it.section.id } : it.level === 0 ? { kind: "header", section: it.group.key } : { kind: "other" };
					if (it?.kind === "row" && it.v.depth === 0) return { kind: "row", id: it.v.row.id, section: rowSection(it.v.row, live.current.sections) };
					return { kind: "other" };
				});
				let index = els.findIndex((el) => {
					const r = el.getBoundingClientRect();
					return y >= r.top && y < r.bottom;
				});
				let lower = false;
				if (index >= 0) {
					const r = els[index]!.getBoundingClientRect();
					lower = y > r.top + r.height / 2;
				} else if (els.length && y >= els[els.length - 1]!.getBoundingClientRect().bottom) {
					index = els.length - 1;
					lower = true;
				}
				const next = resolveDrop(slots, index, lower, live.current.sections, row.id);
				if (next !== undefined) target = next;
				let mark: { top: number; left: number; width: number; height: number } | undefined;
				const box = wrap.current?.getBoundingClientRect();
				if (target && box) {
					const t = target;
					const inSection = els.filter((_, i) => { const sl = slots[i]!; return sl.kind !== "other" && sl.section === t.section; });
					const header = els.find((_, i) => { const sl = slots[i]!; return sl.kind === "header" && sl.section === t.section; });
					if (t.whole && inSection.length) {
						const a = inSection[0]!.getBoundingClientRect(), b = inSection[inSection.length - 1]!.getBoundingClientRect();
						mark = { top: a.top, left: box.left, width: box.width, height: b.bottom - a.top };
					} else if (!t.whole) {
						const before = t.before !== null ? els.find((el) => el.dataset.rowId === t.before) : undefined;
						const last = inSection.filter((el) => el.dataset.rowId !== row.id).at(-1) ?? header;
						const lineY = before ? before.getBoundingClientRect().top : last ? last.getBoundingClientRect().bottom : undefined;
						if (lineY !== undefined) mark = { top: lineY - 1, left: box.left, width: box.width, height: 2 };
					}
				}
				const sec = target ? flatSections(live.current.sections).find((s) => s.id === target!.section) : undefined;
				const label = target === null ? "Can't drop here" : target && target.section !== from ? (sec?.dropLabel ?? `Move to ${sec?.label ?? target.section}`) : undefined;
				setRowDrag({ rowId: row.id, title, x, y, target, label, mark });
			};
			const scrollEdge = () => {
				const el = wrap.current;
				if (el) {
					const r = el.getBoundingClientRect();
					const step = y < r.top + 40 ? -12 : y > r.bottom - 32 ? 12 : 0;
					if (step) (el.scrollTop += step, update());
				}
				frame = requestAnimationFrame(scrollEdge);
			};
			const move = (ev: PointerEvent) => {
				x = ev.clientX;
				y = ev.clientY;
				if (!active) {
					if (Math.hypot(x - x0, y - y0) < 4) return;
					active = true;
					document.body.style.cursor = "grabbing";
					document.body.style.userSelect = "none";
					frame = requestAnimationFrame(scrollEdge);
				}
				update();
			};
			const finish = (commit: boolean) => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", cancel);
				window.removeEventListener("keydown", key, true);
				cancelAnimationFrame(frame);
				if (!active) return;
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				suppressRowClick.current = true;
				setTimeout(() => (suppressRowClick.current = false));
				setRowDrag(null);
				if (!commit || !target) return;
				const m: RowMove = { rowId: row.id, section: target.section, before: target.before };
				if (isNoopMove(live.current.rows, m, live.current.sections)) return;
				setPending({ rows: live.current.nodeRows, move: m });
				// Into a collapsed section, the row goes out of sight: don't select what can't be seen.
				if (!live.current.hidesDrops(m.section)) setSelected(row.id);
				emit("reorder", { table: node.id, rowId: m.rowId, section: m.section, before: m.before });
			};
			const up = () => finish(true);
			const cancel = () => finish(false);
			const key = (ev: KeyboardEvent) => {
				if (ev.key !== "Escape" || !active) return;
				ev.preventDefault();
				ev.stopPropagation();
				finish(false);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("keydown", key, true);
		},
		[emit, node.id, setSelected],
	);

	// Coming back to this table: where it was scrolled to, and the selection in view.
	const ready = useRef(false);
	useLayoutEffect(() => {
		if (ready.current || !items.length || !wrap.current) return;
		const top = uiState.get<number>(surface, `${node.id}:scroll`);
		if (top) wrap.current.scrollTop = top;
		if (selected) rowElement(wrap.current, selected)?.scrollIntoView({ block: "nearest" });
		requestAnimationFrame(() => (ready.current = true));
	});

	// Refreshes that reorder, add or remove rows animate (see row-motion.ts); the person's own
	// changes (sorting, filtering, collapsing) don't.
	const body = useRef<HTMLTableSectionElement>(null);
	const shown = useRowMotion(items, body, wrap, `${node.id}\0${node.sort?.key ?? ""}\0${node.sort?.desc ?? ""}`, ready);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!ownsCollectionKeyboard(wrap.current) || isTyping(e) || e.metaKey || e.ctrlKey) return;
			// The drawer's controls keep their keys (Esc there comes back to the table).
			if ((e.target as HTMLElement | null)?.closest?.("[data-inspector]")) return;
			const i = items.findIndex((it) => it.id === selected);
			const cur = items[i];
			// Moving through the rows brings the keyboard into the table, wherever it was (a
			// screen tab, a toolbar button), so ←/→ and Tab carry on here instead of there.
			if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && wrap.current && !wrap.current.contains(document.activeElement))
				wrap.current.focus({ preventScroll: true });
			// ⌥ / ⇧ shortcuts ("alt+up") belong to the selected row's actions, never to navigation.
			if (e.altKey || (e.shiftKey && e.key.startsWith("Arrow"))) {
				if (cur?.kind !== "row") return;
				const a = actionForEvent(actionsFor(cur.v.row), e);
				if (a) (e.preventDefault(), trigger(a, cur.v.row));
				return;
			}
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
					} else if (cur?.v.row.pane && focusPane.current(null)) {
						// A row with a pane: into its details.
						e.preventDefault();
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
					const acts = cur ? actionsFor(cur.v.row) : [];
					const a = node.enter ? acts.find((x) => x.id === node.enter && !x.disabled) : acts.find((x) => x.inline);
					if (a) (e.preventDefault(), trigger(a, cur!.v.row));
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
				default: {
					// An action's own key ("j", "p"…) on the selected row.
					if (cur?.kind !== "row" || e.key.length !== 1) break;
					const a = actionForEvent(actionsFor(cur.v.row), e);
					if (a) (e.preventDefault(), trigger(a, cur.v.row));
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [items, selected, expanded, toggle, toggleGroup, select, actionsFor, trigger, setSelected, bulk, check, node.enter]);

    const revealedTarget = useRef<string | null>(null);
    useLayoutEffect(() => {
        const key = selectionKey(sharedTarget);
        if (key === revealedTarget.current) return;
        revealedTarget.current = key;
        if (!sharedTarget) return;
        if (sharedTarget.ancestors.some(id => !openIds.has(id)))
            setOverrides(previous => ({ ...previous, ...Object.fromEntries(sharedTarget.ancestors.map(id => [id, true])) }));
        // Sections that start collapsed count as collapsed too.
        if (sharedTarget.groups.some(isCollapsed))
            setCollapsedGroups(previous => ({ ...previous, ...Object.fromEntries(sharedTarget.groups.map(key => [key, false])) }));
        requestAnimationFrame(() => rowElement(wrap.current, sharedTarget.item)?.scrollIntoView({ block: "nearest" }));
    }, [sharedTarget, openIds, isCollapsed, setOverrides, setCollapsedGroups]);

    const handoff = useContext(SelectionHandoffContext);
    const appliedHandoff = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (!handoff || handoff.collection !== `table:${node.id}` || appliedHandoff.current === handoff.token) return;
        appliedHandoff.current = handoff.token;
        setOverrides(previous => ({ ...previous, ...Object.fromEntries(handoff.ancestors.map(id => [id, true])) }));
        setCollapsedGroups(previous => ({ ...previous, ...Object.fromEntries(handoff.groups.map(key => [key, false])) }));
        setSelected(handoff.item);
        requestAnimationFrame(() => {
            wrap.current?.focus({ preventScroll: true });
            rowElement(wrap.current, handoff.item)?.scrollIntoView({ block: "nearest" });
            handoff.onApplied();
        });
    }, [handoff, node.id, setOverrides, setCollapsedGroups, setSelected]);

	// The details drawer: open or closed per plugin, whatever is selected. It only fits a wide
	// table (`@3xl`, 48rem); narrower, neither the drawer nor its toggle shows.
	const [drawerOpen, setDrawerOpen] = usePersisted(`toolbelt.inspector.${surface.split("/")[0]}`, true);
	const paneActions = useContext(PaneActionsContext);
	const drawerUseful = useMemo(() => {
		const any = (rows: Row[]): boolean => rows.some((r) => r.details?.length || r.pane || r.group !== undefined || (r.children && any(r.children)));
		return any(node.rows);
	}, [node.rows]);
	const outer = useRef<HTMLDivElement>(null);
	const [drawerFits, setDrawerFits] = useState(true);
	const toggleDrawer = useCallback(() => setDrawerOpen(!drawerOpen), [drawerOpen, setDrawerOpen]);
	// ⌥⌘B (View → Toggle Details), where the toggle is showing.
	useCommand(useCallback((name: string) => { if (name === "toggleDetails" && drawerUseful && paneActions && drawerFits) toggleDrawer(); }, [drawerUseful, paneActions, drawerFits, toggleDrawer]));
	// Into the drawer: at a pane element (`Action.focus`), or its first control. Opens the drawer
	// first when it's closed; false when it can't show (the window is too narrow).
	const focusPane = useRef<(target: string | null, rowId?: string) => boolean>(() => false);
	focusPane.current = (target, rowId) => {
		if (!drawerUseful || !drawerFits) return false;
		if (rowId !== undefined && rowId !== selected) select(rowId);
		const go = () => {
			const aside = outer.current?.querySelector<HTMLElement>("[data-inspector]");
			const box = aside?.querySelector<HTMLElement>(target === null ? "[data-pane]" : `[data-pane-id="${CSS.escape(target)}"]`);
			const el = box?.matches(PANE_FOCUS) ? box : box?.querySelector<HTMLElement>(PANE_FOCUS);
			el?.focus();
		};
		if (!drawerOpen) setDrawerOpen(true);
		// After the drawer has drawn the row (a newly selected one, or the drawer just opened).
		setTimeout(go, drawerOpen && (rowId === undefined || rowId === selected) ? 0 : 60);
		return true;
	};
	focusInPane.current = (a, rowId) => {
		const row = items.find((it) => it.kind === "row" && it.v.row.id === rowId);
		return !!(row?.kind === "row" && row.v.row.pane && a.focus && focusPane.current(a.focus, rowId));
	};
	useLayoutEffect(() => {
		const el = outer.current;
		if (!el) return;
		const check = () => setDrawerFits(el.clientWidth >= 48 * parseFloat(getComputedStyle(document.documentElement).fontSize || "16"));
		const ro = new ResizeObserver(check);
		ro.observe(el);
		check();
		return () => ro.disconnect();
	}, [node.rows.length > 0]);

	// The table takes the keyboard when it appears, unless something else already has it.
	useEffect(() => {
		if (document.activeElement === document.body) wrap.current?.focus({ preventScroll: true });
	}, [node.rows.length > 0]);

	if (!node.rows.length) return node.empty ? <EmptyState {...node.empty} /> : null;

	const sortBy = (c: Column) => {
		const desc = node.sort?.key === c.key ? !node.sort.desc : (c.sortDesc ?? false);
		emit("sort", { table: node.id, key: c.key, desc });
	};

	return (
		<div ref={outer} className="@container flex min-h-0 min-w-0 w-full flex-1">
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
				{/* The keyboard's home on this pane: menus and dialogs hand focus back here. The scroll
				    padding keeps rows moved to from hiding under the sticky header. */}
				<div
					ref={wrap}
					tabIndex={0}
					data-table-focus
                    data-navigation-collection={`table:${node.id}`}
                    onFocusCapture={() => {
                        if (!wrap.current?.closest("[data-keyboard-pane]")) return;
                        const id = current?.id;
                        if (id) select(id);
                    }}
					onScroll={(e) => uiState.set(surface, `${node.id}:scroll`, e.currentTarget.scrollTop)}
					onClickCapture={(e) => suppressRowClick.current && (e.stopPropagation(), e.preventDefault())}
					className="min-h-0 min-w-0 flex-1 scroll-pt-9 overflow-auto outline-none"
					style={doc ? { paddingInline: DOC_INSET } : undefined}
				>
					<table className="border-separate border-spacing-0 text-left" style={{ tableLayout: "fixed", width: Number.isFinite(available) ? Math.max(available, layout.total) : "100%" }}>
							<colgroup>
								{bulk.length > 0 && <col style={{ width: CHECK_WIDTH }} />}
								{columns.map((c) => <col key={c.key} style={{ width: layout.widths[c.key] }} />)}
								{/* Spare room (no growing column, or all at their maximum) sits after the last column. */}
								<col style={{ width: actionsWidth + (Number.isFinite(available) ? Math.max(0, available - layout.total) : 0) }} />
							</colgroup>
						<thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
							<tr ref={headRow}>
								{bulk.length > 0 && (
									<th className="border-b pl-4">
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
												onPointerDown={(e) => startMove(e, c)}
												onClickCapture={(e) => suppressClick.current && (e.stopPropagation(), e.preventDefault())}
												className={cn("relative h-9 overflow-hidden border-b px-3 text-xs font-medium whitespace-nowrap text-ellipsis text-muted-foreground transition-opacity duration-200", i === 0 && "pl-9", c.align === "right" && "text-right", moving?.key === c.key && "opacity-40")}
											>
											{c.sortable ? (
												<button
													onClick={() => sortBy(c)}
													title={`Sort by ${c.title.toLowerCase()}`}
													className={cn("group/sort -mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors duration-200 hover:bg-accent hover:text-foreground", sorted && "text-foreground", c.align === "right" && "flex-row-reverse")}
												>
													{c.title}
													<Arrow className={cn("size-3 transition-[opacity,transform] duration-200", sorted ? "opacity-100" : "opacity-0 group-hover/sort:opacity-40")} />
												</button>
											) : (
													c.title
												)}
												{boundary(c) && (
													<span
														role="separator"
														aria-orientation="vertical"
														aria-label={`Resize ${c.title}`}
														title="Drag to resize · double-click to reset"
														onPointerDown={(e) => startResize(e, c)}
														onDoubleClick={(e) => (e.stopPropagation(), resetWidth(c))}
														className="group/resize absolute top-0 right-0 z-10 flex h-full w-2 cursor-col-resize justify-center"
													>
														<span className="my-2 w-px bg-border transition-colors duration-200 group-hover/resize:bg-ring/70" />
													</span>
												)}
											</th>
									);
								})}
								<th className="border-b" />
							</tr>
						</thead>
						<tbody ref={body}>
							{shown.map((it) =>
								it.kind === "header" ? (
									<GroupHeader key={it.id} item={it} doc={doc} columns={columns} bulk={bulk.length > 0} selected={!it.leaving && it.id === selected} leaving={it.leaving} onSelect={() => select(it.id)} onToggle={() => toggleGroup(it.key)} />
								) : (
									<TableRow
										key={it.v.row.id}
										v={it.v}
										leaving={it.leaving}
										doc={doc}
										muted={it.muted}
										sig={JSON.stringify(it.v.row) + it.v.depth + it.v.indent}
											columns={columns}
											roomy={roomy}
											actions={actionsFor(it.v.row)}
										selected={!it.leaving && it.v.row.id === selected}
										expanded={expanded.has(it.v.row.id)}
										menuOpen={menuFor === it.v.row.id}
										choosing={choosing?.row === it.v.row.id ? choosing.action : null}
										onChoose={setChoosing}
										onSelect={select}
										onToggle={toggle}
										onMenu={setMenuFor}
										checked={checked.has(it.v.row.id)}
										onCheck={bulk.length ? check : undefined}
										onDragStart={node.reorder ? startRowDrag : undefined}
										dragging={rowDrag?.rowId === it.v.row.id}
										run={runRow}
										ready={ready}
									/>
								),
							)}
						</tbody>
					</table>
				</div>
			</div>
			{contentColumns.length > 0 && (
				// Natural widths of `width: "content"` columns: their cells drawn unconstrained, off screen.
				<div ref={measureBox} aria-hidden className="pointer-events-none invisible fixed top-0 left-0 -z-10 h-0 overflow-hidden">
					{contentColumns.map((c) => {
						const first = ordered[0] === c;
						return (
							<div key={c.key} data-measure={c.key} className="w-max">
								<div className={cn("px-3 text-xs font-medium whitespace-nowrap", first && "pl-9")}>
									{c.title}
									{c.sortable && <span className="inline-block w-4" />}
								</div>
								{measureRows(items).map((v) => (
									<div key={v.row.id} className="w-max px-3 text-sm whitespace-nowrap" style={first ? { paddingLeft: 12 + 24 + v.indent * 16 + v.depth * 20 } : undefined}>
										<CellView cell={owned(v.row.cells, c.key)} col={c} measure />
									</div>
								))}
							</div>
						);
					})}
				</div>
			)}
			{moving &&
				createPortal(
					<>
						{moving.drop && wrap.current && (
							<div className="pointer-events-none fixed z-50 w-0.5 rounded-full bg-ring" style={{ left: moving.drop.edge - 1, top: wrap.current.getBoundingClientRect().top, height: wrap.current.clientHeight }} />
						)}
						<div className="pointer-events-none fixed z-50 rounded-md border bg-popover px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-md" style={{ left: moving.x + 8, top: moving.y + 8 }}>
							{moving.title}
						</div>
					</>,
					document.body,
				)}
			{rowDrag &&
				createPortal(
					<>
						{rowDrag.mark && <div className={cn("pointer-events-none fixed z-50 rounded-sm", rowDrag.target?.whole ? "bg-ring/10 ring-2 ring-ring ring-inset" : "bg-ring")} style={rowDrag.mark} />}
						<div className="pointer-events-none fixed z-50 flex max-w-80 items-center gap-2 rounded-md border bg-popover px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-md" style={{ left: rowDrag.x + 12, top: rowDrag.y + 12 }}>
							<span className="truncate">{rowDrag.title}</span>
							{rowDrag.label && (
								<span className={cn("flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5", rowDrag.target === null ? "bg-destructive/15 text-destructive" : "bg-primary text-primary-foreground")}>
									{rowDrag.target && (() => { const icon = flatSections(sections).find((sec) => sec.id === rowDrag.target!.section)?.dropIcon; return icon ? <Icon name={icon} className="size-3" /> : null; })()}
									{rowDrag.label}
								</span>
							)}
						</div>
					</>,
					document.body,
				)}
			{drawerUseful && (
				<Inspector
					open={drawerOpen}
					selected={!!current}
					item={current?.kind === "row" && (current.v.row.details || current.v.row.pane) ? current : current?.kind === "header" ? current : null}
					actions={current?.kind === "row" ? actionsFor(current.v.row) : []}
					run={runRow}
					emit={emitAction}
					onLeave={() => wrap.current?.focus({ preventScroll: true })}
					onToggleGroup={toggleGroup}
				/>
			)}
			{drawerUseful && paneActions && drawerFits && createPortal(
				<ShortcutTooltip label={drawerOpen ? "Hide details" : "Show details"} keys="⌥⌘B" align="end">
					<Button variant="ghost" size="icon-sm" aria-pressed={drawerOpen} aria-label={drawerOpen ? "Hide details" : "Show details"} aria-keyshortcuts="Alt+Meta+B" onClick={toggleDrawer} className="text-muted-foreground">
						{drawerOpen ? <PanelRightClose /> : <PanelRightOpen />}
					</Button>
				</ShortcutTooltip>,
				paneActions,
			)}
			{dialog}
		</div>
	);
}

/** A group header: a section (level 0: where jobs run), a declared sub-section (drawn like a
 *  section, indented under it) or a group inside them (a folder). It can be selected (and moved
 *  through with the keyboard) and collapsed. */
function GroupHeader({ item, doc, columns, bulk, selected, leaving, onSelect, onToggle }: { item: Extract<Item, { kind: "header" }>; doc?: boolean; columns: Column[]; bulk: boolean; selected: boolean; leaving?: boolean; onSelect: () => void; onToggle: () => void }) {
	const { group: g, level, count, muted, collapsed } = item;
	const top = level === 0 || !!item.section;
	const { index, labelSpan: colSpan } = groupSummaryLayout(columns, g.summary?.column, bulk);
	// In a document, headers sit on the page like headings: no tint, no line under them.
	const background = cn(selected ? "bg-selected text-selected-foreground" : doc ? "group-hover/row:bg-accent" : top ? "bg-muted/60 group-hover/row:bg-accent" : "bg-background group-hover/row:bg-accent", !doc && "border-b");
	const summary = g.summary && <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={`${g.summary.label}: ${g.summary.value}`} className="inline-block shrink-0 rounded font-mono text-xs text-muted-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring">{g.summary.value}</span></TooltipTrigger><TooltipContent className="max-w-xs"><div className="font-medium">{g.summary.label}</div>{g.summary.description && <p className="mt-1 leading-relaxed">{g.summary.description}</p>}</TooltipContent></Tooltip>;
	return (
		<tr data-row-id={item.id} data-group-level={level} data-selected={selected} {...(leaving ? leavingProps : {})} onClick={(e) => (onSelect(), refocusTable(e.currentTarget))} onDoubleClick={onToggle} className={cn("group/row cursor-default", doc && DOC_ROW, leaving && LEAVING)}>
			<td
				colSpan={colSpan}
				className={cn(
					"transition-colors duration-200",
                    background,
					top ? "py-2" : "py-1",
				)}
				style={{ paddingLeft: 12 + level * 16, paddingRight: index === 0 ? 12 : 24 }}
			>
				{/* w-0 + min-w-full: the header never makes the table wider than the window; long
				    labels truncate instead. */}
				<div className={cn("flex w-0 min-w-full items-center gap-2", top ? "text-[15px]" : "text-xs", muted && !selected && "opacity-70")}>
					<button
						tabIndex={-1}
						aria-label={collapsed ? "Expand group" : "Collapse group"}
						onClick={(e) => (e.stopPropagation(), onToggle())}
						className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronRight className={cn("size-3.5 transition-transform duration-200", !collapsed && "rotate-90")} />
					</button>
					{g.icon && <Icon name={g.icon} className={cn("shrink-0 text-muted-foreground", isFileIcon(g.icon) ? (top ? "size-7" : "size-5") : top ? "size-5" : "size-4")} />}
					{top ? (
						<span className={cn("truncate font-semibold", selected ? "text-selected-foreground" : "text-group")}>
							<Strong text={g.label} strong={g.strong} />
						</span>
					) : (
						// A group inside a section (a folder): a blue pill, beside its violet branch pill.
						<span className={cn("min-w-0 truncate rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium", pillClass("blue"))}>
							<Strong text={g.label} strong={g.strong} />
						</span>
					)}
					{g.sub && (
						// The branch: a violet pill, so it stands out from the path next to it.
						<span className={cn("tb-pill-violet flex min-w-0 shrink-[2] items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium", selected ? "bg-selected-foreground/15 text-selected-foreground" : "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300")}>
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
					{count === 0 && item.section?.empty && <span className="truncate text-xs font-normal text-muted-foreground">{item.section.empty}</span>}
					<span aria-label={`${count} ${count === 1 ? "item" : "items"}`} className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] leading-none font-medium tabular-nums", selected ? "bg-selected-foreground/15 text-selected-foreground" : "bg-muted text-muted-foreground")}>{count}</span>
                    {(g.summary?.column === undefined || index === 0) && <span className="ml-auto">{summary}</span>}
				</div>
			</td>
			{index >= 0 && columns.slice(Math.max(1, index)).map((c, offset) => <td key={c.key} className={cn("px-3 whitespace-nowrap transition-colors duration-200", background, c.align === "right" && "text-right", muted && !selected && "text-muted-foreground")} >{index > 0 && offset === 0 && summary}</td>)}
			{index >= 0 && <td className={cn("transition-colors duration-200", background)} />}
		</tr>
	);
}

type InspectorItem = Extract<Item, { kind: "row" }> | Extract<Item, { kind: "header" }>;

/**
 * The details drawer on the right. Open or closed is the person's choice for the plugin (the
 * toggle in the pane header), not the selection's: it stays as they left it while they move
 * through rows. Drag its left edge to resize (remembered). A row shows its title, figures,
 * sectioned details and grouped actions; a group header shows what it holds and collapse /
 * expand; with nothing to show it says so.
 */
function Inspector({ open, item, selected, actions, run, emit, onLeave, onToggleGroup }: { open: boolean; item: InspectorItem | null; selected: boolean; actions: Action[]; run: Run; emit: Emit; onLeave: () => void; onToggleGroup: (key: string) => void }) {
	const [width, setWidth] = usePersisted("toolbelt.inspectorWidth", 340);
	const [dragging, setDragging] = useState(false);
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
			data-inspector
			aria-hidden={!open}
			onKeyDown={(e) => {
				// Esc in the drawer goes back to the table, unless a control used it (an editor
				// putting its text back) or it came from a menu or picker outside the drawer.
				if (e.key !== "Escape" || e.defaultPrevented || !e.currentTarget.contains(e.target as globalThis.Node)) return;
				e.preventDefault();
				onLeave();
			}}
			className={cn("relative hidden shrink-0 overflow-hidden bg-muted/20 @3xl:flex", open && "border-l", !dragging && "transition-[width] duration-200 ease-out")}
			style={{ width: open ? width : 0 }}
		>
			{open && <div onPointerDown={onPointerDown} onDoubleClick={() => setWidth(340)} className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px after:transition-colors after:duration-200 hover:after:bg-ring/60" />}
			<div className={cn("flex h-full shrink-0 flex-col transition-opacity duration-200", open ? "opacity-100" : "opacity-0")} style={{ width }}>
				{!item ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
						<PanelRight className="size-5 opacity-60" />
						{selected ? "No details for this row." : "Select a row to see its details."}
					</div>
				) : item.kind === "header" ? (
					<GroupSummary item={item} onToggle={() => onToggleGroup(item.key)} />
				) : item.v.row.pane ? (
					<RowPane key={item.v.row.id} row={item.v.row} pane={item.v.row.pane} actions={actions} run={run} emit={emit} />
				) : (
					<RowDetails row={item.v.row} actions={actions} run={run} />
				)}
			</div>
		</aside>
	);
}

function DrawerHeader({ icon, dot, title, sub, children }: { icon?: string; dot?: DotNode; title: string; sub?: string; children?: ReactNode }) {
	return (
		<div className="flex items-start gap-3 border-b px-4 py-3.5">
			{icon ? (
				<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
					<Icon name={icon} className="size-4.5" />
				</div>
			) : (
				dot && <Dot dot={dot} className="mt-2" />
			)}
			<div className="min-w-0 flex-1">
				<div className="line-clamp-2 font-medium break-words select-text">
					<Hl text={title} />
				</div>
				{sub && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{sub}</div>}
				{children}
			</div>
		</div>
	);
}

function GroupSummary({ item, onToggle }: { item: Extract<Item, { kind: "header" }>; onToggle: () => void }) {
	const g = item.group;
	return (
		<>
			<DrawerHeader icon={g.icon ?? "folder"} title={g.label} sub={item.level === 0 ? "Section" : item.section ? "Sub-section" : "Group"}>
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
                    {g.summary && <StatTile label={g.summary.label} value={g.summary.value} />}
				</div>
                {g.summary?.description && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{g.summary.description}</p>}
			</div>
			<div className="border-t p-3">
				<Button size="sm" variant="outline" onClick={onToggle}>
					<ChevronRight className={cn("transition-transform duration-200", !item.collapsed && "rotate-90")} />
					{item.collapsed ? "Expand" : "Collapse"}
					<KeyHint keys="↵" />
				</Button>
			</div>
		</>
	);
}

function StatTile({ label, value, spark, tone }: { label: string; value: string; spark?: number[]; tone?: Tone }) {
	return (
		<div className="min-w-0 rounded-lg border bg-background px-3 py-2">
			<div className="truncate text-[11px] text-muted-foreground">{label}</div>
			<div className={cn("truncate text-sm font-semibold tabular-nums", textClass(tone ?? "default"))}>{value}</div>
			{spark && spark.length > 1 ? <Spark values={spark} tone={tone} fill /> : spark && <div className="h-4" />}
		</div>
	);
}

function RowDetails({ row, actions, run }: { row: Row; actions: Action[]; run: Run }) {
	const first = row.cells[Object.keys(row.cells)[0]];
	const title = first && typeof first === "object" ? first.text : String(first ?? row.id);
	const sub = first && typeof first === "object" ? first.sub : undefined;
	const icon = first && typeof first === "object" ? first.icon : undefined;
	const dot = first && typeof first === "object" ? first.dot : undefined;
	const chips = Object.values(row.cells).flatMap((c) => (c && typeof c === "object" && c.chips ? c.chips : []));
	const tags = first && typeof first === "object" ? (first.tags ?? []) : [];
	const groups = groupActions(actions);
	const main = actions.find((a) => a.inline);
	return (
		<>
			<DrawerHeader icon={icon} dot={dot} title={title.replace(/^⤷ /, "")} sub={sub}>
				{(chips.length > 0 || tags.length > 0) && (
					<div className="mt-2 flex flex-wrap items-center gap-1">
						{tags.map((t) => (
							<TagPill key={t.text} tag={t} />
						))}
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
								<DetailRow key={d.label + (d.actionRow ?? "") + (d.target ?? "")} d={d} run={(a) => run(a, d.actionRow ?? row.id, d.target !== undefined ? { target: d.target } : undefined)} />
							))}
						</dl>
					</section>
				))}
			</div>
			{groups.length > 0 && <InspectorActions groups={groups} main={main} row={row} run={(a, target) => run(a, row.id, target ? { target } : undefined)} />}
		</>
	);
}

/** A drawer menu closed: focus stays where its action put it (a composer), or goes to the table. */
const paneMenuClosed = (e: Event) => {
	e.preventDefault();
	if (document.activeElement?.closest("[data-pane]")) return;
	(document.querySelector(TABLE) as HTMLElement | null)?.focus({ preventScroll: true });
};

/**
 * A row's own drawer (`Row.pane`): a slim bar of its actions — the first group as icon buttons,
 * everything in the ⋯ menu — above the plugin's nodes. Events from the nodes carry the row.
 */
function RowPane({ row, pane, actions, run, emit }: { row: Row; pane: Node[]; actions: Action[]; run: Run; emit: Emit }) {
	const paneEmit = useCallback<Emit>((name, payload) => emit(name, { ...(payload as object | undefined), rowId: row.id }), [emit, row.id]);
	const groups = groupActions(actions);
	const first = groups[0] ?? [];
	const runAction = (a: Action, target?: string) => run(a, row.id, target ? { target } : undefined);
	const tip = (a: Action) => (
		<TooltipContent>
			{a.label}
			{a.key && <KeyHint keys={formatKey(a.key)} />}
		</TooltipContent>
	);
	return (
		<>
			{actions.length > 0 && (
				<div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1.5">
					{first.map((a) => {
						const targets = choicesFor(row, a);
						const choices = targets ? targets.map((t) => ({ ...a, id: a.id, label: t.label, icon: t.icon ?? a.icon, target: t.id })) : a.menu?.length ? [{ ...a, target: undefined }, ...a.menu.map((m) => ({ ...m, target: undefined }))] : null;
						const button = (
							<Button variant="ghost" size="icon-sm" disabled={a.disabled} aria-label={a.label} className={cn("text-muted-foreground hover:text-foreground", a.tone === "destructive" && "hover:text-destructive")} onClick={choices ? undefined : () => runAction(a)}>
								<Icon name={a.icon ?? "circle"} />
							</Button>
						);
						if (!choices)
							return (
								<Tooltip key={a.id}>
									<TooltipTrigger asChild>{button}</TooltipTrigger>
									{tip(a)}
								</Tooltip>
							);
						return (
							<DropdownMenu key={a.id}>
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
									</TooltipTrigger>
									{tip(a)}
								</Tooltip>
								<DropdownMenuContent align="start" className="min-w-48" onCloseAutoFocus={paneMenuClosed}>
									{choices.map((c, i) => (
										<DropdownMenuItem key={`${c.id}:${c.target ?? i}`} disabled={c.disabled} variant={c.tone === "destructive" ? "destructive" : "default"} onSelect={() => runAction(c, c.target)}>
											{c.icon && <Icon name={c.icon} />}
											{c.label}
											{c.key && <DropdownMenuShortcut>{formatKey(c.key)}</DropdownMenuShortcut>}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						);
					})}
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="icon-sm" aria-label="All actions" className="ml-auto text-muted-foreground hover:text-foreground">
										<MoreHorizontal />
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent>
								All actions <KeyHint keys="." />
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end" className="min-w-56" onCloseAutoFocus={paneMenuClosed}>
							{groups.map((g, gi) => (
								<Fragment key={gi}>
									{gi > 0 && <DropdownMenuSeparator />}
									<DropdownMenuGroup>
										{g.map((a) => {
											const targets = choicesFor(row, a);
											const item = (
												<>
													{a.icon && <Icon name={a.icon} />}
													{a.label}
													{a.key && <DropdownMenuShortcut>{formatKey(a.key)}</DropdownMenuShortcut>}
												</>
											);
											if (targets)
												return (
													<DropdownMenuSub key={a.id}>
														<DropdownMenuSubTrigger disabled={a.disabled}>{item}</DropdownMenuSubTrigger>
														<DropdownMenuSubContent className="w-72">
															<TargetItems a={a} targets={targets} onPick={(t) => runAction(a, t.id)} />
														</DropdownMenuSubContent>
													</DropdownMenuSub>
												);
											return (
												<DropdownMenuItem key={a.id} disabled={a.disabled} variant={a.tone === "destructive" ? "destructive" : "default"} onSelect={() => runAction(a)}>
													{item}
												</DropdownMenuItem>
											);
										})}
									</DropdownMenuGroup>
								</Fragment>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}
			<div data-pane className="min-h-0 flex-1 space-y-5 overflow-auto px-4 pt-3 pb-8">
				<PaneRow.Provider value={row.id}>
					{pane.map((n, i) => (
						<Render key={(n as { id?: string }).id ?? `${n.type}${i}`} node={n} emit={paneEmit} />
					))}
				</PaneRow.Provider>
			</div>
		</>
	);
}

/**
 * The drawer's actions, by group: the first group as buttons (the main action filled, ↵), the
 * other everyday groups as one quieter row split by dividers, destructive groups last, apart.
 */
function InspectorActions({ groups, main, row, run }: { groups: Action[][]; main?: Action; row: Row; run: (a: Action, target?: string) => void }) {
	const risky = (g: Action[]) => g.every((a) => a.tone === "destructive");
	const [first, ...rest] = groups.filter((g) => !risky(g));
	const middle = rest;
	const danger = groups.filter(risky).flat();
	const button = (a: Action, variant: "default" | "outline" | "ghost" | "destructive") => {
		const targets = choicesFor(row, a);
		const hints = (
			<>
				{a === main && <KeyHint keys="↵" />}
				{a.key && <KeyHint keys={formatKey(a.key)} />}
			</>
		);
		const cls = cn(variant === "ghost" && "px-2 text-muted-foreground hover:text-foreground");
		if (!targets && a.menu?.length) return <SplitButton key={a.id} a={a} size="sm" variant={variant} onRun={(x) => run(x)} hints={hints} className={cls} />;
		if (!targets)
			return (
				<Button key={a.id} size="sm" disabled={a.disabled} variant={variant} onClick={() => run(a)} className={cls}>
					{a.icon && <Icon name={a.icon} />}
					{a.label}
					{hints}
				</Button>
			);
		// Several processes it could apply to: the button asks which.
		const pick = (t: Target) => run(a, t.id);
		return (
			<DropdownMenu key={a.id}>
				<DropdownMenuTrigger asChild>
					<Button size="sm" disabled={a.disabled} variant={variant} className={cls}>
						{a.icon && <Icon name={a.icon} />}
						{a.label}
						<ChevronDown className="-ml-0.5 size-3.5 opacity-70" />
						{hints}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-72" onCloseAutoFocus={toTable} onKeyDown={pickByDigit(targets, pick)}>
					<TargetItems a={a} targets={targets} onPick={pick} />
				</DropdownMenuContent>
			</DropdownMenu>
		);
	};
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

function DetailRow({ d, run }: { d: DetailItem; run: (a: Action) => void }) {
	const [copied, setCopied] = useState(false);
	const [all, setAll] = useState(false);
	const acts = d.actions ?? [];
	const canCopy = !acts.length && (d.copy ?? d.mono);
	const long = d.markdown ? d.value.length > 600 || d.value.split("\n").length > 12 : d.value.length > 200;
	return (
		<div className="group/detail relative px-3 py-2">
			{(d.label || d.dot) && (
				<dt className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", acts.length > 0 && (acts.length > 1 ? "pr-14" : "pr-6"))}>
					{d.dot && <Dot dot={d.dot} className="size-1.5" />}
					{d.label}
				</dt>
			)}
			{acts.length > 0 && (
				// The item's own actions (Peek or open one of the processes listed here).
				<div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
					{acts.map((a) => (
						<Tooltip key={a.id}>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={a.label} onClick={() => run(a)}>
									<Icon name={a.icon} />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{a.label}</TooltipContent>
						</Tooltip>
					))}
				</div>
			)}
			{d.markdown ? (
				<dd className={cn(!d.label && acts.length > 0 && (acts.length > 1 ? "pr-14" : "pr-6"), "relative mt-0.5", long && !all && "max-h-48 overflow-hidden mask-b-from-70%")}>
					<Markdown text={d.value} className="space-y-2" />
				</dd>
			) : (
				<dd className={cn(acts.length > 1 ? "pr-14" : "pr-6", "text-sm break-words select-text", d.mono && "font-mono text-[0.8rem]", long && !all && "line-clamp-4", textClass(d.tone ?? "default"))}>
					<Hl text={d.value} />
				</dd>
			)}
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
    const self = useRef<HTMLDivElement>(null);
	const [active, setActive, sharedTarget] = useCollectionSelection(`${node.id}:active`, `list:${node.id}`);
	const [pointerMoved] = useState(pointerTracker);
	// An action with `input` asks for its text in a line under the item.
	const [asking, setAsking] = useState<{ item: string; action: Action } | null>(null);
	const runItem = useCallback((a: Action, id: string) => (a.input ? (setActive(id), setAsking({ item: id, action: a })) : run(a, id)), [run, setActive]);
	useEffect(() => {
		if (!keyboard) return;
		const onKey = (e: KeyboardEvent) => {
			if (!ownsCollectionKeyboard(self.current) || isTyping(e) || e.metaKey || e.ctrlKey) return;
            if ((e.target as HTMLElement).closest("button, a, [role=switch]")) return;
			const i = node.items.findIndex((it) => it.id === active);
			if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.shiftKey) {
				e.preventDefault();
				const next = node.items[i < 0 ? (e.key === "ArrowDown" ? 0 : node.items.length - 1) : Math.max(0, Math.min(node.items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
				if (next) {
					setActive(next.id);
					requestAnimationFrame(() => self.current?.querySelector(`[data-item-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" }));
				}
            } else if (i >= 0) {
                const item = node.items[i]!;
                const action = e.key === "Enter" ? item.actions?.find(a => !a.disabled) : actionForEvent(item.actions ?? [], e);
                if (action) { e.preventDefault(); runItem(action, item.id); }
            }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [keyboard, node.items, active, setActive, runItem]);
    const revealedTarget = useRef<string | null>(null);
    useLayoutEffect(() => {
        const key = selectionKey(sharedTarget);
        if (key === revealedTarget.current) return;
        revealedTarget.current = key;
        if (sharedTarget) requestAnimationFrame(() => self.current?.querySelector(`[data-item-id="${CSS.escape(sharedTarget.item)}"]`)?.scrollIntoView({ block: "nearest" }));
    }, [sharedTarget]);
    const restoreSelection = () => {
        const item = node.items.find(it => it.id === active);
        if (!item) return;
        requestAnimationFrame(() => self.current?.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: "nearest" }));
    };
    const handoff = useContext(SelectionHandoffContext);
    const appliedHandoff = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (!handoff || handoff.collection !== `list:${node.id}` || appliedHandoff.current === handoff.token) return;
        appliedHandoff.current = handoff.token;
        setActive(handoff.item);
        requestAnimationFrame(() => {
            self.current?.focus({ preventScroll: true });
            self.current?.querySelector(`[data-item-id="${CSS.escape(handoff.item)}"]`)?.scrollIntoView({ block: "nearest" });
            handoff.onApplied();
        });
    }, [handoff, node.id, setActive]);
	if (!node.items.length) return node.empty ? <EmptyState {...node.empty} /> : null;
	return (
		<div ref={self} tabIndex={keyboard ? 0 : undefined} data-navigation-collection={keyboard ? `list:${node.id}` : undefined}
            onFocusCapture={restoreSelection} className="flex flex-col outline-none">
			{node.items.map((it) => (
				<Fragment key={it.id}>
				<div data-item-id={it.id} data-active={it.id === active} onMouseEnter={(e) => { if (canHoverNavigate(self.current) && pointerMoved(e)) { focusPopoverCollection(self.current); setActive(it.id); } }}
                    onMouseMove={(e) => { if (canHoverNavigate(self.current) && pointerMoved(e) && (active !== it.id || !self.current?.contains(document.activeElement))) { focusPopoverCollection(self.current); setActive(it.id); } }}
                    onPointerDown={() => { focusPopoverCollection(self.current); setActive(it.id); }} className="group/row flex items-center gap-3 rounded-lg px-2.5 py-2 data-[active=true]:bg-selected data-[active=true]:text-selected-foreground">
					{it.dot && <Dot dot={it.dot} />}
                    {it.icon && <Icon name={it.icon} className="size-4 shrink-0" />}
					<div className="min-w-0 flex-1">
						<div className={cn("flex items-center gap-1.5 text-sm", it.unread ? "font-semibold" : "font-medium")}>
							{it.unread && <UnreadDot />}
							<span className="truncate">{it.title}</span>
						</div>
						{it.subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{it.subtitle}</div>}
					</div>
					{(it.meta || it.metaAt !== undefined) && <span className="text-xs text-muted-foreground tabular-nums group-data-[active=true]/row:hidden">{it.metaAt !== undefined ? <When at={it.metaAt} /> : it.meta}</span>}
					{it.actions && it.actions.length > 0 && (
						<div className="hidden items-center gap-0.5 group-data-[active=true]/row:flex">
							{withAlternatives(it.actions).map((a, i) => (
								<Tooltip key={a.id}>
									<TooltipTrigger asChild>
										<Button variant="ghost" size="icon-xs" tabIndex={-1} className="hover:bg-selected-foreground/15 hover:text-selected-foreground" onClick={() => runItem(a, it.id)} aria-label={a.label}>
											<Icon name={a.icon} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{a.label}
										{i === 0 && " ↵"}
										{a.key && <KeyHint keys={formatKey(a.key)} />}
									</TooltipContent>
								</Tooltip>
							))}
						</div>
					)}
				</div>
				{asking?.item === it.id && (
					<ItemInput
						action={asking.action}
						onSend={(text) => {
							run(asking.action, it.id, { text });
							setAsking(null);
							self.current?.focus({ preventScroll: true });
						}}
						onCancel={() => {
							setAsking(null);
							self.current?.focus({ preventScroll: true });
						}}
					/>
				)}
				</Fragment>
			))}
			{dialog}
		</div>
	);
}

/** A line under a list item for an action's text (`Action.input`): ↵ sends, Esc cancels. */
function ItemInput({ action, onSend, onCancel }: { action: Action; onSend: (text: string) => void; onCancel: () => void }) {
	const [v, setV] = useState("");
	return (
		<div className="flex items-center gap-2 py-1 pr-1 pl-8 animate-in fade-in-0 slide-in-from-top-1 duration-150">
			<Input
				autoFocus
				value={v}
				aria-label={action.label}
				placeholder={action.input?.placeholder ?? action.label}
				onChange={(e) => setV(e.target.value)}
				onBlur={() => !v.trim() && onCancel()}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter" && v.trim()) (e.preventDefault(), onSend(v.trim()));
					if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onCancel());
				}}
				className="h-7 text-sm"
			/>
			<KeyHint keys="↵" />
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
						<CardTitle className={cn("text-2xl font-semibold tabular-nums", textClass(s.tone ?? "default"))}>{s.at !== undefined ? <When at={s.at} /> : s.value}</CardTitle>
					</CardHeader>
					{s.hint && <CardContent className="px-4 text-xs text-muted-foreground">{s.hint}</CardContent>}
				</Card>
			))}
		</div>
	);
}

// ── forms (settings) ─────────────────────────────────────────────────────
/** True inside a plugin's dialog: forms there drop their card and line up in two columns. */
const InDialog = createContext(false);

/** Fields whose label names a group of controls rather than one input. */
const GROUP_LABEL = new Set<Field["type"]>(["environment", "tags", "color"]);

function Form({ node, emit }: { node: Extract<Node, { type: "form" }>; emit: Emit }) {
	if (node.appearance === "inline") return <InlineForm node={node} emit={emit} />;
	return <BoxedForm node={node} emit={emit} />;
}

/**
 * A drawer's property sheet: labels in a narrow column, controls drawn like text until hovered
 * or focused (see `[data-inline-form]` in index.css), each field committing on its own.
 */
function InlineForm({ node, emit }: { node: Extract<Node, { type: "form" }>; emit: Emit }) {
	const change = (field: Field, value: FieldValue) => emit("field", { form: node.id, field: field.id, value });
	return (
		<div data-inline-form className="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] items-start gap-x-3 gap-y-px">
			{node.fields.map((f) => {
				const id = `${node.id}-${f.id}`;
				const control =
					f.type === "text" && f.heading ? (
						<HeadingField id={id} field={f} onChange={(v) => change(f, v)} />
					) : f.type === "text" ? (
						<TextField id={id} field={f} onChange={(v) => change(f, v)} className="h-8 w-full" />
					) : f.type === "textarea" && f.markdown ? (
						<InlineMarkdown id={id} field={f} onChange={(v) => change(f, v)} />
					) : (
						<FieldControl id={id} field={f} onChange={(v) => change(f, v)} fill />
					);
				if (!f.label || (f.type === "text" && f.heading))
					return (
						<div key={f.id} data-pane-id={f.id} className={cn("col-span-2 min-w-0", f.type === "text" && f.heading ? "mb-1.5" : "mt-1.5")}>
							{control}
						</div>
					);
				return (
					<Fragment key={f.id}>
						<label htmlFor={id} className="flex min-h-8 items-center truncate text-xs text-muted-foreground">
							{f.label}
						</label>
						<div data-pane-id={f.id} className={cn("flex min-h-8 min-w-0 items-center *:max-w-full", f.type === "tags" && "py-0.5")}>
							{control}
						</div>
					</Fragment>
				);
			})}
		</div>
	);
}

/** The title of what a drawer edits: large, wrapping; ↵ or leaving commits, Esc puts it back. */
function HeadingField({ id, field, onChange }: { id: string; field: Extract<Field, { type: "text" }>; onChange: (v: string) => void }) {
	const [v, setV] = useState(field.value);
	useEffect(() => setV(field.value), [field.value]);
	const box = useRef<HTMLTextAreaElement>(null);
	const cancelled = useRef(false);
	// As tall as its text; measured again when the drawer's width changes (it may start hidden).
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const fit = () => {
			el.style.height = "auto";
			if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [v]);
	return (
		<textarea
			ref={box}
			id={id}
			rows={1}
			value={v}
			aria-label={field.label || "Title"}
			placeholder={field.placeholder}
			onChange={(e) => setV(e.target.value.replace(/\n/g, " "))}
			onBlur={() => {
				if (cancelled.current) (cancelled.current = false), setV(field.value);
				else if (v.trim() && v !== field.value) onChange(v.trim());
				else setV(field.value);
			}}
			onKeyDown={(e) => {
				if (e.nativeEvent.isComposing) return;
				if (e.key === "Enter") (e.preventDefault(), e.currentTarget.blur(), leaveToCollection(e.currentTarget));
				if (e.key === "Escape") cancelled.current = true;
			}}
			className="-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md bg-transparent px-2 py-1 text-[1.05rem] leading-snug font-semibold outline-none transition-colors duration-150 placeholder:text-muted-foreground hover:bg-accent/60 focus:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
		/>
	);
}

function BoxedForm({ node, emit }: { node: Extract<Node, { type: "form" }>; emit: Emit }) {
	const change = (field: Field, value: FieldValue) => emit("field", { form: node.id, field: field.id, value });
	const label = (f: Field, className?: string) =>
		GROUP_LABEL.has(f.type) ? <div className={cn("text-sm font-medium", className)}>{f.label}</div> : <Label htmlFor={`${node.id}-${f.id}`} className={className}>{f.label}</Label>;
	if (useContext(InDialog))
		// Labels in a column of their own, controls lined up beside them and as wide as the
		// dialog allows; descriptions under their control.
		return (
			<div className="space-y-4">
				{(node.title || node.description) && (
					<div className="space-y-1">
						{node.title && <div className="font-medium">{node.title}</div>}
						{node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
					</div>
				)}
				<div data-form-fields className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)]">
					{node.fields.map((f) =>
						f.type === "environment" ? (
							<div key={f.id} className="space-y-2 sm:col-span-2">
								{label(f)}
								{f.description && <p className="text-sm text-muted-foreground">{f.description}</p>}
								<FieldControl id={`${node.id}-${f.id}`} field={f} onChange={(v) => change(f, v)} />
							</div>
						) : (
							<div key={f.id} className="contents">
								{label(f, cn("sm:flex sm:min-h-8 sm:items-center sm:self-start", f.type === "textarea" && "sm:items-start sm:pt-2"))}
								<AutoFocus on={!!f.autofocus} className="min-w-0 space-y-1.5">
									<div className={cn("flex min-h-8 items-center *:max-w-full", f.type === "textarea" && "*:w-full", (f.type === "tags" || f.type === "color") && "py-1")}>
										<FieldControl id={`${node.id}-${f.id}`} field={f} onChange={(v) => change(f, v)} fill />
									</div>
									{f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
								</AutoFocus>
							</div>
						),
					)}
				</div>
			</div>
		);
	return (
		<Card>
			{(node.title || node.description) && (
				<CardHeader>
					{node.title && <CardTitle>{node.title}</CardTitle>}
					{node.description && <CardDescription>{node.description}</CardDescription>}
				</CardHeader>
			)}
			<CardContent data-form-fields className="divide-y">
				{node.fields.map((f) => (
					<div key={f.id} className={cn("py-4 first:pt-0 last:pb-0", WIDE_FIELDS.has(f.type) ? "space-y-3" : "flex items-center justify-between gap-6")}>
						<div className="space-y-1">
							{label(f)}
							{f.description && <p className="text-sm text-muted-foreground">{f.description}</p>}
						</div>
						<FieldControl id={`${node.id}-${f.id}`} field={f} onChange={(v) => change(f, v)} />
					</div>
				))}
			</CardContent>
		</Card>
	);
}

/**
 * A field's box. With `on`, its control takes focus when it appears in an open dialog: the
 * dialog opening prefers it to the first field, and a form the plugin swaps in focuses it.
 */
function AutoFocus({ on, className, children }: { on: boolean; className?: string; children: ReactNode }) {
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!on) return;
		// Children's effects ran first, so an editor control exists by now. When the dialog is
		// just opening, its own open focus comes after this and prefers this field too.
		const el = box.current?.querySelector<HTMLElement>(FIRST_FIELD);
		if (el && box.current?.closest("[role=dialog]")) el.focus();
	}, [on]);
	return (
		<div ref={box} data-autofocus={on || undefined} className={className}>
			{children}
		</div>
	);
}

type FieldValue = string | boolean | EnvironmentEntry[] | TagValue[];
/** `fill`: as wide as the space it's given (dialog forms), instead of the control's usual width. */
function FieldControl({ id, field, onChange, fill }: { id: string; field: Field; onChange: (v: FieldValue) => void; fill?: boolean }) {
	switch (field.type) {
		case "environment":
            return <EnvironmentEditor value={field.value} onChange={onChange} />;
        case "select":
			return (
				<Select value={field.value} onValueChange={onChange}>
					<SelectTrigger id={id} className={fill ? "w-full max-w-sm" : "w-48"}>
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
			return <TextField id={id} field={field} onChange={onChange} className={fill ? "w-full" : "w-64"} />;
		case "textarea":
			return <TextAreaField id={id} field={field} onChange={onChange} />;
		case "datetime":
			return <DateTimeField id={id} field={field} onChange={onChange} />;
		case "color":
			return <ColorField id={id} field={field} onChange={onChange} />;
		case "combobox":
			return <ComboboxField id={id} field={field} onChange={onChange} className={fill ? "w-full" : undefined} />;
		case "tags":
			return <TagsField id={id} field={field} onChange={onChange} />;
	}
}

function TextField({ id, field, onChange, className }: { id: string; field: Extract<Field, { type: "text" }>; onChange: (v: string) => void; className?: string }) {
	const [v, setV] = useState(field.value);
	useEffect(() => setV(field.value), [field.value]);
	const commit = () => v !== field.value && onChange(v);
	return <Input id={id} type={field.sensitive ? "password" : "text"} className={className} value={v} placeholder={field.placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && commit()} />;
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
	// In a drawer, a card is a titled section, not a box.
	if (useContext(PaneRow) !== undefined)
		return (
			<section className="space-y-2" data-pane-id={node.id}>
				{(node.title || node.actions?.length) && (
					<div className="flex min-h-6 items-center gap-2">
						{node.title && <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{node.title}</h3>}
						{node.description && <span className="truncate text-xs text-muted-foreground">{node.description}</span>}
						<div className="ml-auto flex items-center gap-0.5">
							{node.actions?.map((a) => (
								<Tooltip key={a.id}>
									<TooltipTrigger asChild>
										<Button variant="ghost" size="icon-xs" aria-label={a.label} disabled={a.disabled} className="text-muted-foreground hover:text-foreground" onClick={() => run(a)}>
											<Icon name={a.icon ?? "circle"} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{a.label}</TooltipContent>
								</Tooltip>
							))}
						</div>
					</div>
				)}
				{node.children.map((c, i) => (
					<Render key={(c as { id?: string }).id ?? `${c.type}${i}`} node={c} emit={emit} />
				))}
				{dialog}
			</section>
		);
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
					<dd className={cn("min-w-0 break-words select-text", d.mono && "font-mono text-[0.8rem]", textClass(d.tone ?? "default"))}>{d.value}</dd>
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
				<div key={i} className={cn("break-all whitespace-pre-wrap", textClass(l.tone ?? "default"))}>
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
				<span className={cn("min-w-0 flex-1 truncate", textClass(node.tone ?? "default"))}>{node.label ?? "Working…"}</span>
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
export function Markdown({ text, className }: { text: string; className?: string }) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return <div className={cn("space-y-3 text-sm leading-relaxed break-words select-text", className)}>{blocks.map((b, i) => <MdBlock key={i} b={b} />)}</div>;
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
