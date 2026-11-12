import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GitHubError, isRateLimit, visibleGitHubFailure, type GitHubFailure } from "../shared/github";
export { GitHubError } from "../shared/github";

type Entry = { data: unknown; etag?: string; url: string; checkedAt: number };
type Gate = { failure?: GitHubFailure; attempts: number };
/** Public release metadata only. Archive verification and publisher binding remain at callers. */
export class GitHubMetadata {
  private entries = new Map<string, Entry>();
  private gates = new Map<string, Gate>();
  private notices = new Map<string, GitHubFailure>();
  readonly listeners = new Set<() => void>();
  private pending = new Map<string, Promise<Entry>>();
  constructor(private options: { file?: string; fetch?: typeof fetch; now?: () => number } = {}) {
    try {
      const saved = JSON.parse(readFileSync(options.file!, "utf8"));
      if (saved.version === 1) {
        for (const [key, failure] of saved.notices ?? []) if (typeof key === "string" && Number.isFinite(failure.at)) this.notices.set(key, failure);
        for (const [key, entry] of saved.entries ?? []) {
          if (typeof key === "string" && typeof entry.url === "string" && Number.isFinite(entry.checkedAt)) this.entries.set(key, entry);
        }
        for (const [key, gate] of saved.gates ?? []) {
          if (typeof key === "string" && Number.isFinite(gate.attempts) && (!gate.failure || Number.isFinite(gate.failure.retryAt))) this.gates.set(key, gate);
        }
      }
    } catch {}
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private save() {
    if (!this.options.file) return;
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      const temporary = this.options.file + ".tmp";
      writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...this.entries].slice(-128), gates: [...this.gates], notices: [...this.notices] }));
      renameSync(temporary, this.options.file);
    } catch {}
  }
  cooldown(url: string): GitHubFailure | undefined {
    const failure = this.gates.get(new URL(url).origin)?.failure;
    return failure && isRateLimit(failure) && failure.retryAt && failure.retryAt > this.now() ? failure : undefined;
  }
  notice(url: string) {
    const failure = this.cooldown(url) ?? this.notices.get(new URL(url).origin);
    return failure && visibleGitHubFailure(failure, this.now()) ? failure : undefined;
  }
  private failed(url: string, failure: GitHubFailure): never {
    failure.at ??= this.now();
    this.notices.set(new URL(url).origin, failure);
    this.save();
    for (const listener of this.listeners) { try { listener(); } catch {} }
    throw new GitHubError(failure);
  }
  private succeeded(url: string) {
    if (!this.cooldown(url)) {
      this.gates.delete(new URL(url).origin);
      this.notices.delete(new URL(url).origin);
    }
    this.save();
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  async get(url: string, options: { headers?: HeadersInit; signal?: AbortSignal } = {}): Promise<Entry> {
    options.signal?.throwIfAborted();
    const blocked = this.cooldown(url);
    if (blocked) throw new GitHubError(blocked);
    let work = this.pending.get(url);
    if (!work) {
      work = this.request(url, options.headers).finally(() => this.pending.delete(url));
      this.pending.set(url, work);
    }
    // Cancellation belongs to a subscriber; it must not cancel another caller's lookup.
    if (!options.signal) return structuredClone(await work);
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work!.then(value => { if (!signal.aborted) resolve(structuredClone(value)); }, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private async request(url: string, supplied?: HeadersInit): Promise<Entry> {
    const origin = new URL(url).origin;
    const previous = this.entries.get(url);
    const headers = new Headers(supplied);
    headers.set("Accept", "application/vnd.github+json");
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, { headers, signal: AbortSignal.timeout(30000) });
    } catch {
      return this.failed(url, { kind: "network", message: "Couldn’t connect to GitHub. Check your connection and try again." });
    }
    const receivedAt = this.now();
    if (response.status === 304 && previous) {
      const entry = { ...previous, url: response.url || previous.url, checkedAt: this.now() };
      this.entries.set(url, entry);
      this.succeeded(url);
      return entry;
    }
    if (!response.ok) {
      let detail: string | undefined;
      try { const body = await response.json() as { message?: unknown }; if (typeof body.message === "string") detail = body.message.slice(0, 1000); } catch {}
      const limited = response.status === 403 || response.status === 429;
      const quota = limited && response.headers.get("x-ratelimit-remaining") === "0";
      const throttled = limited && (response.status === 429 || response.headers.has("retry-after") || /secondary|rate limit|abuse/i.test(detail ?? ""));
      const kind: GitHubFailure["kind"] = quota ? "quota" : throttled ? "throttled" : response.status === 404 ? "missing" : response.status >= 500 ? "service" : "access";
      const failure: GitHubFailure = {
        kind, status: response.status, detail, at: receivedAt,
        requestId: response.headers.get("x-github-request-id")?.slice(0, 200) || undefined,
        serverAt: Number.isFinite(Date.parse(response.headers.get("date") ?? "")) ? Date.parse(response.headers.get("date")!) : undefined,
        rateLimit: {
          limit: headerCount(response.headers, "x-ratelimit-limit"),
          remaining: headerCount(response.headers, "x-ratelimit-remaining"),
          used: headerCount(response.headers, "x-ratelimit-used"),
          resource: response.headers.get("x-ratelimit-resource")?.slice(0,100) || undefined,
        },
        message: kind === "quota" ? "GitHub’s request quota is exhausted." : kind === "throttled" ? "GitHub is temporarily slowing requests." : kind === "missing" ? "No public release was found. Check the repository, channel or tag; private repositories aren’t supported." : kind === "service" ? "GitHub’s release service is having trouble." : "GitHub refused the release request.",
      };
      if (quota || throttled) {
        const attempts = Math.min((this.gates.get(origin)?.attempts ?? 0) + 1, 6);
        const raw = response.headers.get("retry-after");
        const retry = raw === null ? NaN : /^\d+(\.\d+)?$/.test(raw.trim()) ? receivedAt + Number(raw) * 1000 : Date.parse(raw);
        const reset = quota ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : NaN;
        const explicit = [retry, reset].filter(time => Number.isFinite(time) && time > this.now());
        failure.retryAt = explicit.length ? Math.max(...explicit) : this.now() + Math.min(60_000 * 2 ** (attempts - 1), 30 * 60_000);
        failure.retrySource = !explicit.length ? "backoff" : retry >= (Number.isFinite(reset) ? reset : 0) && retry === failure.retryAt ? "retry-after" : "quota-reset";
        this.gates.set(origin, { failure, attempts });
        this.save();
      }
      return this.failed(url, failure);
    }
    let data: unknown;
    try { data = await response.json(); } catch { return this.failed(url, { kind: "invalid", message: "GitHub returned unreadable release metadata." }); }
    const entry = { data, etag: response.headers.get("etag") ?? undefined, url: response.url || url, checkedAt: this.now() };
    this.entries.delete(url);
    this.entries.set(url, entry);
    while (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value!);
    this.succeeded(url);
    return entry;
  }
}
const profiles = new Map<string, GitHubMetadata>();
export function githubMetadata(file: string) {
  let client = profiles.get(file);
  if (!client) { client = new GitHubMetadata({ file }); profiles.set(file, client); }
  return client;
}

function headerCount(headers: Headers, name: string) {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}
