// Keeps the official app up to date from GitHub releases — a port of Running.app's updater.
// Checks now and then; when a newer release is out, downloads its disk image, checks it
// (SHA-256 from GitHub, bundle id, version, code signature), swaps the app bundle in place and
// relaunches. Dev builds never update themselves — they're rebuilt from the checkout.
//
// No Electrobun imports: index.ts wires it up (persistence, relaunch, quit), tests drive it
// with a fake fetch, a fake shell and a temp folder.
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const FEED =
  "https://api.github.com/repos/tkarakai/toolbelt/releases/latest";
export const BUNDLE_ID = "io.github.tkarakai.toolbelt";
/** How often to look: GitHub allows 60 unauthenticated requests an hour; this is 4 a day. */
export const INTERVAL = 6 * 3600_000;
/** At launch and when the window opens: check if the last attempt is older than this. */
export const SOON = 3600_000;
/** The schedule is looked at this often (a plain 6-hour timer doesn't count time asleep). */
export const TICK = 15 * 60_000;

export type Release = {
  version: string;
  /** The CHANGELOG section (Markdown), without the download instructions. */
  notes: string;
  page: string;
  dmg: string;
  size: number;
  sha256: string | null;
  /** ms since the epoch */
  published: number | null;
};

export type Phase =
  | { kind: "idle" }
  | {
      kind: "downloading";
      received: number;
      total: number;
      /** bytes per second, smoothed */ speed: number;
    }
  | { kind: "verifying" }
  | { kind: "installing" }
  | { kind: "relaunching" }
  | { kind: "failed"; message: string };

export type UpdateState = {
  /** Only the official (stable) build updates itself, or any build with TOOLBELT_UPDATE_FEED. */
  enabled: boolean;
  channel: string;
  version: string;
  checking: boolean;
  /** The last check that got an answer. */
  lastChecked: number | null;
  nextCheck: number | null;
  lastError: string | null;
  /** The newest release GitHub knows of, newer or not. */
  latest: Release | null;
  available: Release | null;
  phase: Phase;
  /** The bundle an update would replace. */
  appPath: string | null;
};

export const isBusy = (p: Phase) =>
  p.kind === "downloading" ||
  p.kind === "verifying" ||
  p.kind === "installing" ||
  p.kind === "relaunching";

export class UpdateError extends Error {}

// ── pure helpers ─────────────────────────────────────────────────────────

/** The body is the CHANGELOG section, then download instructions — only the first is news. */
export function releaseNotes(body: string | null | undefined): string {
  const s = body ?? "";
  const cut = s.indexOf("\n## Downloads");
  return (cut < 0 ? s : s.slice(0, cut)).trim();
}

/** A GitHub "latest release" answer → the release, or an UpdateError. */
export function parseRelease(json: unknown): Release {
  const r = json as {
    tag_name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    assets?: {
      name?: unknown;
      size?: unknown;
      browser_download_url?: unknown;
      digest?: unknown;
    }[];
  };
  if (
    !r ||
    typeof r.tag_name !== "string" ||
    typeof r.html_url !== "string" ||
    !Array.isArray(r.assets)
  )
    throw new UpdateError("GitHub's answer isn't a release");
  const version = r.tag_name.startsWith("v") ? r.tag_name.slice(1) : r.tag_name;
  const dmg = r.assets.find(
    (a) => typeof a?.name === "string" && a.name === `Toolbelt-${version}-arm64.dmg`,
  );
  if (!dmg || typeof dmg.browser_download_url !== "string")
    throw new UpdateError("The release has no disk image");
  const digest =
    typeof dmg.digest === "string" && dmg.digest.startsWith("sha256:")
      ? dmg.digest.slice(7).toLowerCase()
      : null;
  const published =
    typeof r.published_at === "string" ? Date.parse(r.published_at) : NaN;
  return {
    version,
    notes: releaseNotes(typeof r.body === "string" ? r.body : ""),
    page: r.html_url,
    dmg: dmg.browser_download_url,
    size: typeof dmg.size === "number" ? dmg.size : 0,
    sha256: digest,
    published: Number.isFinite(published) ? published : null,
  };
}

/** SemVer precedence includes prerelease identifiers. */
export function isNewer(a: string, b: string): boolean {
  return Bun.semver.order(a, b) > 0;
}

/** Whether a check is due: never attempted, or the last attempt is at least `age` old. */
export const isDue = (
  lastAttempt: number | null,
  now: number,
  age = INTERVAL,
) => lastAttempt === null || now - lastAttempt >= age;

/** Download speed, smoothed like Running's (70% old, 30% new). */
export const smoothSpeed = (prev: number, instant: number) =>
  prev === 0 ? instant : prev * 0.7 + instant * 0.3;

/** The .app bundle around Bun's executable (…/Toolbelt.app/Contents/MacOS/bun), or null. */
export function bundleOf(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1] : null;
}

/** Why this copy can't replace itself, or null if it can. */
export function installProblem(
  appPath: string | null,
  writable: (dir: string) => boolean,
): string | null {
  if (!appPath) return "This copy of Toolbelt isn't an app bundle.";
  if (appPath.includes("/AppTranslocation/") || appPath.startsWith("/Volumes/"))
    return "Move Toolbelt to your Applications folder first, then update.";
  if (!appPath.endsWith(".app"))
    return "This copy of Toolbelt isn't an app bundle.";
  if (!writable(dirname(appPath)))
    return `Toolbelt can't write to ${dirname(appPath)}.`;
  return null;
}

// ── the updater ──────────────────────────────────────────────────────────

export type Persisted = {
  lastChecked?: number | null;
  lastAttempt?: number | null;
};

/** Runs a command; resolves with its output, rejects with an UpdateError on a non-zero exit. */
export type Shell = (exe: string, ...args: string[]) => Promise<string>;

export const sh: Shell = async (exe, ...args) => {
  const p = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0)
    throw new UpdateError(`${basename(exe)} failed: ${(err || out).trim()}`);
  return out;
};

export type UpdaterOptions = {
  /** Reject before disrupting the current app when installed plugins cannot use the target host. */
  preflight?: (version: string) => void;
  prepareInstall?: () => Promise<void>;
  resumeInstall?: () => Promise<void>;
  version: string;
  channel: string;
  /** TOOLBELT_UPDATE_FEED: a local server or file to try the whole update against. */
  feed?: string;
  /** JSON file for lastChecked / lastAttempt. */
  stateFile: string;
  /** The bundle to replace (bundleOf(process.execPath)). */
  appPath: string | null;
  onChange: (s: UpdateState) => void;
  /** Start the new bundle (window open) and quit this one. */
  relaunch: (appPath: string) => void;
  fetch?: typeof fetch;
  sh?: Shell;
  now?: () => number;
  /** Infos of the bundle on the mounted disk image (Info.plist as JSON). */
  readInfo?: (app: string) => Promise<Record<string, unknown>>;
  writable?: (dir: string) => boolean;
  /** Time to let "Restarting…" be seen before relaunching. */
  relaunchDelay?: number;
};

const defaultWritable = (dir: string) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export class Updater {
  private o: Required<Omit<UpdaterOptions, "feed">> & { feed: string };
  private checking = false;
  private lastChecked: number | null = null;
  private lastAttempt: number | null = null;
  private latest: Release | null = null;
  private available: Release | null = null;
  private lastError: string | null = null;
  private phase: Phase = { kind: "idle" };
  private timer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private mounted: string | null = null;
  readonly enabled: boolean;

  constructor(opts: UpdaterOptions) {
    this.o = {
      fetch: globalThis.fetch.bind(globalThis),
      sh,
      now: Date.now,
      readInfo: async (app) =>
        JSON.parse(
          await (opts.sh ?? sh)(
            "/usr/bin/plutil",
            "-convert",
            "json",
            "-o",
            "-",
            join(app, "Contents/Info.plist"),
          ),
        ),
      writable: defaultWritable,
      relaunchDelay: 600,
      ...opts,
      feed: opts.feed || FEED,
    } as typeof this.o;
    this.enabled = opts.channel === "stable" || !!opts.feed;
    try {
      const p = JSON.parse(readFileSync(opts.stateFile, "utf8")) as Persisted;
      this.lastChecked =
        typeof p.lastChecked === "number" ? p.lastChecked : null;
      this.lastAttempt =
        typeof p.lastAttempt === "number" ? p.lastAttempt : null;
    } catch {}
  }

  state(): UpdateState {
    return {
      enabled: this.enabled,
      channel: this.o.channel,
      version: this.o.version,
      checking: this.checking,
      lastChecked: this.lastChecked,
      nextCheck: this.lastAttempt === null ? null : this.lastAttempt + INTERVAL,
      lastError: this.lastError,
      latest: this.latest,
      available: this.available,
      phase: this.phase,
      appPath: this.o.appPath,
    };
  }

  private changed() {
    this.o.onChange(this.state());
  }

  private persist() {
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(
        this.o.stateFile,
        JSON.stringify({
          lastChecked: this.lastChecked,
          lastAttempt: this.lastAttempt,
        } satisfies Persisted) + "\n",
      );
    } catch {}
  }

  /** Checks at launch (unless the last attempt was within the hour), then whenever the last
   *  one is 6 hours old — looked at every 15 minutes. */
  start() {
    if (!this.enabled || this.timer) return;
    this.checkIfDue(SOON);
    this.timer = setInterval(() => this.checkIfDue(), TICK);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns whether a check started. */
  checkIfDue(age = INTERVAL): boolean {
    if (!this.enabled || !isDue(this.lastAttempt, this.o.now(), age))
      return false;
    void this.check();
    return true;
  }

  async check(): Promise<void> {
    if (!this.enabled || this.checking || isBusy(this.phase)) return;
    this.checking = true;
    this.lastAttempt = this.o.now();
    this.persist();
    this.changed();
    try {
      const res = await this.o.fetch(this.o.feed, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Toolbelt/${this.o.version}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status !== 200)
        throw new UpdateError(`GitHub answered ${res.status}`);
      const release = parseRelease(await res.json());
      this.lastError = null;
      this.lastChecked = this.o.now();
      this.latest = release;
      this.available = isNewer(release.version, this.o.version)
        ? release
        : null;
      this.persist();
    } catch (e) {
      this.lastError = errorText(e);
    } finally {
      this.checking = false;
      this.changed();
    }
  }

  /** Stop a download (only a download can be stopped). */
  cancel() {
    if (this.phase.kind !== "downloading") return;
    this.abort?.abort();
  }

  /** Back to idle after a failure. */
  dismiss() {
    if (isBusy(this.phase)) return;
    this.phase = { kind: "idle" };
    this.changed();
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.changed();
  }

  async install(): Promise<void> {
    const r = this.available;
    if (!r || isBusy(this.phase)) return;
    const work = join(tmpdir(), `toolbelt-update-${randomUUID()}`);
    const abort = (this.abort = new AbortController());
    try {
      this.o.preflight?.(r.version);
      const problem = installProblem(this.o.appPath, this.o.writable);
      if (problem) throw new UpdateError(problem);
      const target = this.o.appPath!;
      mkdirSync(work, { recursive: true });

      // 1. Download, with progress.
      this.setPhase({
        kind: "downloading",
        received: 0,
        total: r.size,
        speed: 0,
      });
      const dmg = join(work, "Toolbelt.dmg");
      await this.download(r, dmg, abort.signal);
      this.abort = null;

      // 2. Check it's what GitHub says it is, and that it's Toolbelt.
      this.setPhase({ kind: "verifying" });
      if (r.sha256) {
        const got = await sha256(dmg);
        if (got !== r.sha256.toLowerCase())
          throw new UpdateError(
            "The download is damaged (checksum mismatch). Try again.",
          );
      }
      const mount = join(work, "mnt");
      await this.o.sh(
        "/usr/bin/hdiutil",
        "attach",
        "-nobrowse",
        "-readonly",
        "-noautoopen",
        "-mountpoint",
        mount,
        dmg,
      );
      this.mounted = mount;
      const newApp = join(mount, "Toolbelt.app");
      let info: Record<string, unknown>;
      try {
        info = await this.o.readInfo(newApp);
      } catch {
        throw new UpdateError("The disk image doesn't contain Toolbelt.app");
      }
      if (info.CFBundleIdentifier !== BUNDLE_ID)
        throw new UpdateError("The disk image contains a different app");
      if (info.CFBundleShortVersionString !== r.version)
        throw new UpdateError(
          "The disk image holds a different version than announced",
        );
      await this.o.sh("/usr/bin/codesign", "--verify", "--strict", newApp);

      // 3. Copy it next to the current app (same volume, so the swap is a rename), then swap.
      this.setPhase({ kind: "installing" });
      const dir = dirname(target);
      const tag = randomUUID().slice(0, 6);
      const staged = join(dir, `.Toolbelt-${r.version}-${tag}.app`);
      const old = join(dir, `.Toolbelt-old-${tag}.app`);
      try {
        await this.o.sh("/usr/bin/ditto", newApp, staged);
      } catch (e) {
        rmSync(staged, { recursive: true, force: true });
        throw e;
      }
      await this.o
        .sh("/usr/bin/xattr", "-dr", "com.apple.quarantine", staged)
        .catch(() => {});
      await this.detach(); // done with the disk image
      try {
        this.o.preflight?.(r.version);
        await this.o.prepareInstall?.();
        renameSync(target, old);
      } catch (e) {
        rmSync(staged, { recursive: true, force: true });
        throw new UpdateError(`Couldn't replace ${target}: ${errorText(e)}`);
      }
      try {
        renameSync(staged, target);
      } catch (e) {
        try {
          renameSync(old, target); // put the old one back
        } catch {}
        rmSync(staged, { recursive: true, force: true });
        throw new UpdateError(
          `Couldn't install the new version: ${errorText(e)}`,
        );
      }
      rmSync(old, { recursive: true, force: true }); // our own files stay readable while we run

      // 4. Start the new one with the window open, and quit.
      this.setPhase({ kind: "relaunching" });
      rmSync(work, { recursive: true, force: true });
      await Bun.sleep(this.o.relaunchDelay); // let the last step be seen
      this.o.relaunch(target);
    } catch (e) {
      await this.o
        .resumeInstall?.()
        .catch((error) =>
          console.error("plugin resume after failed app upgrade:", error),
        );
      await this.detach();
      rmSync(work, { recursive: true, force: true });
      this.abort = null;
      if (abort.signal.aborted) this.setPhase({ kind: "idle" });
      else this.setPhase({ kind: "failed", message: errorText(e) });
    }
  }

  private async download(r: Release, dest: string, signal: AbortSignal) {
    const res = await this.o.fetch(r.dmg, {
      headers: { "User-Agent": `Toolbelt/${this.o.version}` },
      signal,
    });
    if (res.status !== 200 || !res.body)
      throw new UpdateError(`The download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || r.size;
    const out = Bun.file(dest).writer();
    let got = 0,
      speed = 0,
      lastBytes = 0,
      lastTime = this.o.now(),
      lastSent = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (signal.aborted) throw new UpdateError("cancelled");
        out.write(chunk);
        got += chunk.byteLength;
        const now = this.o.now(),
          dt = now - lastTime;
        if (dt > 250) {
          speed = smoothSpeed(speed, ((got - lastBytes) * 1000) / dt);
          lastBytes = got;
          lastTime = now;
        }
        // A few updates a second is plenty for a progress bar.
        if (now - lastSent > 100 || got === total) {
          lastSent = now;
          this.setPhase({ kind: "downloading", received: got, total, speed });
        }
      }
    } finally {
      await out.end();
    }
    if (signal.aborted) throw new UpdateError("cancelled");
    if (total && got !== total)
      throw new UpdateError(
        `The download stopped early (${got} of ${total} bytes). Try again.`,
      );
    this.setPhase({ kind: "downloading", received: got, total, speed });
  }

  private async detach() {
    const m = this.mounted;
    if (!m) return;
    this.mounted = null;
    await this.o.sh("/usr/bin/hdiutil", "detach", "-force", m).catch(() => {});
  }
}

export function sha256(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });
}

function errorText(e: unknown): string {
  if (e instanceof UpdateError) return e.message;
  if (e instanceof Error)
    return e.name === "TimeoutError"
      ? "GitHub didn't answer in time"
      : e.message;
  return String(e);
}
