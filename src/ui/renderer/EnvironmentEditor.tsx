import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import type { EnvironmentEntry } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

/** Keeps edits local while the plugin receives the full draft, including unsaved blank rows. */
export function EnvironmentEditor({ value, onChange }: { value: EnvironmentEntry[]; onChange: (v: EnvironmentEntry[]) => void }) {
    const [rows, setRows] = useState(value);
    const [visible, setVisible] = useState<Set<number>>(new Set());
    const sent = useRef(JSON.stringify(value));
    useEffect(() => {
        const next = JSON.stringify(value);
        if (next !== sent.current) { setRows(value); sent.current = next; }
    }, [value]);
    const commit = (next: EnvironmentEntry[]) => { sent.current = JSON.stringify(next); setRows(next); onChange(next); };
    const patch = (i: number, next: Partial<EnvironmentEntry>) => commit(rows.map((r, n) => n === i ? { ...r, ...next } : r));
    return <div className="min-w-0 space-y-3">
        <div className="overflow-hidden rounded-lg border">
            <div className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_64px] items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span /><span>Variable</span><span>Value</span><span className="sr-only">Actions</span>
            </div>
            {rows.length === 0 && <p className="px-3 py-5 text-sm text-muted-foreground">No environment overrides. Add a variable to save it with this command.</p>}
            {rows.map((row, i) => <div key={i} className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_64px] items-center gap-2 border-b px-3 py-2 last:border-0 animate-in fade-in-0 duration-200">
                <Checkbox aria-label={`Include variable ${i + 1}`} checked={row.selected} onCheckedChange={v => patch(i, { selected: v === true })} />
                <Input aria-label={`Variable ${i + 1} name`} className="min-w-0 font-mono text-xs" placeholder="NAME" value={row.key} onChange={e => patch(i, { key: e.target.value, secret: /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i.test(e.target.value) })} />
                <Input aria-label={`Variable ${i + 1} value`} className="min-w-0 font-mono text-xs" type={row.secret && !visible.has(i) ? "password" : "text"} placeholder="value" value={row.value} onChange={e => patch(i, { value: e.target.value })} />
                <div className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label={visible.has(i) ? "Hide value" : "Show value"} disabled={!row.secret} onClick={() => setVisible(v => { const next = new Set(v); next.has(i) ? next.delete(i) : next.add(i); return next; })}>{visible.has(i) ? <EyeOff /> : <Eye />}</Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove variable ${i + 1}`} onClick={() => { setVisible(new Set()); commit(rows.filter((_, n) => n !== i)); }}><Trash2 /></Button>
                </div>
            </div>)}
        </div>
        <Button variant="outline" size="sm" onClick={() => commit([...rows, { key: "", value: "", selected: true, secret: false }])}><Plus />Add variable</Button>
    </div>;
}
