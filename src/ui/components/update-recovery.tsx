import { useEffect, useState } from "react";
import { Clock3, CircleCheck, TriangleAlert } from "lucide-react";
import { visibleGitHubFailure, isRateLimit, type GitHubFailure } from "../../shared/github";
import { cn } from "../lib/utils";

/** Renderer clock keeps recovery text and disabled controls current without extra RPC. */
export function useRecoveryClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
export function elapsedTime(ms: number) {
  if (ms < 60000) return "just now";
  const minutes = Math.floor(ms / 60000);
  const count = minutes >= 1440 ? Math.floor(minutes / 1440) : minutes >= 60 ? Math.floor(minutes / 60) : minutes;
  const unit = minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute";
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
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
export function UpdateRecovery({ failure, failures = [], checkedAt }: { failure: GitHubFailure; failures?: GitHubFailure[]; checkedAt?: number | null }) {
  const now = useRecoveryClock();
  const unique = [...new Map([failure, ...failures].filter(item => visibleGitHubFailure(item, now)).map(item => [JSON.stringify(item), item])).values()];
  if (!unique.length) return null;
  const ready = unique.every(item => expired(item, now));
  const waiting = unique.some(item => isRateLimit(item) && (item.retryAt ?? 0) > now);
  const Icon = ready ? CircleCheck : waiting ? Clock3 : TriangleAlert;
  return <div role="status" className={cn("flex w-full min-w-0 gap-3 rounded-xl border p-4", ready ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200" : waiting ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200" : "border-destructive/30 bg-destructive/10 text-destructive")}>
    <Icon className="mt-0.5 size-4 shrink-0"/>
    <div className="min-w-0 flex-1 space-y-2">
      <h4 className="text-sm font-semibold">{ready ? "Ready to check again" : waiting ? "Update checks are paused" : "Your last update check couldn’t finish"}</h4>
      {unique.map((item, index) => <div key={index} className="space-y-1.5 text-xs leading-relaxed">
        {expired(item, now) ? <>
          <p>Your earlier check failed because {item.kind === "quota" ? "GitHub’s request quota was exhausted" : item.kind === "throttled" ? "GitHub temporarily throttled requests" : "GitHub asked ToolBelt to wait before retrying"}.</p>
          <p>{item.retrySource === "backoff" ? "ToolBelt’s precautionary wait ended" : "The retry window opened"} {elapsedTime(now - item.retryAt!)}. {item.retrySource === "backoff" ? "GitHub didn’t supply a reset time. " : item.retrySource ? "The rate limit should have lifted. " : ""}Try checking again to confirm the latest releases.</p>
        </> : <>
          <p>{item.message}</p>
          {isRateLimit(item) && item.retryAt ? <p className="font-medium tabular-nums">{recoveryTiming(item.retryAt, now)}</p> : <p>Please try again later.</p>}
        </>}
        {isRateLimit(item) && !expired(item, now) && <p className="opacity-80">{item.retrySource === "backoff" ? "GitHub didn’t supply a usable retry time. ToolBelt is using a precautionary backoff." : item.retrySource === "retry-after" ? "Retry time supplied by GitHub’s Retry-After header." : item.retrySource === "quota-reset" ? "Retry time supplied by GitHub’s quota reset header." : "The retry-time source wasn’t recorded for this earlier response."}</p>}
        {item.at && <p className="opacity-80">{item.status ? "GitHub response received" : "Check failed"} <time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time> · {elapsedTime(now - item.at)}</p>}
        {(item.detail || item.status) && <details className="pt-0.5"><summary className="cursor-pointer opacity-80">{expired(item, now) ? "Earlier GitHub response" : "GitHub response"}{item.status ? ` · HTTP ${item.status}` : ""}</summary><div className="mt-2 space-y-1.5 break-words [overflow-wrap:anywhere]">
          <p>{item.detail ?? item.message}</p>
          {item.rateLimit?.remaining !== undefined && <p>Quota remaining: {item.rateLimit.remaining}{item.rateLimit.limit !== undefined ? ` of ${item.rateLimit.limit}` : ""}{item.rateLimit.used !== undefined ? ` · Used: ${item.rateLimit.used}` : ""}{item.rateLimit.resource ? ` · Resource: ${item.rateLimit.resource}` : ""}</p>}
          {item.serverAt && <p>GitHub server time: {new Date(item.serverAt).toLocaleString()}</p>}
          {item.requestId && <p>Request ID: <span className="font-mono">{item.requestId}</span></p>}
        </div></details>}
      </div>)}
      {checkedAt && <p className="text-xs opacity-80">Last successful check: {new Date(checkedAt).toLocaleString()}. Previously found releases may have changed.</p>}
    </div>
  </div>;
}
