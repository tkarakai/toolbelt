import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, LockKeyhole, LockKeyholeOpen, Plus, Trash2 } from "lucide-react";
import type { EnvironmentEntry } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/** Names that look like they hold a secret: such variables start out secret. */
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i;

/**
 * Keeps edits local while the plugin receives the full draft, including unsaved blank rows.
 * With `keychain` (the field's `secretPrefix`), secret values go to ToolBelt's Keychain instead:
 * they're typed in a masked box that saves on ↵ or leaving it, never shown again, and a saved
 * variable's name is fixed (remove it and add it again to rename it).
 */
export function EnvironmentEditor({ value, onChange, keychain = false }: { value: EnvironmentEntry[]; onChange: (v: EnvironmentEntry[]) => void; keychain?: boolean }) {
    const [rows, setRows] = useState(value);
    const [visible, setVisible] = useState<Set<number>>(new Set());
    const sent = useRef(JSON.stringify(value));
    useEffect(() => {
        const next = JSON.stringify(value);
        if (next !== sent.current) { setRows(value); sent.current = next; }
    }, [value]);
    const commit = (next: EnvironmentEntry[]) => { sent.current = JSON.stringify(next); setRows(next); onChange(next); };
    const patch = (i: number, next: Partial<EnvironmentEntry>) => commit(rows.map((r, n) => n === i ? { ...r, ...next } : r));
    const columns = "grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_64px]";
    return <div className="min-w-0 space-y-3">
        <div className="overflow-hidden rounded-lg border">
            <div className={cn("grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground", columns)}>
                <span /><span>Variable</span><span>Value</span><span className="sr-only">Actions</span>
            </div>
            {rows.length === 0 && <p className="px-3 py-5 text-sm text-muted-foreground">No environment overrides. Add a variable to save it with this command.</p>}
            {rows.map((row, i) => {
                const kept = keychain && row.secret;
                const stored = kept && row.stored === true;
                return <div key={i} className={cn("grid items-center gap-2 border-b px-3 py-2 last:border-0 animate-in fade-in-0 duration-200", columns)}>
                    <Checkbox aria-label={`Include variable ${i + 1}`} checked={row.selected} onCheckedChange={v => patch(i, { selected: v === true })} />
                    <Input aria-label={`Variable ${i + 1} name`} className="min-w-0 font-mono text-xs" placeholder="NAME" value={row.key} readOnly={stored} title={stored ? "Saved in Keychain: remove it to rename it" : undefined}
                        onChange={e => patch(i, { key: e.target.value, ...(stored ? {} : { secret: SECRET_KEY.test(e.target.value) || (keychain && row.secret) }) })} />
                    {kept
                        ? <KeychainValue index={i} name={row.key} stored={stored} onSave={(v) => patch(i, { value: v })} />
                        : <Input aria-label={`Variable ${i + 1} value`} className="min-w-0 font-mono text-xs" type={row.secret && !visible.has(i) ? "password" : "text"} placeholder="value" value={row.value} onChange={e => patch(i, { value: e.target.value })} />}
                    <div className="flex">
                        {keychain
                            ? <Button variant="ghost" size="icon-sm" aria-label={row.secret ? "Keep in plain settings instead of the Keychain" : "Keep the value in the Keychain"} title={stored ? "Saved in Keychain" : row.secret ? "Kept in the Keychain" : "Kept in plain settings"} aria-pressed={row.secret} disabled={stored} className={row.secret ? undefined : "text-muted-foreground"}
                                onClick={() => patch(i, { secret: !row.secret })}>{row.secret ? <LockKeyhole /> : <LockKeyholeOpen />}</Button>
                            : <Button variant="ghost" size="icon-sm" aria-label={visible.has(i) ? "Hide value" : "Show value"} disabled={!row.secret} onClick={() => setVisible(v => { const next = new Set(v); next.has(i) ? next.delete(i) : next.add(i); return next; })}>{visible.has(i) ? <EyeOff /> : <Eye />}</Button>}
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove variable ${i + 1}`} onClick={() => { setVisible(new Set()); commit(rows.filter((_, n) => n !== i)); }}><Trash2 /></Button>
                    </div>
                </div>;
            })}
        </div>
        <Button variant="outline" size="sm" onClick={() => commit([...rows, { key: "", value: "", selected: true, secret: false }])}><Plus />Add variable</Button>
    </div>;
}

/** A Keychain-kept variable's value: "Saved in Keychain" with Replace, or a masked box that saves on ↵ or leaving it. */
function KeychainValue({ index, name, stored, onSave }: { index: number; name: string; stored: boolean; onSave: (value: string) => void }) {
    const [draft, setDraft] = useState("");
    const [replacing, setReplacing] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => { setReplacing(false); setDraft(""); }, [stored]);
    const save = () => {
        if (!draft) return;
        onSave(draft);
        setDraft("");
        setReplacing(false);
    };
    if (stored && !replacing)
        return <div className="flex min-w-0 items-center gap-1 animate-in fade-in-0 duration-200">
            <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">Saved in Keychain</span>
            </span>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" aria-label={`Replace the value of ${name || `variable ${index + 1}`}`}
                onClick={() => { setReplacing(true); requestAnimationFrame(() => input.current?.focus()); }}>Replace</Button>
        </div>;
    return <Input ref={input} aria-label={`Variable ${index + 1} value`} className="min-w-0 font-mono text-xs" type="password" autoComplete="off" spellCheck={false}
        disabled={!name} placeholder={!name ? "Name it first" : replacing ? "New value" : "Value for the Keychain"} value={draft}
        onChange={e => setDraft(e.target.value)} onBlur={() => { save(); if (!draft) setReplacing(false); }}
        onKeyDown={e => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") save();
            if (e.key === "Escape" && replacing) { e.preventDefault(); e.stopPropagation(); setDraft(""); setReplacing(false); }
        }} />;
}
