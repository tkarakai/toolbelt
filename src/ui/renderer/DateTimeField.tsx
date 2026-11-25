// The `datetime` field (capability `ui.rich-fields`): a button that reads the value in words
// ("Fri, Nov 20 · 2:30 PM", "in 5 days") or the placeholder when there is none, and a popover
// to change it. In the popover people can type ("fri 5pm", "+3d", "nov 20"), pick a preset,
// walk a month with the keyboard, and type or pick a time. Every pick is sent at once.
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, CornerDownLeft, X } from "lucide-react";
import type { Field } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { KeyHint } from "@/components/key-hint";
import { defaultPresets, formatTime, formatValue, isoDate, join, monthGrid, moveFocus, parseInput, parseTime, relativeDay, sameMonth, split, toDate, weekStart, type Parts } from "./datetime";

type DateTime = Extract<Field, { type: "datetime" }>;

/** Times offered under the time box. */
const QUICK_TIMES = ["09:00", "12:00", "17:00"];

/** `past`: typed dates that could go either way ("fri", "nov 20") are the latest past ones, for
 *  picking a moment that happened rather than a due date. */
export function DateTimeField({ id, field, onChange, past = false }: { id: string; field: DateTime; onChange: (v: string) => void; past?: boolean }) {
	const withTime = field.time !== false;
	const [open, setOpen] = useState(false);
	// A key typed on the closed button starts the typed date with it.
	const [seed, setSeed] = useState("");
	const today = isoDate(new Date());
	const parts = split(field.value);
	const send = (p: Parts | null) => {
		const next = join(p, withTime);
		if (next !== field.value) onChange(next);
	};
	const shown = parts ? formatValue(parts, today) : null;
	const rel = parts ? relativeDay(parts.date, today) : null;
	return (
		<div className="flex w-full max-w-sm items-center gap-1">
			<Popover open={open} onOpenChange={(o) => (setOpen(o), !o && setSeed(""))}>
				<PopoverTrigger asChild>
					<Button
						id={id}
						type="button"
						variant="outline"
						role="combobox"
						aria-haspopup="dialog"
						aria-expanded={open}
						aria-label={`${field.label}: ${shown ?? field.placeholder ?? "none"}`}
						className="min-w-0 flex-1 justify-start gap-2 font-normal"
						onKeyDown={(e) => {
							if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
							if ((e.key === "Backspace" || e.key === "Delete") && field.value) {
								e.preventDefault();
								send(null);
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								setOpen(true);
							} else if (e.key.length === 1 && e.key !== " ") {
								e.preventDefault();
								setSeed(e.key);
								setOpen(true);
							}
						}}
					>
						<CalendarDays className="text-muted-foreground" />
						{shown ? <span className="truncate tabular-nums">{shown}</span> : <span className="truncate text-muted-foreground">{field.placeholder ?? "No date"}</span>}
						{rel && <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{rel}</span>}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
					<DatePanel
						field={field}
						parts={parts}
						today={today}
						withTime={withTime}
						seed={seed}
						past={past}
						onPick={(p, close) => {
							send(p);
							if (close) setOpen(false);
						}}
						onClose={() => setOpen(false)}
					/>
				</PopoverContent>
			</Popover>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={`Clear ${field.label}`}
				title="Clear (⌫)"
				tabIndex={-1}
				onClick={() => send(null)}
				className={cn("text-muted-foreground transition-opacity duration-200", !field.value && "pointer-events-none opacity-0")}
			>
				<X />
			</Button>
		</div>
	);
}

function DatePanel({ field, parts, today, withTime, seed, past, onPick, onClose }: { field: DateTime; parts: Parts | null; today: string; withTime: boolean; seed: string; past: boolean; onPick: (p: Parts | null, close: boolean) => void; onClose: () => void }) {
	const [text, setText] = useState(seed);
	const typed = text.trim() ? parseInput(text, today, past) : null;
	const reading = typed && !withTime ? { date: typed.date } : typed;
	const [focus, setFocus] = useState(parts?.date ?? today);
	const start = useMemo(() => weekStart(), []);
	const grid = useMemo(() => monthGrid(focus, start), [focus.slice(0, 7), start]);
	const gridRef = useRef<HTMLDivElement>(null);
	const timeRef = useRef<HTMLInputElement>(null);
	const [timeText, setTimeText] = useState(parts?.time ? formatTime(parts.time) : "");
	const [timeError, setTimeError] = useState(false);
	useEffect(() => setTimeText(parts?.time ? formatTime(parts.time) : ""), [parts?.time]);
	// Keyboard moves in the grid carry focus with them.
	const moved = useRef(false);
	useEffect(() => {
		if (!moved.current) return;
		moved.current = false;
		gridRef.current?.querySelector<HTMLElement>(`[data-date="${focus}"]`)?.focus();
	}, [focus]);
	const focusGrid = (date = focus) => {
		moved.current = true;
		if (date === focus) gridRef.current?.querySelector<HTMLElement>(`[data-date="${focus}"]`)?.focus();
		else setFocus(date);
	};

	/** A day from the grid or a date-only preset keeps the time already chosen. */
	const pickDay = (date: string, close: boolean) => {
		setFocus(date);
		onPick({ date, ...(parts?.time && { time: parts.time }) }, close);
	};
	const afterDay = (date: string) => {
		// With a time to choose, the time box is next; otherwise the choice is made.
		pickDay(date, !withTime);
		if (withTime) setTimeout(() => timeRef.current?.select(), 0);
	};
	/** Commits the time box. Empty removes the time; unreadable keeps the old value. */
	const commitTime = (close: boolean) => {
		const raw = timeText.trim();
		if (!raw) {
			setTimeError(false);
			if (parts?.time) onPick({ date: parts.date }, close);
			else if (close) onClose();
			return true;
		}
		const time = parseTime(raw);
		if (!time) {
			setTimeError(true);
			return false;
		}
		setTimeError(false);
		setTimeText(formatTime(time));
		onPick({ date: parts?.date ?? today, time }, close);
		return true;
	};
	const stepTime = (by: number) => {
		const base = parseTime(timeText) ?? parts?.time ?? "09:00";
		const [h, m] = base.split(":").map(Number);
		const total = (((h! * 60 + m!) + by) % 1440 + 1440) % 1440;
		const next = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
		setTimeText(formatTime(next));
		setTimeError(false);
		onPick({ date: parts?.date ?? today, time: next }, false);
	};

	const presets = field.presets ?? defaultPresets(today);
	const weekdays = grid.slice(0, 7).map((d) => toDate(d).toLocaleDateString(undefined, { weekday: "narrow" }));
	const weekdayNames = grid.slice(0, 7).map((d) => toDate(d).toLocaleDateString(undefined, { weekday: "long" }));
	const monthLabel = toDate(focus).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	const shiftMonth = (by: number) => setFocus(moveFocus(focus, by < 0 ? "PageUp" : "PageDown", false, start)!);

	return (
		<div className="flex w-[30rem] max-w-full flex-col">
			{/* Typing */}
			<div className="border-b p-2">
				<Input
					autoFocus
					value={text}
					aria-label={`Type ${field.label}`}
					placeholder={withTime ? "Type a date: fri 5pm, +3d, nov 20…" : "Type a date: fri, +3d, nov 20…"}
					onChange={(e) => setText(e.target.value)}
					onFocus={(e) => {
						// The seeded key was typed already: keep the caret after it.
						const el = e.currentTarget;
						setTimeout(() => el.setSelectionRange(el.value.length, el.value.length), 0);
					}}
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing) return;
						if (e.key === "Enter" && !e.metaKey) {
							e.preventDefault();
							if (reading) {
								setFocus(reading.date);
								onPick(reading, true);
							}
						} else if (e.key === "ArrowDown") {
							e.preventDefault();
							focusGrid(reading?.date ?? focus);
						}
					}}
					className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div aria-live="polite" className="flex h-5 items-center gap-1.5 px-2.5 text-xs text-muted-foreground">
					{text.trim() ? (
						reading ? (
							<>
								<span className="font-medium text-foreground">{formatValue(reading, today)}</span>
								{relativeDay(reading.date, today) && <span>· {relativeDay(reading.date, today)}</span>}
								<KeyHint keys="↵" className="ml-auto" />
							</>
						) : text.trim().length < 3 ? (
							<span>Keep typing: fri, +3d, nov 20…</span>
						) : (
							<span className="text-destructive">Can't read that date</span>
						)
					) : (
						<span>↓ to pick from the calendar</span>
					)}
				</div>
			</div>

			<div className="flex min-h-0">
				{/* Presets */}
				<div role="group" aria-label="Quick picks" className="flex w-40 shrink-0 flex-col gap-0.5 border-r p-1.5">
					{presets.map((p) => {
						const pp = split(p.value);
						if (!pp) return null;
						const hasTime = !!pp.time && withTime;
						const on = !!parts && parts.date === pp.date && (!hasTime || parts.time === pp.time);
						return (
							<button
								key={p.label}
								type="button"
								onClick={() => (hasTime ? (setFocus(pp.date), onPick(pp, true)) : pickDay(pp.date, true))}
								className={cn("flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring", on && "font-medium")}
							>
								<span className="truncate">{p.label}</span>
								<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
									{toDate(pp.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
									{hasTime && ` ${formatTime(pp.time!)}`}
								</span>
							</button>
						);
					})}
				</div>

				{/* Month */}
				<div className="flex-1 p-2">
					<div className="mb-1 flex items-center justify-between">
						<Button type="button" variant="ghost" size="icon-xs" tabIndex={-1} aria-label="Previous month" title="Previous month (Page Up)" onClick={() => shiftMonth(-1)}>
							<ChevronLeft />
						</Button>
						<div className="text-sm font-medium" aria-live="polite">
							{monthLabel}
						</div>
						<Button type="button" variant="ghost" size="icon-xs" tabIndex={-1} aria-label="Next month" title="Next month (Page Down)" onClick={() => shiftMonth(1)}>
							<ChevronRight />
						</Button>
					</div>
					<div
						ref={gridRef}
						role="grid"
						aria-label={monthLabel}
						onKeyDown={(e) => {
							if (e.metaKey || e.ctrlKey || e.altKey) return;
							if (e.key === "t" || e.key === "T") return (e.preventDefault(), focusGrid(today));
							const next = moveFocus(focus, e.key, e.shiftKey, start);
							if (!next) return;
							e.preventDefault();
							focusGrid(next);
						}}
					>
						<div role="row" className="grid grid-cols-7">
							{weekdays.map((w, i) => (
								<div key={i} role="columnheader" aria-label={weekdayNames[i]} className="py-1 text-center text-[11px] text-muted-foreground">
									{w}
								</div>
							))}
						</div>
						{[0, 1, 2, 3, 4, 5].map((week) => (
							<div key={week} role="row" className="grid grid-cols-7">
								{grid.slice(week * 7, week * 7 + 7).map((date) => {
									const selected = parts?.date === date;
									const outside = !sameMonth(date, focus);
									return (
										<button
											key={date}
											type="button"
											role="gridcell"
											data-date={date}
											aria-selected={selected}
											aria-current={date === today ? "date" : undefined}
											aria-label={toDate(date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
											tabIndex={date === focus ? 0 : -1}
											onClick={() => afterDay(date)}
											onDoubleClick={() => pickDay(date, true)}
											onFocus={() => date !== focus && setFocus(date)}
											className={cn(
												"relative mx-auto flex size-8 items-center justify-center rounded-md text-sm tabular-nums outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
												outside && "text-muted-foreground/60",
												date === today && !selected && "font-semibold text-primary after:absolute after:bottom-1 after:h-0.5 after:w-3 after:rounded-full after:bg-current",
												selected && "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
											)}
										>
											{Number(date.slice(8))}
										</button>
									);
								})}
							</div>
						))}
					</div>
				</div>
			</div>

			{/* Time and finishing */}
			<div className="flex flex-wrap items-center gap-1.5 border-t p-2">
				{withTime && (
					<>
						<Clock className="ml-1 size-4 text-muted-foreground" />
						<Input
							ref={timeRef}
							value={timeText}
							aria-label={`${field.label} time`}
							aria-invalid={timeError || undefined}
							placeholder="No time"
							title="Type 9:30, 2pm or 14:00. ↑/↓ change it by 15 minutes."
							className="h-7 w-24 tabular-nums"
							onChange={(e) => (setTimeText(e.target.value), setTimeError(false))}
							onBlur={() => commitTime(false)}
							onKeyDown={(e) => {
								if (e.nativeEvent.isComposing) return;
								if (e.key === "Enter" && !e.metaKey) {
									e.preventDefault();
									commitTime(true);
								} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
									e.preventDefault();
									stepTime(e.key === "ArrowUp" ? 15 : -15);
								}
							}}
						/>
						{QUICK_TIMES.map((t) => (
							<Button key={t} type="button" variant="ghost" size="xs" className="text-muted-foreground tabular-nums" onClick={() => (setTimeText(formatTime(t)), onPick({ date: parts?.date ?? today, time: t }, true))}>
								{formatTime(t)}
							</Button>
						))}
						{parts?.time && (
							<Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => (setTimeText(""), onPick({ date: parts.date }, false))}>
								No time
							</Button>
						)}
					</>
				)}
				{timeError && <span className="text-xs text-destructive">Try 9:30, 2pm or 14:00</span>}
				<div className="ml-auto flex items-center gap-1.5">
					<Button type="button" variant="ghost" size="sm" disabled={!parts} onClick={() => onPick(null, true)}>
						Clear
					</Button>
					<Button type="button" size="sm" onClick={() => (withTime && timeText.trim() !== (parts?.time ? formatTime(parts.time) : "") ? commitTime(true) : onClose())}>
						Done
						<CornerDownLeft className="opacity-60" />
					</Button>
				</div>
			</div>
		</div>
	);
}
