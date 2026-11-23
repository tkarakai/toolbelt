// An editable list of choices (`options` field, capability `ui.options-field`): rename in place,
// add from the last row (one item per line when pasting), remove, move by dragging the grip or
// with ⌥↑ ⌥↓, and, with `colors`, give each item a color from a swatch popover. New items get a
// color the list uses least. Rows keep their identity across renders (by key, or by text until
// the plugin gives them a key), so focus stays put and moves animate.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import type { Field, Hue, OptionItem } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ColorField } from "./fields";
import { dotClass } from "./colors";
import { leastUsedHue, moveItem, newOptionTexts } from "./pure";

type Of = Extract<Field, { type: "options" }>;
type Item = OptionItem & { id: string };

let next = 0;
const freshId = () => `o${++next}`;

/** The plugin's items, keeping the ids of rows already shown: same key, or same text while unkeyed. */
function sync(incoming: OptionItem[], current: Item[]): Item[] {
	const taken = new Set<string>();
	return incoming.map((o) => {
		const free = (c: Item) => !taken.has(c.id);
		const match = (o.key !== undefined && current.find((c) => free(c) && c.key === o.key)) || current.find((c) => free(c) && (c.key === undefined || o.key === undefined) && c.text === o.text);
		const id = match ? match.id : freshId();
		taken.add(id);
		return { ...o, id };
	});
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function OptionsField({ id, field, onChange }: { id: string; field: Of; onChange: (v: OptionItem[]) => void }) {
	const [items, setItems] = useState<Item[]>(() => sync(field.value, []));
	const latest = useRef(items);
	latest.current = items;
	useEffect(() => setItems((cur) => sync(field.value, cur)), [JSON.stringify(field.value)]);

	const list = useRef<HTMLUListElement>(null);
	const adder = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState("");
	const [dragging, setDragging] = useState<string | null>(null);
	const drag = useRef<{ id: string; start: string } | null>(null);

	// Edits read `latest`, not this render's `items`: a blur can follow ↵ before React re-renders.
	const commit = (nextItems: Item[]) => {
		latest.current = nextItems;
		setItems(nextItems);
		onChange(nextItems.map(({ id: _id, count: _count, ...o }) => o));
	};

	/** Focus row `i`'s text (caret at the end), or the add row past the last. */
	const focusRow = (i: number) =>
		requestAnimationFrame(() => {
			const el = list.current?.querySelectorAll<HTMLInputElement>("input[data-option-text]")[i];
			const target = el ?? adder.current;
			target?.focus();
			target?.setSelectionRange(target.value.length, target.value.length);
		});

	const rename = (rowId: string, text: string) => {
		const cur = latest.current;
		const t = text.trim();
		const it = cur.find((x) => x.id === rowId);
		if (!it || !t || t === it.text) return false;
		commit(cur.map((x) => (x.id === rowId ? { ...x, text: t } : x)));
		return true;
	};
	const remove = (rowId: string, focus?: number) => {
		commit(latest.current.filter((x) => x.id !== rowId));
		if (focus !== undefined) focusRow(focus);
	};
	const move = (rowId: string, by: number) => {
		const cur = latest.current;
		const from = cur.findIndex((x) => x.id === rowId);
		const to = from + by;
		if (from < 0 || to < 0 || to >= cur.length) return;
		commit(moveItem(cur, from, to));
		focusRow(to);
	};
	const recolor = (rowId: string, color: Hue) => {
		const cur = latest.current;
		if (cur.find((x) => x.id === rowId)?.color !== color) commit(cur.map((x) => (x.id === rowId ? { ...x, color } : x)));
	};

	// An existing item typed again is pointed at instead of added twice.
	const [nudged, setNudged] = useState<string | null>(null);
	const add = (input: string) => {
		const items = latest.current;
		const texts = newOptionTexts(input, items.map((it) => it.text));
		if (!texts.length) {
			const dup = items.find((it) => it.text.toLowerCase() === input.trim().toLowerCase());
			if (dup) {
				setNudged(dup.id);
				list.current?.querySelector(`[data-option-row="${dup.id}"]`)?.scrollIntoView({ block: "nearest" });
				setTimeout(() => setNudged((n) => (n === dup.id ? null : n)), 900);
			}
			return;
		}
		const used = items.map((it) => it.color);
		const added = texts.map((text): Item => {
			const color = field.colors ? leastUsedHue(used) : undefined;
			used.push(color);
			return { id: freshId(), text, ...(color && { color }) };
		});
		commit([...items, ...added]);
		setDraft("");
		requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: reduced() ? "auto" : "smooth" }));
	};

	// Rows slide to their new places (FLIP) and new ones fade in; not on first paint.
	const tops = useRef(new Map<string, number>());
	const painted = useRef(false);
	useLayoutEffect(() => {
		const rows = list.current?.querySelectorAll<HTMLElement>("[data-option-row]") ?? [];
		const animate = painted.current && !reduced();
		const seen = new Map<string, number>();
		rows.forEach((el) => {
			const rowId = el.dataset.optionRow!;
			const top = el.offsetTop;
			const before = tops.current.get(rowId);
			seen.set(rowId, top);
			if (!animate || rowId === dragging) return;
			if (before === undefined) el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
			else if (before !== top) el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
		});
		tops.current = seen;
		painted.current = true;
	});

	// Dragging the grip moves the row live; letting go sends the new order once.
	const order = (xs: Item[]) => xs.map((x) => x.id).join("\u0000");
	const gripDown = (e: ReactPointerEvent<HTMLElement>, rowId: string) => {
		if (e.button !== 0) return;
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			// A pointer that's already gone; the drag still follows moves over the grip.
		}
		drag.current = { id: rowId, start: order(latest.current) };
		setDragging(rowId);
	};
	const gripMove = (e: ReactPointerEvent<HTMLElement>) => {
		const d = drag.current;
		if (!d || !list.current) return;
		const rows = [...list.current.querySelectorAll<HTMLElement>("[data-option-row]")];
		// The first row whose middle is below the pointer is where the dragged one goes.
		const slot = rows.findIndex((r) => {
			const b = r.getBoundingClientRect();
			return e.clientY < b.top + b.height / 2;
		});
		setItems((cur) => {
			const from = cur.findIndex((x) => x.id === d.id);
			const to = slot < 0 ? cur.length - 1 : slot > from ? slot - 1 : slot;
			return from < 0 || to === from ? cur : moveItem(cur, from, to);
		});
	};
	const gripUp = () => {
		const d = drag.current;
		drag.current = null;
		setDragging(null);
		if (d && order(latest.current) !== d.start) commit(latest.current);
	};

	return (
		<div id={id} role="group" aria-label={field.label} className="w-full max-w-md overflow-hidden rounded-lg border border-input bg-transparent shadow-xs dark:bg-input/30">
			<ul ref={list} className="relative max-h-72 overflow-y-auto overscroll-contain p-1 empty:hidden">
				{items.map((item, i) => (
					<OptionRow
						key={item.id}
						item={item}
						colors={!!field.colors}
						reorder={!!field.reorder}
						dragging={dragging === item.id}
						nudged={nudged === item.id}
						onRename={(t) => rename(item.id, t)}
						onRemove={(focus) => remove(item.id, focus ? Math.min(i, items.length - 2) : undefined)}
						onRecolor={(c) => recolor(item.id, c)}
						onKey={(e, text) => {
							if (e.nativeEvent.isComposing) return;
							if (e.key === "Enter" && !e.metaKey) (e.preventDefault(), rename(item.id, text), focusRow(i + 1));
							else if (e.key === "ArrowUp" && e.altKey && field.reorder) (e.preventDefault(), rename(item.id, text), move(item.id, -1));
							else if (e.key === "ArrowDown" && e.altKey && field.reorder) (e.preventDefault(), rename(item.id, text), move(item.id, 1));
							else if (e.key === "ArrowUp" && !e.altKey && i > 0) (e.preventDefault(), focusRow(i - 1));
							else if (e.key === "ArrowDown" && !e.altKey) (e.preventDefault(), focusRow(i + 1));
							else if (e.key === "Backspace" && text === "") (e.preventDefault(), remove(item.id, Math.max(0, i - 1)));
						}}
						gripHandlers={{ onPointerDown: (e) => gripDown(e, item.id), onPointerMove: gripMove, onPointerUp: gripUp, onPointerCancel: gripUp }}
					/>
				))}
			</ul>
			<div className={cn("flex h-9 items-center gap-1.5 px-2", items.length > 0 && "border-t border-border/60")}>
				{field.reorder && <span aria-hidden className="w-3.5 shrink-0" />}
				<Plus aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", field.colors && "mx-[0.3125rem]")} />
				<input
					ref={adder}
					value={draft}
					aria-label={field.placeholder ?? `Add to ${field.label}`}
					placeholder={field.placeholder ?? "Add…"}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => draft.trim() && add(draft)}
					onPaste={(e) => {
						const pasted = e.clipboardData.getData("text");
						if (!/[\r\n\t]/.test(pasted)) return;
						e.preventDefault();
						add(draft + pasted);
					}}
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing) return;
						if (e.key === "Enter" && !e.metaKey && draft.trim()) (e.preventDefault(), add(draft));
						else if (e.key === "ArrowUp" && items.length) (e.preventDefault(), focusRow(items.length - 1));
					}}
					className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
				/>
				<kbd aria-hidden className={cn("pointer-events-none shrink-0 rounded border px-1 font-sans text-[0.6875rem] text-muted-foreground transition-opacity duration-150", draft.trim() ? "opacity-100" : "opacity-0")}>↵</kbd>
			</div>
		</div>
	);
}

type GripHandlers = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;

function OptionRow({
	item,
	colors,
	reorder,
	dragging,
	nudged,
	onRename,
	onRemove,
	onRecolor,
	onKey,
	gripHandlers,
}: {
	item: Item;
	colors: boolean;
	reorder: boolean;
	dragging: boolean;
	nudged: boolean;
	onRename: (text: string) => boolean;
	onRemove: (focusNeighbour: boolean) => void;
	onRecolor: (c: Hue) => void;
	onKey: (e: React.KeyboardEvent<HTMLInputElement>, text: string) => void;
	gripHandlers: GripHandlers;
}) {
	const [text, setText] = useState(item.text);
	useEffect(() => setText(item.text), [item.text]);
	const [picking, setPicking] = useState(false);
	const used = item.count !== undefined;
	return (
		<li
			data-option-row={item.id}
			className={cn(
				"group/row relative flex h-8 items-center gap-1.5 rounded-md px-1 transition-colors duration-150 focus-within:bg-accent/60 hover:bg-accent/50",
				dragging && "z-10 bg-accent shadow-sm",
				nudged && "bg-accent ring-1 ring-ring/60",
			)}
		>
			{reorder && (
				<span
					{...gripHandlers}
					aria-hidden
					title="Drag to move (⌥↑ ⌥↓)"
					className={cn("flex h-6 w-3.5 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-60 group-hover/row:opacity-60 hover:!opacity-100", dragging && "cursor-grabbing opacity-100")}
				>
					<GripVertical className="size-3.5" />
				</span>
			)}
			{colors && (
				<Popover open={picking} onOpenChange={setPicking}>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={`Color of ${item.text}${item.color ? `: ${item.color}` : ""}`}
							className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none transition-transform duration-150 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
						>
							<span className={cn("size-3 rounded-full", item.color ? dotClass(item.color) : "border border-dashed border-muted-foreground/60")} />
						</button>
					</PopoverTrigger>
					<PopoverContent align="start" className="w-auto p-2.5" onClick={(e) => (e.target as HTMLElement).closest("[data-hue]") && setPicking(false)}>
						<div className="w-[13.75rem]">
							<ColorField id={`${item.id}-color`} field={{ type: "color", id: "color", label: `Color of ${item.text}`, value: item.color ?? "blue" }} onChange={onRecolor} />
						</div>
					</PopoverContent>
				</Popover>
			)}
			<input
				data-option-text
				value={text}
				aria-label={item.text}
				onChange={(e) => setText(e.target.value)}
				onBlur={() => onRename(text) || setText(item.text)}
				onKeyDown={(e) => onKey(e, text)}
				className="h-7 min-w-0 flex-1 truncate rounded-sm bg-transparent px-1 text-sm outline-none"
			/>
			{used && (
				<span title={`Used ${item.count} ${item.count === 1 ? "time" : "times"}`} className={cn("shrink-0 px-1 text-xs tabular-nums text-muted-foreground", item.count === 0 && "opacity-50")}>
					{item.count}
				</span>
			)}
			<button
				type="button"
				aria-label={`Remove ${item.text}`}
				onClick={(e) => onRemove(e.detail === 0)}
				className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
			>
				<X className="size-3.5" />
			</button>
		</li>
	);
}
