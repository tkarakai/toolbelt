import { ChevronDown, ArrowDownRight } from "lucide-react";
import { useId, useState } from "react";
import { quotaComparison, quotaNumber, recentGitHubCalls, GITHUB_HISTORY_AGE, type GitHubCall } from "../../shared/github-history";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { DisclosureContent, DisclosureIndicator } from "./diagnostic-disclosure";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const triggers: Record<string, string> = { manual:"Manual", startup:"App started", scheduled:"Scheduled", window:"Window opened", wake:"Wake from sleep", "plugin-resolve":"Release review" };
function endpoint(call: GitHubCall) {
  const url = new URL(call.url);
  return url.pathname.replace(/^\/repos\//, "").replace(/\/releases\/latest$/, " · latest").replace(/\/releases\/tags\//, " · tag ");
}
function QuotaChart({ calls, now }: { calls: GitHubCall[]; now: number }) {
  const samples = calls.filter(call => quotaNumber(call,"remaining") !== undefined && (quotaNumber(call,"limit") ?? 0) > 0);
  if (!samples.length) return null;
  return <div className="mt-4 rounded-lg border bg-background/70 px-3 py-2 text-foreground">
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground"><span>QUOTA REMAINING · % OF LIMIT</span><span>Each dot is a GitHub response</span></div>
    <svg viewBox="0 0 600 88" role="img" aria-label="Quota remaining at each response over the last 24 hours" className="h-24 w-full overflow-visible">
      {[0,50,100].map(percent => <g key={percent}><line x1="28" x2="590" y1={68-percent*.58} y2={68-percent*.58} stroke="currentColor" opacity=".12"/><text x="0" y={71-percent*.58} fill="currentColor" opacity=".65" fontSize="9">{percent}%</text></g>)}
      {samples.map(call => {
        const remaining = quotaNumber(call,"remaining")!;
        const percent = Math.max(0, Math.min(100, remaining / quotaNumber(call,"limit")! * 100));
        const x = 28 + Math.max(0,Math.min(1,((call.completedAt ?? call.at) - (now-GITHUB_HISTORY_AGE))/GITHUB_HISTORY_AGE))*562;
        return <circle key={call.id} cx={x} cy={68-percent*.58} r="3.5" fill="currentColor" className={remaining === 0 ? "text-destructive" : "text-primary"}><title>{time(call.completedAt ?? call.at)} · {remaining} of {quotaNumber(call,"limit")} remaining · {endpoint(call)}</title></circle>;
      })}
      <text x="28" y="85" fill="currentColor" opacity=".65" fontSize="9">24 hours ago</text><text x="590" y="85" textAnchor="end" fill="currentColor" opacity=".65" fontSize="9">Now</text>
    </svg>
  </div>;
}
function QuotaCell({ call }: { call: GitHubCall }) {
  const remaining = quotaNumber(call,"remaining"), limit = quotaNumber(call,"limit"), used = quotaNumber(call,"used"), reset = quotaNumber(call,"reset");
  return <div className="min-w-28 space-y-1">
    {remaining === undefined ? <span className="text-muted-foreground">Not reported</span> : <>
      <div className={cn("font-medium tabular-nums", remaining === 0 && "text-destructive")}><span className="text-base font-semibold">{remaining}</span><span className="text-muted-foreground">{limit !== undefined ? ` / ${limit}` : ""} left</span></div>
      {limit !== undefined && limit > 0 && <div className="h-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Quota remaining" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(remaining,limit)}><div className={cn("h-full rounded-full bg-primary",remaining === 0 && "bg-destructive")} style={{width:`${Math.min(100,remaining/limit*100)}%`}}/></div>}
    </>}
    <div className="text-[10px] text-muted-foreground">{used !== undefined ? `${used} used` : "Used count unknown"}{call.headers["x-ratelimit-resource"] ? ` · ${call.headers["x-ratelimit-resource"]}` : ""}</div>
    {reset !== undefined && Number.isFinite(new Date(reset*1000).getTime()) && <div className="text-[10px] text-muted-foreground" title={new Date(reset*1000).toLocaleString()}>Reset {time(reset*1000)}</div>}
  </div>;
}
function QuotaReset({ call }: { call: GitHubCall }) {
  const seconds = quotaNumber(call, "reset");
  const resetAt = seconds !== undefined && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds * 1000 : undefined;
  return <div><dt className="text-muted-foreground">x-ratelimit-reset</dt><dd className="font-mono">{call.headers["x-ratelimit-reset"] ?? "Not reported"}</dd>{resetAt !== undefined && <dd className="mt-0.5 tabular-nums"><time dateTime={new Date(resetAt).toISOString()}>{new Date(resetAt).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", second:"2-digit", timeZoneName:"short" })}</time></dd>}</div>;
}
function TimelineRequestRow({ call, calls }: { call: GitHubCall; calls: GitHubCall[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const comparison = quotaComparison(call, calls);
  return <>
    <TableRow className="align-top">
      <TableCell className="align-top"><time dateTime={new Date(call.at).toISOString()} className="font-medium tabular-nums">{time(call.at)}</time><div className="mt-1 text-[10px] text-muted-foreground">{new Date(call.at).toLocaleDateString([], {month:"short",day:"numeric"})}</div><span className={cn("mt-2 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium", (call.status ?? 0)>=400 || call.networkError ? "border-destructive/25 text-destructive" : "text-muted-foreground")}>{call.networkError ? "Network error" : call.status ? `HTTP ${call.status}` : "No response yet"}</span></TableCell>
      <TableCell className="max-w-64 whitespace-normal align-top"><div className="font-medium break-words [overflow-wrap:anywhere]">{endpoint(call)}</div><p className="mt-1 text-[10px] text-muted-foreground">{triggers[call.trigger ?? ""] ?? "Unknown trigger"} · {call.purpose === "metadata" ? "Release metadata" : "Asset download"}{call.conditional ? " · Conditional" : ""}</p>
        <Button type="button" variant="outline" size="xs" className="mt-2 gap-2 text-[10px]" id={`${id}-trigger`} aria-expanded={open} aria-controls={`${id}-content`} onClick={() => setOpen(!open)}>Request details<DisclosureIndicator open={open} compact/></Button>
      </TableCell>
      <TableCell className="align-top"><QuotaCell call={call}/></TableCell>
      <TableCell className="whitespace-normal align-top"><div className="min-w-32">{comparison ? <><p className="flex items-center gap-1 font-medium tabular-nums"><ArrowDownRight className="size-3 shrink-0"/>{comparison.delta>=0?"+":""}{comparison.delta} GitHub used</p><p className="mt-1 text-[10px] text-muted-foreground">{comparison.appCalls} ToolBelt call{comparison.appCalls===1?"":"s"} started between responses</p></> : <p className="text-[10px] text-muted-foreground">No earlier comparable response in this quota window</p>}</div></TableCell>
    </TableRow>
    <TableRow className={cn("hover:bg-transparent", !open && "border-0")}><TableCell colSpan={4} className="p-0 whitespace-normal">
      <DisclosureContent id={`${id}-content`} labelledBy={`${id}-trigger`} open={open}>
        <div className="@container min-w-0 bg-muted/25 p-4"><dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 text-[11px] [overflow-wrap:anywhere] @md:grid-cols-2 @2xl:grid-cols-3 [&>div]:min-w-0"><div className="col-span-full"><dt className="font-medium">GET</dt><dd className="font-mono text-muted-foreground">{call.url}</dd></div><div><dt className="text-muted-foreground">Process / authentication</dt><dd>{call.pid} · {call.authenticated ? "Authenticated" : "Unauthenticated"}</dd></div><div><dt className="text-muted-foreground">Response</dt><dd>{call.completedAt ? `${time(call.completedAt)} · ${call.completedAt-call.at} ms` : "No response recorded; the request may have been interrupted."}</dd></div>{call.responseUrl && call.responseUrl !== call.url && <div className="col-span-full"><dt className="text-muted-foreground">Final URL</dt><dd className="font-mono">{call.responseUrl}</dd></div>}<QuotaReset call={call}/>{Object.entries(call.headers).filter(([name]) => name !== "x-ratelimit-reset").map(([name,value])=><div key={name}><dt className="text-muted-foreground">{name}</dt><dd className="font-mono">{value}</dd></div>)}</dl></div>
      </DisclosureContent>
    </TableCell></TableRow>
  </>;
}
export function GitHubQuotaHistory({ calls, now }: { calls: GitHubCall[]; now: number }) {
  const [all, setAll] = useState(false);
  const recent = recentGitHubCalls(calls, now).sort((a,b)=>b.at-a.at);
  const rows = all ? recent : recent.slice(0,20);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const latest = [...recent].filter(call=>quotaNumber(call,"remaining") !== undefined).sort((a,b)=>(b.completedAt ?? b.at)-(a.completedAt ?? a.at))[0];
  const apiCalls = recent.filter(call=>new URL(call.url).hostname === "api.github.com").length;
  return <section aria-label="GitHub quota analysis" className="min-w-0 text-foreground">
    <div className="min-w-0"><Button type="button" variant="outline" size="sm" className="gap-3" id={`${id}-trigger`} aria-expanded={expanded} aria-controls={`${id}-content`} onClick={() => setExpanded(!expanded)}>Quota timeline<ChevronDown className={cn("size-3.5 transition-transform ease-out motion-reduce:transition-none", expanded ? "rotate-180 duration-200" : "duration-150")}/></Button></div>
    <DisclosureContent id={`${id}-content`} labelledBy={`${id}-trigger`} open={expanded}>
    <div className="min-w-0 pt-4">
    <div className="grid grid-cols-2 gap-4 rounded-lg border bg-background/70 p-3">
      <div><p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">ToolBelt calls</p><p className="mt-1 text-xl font-semibold tabular-nums">{recent.length}<span className="ml-2 text-[11px] font-normal text-muted-foreground">{apiCalls} to GitHub API</span></p></div>
      <div><p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Last reported remaining</p><p className="mt-1 text-xl font-semibold tabular-nums">{latest ? quotaNumber(latest,"remaining") : "—"}<span className="ml-2 text-[11px] font-normal text-muted-foreground">{latest ? `at ${time(latest.completedAt ?? latest.at)}` : "No quota response yet"}</span></p></div>
    </div>
    <QuotaChart calls={recent} now={now}/>
    {!recent.length ? <p className="mt-4 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">No calls recorded in the last 24 hours. History starts with this version; earlier checks cannot be reconstructed.</p> : <>
      <div className="mt-4 max-h-96 min-w-0 overflow-auto rounded-lg border bg-background/80">
        <Table className="text-xs"><TableHeader className="sticky top-0 z-10 bg-muted"><TableRow><TableHead>Time / result</TableHead><TableHead>ToolBelt request</TableHead><TableHead>GitHub quota</TableHead><TableHead>Since prior observation</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map(call => <TimelineRequestRow key={call.id} call={call} calls={recent}/>)}</TableBody>
        </Table>
      </div>
      {recent.length>20 && <Button variant="ghost" size="sm" className="mt-2 h-7 text-xs" onClick={()=>setAll(!all)}>{all ? "Show latest 20" : `Show all ${recent.length} calls`}</Button>}
    </>}
    <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">A larger rise in GitHub’s used count than ToolBelt’s calls can suggest other traffic sharing your quota. Compare within the same reset window; overlapping requests, network changes and GitHub routing can affect counts. Missing headers mean unknown usage.</p>
    <p className="mt-1 text-[10px] text-muted-foreground">Every host release lookup, asset download and redirect is recorded. Shared lookups and paused checks make no call. Older rows expire automatically. Plugin-owned traffic is outside this timeline.</p>
    </div>
    </DisclosureContent>
  </section>;
}
