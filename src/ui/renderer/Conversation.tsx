// The `conversation` node: an agent session the way a chat app shows it — the person's messages
// on the right, the agent's on the left (markdown), and tool calls as compact rows that open to
// show their details. Follows new messages unless the person scrolled up. ⌘+ / ⌘- zoom it.
// Message times are compact stamps ("Mon 14:03"); hovering or focusing one shows the full date.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FloatingSurface } from "./floating-context";
import { Bot, ChevronRight, User, Wrench } from "lucide-react";
import type { Message, Node } from "../../shared/protocol";
import { cn } from "@/lib/utils";
import { useZoomLevel, useZoomTarget, ZoomIndicator } from "@/lib/zoom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fullStamp, stamp, stampRefresh } from "../../shared/time";
import { showsStamp } from "./pure";
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
	// In a floating window the window is the frame: no border of its own, tighter spacing.
	const compact = useContext(FloatingSurface);
	// Where following last put the scroll: the scroll event that move fires later says nothing
	// about the person (the content may have grown since), so it doesn't unpin.
	const followedTo = useRef(-1);
	const follow = (el: HTMLElement) => {
		el.scrollTop = el.scrollHeight;
		followedTo.current = el.scrollTop;
	};
	useLayoutEffect(() => {
		const el = box.current;
		if (el && pinned.current) follow(el);
	}, [node.messages, zoom]);
	// Still following when the box or its content changes size (the window is resized, the
	// floating composer grows over the bottom, a tool call opens at the end).
	useEffect(() => {
		const el = box.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const watch = new ResizeObserver(() => pinned.current && follow(el));
		watch.observe(el);
		if (el.firstElementChild) watch.observe(el.firstElementChild);
		return () => watch.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", !compact && "rounded-md border bg-muted/30")}>
			<div
				ref={box}
				onScroll={(e) => {
					const el = e.currentTarget;
					if (Math.abs(el.scrollTop - followedTo.current) < 1) return void (followedTo.current = -1);
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
				}}
				// In a floating window the composer floats over the bottom (Floating.tsx sets its height).
				className={cn("min-h-0 flex-1 overflow-auto", compact ? "px-1 pt-1 pb-[calc(var(--floating-composer-height,0px)+0.75rem)] [scroll-padding-bottom:var(--floating-composer-height,0px)]" : "px-4 py-4")}
			>
				<div className={cn("mx-auto flex max-w-3xl flex-col", compact ? "gap-3" : "gap-4")} style={{ zoom }}>
					{!node.messages.length && <p className="py-12 text-center text-sm text-muted-foreground">{node.empty ?? "No messages yet."}</p>}
					{blocks(node.messages).map((b) => (b.kind === "tools" ? <ToolCalls key={`t${b.items[0].i}`} items={b.items.map((x) => x.m)} compact={compact} /> : compact ? <CompactBubble key={`m${b.i}`} m={b.m} stamped={showsStamp(node.messages, b.i)} /> : <Bubble key={`m${b.i}`} m={b.m} />))}
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
					{m.at !== undefined && <MessageTime at={m.at} className="ml-2" />}
				</div>
				<div className={cn("rounded-2xl px-3.5 py-2.5 shadow-xs", mine ? "rounded-tr-sm bg-primary text-primary-foreground [&_code]:bg-primary-foreground/15 [&_pre]:bg-primary-foreground/10" : "rounded-tl-sm border bg-card text-card-foreground")}>
					<Markdown text={m.text} />
				</div>
			</div>
		</div>
	);
}

/** A message's compact time; hovering or focusing it shows the full date and time. Redrawn at
 *  midnight, when "14:03" becomes "Thu 14:03". */
export function MessageTime({ at, className }: { at: number; className?: string }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setTimeout(() => tick((n) => n + 1), stampRefresh());
		return () => clearTimeout(t);
	});
	const full = fullStamp(at);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<time dateTime={new Date(at).toISOString()} tabIndex={0} aria-label={full} className={cn("rounded-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
					{stamp(at)}
				</time>
			</TooltipTrigger>
			<TooltipContent>{full}</TooltipContent>
		</Tooltip>
	);
}

/** A floating window's message: the person's in a quiet bubble on the right, the agent's as text.
 *  The first of a run from one side carries its time. */
function CompactBubble({ m, stamped }: { m: Message; stamped: boolean }) {
	if (m.role === "system")
		return <div className="self-center rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{m.text}</div>;
	const time = stamped && m.at !== undefined && <MessageTime at={m.at} className="text-[11px] text-muted-foreground" />;
	if (m.role === "user")
		return (
			<div className="flex max-w-[85%] flex-col items-end gap-1 self-end animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
				{time && <div className="px-1">{time}</div>}
				<div className="rounded-xl rounded-br-sm bg-muted px-3 py-1.5 text-[13px] [&_p]:my-0"><Markdown text={m.text} /></div>
			</div>
		);
	return (
		<div className="flex items-start gap-2 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
			<div className="mt-0.5 flex size-5.5 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
				<Bot className="size-3.5" />
			</div>
			<div className="min-w-0 flex-1">
				{time && <div className="mb-0.5 leading-none">{time}</div>}
				<div className="text-[13px] [&_p]:my-0 [&_p+p]:mt-1.5"><Markdown text={m.text} /></div>
			</div>
		</div>
	);
}

function ToolCalls({ items, compact }: { items: Message[]; compact?: boolean }) {
	const [open, setOpen] = useState(false);
	const names = [...new Set(items.map((m) => m.tool?.name ?? "tool"))];
	return (
		<div className={cn("max-w-[85%] self-start", compact ? "ml-7.5 max-w-[calc(100%-1.875rem)]" : "ml-9")}>
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
