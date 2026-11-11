// The `conversation` node: an agent session the way a chat app shows it — the person's messages
// on the right, the agent's on the left (markdown), and tool calls as compact rows that open to
// show their details. Follows new messages unless the person scrolled up. ⌘+ / ⌘- zoom it.
import { useLayoutEffect, useRef, useState } from "react";
import { Bot, ChevronRight, User, Wrench } from "lucide-react";
import type { Message, Node } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { useZoomLevel, useZoomTarget, ZoomIndicator } from "@/lib/zoom";
import { Markdown } from "./Render";

type ConversationNode = Extract<Node, { type: "conversation" }>;

/** Consecutive tool calls are shown as one block. */
type Block = { kind: "message"; m: Message; i: number } | { kind: "tools"; items: { m: Message; i: number }[] };

function blocks(messages: Message[]): Block[] {
	const out: Block[] = [];
	messages.forEach((m, i) => {
		const last = out[out.length - 1];
		if (m.role === "tool") {
			if (last?.kind === "tools") last.items.push({ m, i });
			else out.push({ kind: "tools", items: [{ m, i }] });
		} else out.push({ kind: "message", m, i });
	});
	return out;
}

export function ConversationView({ node }: { node: ConversationNode }) {
	const box = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [zoom, applyZoom, zoomShownAt] = useZoomLevel("toolbelt.conversationZoom");
	useZoomTarget(applyZoom);
	useLayoutEffect(() => {
		const el = box.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [node.messages, zoom]);
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-muted/30">
			<div
				ref={box}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
				}}
				className="min-h-0 flex-1 overflow-auto px-4 py-4"
			>
				<div className="mx-auto flex max-w-3xl flex-col gap-4" style={{ zoom }}>
					{!node.messages.length && <p className="py-12 text-center text-sm text-muted-foreground">{node.empty ?? "No messages yet."}</p>}
					{blocks(node.messages).map((b) => (b.kind === "tools" ? <ToolCalls key={`t${b.items[0].i}`} items={b.items.map((x) => x.m)} /> : <Bubble key={`m${b.i}`} m={b.m} />))}
				</div>
			</div>
			<ZoomIndicator zoom={zoom} shownAt={zoomShownAt} className="absolute top-2 right-3 z-10" />
		</div>
	);
}

function Bubble({ m }: { m: Message }) {
	const mine = m.role === "user";
	if (m.role === "system")
		return <div className="self-center rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{m.text}</div>;
	return (
		<div className={cn("flex items-start gap-2.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200", mine && "flex-row-reverse")}>
			<div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border", mine ? "bg-background" : "bg-primary text-primary-foreground")}>
				{mine ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
			</div>
			<div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1", mine && "items-end")}>
				<div className="px-1 text-xs text-muted-foreground">
					{m.author ?? (mine ? "You" : "Agent")}
					{m.at !== undefined && <span className="ml-2 tabular-nums">{new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
				</div>
				<div className={cn("rounded-2xl px-3.5 py-2.5 shadow-xs", mine ? "rounded-tr-sm bg-primary text-primary-foreground [&_code]:bg-primary-foreground/15 [&_pre]:bg-primary-foreground/10" : "rounded-tl-sm border bg-card text-card-foreground")}>
					<Markdown text={m.text} />
				</div>
			</div>
		</div>
	);
}

function ToolCalls({ items }: { items: Message[] }) {
	const [open, setOpen] = useState(false);
	const names = [...new Set(items.map((m) => m.tool?.name ?? "tool"))];
	return (
		<div className="ml-9 max-w-[85%] self-start">
			<button
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
			>
				<ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
				<Wrench className="size-3.5" />
				{items.length === 1 ? (
					<span className="truncate font-mono">
						{items[0].tool?.name} <span className="opacity-70">{items[0].text}</span>
					</span>
				) : (
					<span>
						{items.length} tool calls · <span className="font-mono">{names.slice(0, 4).join(", ")}{names.length > 4 ? "…" : ""}</span>
					</span>
				)}
			</button>
			{open && (
				<div className="mt-1 space-y-1 border-l pl-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
					{items.map((m, i) => (
						<div key={i} className="font-mono text-xs">
							<span className="font-medium">{m.tool?.name}</span> <span className="break-all text-muted-foreground">{m.text}</span>
							{m.tool?.detail && <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted px-2 py-1 whitespace-pre-wrap">{m.tool.detail}</pre>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
