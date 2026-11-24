// The `duration` field (capability `ui.duration-field`): a length of time in whole minutes,
// edited in place as days, hours and minutes, like a native time field. Each part is a
// spinbutton: ↑/↓ step it (carrying into the next part), digits type it, ←/→ move between
// parts, ⌫ clears it, ↵ sends and Esc puts the value back. Parts that are zero stay quiet, so
// "3d 0h 0m" reads as 3d and "0d 4h 30m" as 4h 30m. A menu offers the plugin's presets and,
// with `none`, a value of none ("Never"). The plugin hears the minutes (or null) on leaving
// the field, ↵ or a pick.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Field } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { clampMinutes, DURATION_PARTS, durationWords, joinMinutes, splitMinutes, stepMinutes, type DurationUnit } from "./pure";

type Duration = Extract<Field, { type: "duration" }>;

export function DurationField({ id, field, onChange, fill }: { id: string; field: Duration; onChange: (v: number | null) => void; fill?: boolean }) {
	const min = field.min ?? 0;
	const max = field.max ?? Infinity;
	// The value being edited; typed digits for the focused part wait in `typed`.
	const [value, setValue] = useState<number | null>(field.value);
	const [typed, setTyped] = useState("");
	const [focus, setFocus] = useState<DurationUnit | null>(null);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => setValue(field.value), [field.value]);

	const send = (next: number | null) => {
		const v = next === null ? (field.none !== undefined ? null : field.value) : clampMinutes(next, min, max);
		setValue(v);
		if (v !== field.value) onChange(v);
	};
	/** The value with the focused part's typed digits in it. */
	const withTyped = (unit: DurationUnit | null = focus) => {
		if (value === null || !typed || !unit) return value;
		return joinMinutes({ ...splitMinutes(value), [unit]: Number(typed) });
	};
	const settle = () => {
		const v = withTyped();
		setTyped("");
		return v;
	};
	const focusPart = (unit: DurationUnit) => box.current?.querySelector<HTMLElement>(`[data-part="${unit}"]`)?.focus();

	const onKey = (unit: DurationUnit, e: KeyboardEvent<HTMLSpanElement>) => {
		const at = DURATION_PARTS.findIndex((p) => p.unit === unit);
		const part = DURATION_PARTS[at]!;
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault();
			const by = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
			setValue(stepMinutes(settle() ?? min, unit, by, min, max));
		} else if (/^\d$/.test(e.key)) {
			e.preventDefault();
			const digits = (typed + e.key).slice(-part.digits);
			setTyped(digits);
			if (value === null) setValue(min);
			// A part typed full moves on to the next one.
			if (digits.length === part.digits && at < DURATION_PARTS.length - 1) {
				setValue(joinMinutes({ ...splitMinutes(value ?? min), [unit]: Number(digits) }));
				setTyped("");
				focusPart(DURATION_PARTS[at + 1]!.unit);
			}
		} else if (e.key === "Backspace" || e.key === "Delete") {
			e.preventDefault();
			setTyped("");
			if (value !== null) setValue(joinMinutes({ ...splitMinutes(value), [unit]: 0 }));
		} else if (e.key === "ArrowLeft" && at > 0) {
			e.preventDefault();
			setValue(settle());
			focusPart(DURATION_PARTS[at - 1]!.unit);
		} else if (e.key === "ArrowRight" && at < DURATION_PARTS.length - 1) {
			e.preventDefault();
			setValue(settle());
			focusPart(DURATION_PARTS[at + 1]!.unit);
		} else if (e.key === "Enter") {
			e.preventDefault();
			send(settle());
		} else if (e.key === "Escape" && (typed || value !== field.value)) {
			// Esc puts it back; a second Esc is the dialog's or the drawer's.
			e.preventDefault();
			e.stopPropagation();
			setTyped("");
			setValue(field.value);
		}
	};

	const parts = value === null ? null : splitMinutes(withTyped() ?? 0);
	// Parts that are zero stay quiet; a value of 0 keeps its minutes legible.
	const empty = parts !== null && joinMinutes(parts) === 0;
	const presets = [...(field.none !== undefined && !field.presets?.some((p) => p.value === null) ? [{ label: field.none, value: null }] : []), ...(field.presets ?? [])];
	const label = (v: number | null, own?: string) => own ?? (v === null ? (field.none ?? "None") : durationWords(v));

	return (
		<div
			ref={box}
			id={id}
			role="group"
			aria-label={field.label}
			// Leaving the field (not moving between its parts or into its menu) sends it.
			onBlur={(e) => {
				if (!box.current?.contains(e.relatedTarget as Node | null)) {
					setFocus(null);
					send(settle());
				}
			}}
			className={cn(
				"flex h-8 items-center rounded-lg border border-input bg-transparent pl-1.5 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
				fill ? "w-full max-w-sm" : "w-48",
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-0.5 tabular-nums">
				{parts === null ? (
					// No value: its name, and ↑ or a digit starts one.
					<span
						tabIndex={0}
						role="spinbutton"
						aria-label={field.label}
						aria-valuetext={label(null)}
						onKeyDown={(e) => {
							if (e.key === "ArrowUp" || /^\d$/.test(e.key)) {
								e.preventDefault();
								setValue(field.presets?.find((p) => p.value !== null)?.value ?? Math.max(min, 60));
								requestAnimationFrame(() => focusPart(DURATION_PARTS[0]!.unit));
							}
						}}
						className="rounded px-1 text-muted-foreground outline-none focus-visible:bg-accent focus-visible:text-accent-foreground"
					>
						{label(null)}
					</span>
				) : (
					DURATION_PARTS.map((p, i) => {
						const on = focus === p.unit;
						const quiet = !on && parts[p.unit] === 0 && !(empty && i === DURATION_PARTS.length - 1);
						return (
							<span
								key={p.unit}
								data-part={p.unit}
								tabIndex={0}
								role="spinbutton"
								aria-label={p.name}
								aria-valuenow={parts[p.unit]}
								aria-valuetext={durationWords(joinMinutes(parts))}
								onFocus={() => (setFocus(p.unit), setTyped(""))}
								onKeyDown={(e) => onKey(p.unit, e)}
								className={cn(
									"flex cursor-default items-baseline rounded px-1 py-0.5 outline-none transition-colors duration-150 select-none",
									on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
									quiet && "text-muted-foreground/60",
								)}
							>
								<span className={cn("text-right font-medium", p.digits === 3 ? "min-w-[1.6ch]" : "min-w-[1.2ch]")}>{on && typed ? typed : parts[p.unit]}</span>
								<span className={cn("ml-px text-xs", on ? "text-accent-foreground/70" : "text-muted-foreground")}>{p.unit}</span>
							</span>
						);
					})
				)}
			</div>
			{presets.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label={`${field.label}: choose`}
						className="flex h-full shrink-0 items-center rounded-r-lg px-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
					>
						<ChevronDown className="size-3.5" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-44">
						{presets.map((p, i) => (
							<span key={i} className="contents">
								{i > 0 && p.value !== null && presets[i - 1]!.value === null && <DropdownMenuSeparator />}
								<DropdownMenuItem onSelect={() => (setTyped(""), send(p.value))} className="gap-2">
									<Check className={cn("size-3.5", p.value === field.value ? "opacity-100" : "opacity-0")} />
									<span className="flex-1">{label(p.value, p.label)}</span>
								</DropdownMenuItem>
							</span>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
