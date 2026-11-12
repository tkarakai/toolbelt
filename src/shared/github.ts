export type GitHubFailure = {
  kind: "quota" | "throttled" | "missing" | "network" | "service" | "access" | "invalid";
  message: string;
  at?: number;
  status?: number;
  detail?: string;
  retryAt?: number;
  retrySource?: "retry-after" | "quota-reset" | "backoff";
  rateLimit?: { limit?: number; remaining?: number; used?: number; resource?: string };
  requestId?: string;
  serverAt?: number;
};
export class GitHubError extends Error {
  constructor(readonly failure: GitHubFailure) {
    super(failure.message);
    failure.at ??= Date.now();
    this.name = "GitHubError";
  }
}

export const GITHUB_NOTICE_LIFETIME = 2 * 3600_000;
export const isRateLimit = (failure: GitHubFailure) => failure.kind === "quota" || failure.kind === "throttled";
export function visibleGitHubFailure(failure: GitHubFailure, now: number) {
  const since = isRateLimit(failure) ? failure.retryAt : failure.at;
  return typeof since === "number" && now < since + GITHUB_NOTICE_LIFETIME;
}
