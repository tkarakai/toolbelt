// The CodeMirror editors behind Markdown `textarea` fields and the Markdown box (composer,
// inline Markdown, asked-for text). CodeMirror is large and most surfaces never show an editor,
// so this module is its own chunk: fields.tsx and compose.tsx load it on first use.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import type { Field } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import type { BoxProps, MarkdownBoxHandle } from "./compose";

/**
 * Markdown styled as it's typed: headings grow, emphasis and code look the part, and the
 * syntax characters stay visible but quiet. The text is the Markdown source, unchanged.
 */
const markdownStyle = HighlightStyle.define([
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
const editorTheme = EditorView.theme({
	"&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "0.875rem" },
	"&.cm-focused": { outline: "none" },
	".cm-content": { fontFamily: "inherit", padding: "0.5rem 0", caretColor: "var(--foreground)", lineHeight: "1.55" },
	".cm-line": { padding: "0 0.625rem" },
	".cm-scroller": { fontFamily: "inherit" },
	".cm-placeholder": { color: "var(--muted-foreground)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--ring) 35%, transparent)" },
	".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

export function MarkdownEditor({ id, field, onChange }: { id: string; field: Extract<Field, { type: "textarea" }>; onChange: (v: string) => void }) {
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
