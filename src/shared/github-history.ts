/** One host HTTP call, retained for a rolling day. Missing headers stay unknown. */
export const GITHUB_HISTORY_AGE = 24 * 3600_000;
export type GitHubCall = {
  id: string;
  at: number;
  pid: number;
  url: string;
  trigger?: string;
  purpose: "metadata" | "download";
  conditional: boolean;
  authenticated: boolean;
  completedAt?: number;
  status?: number;
  networkError?: boolean;
  responseUrl?: string;
  headers: Record<string, string>;
};
export function recentGitHubCalls(calls: GitHubCall[], now: number) {
  return calls.filter(call => call.at > now - GITHUB_HISTORY_AGE && call.at <= now);
}
export function quotaNumber(call: GitHubCall, name: string) {
  const raw = call.headers[`x-ratelimit-${name}`];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
/** Compare observations, not an attribution claim. Requests may overlap or change IP. */
export function quotaComparison(call: GitHubCall, calls: GitHubCall[]) {
  const observedAt = call.completedAt;
  const used = quotaNumber(call, "used");
  if (observedAt === undefined || used === undefined || !call.headers["x-ratelimit-reset"] || !call.headers["x-ratelimit-resource"]) return null;
  const sameBucket = (other: GitHubCall) => new URL(other.url).origin === new URL(call.url).origin &&
    other.authenticated === call.authenticated && other.headers["x-ratelimit-resource"] === call.headers["x-ratelimit-resource"] &&
    other.headers["x-ratelimit-reset"] === call.headers["x-ratelimit-reset"] && other.headers["x-ratelimit-limit"] === call.headers["x-ratelimit-limit"];
  const previous = calls.filter(other => other.id !== call.id && other.completedAt !== undefined && other.completedAt < observedAt && quotaNumber(other,"used") !== undefined && sameBucket(other))
    .sort((a,b) => b.completedAt! - a.completedAt!)[0];
  if (!previous) return null;
  const appCalls = calls.filter(other => other.id !== previous.id && new URL(other.url).origin === new URL(call.url).origin && other.authenticated === call.authenticated &&
    other.at >= previous.completedAt! && other.at <= observedAt).length;
  return { delta: used - quotaNumber(previous,"used")!, appCalls };
}
