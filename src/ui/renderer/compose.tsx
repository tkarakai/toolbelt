// Writing in place (capabilities `ui.composer` and `ui.row-pane`): a Markdown box that sends on
// ⌘↵ and cancels on Esc, the `composer` node built on it, and the inline Markdown field of a
// drawer's property sheet (formatted text that turns into an editor). Typing stays here; the
// plugin hears what was sent or committed.
import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import type { Field, Node } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/icon";
import { isTyping, useUIState } from "@/lib/uistate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyHint } from "@/components/key-hint";
import { editorTheme, markdownStyle } from "./fields";
import { Markdown, type Emit } from "./Render";

/** The row whose drawer pane holds what's rendered (its events carry it as `rowId`). */
export const PaneRow = createContext<string | undefined>(undefined);

export type MarkdownBoxHandle = { focus(): void; set(text: string): void; text(): string };

type BoxProps = {
	value: string;
	label: string;
	placeholder?: string;
	autoFocus?: boolean;
	/** The height it keeps while empty and unfocused, in lines. */
	rows?: number;
	/** ⌘↵. */
	onSubmit?: (text: string) => void;
	/** Esc. Without it, Esc is left to whatever holds the box. */
	onCancel?: () => void;
	onBlur?: (text: string) => void;
	onChange?: (text: string) => void;
	onFocus?: () => void;
	className?: string;
};

/** Markdown styled as it's typed (as in a Markdown `textarea`), with send and cancel keys. */
export const MarkdownBox = forwardRef<MarkdownBoxHandle, BoxProps>(function MarkdownBox(props, ref) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const latest = useRef(props);
	latest.current = props;
	useImperativeHandle(ref, () => ({
		focus: () => view.current?.focus(),
		set: (text) => view.current?.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: text } }),
		text: () => view.current?.state.doc.toString() ?? "",
	}));
	useEffect(() => {
		const text = () => view.current?.state.doc.toString() ?? "";
		view.current = new EditorView({
			parent: host.current!,
			state: EditorState.create({
				doc: props.value,
				extensions: [
					history(),
					// No Tab binding: Tab moves on to the next control, as everywhere else.
					keymap.of([
						{ key: "Mod-Enter", run: () => (latest.current.onSubmit?.(text()), !!latest.current.onSubmit) },
						{ key: "Escape", run: () => (latest.current.onCancel?.(), !!latest.current.onCancel) },
						...defaultKeymap,
						...historyKeymap,
					]),
					markdown(),
					syntaxHighlighting(markdownStyle),
					editorTheme,
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ "aria-label": props.label, "aria-multiline": "true" }),
					EditorView.updateListener.of((u) => u.docChanged && latest.current.onChange?.(text())),
					EditorView.domEventHandlers({ blur: () => latest.current.onBlur?.(text()), focus: () => latest.current.onFocus?.() }),
					...(props.placeholder ? [placeholderExt(props.placeholder)] : []),
				],
			}),
		});
		if (props.autoFocus) {
			view.current.focus();
			view.current.dispatch({ selection: { anchor: view.current.state.doc.length } });
		}
		return () => view.current?.destroy();
		// Created once; the owner sets new text through the handle.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div
			ref={host}
			onClick={() => view.current?.focus()}
			style={{ minHeight: `${(props.rows ?? 1) * 1.55 + 1}rem` }}
			className={cn("cursor-text rounded-lg border border-input bg-background transition-[border-color,box-shadow,min-height] duration-200 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30", props.className)}
		/>
	);
});

/**
 * Back to the list the box belongs to: from a drawer, the table beside it; in a quick view, its
 * list. The keyboard then carries on where it was.
 */
export function leaveToCollection(from: Element | null) {
	const drawer = from?.closest("[data-inspector]");
	const table = drawer?.parentElement?.querySelector<HTMLElement>("[data-table-focus]");
	if (table) return table.focus({ preventScroll: true });
	const scope = from?.closest("[data-quick-content]") ?? document;
	scope.querySelector<HTMLElement>("[data-navigation-collection]")?.focus({ preventScroll: true });
}

/** The `composer` node: write, send, and the box is empty and ready for the next one. */
export function Composer({ node, emit }: { node: Extract<Node, { type: "composer" }>; emit: Emit }) {
	const row = useContext(PaneRow);
	const [draft, setDraft] = useUIState(`composer:${node.id}:${row ?? ""}`, "");
	const [focused, setFocused] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const box = useRef<MarkdownBoxHandle>(null);
	const input = useRef<HTMLInputElement>(null);
	const send = (text: string) => {
		if (!text.trim() || node.action.disabled) return;
		emit(node.action.id, { composer: node.id, text: text.trim() });
		setDraft("");
		box.current?.set("");
	};
	// Its key focuses it while the keyboard is on this surface and nothing is being typed.
	useEffect(() => {
		if (!node.key) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== node.key || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || !root.current?.getClientRects().length) return;
			const pane = root.current.closest<HTMLElement>("[data-keyboard-pane]");
			if (pane && pane.dataset.keyboardActive !== "true") return;
			if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
			e.preventDefault();
			if (node.single) input.current?.focus();
			else box.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [node.key, node.single]);
	const hint = node.key ? <KeyHint keys={node.key.toUpperCase()} /> : null;
	if (node.single)
		return (
			<div ref={root} data-pane-id={node.id} className="relative">
				<Icon name={node.action.icon ?? "plus"} className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					ref={input}
					value={draft}
					aria-label={node.action.label}
					placeholder={node.placeholder ?? node.action.label}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing) return;
						if (e.key === "Enter") (e.preventDefault(), send(draft));
						else if (e.key === "Escape" || (e.key === "ArrowDown" && !e.shiftKey)) {
							e.preventDefault();
							e.stopPropagation();
							if (e.key === "Escape" && draft) setDraft("");
							else leaveToCollection(root.current);
						}
					}}
					className="h-8 pr-16 pl-8 text-sm"
				/>
				<span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">{focused ? (draft.trim() ? <KeyHint keys="↵" /> : null) : hint}</span>
			</div>
		);
	const open = focused || !!draft;
	return (
		<div ref={root} data-pane-id={node.id} className="space-y-1.5">
			<MarkdownBox
				ref={box}
				value={draft}
				label={node.action.label}
				placeholder={node.placeholder ?? node.action.label}
				rows={open ? 3 : 1}
				onChange={setDraft}
				onSubmit={send}
				onCancel={() => leaveToCollection(root.current)}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
			/>
			<div className={cn("flex items-center justify-end gap-2 overflow-hidden transition-[height,opacity] duration-200", open ? "h-7 opacity-100" : "h-0 opacity-0")}>
				<span className="mr-auto truncate text-xs text-muted-foreground">Markdown · Esc to leave</span>
				<Button size="xs" disabled={!draft.trim() || node.action.disabled} tabIndex={open ? 0 : -1} onMouseDown={(e) => e.preventDefault()} onClick={() => send(box.current?.text() ?? draft)}>
					{node.action.icon && <Icon name={node.action.icon} />}
					{node.action.label}
					<KeyHint keys="⌘↵" />
				</Button>
			</div>
		</div>
	);
}

/**
 * A Markdown `textarea` in an inline form: the formatted text, which becomes an editor on click,
 * ↵ or Space. Leaving it or ⌘↵ commits; Esc puts the text back.
 */
export function InlineMarkdown({ id, field, onChange }: { id: string; field: Extract<Field, { type: "textarea" }>; onChange: (v: string) => void }) {
	const [editing, setEditing] = useState(false);
	const preview = useRef<HTMLDivElement>(null);
	const done = useRef(false);
	const finish = (text: string | null, refocus: boolean) => {
		if (done.current) return;
		done.current = true;
		if (text !== null && text !== field.value) onChange(text);
		setEditing(false);
		if (refocus) setTimeout(() => preview.current?.focus({ preventScroll: true }));
	};
	if (editing)
		return (
			<MarkdownBox
				value={field.value}
				label={field.label || "Text"}
				placeholder={field.placeholder}
				rows={Math.min(field.rows ?? 4, 8)}
				autoFocus
				onSubmit={(t) => finish(t, true)}
				onCancel={() => finish(null, true)}
				onBlur={(t) => finish(t, false)}
				className="w-full"
			/>
		);
	return (
		<div
			ref={preview}
			id={id}
			role="button"
			tabIndex={0}
			aria-label={`Edit ${field.label || "text"}`}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest("a")) return;
				done.current = false;
				setEditing(true);
			}}
			onKeyDown={(e) => {
				if ((e.key === "Enter" || e.key === " ") && !e.metaKey && !e.altKey && !e.ctrlKey) {
					e.preventDefault();
					done.current = false;
					setEditing(true);
				}
			}}
			className="-mx-2 w-[calc(100%+1rem)] cursor-text rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
		>
			{field.value.trim() ? <Markdown text={field.value} className="space-y-2" /> : <span className="text-sm text-muted-foreground">{field.placeholder || "Add text…"}</span>}
		</div>
	);
}
