import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { Field } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyHint } from "@/components/key-hint";
import { cn } from "@/lib/utils";

/** How long "Saving…" waits for ToolBelt to say the secret is stored before typing is possible again. */
const SAVING_MS = 5000;

/**
 * A `text` field with `secret` (capability `secrets`): what's typed goes to ToolBelt, which keeps
 * it in the Keychain; the tree only says whether it's `stored`. Saved, it reads "Saved in
 * Keychain" with Replace and Remove. The value is never shown, and never comes back.
 */
export function SecretField({ id, field, onChange, className }: { id: string; field: Extract<Field, { type: "text" }>; onChange: (v: string | null) => void; className?: string }) {
	const stored = field.stored === true;
	const [replacing, setReplacing] = useState(false);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const removeButton = useRef<HTMLButtonElement>(null);
	// ToolBelt said where the secret stands: stop waiting, start over.
	useEffect(() => {
		setSaving(false);
		setReplacing(false);
		setDraft("");
	}, [stored]);
	useEffect(() => {
		if (!saving) return;
		const timer = setTimeout(() => setSaving(false), SAVING_MS);
		return () => clearTimeout(timer);
	}, [saving]);
	const editing = !stored || replacing;
	const commit = () => {
		if (!draft) return;
		// A replaced secret stays stored, so nothing would say it's done: show it saved at once
		// (ToolBelt reports a failure). A new one waits until ToolBelt says it's stored.
		if (replacing) setReplacing(false);
		else setSaving(true);
		onChange(draft);
		setDraft("");
	};
	const cancel = () => {
		setDraft("");
		setReplacing(false);
	};

	if (!editing)
		return (
			// As wide as it needs (it may wrap in a narrow form), not the text box's fixed width.
			<div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 animate-in fade-in-0 duration-200">
				<span id={id} className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
					<KeyRound aria-hidden className="size-3.5 shrink-0" />
					<span className="truncate">Saved in Keychain</span>
				</span>
				<span className="flex shrink-0 items-center gap-1">
					<Button
						variant="outline"
						size="sm"
						aria-label={`Replace ${field.label || "secret"}`}
						onClick={() => {
							setReplacing(true);
							requestAnimationFrame(() => input.current?.focus());
						}}
					>
						Replace
					</Button>
					<Button variant="ghost" size="sm" aria-label={`Remove ${field.label || "secret"}`} onClick={() => setConfirming(true)}>
						Remove
					</Button>
				</span>
				<Dialog open={confirming} onOpenChange={setConfirming}>
					<DialogContent
						className="sm:max-w-sm"
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							removeButton.current?.focus();
						}}
					>
						<DialogHeader>
							<DialogTitle>Remove {field.label || "secret"}?</DialogTitle>
							<DialogDescription>ToolBelt deletes it from the Keychain. You can't get it back here; you'd type it again.</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" aria-keyshortcuts="Escape" onClick={() => setConfirming(false)}>
								Cancel
								<KeyHint keys="esc" />
							</Button>
							<Button
								ref={removeButton}
								variant="destructive"
								aria-keyshortcuts="Enter"
								onClick={() => {
									setConfirming(false);
									setSaving(true);
									onChange(null);
								}}
							>
								Remove
								<KeyHint keys="↵" />
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
		);

	return (
		<div className={cn("flex min-w-0 items-center gap-2", replacing && "animate-in fade-in-0 duration-200", className)}>
			<Input
				ref={input}
				id={id}
				type="password"
				autoComplete="off"
				spellCheck={false}
				className="min-w-0 flex-1"
				value={draft}
				disabled={saving}
				aria-label={field.label || undefined}
				placeholder={saving ? "Saving to Keychain…" : replacing ? "New value" : (field.placeholder ?? "Not set")}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter") commit();
					if (e.key === "Escape" && replacing) (e.preventDefault(), e.stopPropagation(), cancel());
				}}
			/>
			{replacing && (
				// Pressing it mustn't blur the input first (that would save what's typed).
				<Button variant="ghost" size="sm" className="shrink-0" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
					Cancel
				</Button>
			)}
		</div>
	);
}
