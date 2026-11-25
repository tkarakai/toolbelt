// A time-range filter for a toolbar, drawn like the renderer's filter menus: a button ("Time ·
// Last 24 hours", "Time · Nov 20, 14:00 – Nov 21, 09:30") and a popover with quick ranges and a
// custom From–To range. The From and To pickers are the renderer's datetime field, so typing
// ("yesterday 9am", "nov 20") and the calendar work as in plugins. Changes apply at once.
import { useState } from "react";
import { ChevronDown, Clock, X } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";
import { ACTIVE_QUERY } from "@/renderer/Render";
import { DateTimeField } from "@/renderer/DateTimeField";
import { addDays, isoDate } from "@/renderer/datetime";
import { TIME_PRESETS, rangeBounds, rangeLabel, type TimeRange } from "@/lib/time-range";

export { rangeBounds, type TimeRange };

export function TimeRangeFilter({ value, onChange, label = "Time" }: { value: TimeRange; onChange: (range: TimeRange) => void; label?: string }) {
	const [open, setOpen] = useState(false);
	const custom = value && "from" in value ? value : { from: "", to: "" };
	// The custom range as typed, applied once it's a range (From before To).
	const [draft, setDraft] = useState(custom);
	const shown = rangeLabel(value);
	const today = isoDate(new Date());
	const presets = [
		{ label: "Today", value: today },
		{ label: "Yesterday", value: addDays(today, -1) },
		{ label: "A week ago", value: addDays(today, -7) },
		{ label: "A month ago", value: addDays(today, -30) },
	];
	const { since, until } = rangeBounds(draft);
	const invalid = since !== undefined && until !== undefined && since > until;
	const edit = (next: { from: string; to: string }) => {
		setDraft(next);
		const b = rangeBounds(next);
		if (b.since !== undefined && b.until !== undefined && b.since > b.until) return;
		onChange(next.from || next.to ? next : null);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (o) setDraft(custom);
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" data-view-control data-filtering={!!shown} className={cn("h-8 shrink-0 gap-1.5 transition-colors duration-200", shown && ACTIVE_QUERY)}>
					<Clock />
					{label}
					{shown && <span className="max-w-72 truncate font-normal text-muted-foreground">· {shown}</span>}
					<ChevronDown className="size-3.5 opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent data-view-control align="start" className="w-[34rem] max-w-[calc(100vw-2rem)] p-0">
				<div className="flex flex-col sm:flex-row">
					<div role="radiogroup" aria-label="Quick ranges" className="flex shrink-0 flex-col gap-0.5 border-b p-1.5 sm:w-44 sm:border-r sm:border-b-0">
						{[{ id: null, label: "Any time" }, ...TIME_PRESETS].map((p) => {
							const on = p.id === null ? !value : !!value && "preset" in value && value.preset === p.id;
							return (
								<button
									key={p.id ?? "any"}
									type="button"
									role="radio"
									aria-checked={on}
									onClick={() => {
										onChange(p.id === null ? null : { preset: p.id });
										setDraft({ from: "", to: "" });
										setOpen(false);
									}}
									className={cn(
										"rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-200 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
										on && "bg-selected text-selected-foreground hover:bg-selected",
									)}
								>
									{p.label}
								</button>
							);
						})}
					</div>
					<div className="min-w-0 flex-1 space-y-3 p-4">
						<div>
							<h3 className="text-sm font-medium">Custom range</h3>
							<p className="mt-0.5 text-xs text-muted-foreground">Type a date like “nov 20 9am”, “yesterday 14:00” or “3d ago”, or pick one. Leave an end open to go back to the beginning or up to now.</p>
						</div>
						<label className="block space-y-1.5">
							<span className="text-xs font-medium text-muted-foreground">From</span>
							<DateTimeField id="time-range-from" field={{ type: "datetime", id: "from", label: "From", value: draft.from, placeholder: "The beginning", presets }} onChange={(from) => edit({ ...draft, from })} past />
						</label>
						<label className="block space-y-1.5">
							<span className="text-xs font-medium text-muted-foreground">To</span>
							<DateTimeField id="time-range-to" field={{ type: "datetime", id: "to", label: "To", value: draft.to, placeholder: "Now", presets }} onChange={(to) => edit({ ...draft, to })} past />
						</label>
						{invalid && <p className="text-xs text-destructive">From is after To.</p>}
						{value && (
							<div className="flex justify-end pt-1">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										onChange(null);
										setDraft({ from: "", to: "" });
									}}
								>
									<X />
									Any time
								</Button>
							</div>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
