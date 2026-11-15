// The `timeline` node (capability `ui.timeline`): dated Markdown notes down a rail, such as a
// task's status updates. Keyboard: ↑/↓ (or J/K) move between entries, Home/End to the ends,
// ↵ runs the entry's first action, an action's own key runs it, ⌫/Delete runs its destructive
// action (after its confirmation). Focus is roving: Tab enters on the selected entry. With `edit`
// (capability `ui.composer`), that action edits the entry's text in place: ⌘↵ or leaving saves,
// Esc cancels.
import { useContext, useEffect, useRef, useState } from "react";
import type { Action, Node, TimelineEntry } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, Markdown, When, useConfirm, type Emit } from "./Render";
import { MarkdownBox, PaneRow } from "./compose";
import { actionForEvent, formatKey } from "./pure";

type TimelineNode = Extract<Node, { type: "timeline" }>;

/** "Nov 14, 2026, 9:30 AM": the moment in full; the year is left out when it's this year's. */
const stamp = (at: number) => {
	const d = new Date(at);
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleString(undefined, { month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }), hour: "numeric", minute: "2-digit" });
};

/** The entry's actions; editing in place comes first (↵, double-click). */
const entryActions = (node: TimelineNode, e: TimelineEntry): Action[] => {
	const all = [...(node.edit ? [node.edit] : []), ...(node.actions ?? [])];
	return e.actions ? all.filter((a) => a === node.edit || e.actions!.includes(a.id)) : all;
};

export function Timeline({ node, emit }: { node: TimelineNode; emit: Emit }) {
	const { run, dialog } = useConfirm(emit);
	const inPane = useContext(PaneRow) !== undefined;
	const list = useRef<HTMLOListElement>(null);
	const ids = node.entries.map((e) => e.id);
	const [active, setActive] = useState<string | undefined>(node.selected ?? ids[0]);
	const current = active && ids.includes(active) ? active : (node.selected ?? ids[0]);
	// The plugin's selection wins when it changes (an entry being edited), and comes into view.
	useEffect(() => {
		if (!node.selected) return;
		setActive(node.selected);
		list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(node.selected)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [node.selected]);

	const [editing, setEditing] = useState<string | null>(null);
	const runOn = (a: Action, e: TimelineEntry) => (a === node.edit ? (setActive(e.id), setEditing(e.id)) : run(a, undefined, { timeline: node.id, entryId: e.id }));
	const focusEntry = (id: string) => {
		setActive(id);
		list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`)?.focus();
	};
	/** Leave the editor: send the text when it changed (`null`: cancelled). */
	const finishEdit = (e: TimelineEntry, text: string | null, refocus: boolean) => {
		if (editing !== e.id) return;
		setEditing(null);
		if (text !== null && text.trim() && text !== e.text && node.edit) emit(node.edit.id, { timeline: node.id, entryId: e.id, text: text.trim() });
		if (refocus) setTimeout(() => focusEntry(e.id));
	};

	if (!node.entries.length) {
		const empty = node.empty ?? { title: "Nothing here yet" };
		// In a drawer, one quiet line instead of a big empty state.
		if (inPane) return <p className="px-1 text-xs text-muted-foreground">{empty.description ?? empty.title}</p>;
		return <EmptyState title={empty.title} description={empty.description} icon={empty.icon ?? "history"} />;
	}
	return (
		<>
			<ol
				ref={list}
				aria-label="Timeline"
				className="relative flex flex-col"
				onKeyDown={(ev) => {
					if (ev.metaKey || ev.ctrlKey || ev.nativeEvent.isComposing) return;
					const target = ev.target as HTMLElement;
					// Keys belong to the entry itself, not to its buttons or links.
					const i = target.matches("[data-entry]") ? ids.indexOf(target.dataset.entry ?? "") : -1;
					if (i < 0) return;
					const entry = node.entries[i]!;
					const move = (to: number) => {
						ev.preventDefault();
						ev.stopPropagation();
						focusEntry(ids[Math.max(0, Math.min(ids.length - 1, to))]!);
					};
					if (!ev.altKey && !ev.shiftKey) {
						if (ev.key === "ArrowDown" || ev.key === "j") return move(i + 1);
						if (ev.key === "ArrowUp" || ev.key === "k") return move(i - 1);
						if (ev.key === "Home") return move(0);
						if (ev.key === "End") return move(ids.length - 1);
					}
					const acts = entryActions(node, entry).filter((a) => !a.disabled);
					let a: Action | undefined;
					if (ev.key === "Enter" && !ev.altKey && !ev.shiftKey) a = acts[0];
					else if (ev.key === "Backspace" || ev.key === "Delete") a = acts.find((x) => x.tone === "destructive");
					else a = actionForEvent(acts, ev);
					if (!a) return;
					ev.preventDefault();
					ev.stopPropagation();
					runOn(a, entry);
				}}
			>
				{node.entries.map((e, i) => {
					const acts = entryActions(node, e);
					const selected = e.id === node.selected;
					const edited = e.edited !== undefined && e.edited > e.at + 60_000;
					return (
						<li
							key={e.id}
							data-entry={e.id}
							tabIndex={e.id === current ? 0 : -1}
							aria-current={selected || undefined}
							aria-keyshortcuts={acts.map((a) => a.key).filter(Boolean).join(" ") || undefined}
							onFocus={(ev) => ev.target === ev.currentTarget && setActive(e.id)}
							onDoubleClick={(ev) => editing !== e.id && !(ev.target as HTMLElement).closest("a, button, [contenteditable]") && acts[0] && !acts[0].disabled && runOn(acts[0], e)}
							className={cn(
								"group/entry relative rounded-lg py-2.5 pr-2 pl-7 outline-none transition-colors duration-200 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50",
								selected && "bg-primary/5 ring-1 ring-primary/30",
							)}
						>
							{/* The rail and the entry's dot. */}
							<span aria-hidden className={cn("absolute top-0 bottom-0 left-[0.6875rem] w-px bg-border", i === 0 && "top-4", i === node.entries.length - 1 && "bottom-auto h-4")} />
							<span aria-hidden className={cn("absolute top-[0.9rem] left-2 size-2 rounded-full ring-4 ring-background", selected ? "bg-primary" : "bg-muted-foreground/50")} />
							<div className="flex min-h-6 items-center gap-2">
								<div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
									{e.author && <span className="font-medium text-foreground">{e.author}</span>}
									<time dateTime={new Date(e.at).toISOString()} className="tabular-nums">
										{stamp(e.at)}
									</time>
									<span aria-hidden>·</span>
									<When at={e.at} />
									{edited && (
										<span title={`Edited ${new Date(e.edited!).toLocaleString()}`}>
											· edited <When at={e.edited!} />
										</span>
									)}
								</div>
								{acts.length > 0 && (
									<div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover/entry:opacity-100 group-focus-within/entry:opacity-100">
										{acts.map((a) => (
											<Tooltip key={a.id}>
												<TooltipTrigger asChild>
													<Button
														type="button"
														variant="ghost"
														size="icon-xs"
														tabIndex={-1}
														disabled={a.disabled}
														aria-label={a.label}
														className={cn("text-muted-foreground hover:text-foreground", a.tone === "destructive" && "hover:text-destructive")}
														onClick={() => runOn(a, e)}
													>
														<Icon name={a.icon ?? "circle"} />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{a.label}
													{a.key ? ` (${formatKey(a.key)})` : a.tone === "destructive" ? " (⌫)" : ""}
												</TooltipContent>
											</Tooltip>
										))}
									</div>
								)}
							</div>
							{e.title && <div className="mt-0.5 text-sm font-medium">{e.title}</div>}
							{editing === e.id ? (
								<MarkdownBox
									value={e.text}
									label="Entry text"
									rows={3}
									autoFocus
									className="mt-1.5"
									onSubmit={(t) => finishEdit(e, t, true)}
									onCancel={() => finishEdit(e, null, true)}
									onBlur={(t) => finishEdit(e, t, false)}
								/>
							) : (
								<Markdown text={e.text} className="mt-1 space-y-2" />
							)}
						</li>
					);
				})}
			</ol>
			{dialog}
		</>
	);
}
