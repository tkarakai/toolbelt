import { elapsedTime } from "../lib/time";
import { useEffect, useState } from "react";
import { Clock3, CircleCheck, TriangleAlert } from "lucide-react";
import { visibleGitHubFailure, isRateLimit, type GitHubFailure } from "../../shared/github";
import { cn } from "../lib/utils";
import { GitHubQuotaHistory } from "./github-quota-history";
import { recentGitHubCalls, type GitHubCall } from "../../shared/github-history";
import { DiagnosticDisclosure } from "./diagnostic-disclosure";

/** Renderer clock keeps recovery text and disabled controls current without extra RPC. */
export function useRecoveryClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
export function recoveryTiming(retryAt: number, now: number) {
  const minutes = Math.max(1, Math.ceil((retryAt - now) / 60000));
  const duration = minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  const time = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = new Date(retryAt).toDateString() === new Date(now).toDateString() ? "" : `${new Date(retryAt).toLocaleDateString()}, `;
  return `Try again in ${duration}, at ${day}${time}`;
}
function expired(failure: GitHubFailure, now: number) {
  return isRateLimit(failure) && !!failure.retryAt && failure.retryAt <= now;
}
/** One section-wide notice; identical failures across plugins appear only once. */
export function UpdateRecovery({ failure, failures = [], checkedAt, history = [] }: { failure: GitHubFailure; failures?: GitHubFailure[]; checkedAt?: number | null; history?: GitHubCall[] }) {
  const now = useRecoveryClock();
  const unique = [...new Map([failure, ...failures].filter(item => visibleGitHubFailure(item, now)).map(item => [JSON.stringify(item), item])).values()];
  if (!unique.length) return null;
  const ready = unique.every(item => expired(item, now));
  const waiting = unique.some(item => isRateLimit(item) && (item.retryAt ?? 0) > now);
  const Icon = ready ? CircleCheck : waiting ? Clock3 : TriangleAlert;
  const retryAt = Math.max(...unique.filter(item => isRateLimit(item)).map(item => item.retryAt ?? 0));
  const lastCall = recentGitHubCalls(history, now).sort((a,b) => b.at-a.at)[0];
  const lastCallAt = lastCall ? lastCall.completedAt ?? lastCall.at : undefined;
  const lastCallSummary = lastCall && <>
    {(lastCall.status || lastCall.networkError) && <span className="shrink-0 rounded-md border bg-background/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{lastCall.status ? `HTTP ${lastCall.status}` : "Network error"}</span>}
    {lastCallAt !== undefined && <span className="text-[10px] tabular-nums text-muted-foreground"><time dateTime={new Date(lastCallAt).toISOString()} title={new Date(lastCallAt).toLocaleString()}>{new Date(lastCallAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",second:"2-digit"})}</time> · {elapsedTime(now-lastCallAt)}</span>}
  </>;
  return <DiagnosticDisclosure notice showAction={false} icon={<Icon className="size-4"/>}
    title={<span className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span role="heading" aria-level={4} className="text-sm font-semibold">{ready ? "Ready to check again" : waiting ? "Update checks are paused" : "Your last update check couldn’t finish"}</span>{waiting && <span className="text-xs font-normal tabular-nums">{recoveryTiming(retryAt, now)}</span>}</span>}
    className={cn("w-full rounded-xl", ready ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200" : waiting ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200" : "border-destructive/30 bg-destructive/10 text-destructive")}>
    <div className="min-w-0 space-y-3">
      {unique.map((item, index) => <div key={index} className="space-y-1.5 text-xs leading-relaxed">
        {expired(item, now) ? <>
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span>Your earlier check failed because {item.kind === "quota" ? "GitHub’s request quota was exhausted" : item.kind === "throttled" ? "GitHub temporarily throttled requests" : "GitHub asked ToolBelt to wait before retrying"}.</span>{index === 0 && lastCallSummary}</p>
          <p>{item.retrySource === "backoff" ? "ToolBelt’s precautionary wait ended" : "The retry window opened"} {elapsedTime(now - item.retryAt!)}. {item.retrySource === "backoff" ? "GitHub didn’t supply a reset time. " : item.retrySource ? "The rate limit should have lifted. " : ""}Try checking again to confirm the latest releases.</p>
        </> : <>
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span>{item.message}</span>{index === 0 && lastCallSummary}</p>
          {!isRateLimit(item) && <p>Please try again later.</p>}
        </>}
      </div>)}
      {checkedAt && <p className="text-xs leading-relaxed opacity-80">Last successful check: {new Date(checkedAt).toLocaleString()}. Previously found releases may have changed.</p>}
      <GitHubQuotaHistory calls={history} now={now}/>
    </div>
  </DiagnosticDisclosure>;
}
