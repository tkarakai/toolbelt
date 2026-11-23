// Form fields beyond one-line text, switches and selects (capability `ui.rich-fields`):
// several lines with optional live Markdown styling, a local date with an optional time, a
// theme color, a searchable choice and key/value pills. Typing stays here; the plugin hears
// committed values (blur, ⌘↵, a pick).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { HUES, type Field, type Hue, type TagKey, type TagValue } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { dotClass, pillClass, shadeStyle } from "./colors";

type Of<T extends Field["type"]> = Extract<Field, { type: T }>;

/** Fields drawn under their label, across the form's width. */
export const WIDE_FIELDS = new Set<Field["type"]>(["environment", "textarea", "tags", "color"]);

// ── several lines ───────────────────────────────────────────────────────

export function TextAreaField({ id, field, onChange }: { id: string; field: Of<"textarea">; onChange: (v: string) => void }) {
	if (field.markdown) return <MarkdownEditor id={id} field={field} onChange={onChange} />;
	return <PlainTextArea id={id} field={field} onChange={onChange} />;
}

function PlainTextArea({ id, field, onChange }: { id: string; field: Of<"textarea">; onChange: (v: string) => void }) {
	const [v, setV] = useState(field.value);
	useEffect(() => setV(field.value), [field.value]);
	const commit = () => v !== field.value && onChange(v);
	return (
		<Textarea
			id={id}
			value={v}
			placeholder={field.placeholder}
			style={{ minHeight: `${(field.rows ?? 4) * 1.5 + 1}rem` }}
			onChange={(e) => setV(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => e.key === "Enter" && e.metaKey && commit()}
		/>
	);
}

/**
 * Markdown styled as it's typed: headings grow, emphasis and code look the part, and the
 * syntax characters stay visible but quiet. The text is the Markdown source, unchanged.
 */
export const markdownStyle = HighlightStyle.define([
	{ tag: t.heading1, fontSize: "1.45em", fontWeight: "700" },
	{ tag: t.heading2, fontSize: "1.25em", fontWeight: "700" },
	{ tag: t.heading3, fontSize: "1.1em", fontWeight: "650" },
	{ tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
	{ tag: t.strong, fontWeight: "700" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.strikethrough, textDecoration: "line-through" },
	{ tag: t.monospace, fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "0.9em", backgroundColor: "color-mix(in oklab, var(--muted) 80%, transparent)", borderRadius: "4px" },
	{ tag: t.link, color: "var(--color-sky-600, #0284c7)", textDecoration: "underline" },
	{ tag: t.url, color: "var(--muted-foreground)" },
	{ tag: t.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: "color-mix(in oklab, var(--muted-foreground) 75%, transparent)" },
	{ tag: t.list, color: "var(--muted-foreground)" },
]);
export const editorTheme = EditorView.theme({
	"&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "0.875rem" },
	"&.cm-focused": { outline: "none" },
	".cm-content": { fontFamily: "inherit", padding: "0.5rem 0", caretColor: "var(--foreground)", lineHeight: "1.55" },
	".cm-line": { padding: "0 0.625rem" },
	".cm-scroller": { fontFamily: "inherit" },
	".cm-placeholder": { color: "var(--muted-foreground)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--ring) 35%, transparent)" },
	".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

function MarkdownEditor({ id, field, onChange }: { id: string; field: Of<"textarea">; onChange: (v: string) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const latest = useRef({ value: field.value, onChange });
	latest.current = { value: field.value, onChange };
	useEffect(() => {
		const commit = () => {
			const text = view.current?.state.doc.toString() ?? "";
			if (text !== latest.current.value) latest.current.onChange(text);
		};
		view.current = new EditorView({
			parent: host.current!,
			state: EditorState.create({
				doc: field.value,
				extensions: [
					history(),
					// No Tab binding: Tab moves on to the next control, as everywhere else.
					keymap.of([{ key: "Mod-Enter", run: () => (commit(), true) }, ...defaultKeymap, ...historyKeymap]),
					markdown(),
					syntaxHighlighting(markdownStyle),
					editorTheme,
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ "aria-label": "Markdown", id }),
					EditorView.domEventHandlers({ blur: () => commit() }),
					...(field.placeholder ? [placeholderExt(field.placeholder)] : []),
				],
			}),
		});
		return () => view.current?.destroy();
		// The editor is created once; later values arrive through the effect below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// The plugin's value, when the person isn't editing.
	useEffect(() => {
		const v = view.current;
		if (!v || v.hasFocus || v.state.doc.toString() === field.value) return;
		v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: field.value } });
	}, [field.value]);
	return (
		<div
			ref={host}
			onClick={() => view.current?.focus()}
			style={{ minHeight: `${(field.rows ?? 6) * 1.55 + 1}rem` }}
			className="cursor-text rounded-lg border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
		/>
	);
}

// ── color ───────────────────────────────────────────────────────────────

export function ColorField({ id, field, onChange }: { id: string; field: Of<"color">; onChange: (v: Hue) => void }) {
	const group = useRef<HTMLDivElement>(null);
	const move = (by: number) => {
		const next = HUES[(HUES.indexOf(field.value) + by + HUES.length) % HUES.length]!;
		onChange(next);
		requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-hue="${next}"]`)?.focus());
	};
	return (
		<div
			ref={group}
			id={id}
			role="radiogroup"
			aria-label={field.label}
			className="flex flex-wrap gap-1.5"
			onKeyDown={(e) => {
				if (e.key === "ArrowRight" || e.key === "ArrowDown") (e.preventDefault(), move(1));
				if (e.key === "ArrowLeft" || e.key === "ArrowUp") (e.preventDefault(), move(-1));
			}}
		>
			{HUES.map((hue) => {
				const on = hue === field.value;
				return (
					<button
						key={hue}
						type="button"
						role="radio"
						aria-checked={on}
						aria-label={hue}
						title={hue}
						data-hue={hue}
						tabIndex={on ? 0 : -1}
						onClick={() => !on && onChange(hue)}
						className={cn("flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring", dotClass(hue), on && "ring-2 ring-foreground")}
					>
						{on && <Check className="size-3.5 text-white drop-shadow" />}
					</button>
				);
			})}
		</div>
	);
}

// ── searchable choice ───────────────────────────────────────────────────

/** A list to pick from, with "Use …" for typed text when any text is allowed. */
function Picker({ options, value, freeform, placeholder, onPick }: { options: { value: string; label: string; sub?: string; swatch?: CSSProperties }[]; value: string; freeform: boolean; placeholder: string; onPick: (v: string) => void }) {
	const [query, setQuery] = useState("");
	const typed = query.trim();
	const exact = options.some((o) => o.value === typed || o.label.toLowerCase() === typed.toLowerCase());
	return (
		<Command>
			<CommandInput autoFocus placeholder={placeholder} value={query} onValueChange={setQuery} />
			<CommandList>
				<CommandEmpty>{freeform ? "Type to use any value" : "No matches"}</CommandEmpty>
				{freeform && typed && !exact && (
					<CommandGroup>
						<CommandItem value={`\u0001use ${typed}`} onSelect={() => onPick(typed)}>
							<Plus className="size-3.5" /> Use “{typed}”
						</CommandItem>
					</CommandGroup>
				)}
				{options.length > 0 && (
					<CommandGroup>
						{options.map((o) => (
							<CommandItem key={o.value} value={`${o.label} ${o.sub ?? ""} \u0002${o.value}`} onSelect={() => onPick(o.value)}>
								<Check className={cn("size-3.5", o.value === value ? "opacity-100" : "opacity-0")} />
								{o.swatch ? (
									// A shaded value: shown as the pill it will be.
									<span style={o.swatch} className="min-w-0 truncate rounded px-1.5 py-0.5 text-xs font-medium">{o.label}</span>
								) : null}
								<span className={cn("min-w-0 flex-1 truncate", o.swatch && "sr-only")}>{o.label}</span>
								{o.sub && <span className="truncate text-xs text-muted-foreground">{o.sub}</span>}
							</CommandItem>
						))}
					</CommandGroup>
				)}
			</CommandList>
		</Command>
	);
}

export function ComboboxField({ id, field, onChange, className }: { id: string; field: Of<"combobox">; onChange: (v: string) => void; className?: string }) {
	const [open, setOpen] = useState(false);
	const current = field.options.find((o) => o.value === field.value);
	const shown = current?.label ?? field.value;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={field.label} className={cn("w-64 justify-between font-normal", className)}>
					<span className={cn("truncate", !shown && "text-muted-foreground")}>{shown || field.placeholder || "Choose…"}</span>
					<ChevronsUpDown className="opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="end">
				<Picker
					options={field.options}
					value={field.value}
					freeform={!!field.freeform}
					placeholder="Search…"
					onPick={(v) => {
						setOpen(false);
						if (v !== field.value) onChange(v);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

// ── key/value pills ─────────────────────────────────────────────────────

const anyText = (k: TagKey) => !!k.freeform || !k.values?.length;
/** A key's values as picker options, each shown as its shaded pill when the key has shades. */
const valueOptions = (k: TagKey) => (k.values ?? []).map((v) => ({ value: v, label: v, swatch: shadeStyle(k.color, k.shades?.[v]) }));

export function TagsField({ id, field, onChange }: { id: string; field: Of<"tags">; onChange: (v: TagValue[]) => void }) {
	const [tags, setTags] = useState(field.value);
	useEffect(() => setTags(field.value), [JSON.stringify(field.value)]);
	const commit = (next: TagValue[]) => (setTags(next), onChange(next));
	const keyOf = (key: string) => field.keys.find((k) => k.key === key);
	const set = (key: string, value?: string) => {
		const k = keyOf(key)!;
		const entry: TagValue = k.flag ? { key } : { key, value: value ?? "" };
		const i = tags.findIndex((x) => x.key === key);
		commit(i < 0 ? [...tags, entry] : tags.map((x, n) => (n === i ? entry : x)));
	};
	const unused = field.keys.filter((k) => !tags.some((x) => x.key === k.key));
	return (
		<div id={id} role="group" aria-label={field.label} className="flex flex-wrap items-center gap-1.5">
			{tags.map((tag) => {
				const k = keyOf(tag.key);
				if (!k) return null;
				return <TagPillEditor key={tag.key} k={k} tag={tag} onSet={(v) => set(tag.key, v)} onRemove={() => commit(tags.filter((x) => x.key !== tag.key))} />;
			})}
			{unused.length > 0 && <AddTag keys={unused} onAdd={set} />}
			{!tags.length && !unused.length && <span className="text-sm text-muted-foreground">No keys to add</span>}
		</div>
	);
}

function TagPillEditor({ k, tag, onSet, onRemove }: { k: TagKey; tag: TagValue; onSet: (v: string) => void; onRemove: () => void }) {
	const [open, setOpen] = useState(false);
	const text = k.flag ? k.label : `${k.label}: ${tag.value ?? ""}`;
	const shaded = tag.value === undefined ? undefined : shadeStyle(k.color, k.shades?.[tag.value]);
	return (
		<span style={shaded} className={cn("inline-flex h-7 items-center overflow-hidden rounded-md text-xs font-medium", !shaded && pillClass(k.color ?? "default"))}>
			{k.flag ? (
				<span className="pl-2">{text}</span>
			) : (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<button type="button" aria-label={`Change ${k.label}`} className="h-full rounded-l-md pl-2 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
							{text}
						</button>
					</PopoverTrigger>
					<PopoverContent className="w-64 p-0" align="start">
						<Picker options={valueOptions(k)} value={tag.value ?? ""} freeform={anyText(k)} placeholder={`${k.label}…`} onPick={(v) => (setOpen(false), onSet(v))} />
					</PopoverContent>
				</Popover>
			)}
			<button type="button" aria-label={`Remove ${k.label}`} onClick={onRemove} className="flex h-full items-center rounded-r-md px-1.5 opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
				<X className="size-3" />
			</button>
		</span>
	);
}

function AddTag({ keys, onAdd }: { keys: TagKey[]; onAdd: (key: string, value?: string) => void }) {
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState<TagKey | null>(null);
	return (
		<Popover open={open} onOpenChange={(o) => (setOpen(o), !o && setKey(null))}>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" size="sm" className="h-7 gap-1 border-dashed text-xs">
					<Plus className="size-3.5" /> Add
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-0" align="start">
				{key ? (
					<Picker options={valueOptions(key)} value="" freeform={anyText(key)} placeholder={`${key.label}…`} onPick={(v) => (setOpen(false), setKey(null), onAdd(key.key, v))} />
				) : (
					<Command>
						<CommandInput placeholder="Add…" />
						<CommandList>
							<CommandEmpty>No matches</CommandEmpty>
							<CommandGroup>
								{keys.map((k) => (
									<CommandItem key={k.key} value={`${k.label} \u0002${k.key}`} onSelect={() => (k.flag ? (setOpen(false), onAdd(k.key)) : setKey(k))}>
										<span className={cn("size-2 rounded-full", dotClass(k.color ?? "default"))} />
										{k.label}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}
