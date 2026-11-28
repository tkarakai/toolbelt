// journal/changes.jsonl (docs/architecture.md, "Change journal"): one entry per change made through a
// plugin's screens, whoever made it. Append-only and hash-chained so an edited, removed or torn
// line shows at the next start; ToolBelt never rewrites or repairs it. Entries name what changed
// (plugin, surface, action or form field, row ids, outcome) and never what was typed, shown or
// returned: no text, field values, row titles or result data.
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Actor, EventSettled } from "./host";

export type JournalEntry = {
	/** 1 for the first entry, then one more than the entry before it. */
	seq: number;
	/** When the host sent the event (the first one, for coalesced field events). */
	at: number;
	/** The event's id (the first one, for coalesced field events). */
	event: string;
	actor: Actor;
	plugin: string;
	surface: string;
	/** The action id, or `form.field` for a field event. */
	name: string;
	effect: "write" | "external" | "destructive";
	/** Ids only, at most 200. */
	rows?: string[];
	/** Agents only: how the change was allowed. */
	approval?: "none" | "grant" | "once";
	outcome: EventSettled["outcome"];
	error?: string;
	/** sha256 (hex) of the previous entry's hash and this entry's canonical form (`entryHash`). */
	hash: string;
};

/** Something wrong with the file, found at start. Lines count from 1. */
export type JournalBreak = {
	line: number;
	/**
	 * `changed`: an entry doesn't hash to its chain (it, or the entry before it, was edited);
	 * `missing`: entries are missing before it (lines removed); `out-of-order`: its seq doesn't
	 * follow (lines moved or copied); `unreadable`: not an entry; `torn`: a write that didn't
	 * finish (the last line has no end, or an unreadable line the chain continues past).
	 */
	kind: "changed" | "missing" | "out-of-order" | "unreadable" | "torn";
	detail: string;
};

export type JournalStatus = {
	file: string;
	/** Readable entries in the file (a held field entry isn't written yet). */
	entries: number;
	/** The last entry's seq (0 when there's none). */
	seq: number;
	/** What the check at start found, oldest first (at most `MAX_BREAKS`). */
	breaks: JournalBreak[];
	/** Breaks found, including those beyond `MAX_BREAKS`. */
	breakCount: number;
	/** False after a write failed, until one succeeds again. */
	writable: boolean;
	/** The latest write failure. */
	error?: string;
	/** Entries lost to write failures since start. */
	dropped: number;
};

/** The previous hash of the first entry. */
export const GENESIS = "0".repeat(64);
/** Consecutive field events this close together (ms, from the first) are one entry. */
export const COALESCE_MS = 10_000;
/** Entries are synced to disk within this long of being written (ms). */
export const SYNC_MS = 1_000;
/** Breaks kept for diagnostics; more are only counted. */
const MAX_BREAKS = 100;
const CHUNK = 256 * 1024;

/**
 * The canonical form an entry's hash covers: JSON without whitespace, object keys sorted by UTF-16
 * code unit at every level, array order kept, absent fields left out. Entries hold only strings,
 * integers, arrays and plain objects, which JSON round-trips exactly, so any reader can verify.
 */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** sha256 (hex) of the previous entry's hash followed by the entry's canonical form without `hash`. */
export function entryHash(previous: string, entry: Omit<JournalEntry, "hash"> | JournalEntry): string {
	const { hash: _, ...rest } = entry as JournalEntry;
	return new Bun.CryptoHasher("sha256").update(previous + canonical(rest)).digest("hex");
}

const isEntry = (v: unknown): v is JournalEntry => {
	const e = v as JournalEntry;
	return !!e && typeof e === "object" && Number.isSafeInteger(e.seq) && typeof e.hash === "string" && typeof e.at === "number" && !!e.actor && typeof e.actor === "object";
};

/** Every complete line of a file, in order, with whatever follows the last newline (a torn line). */
function* lines(fd: number): Generator<string, string> {
	const size = fstatSync(fd).size;
	let rest = Buffer.alloc(0);
	for (let pos = 0; pos < size; ) {
		const chunk = Buffer.alloc(Math.min(CHUNK, size - pos));
		const read = readSync(fd, chunk, 0, chunk.length, pos);
		if (read <= 0) break;
		pos += read;
		let buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
		let nl: number;
		while ((nl = buf.indexOf(10)) >= 0) {
			yield buf.subarray(0, nl).toString("utf8");
			buf = buf.subarray(nl + 1);
		}
		rest = Buffer.from(buf);
	}
	return rest.toString("utf8");
}

/**
 * Checks a journal's chain: each entry's seq follows the one before it and its hash covers the
 * previous hash and its own fields. After a break the check goes on from the entry it stopped at
 * (its stored seq and hash), so one edit reports once; an entry whose seq goes back is skipped.
 * An unreadable line followed by an entry that continues the chain from before it is a torn
 * write, as is a last line without its newline.
 * Deleting the newest entries can't be told from never having written them.
 */
export function verifyJournal(file: string): { entries: number; last: { seq: number; hash: string } | null; breaks: JournalBreak[]; breakCount: number; endsTorn: boolean } {
	const breaks: JournalBreak[] = [];
	let breakCount = 0;
	const report = (b: JournalBreak) => {
		breakCount++;
		if (breaks.length < MAX_BREAKS) breaks.push(b);
	};
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return { entries: 0, last: null, breaks, breakCount, endsTorn: false };
	}
	let entries = 0;
	let previous = GENESIS;
	let seq = 0;
	let unreadable: number | null = null;
	let endsTorn = false;
	try {
		const it = lines(fd);
		let line = 0;
		for (let next = it.next(); ; next = it.next()) {
			if (next.done) {
				if (unreadable !== null) report({ line: unreadable, kind: "unreadable", detail: "the line isn't a journal entry" });
				if (next.value.length) {
					endsTorn = true;
					report({ line: line + 1, kind: "torn", detail: "the last line is incomplete (ToolBelt may have stopped while writing it)" });
				}
				break;
			}
			line++;
			let entry: unknown;
			try {
				entry = JSON.parse(next.value);
			} catch {}
			if (!isEntry(entry)) {
				if (unreadable !== null) report({ line: unreadable, kind: "unreadable", detail: "the line isn't a journal entry" });
				unreadable = line;
				continue;
			}
			entries++;
			const chained = entry.seq === seq + 1 && entry.hash === entryHash(previous, entry);
			if (unreadable !== null)
				report(chained ? { line: unreadable, kind: "torn", detail: "a write that didn't finish; the chain continues past it" } : { line: unreadable, kind: "unreadable", detail: "the line isn't a journal entry" });
			unreadable = null;
			if (entry.seq <= seq) {
				// A moved or copied line: the chain goes on from the entry before it.
				report({ line, kind: "out-of-order", detail: `entry ${entry.seq} follows entry ${seq}` });
				continue;
			}
			if (entry.seq > seq + 1) report({ line, kind: "missing", detail: `entr${entry.seq - seq - 1 === 1 ? "y" : "ies"} ${seq + 1}${entry.seq - seq - 1 > 1 ? `–${entry.seq - 1}` : ""} missing before entry ${entry.seq}` });
			else if (!chained) report({ line, kind: "changed", detail: `entry ${entry.seq} doesn't match the chain: it or the entry before it was changed` });
			previous = entry.hash;
			seq = entry.seq;
		}
	} finally {
		closeSync(fd);
	}
	return { entries, last: seq ? { seq, hash: previous } : null, breaks, breakCount, endsTorn };
}

/** A field entry waiting for more events on the same field. */
type Held = { key: string; entry: Omit<JournalEntry, "seq" | "hash">; timer: ReturnType<typeof setTimeout> };

/**
 * The change journal. `record` takes every settled event; those with a `change` become entries.
 * It never throws and never blocks the event: a failed write is logged, counted and reported in
 * `status`, and the next entry tries again.
 */
export class ChangeJournal {
	private fd: number | null = null;
	private seq = 0;
	private previous = GENESIS;
	private entries = 0;
	private breaks: JournalBreak[] = [];
	private breakCount = 0;
	/** The file may not end with a newline (a torn line, or a failed write): check before writing. */
	private checkEnd = true;
	private writable = true;
	private error?: string;
	private dropped = 0;
	private syncTimer?: ReturnType<typeof setTimeout>;
	private held?: Held;

	constructor(
		readonly file: string,
		private readonly opts: { log?: (line: string) => void; coalesceMs?: number; syncMs?: number } = {},
	) {
		const check = verifyJournal(file);
		this.entries = check.entries;
		this.breaks = check.breaks;
		this.breakCount = check.breakCount;
		// The chain goes on from where the check ended (the last complete entry, past any torn line).
		if (check.last) (this.seq = check.last.seq), (this.previous = check.last.hash);
		if (check.breakCount)
			this.log(`${check.breakCount} problem${check.breakCount === 1 ? "" : "s"} in ${file}: ${check.breaks.slice(0, 5).map((b) => `line ${b.line}: ${b.kind}, ${b.detail}`).join("; ")}${check.breakCount > 5 ? "; …" : ""}`);
	}

	status(): JournalStatus {
		return {
			file: this.file,
			entries: this.entries,
			seq: this.seq,
			breaks: this.breaks,
			breakCount: this.breakCount,
			writable: this.writable,
			...(this.error ? { error: this.error } : {}),
			dropped: this.dropped,
		};
	}

	/**
	 * Journals a settled event that may have changed data (`change`). A field event joins the held
	 * entry for the same plugin, surface, form field, row and actor when it has the same outcome and
	 * was sent within `COALESCE_MS` of that entry's first event: the entry keeps the first event's
	 * id and time and takes the latest error. Any other entry writes the held one first.
	 */
	record(e: EventSettled) {
		const c = e.change;
		if (!c) return;
		try {
			const entry: Omit<JournalEntry, "seq" | "hash"> = {
				at: c.at,
				event: e.id,
				actor: e.actor,
				plugin: e.plugin,
				surface: e.surface,
				name: c.name,
				effect: c.effect,
				...(c.rows.length ? { rows: c.rows } : {}),
				...(c.approval ? { approval: c.approval } : {}),
				outcome: e.outcome,
				...(e.error !== undefined ? { error: e.error.slice(0, 500) } : {}),
			};
			if (e.name !== "field") {
				this.release();
				this.write(entry);
				return;
			}
			const key = canonical([e.plugin, e.surface, c.name, c.rows, e.actor]);
			const held = this.held;
			const window = this.opts.coalesceMs ?? COALESCE_MS;
			if (held && held.key === key && held.entry.outcome === entry.outcome && entry.at - held.entry.at <= window) {
				if (entry.error !== undefined) held.entry.error = entry.error;
				return;
			}
			this.release();
			const timer = setTimeout(() => this.release(), Math.max(0, entry.at + window - Date.now()));
			timer.unref?.();
			this.held = { key, entry, timer };
		} catch (error) {
			this.failed(error);
		}
	}

	/** Writes the held field entry and syncs the file now (before quitting). */
	flush() {
		this.release();
		this.sync();
	}

	/** The newest entries, newest first (readable lines only; at most `limit`, up to 1,000). */
	read(limit = 50): JournalEntry[] {
		const want = Math.max(1, Math.min(1000, Math.floor(limit)));
		const out: JournalEntry[] = [];
		let fd: number;
		try {
			fd = openSync(this.file, "r");
		} catch {
			return out;
		}
		try {
			let pos = fstatSync(fd).size;
			let tail = Buffer.alloc(0);
			let first = true;
			while (pos > 0 && out.length < want) {
				const start = Math.max(0, pos - CHUNK);
				const chunk = Buffer.alloc(pos - start);
				readSync(fd, chunk, 0, chunk.length, start);
				const buf = Buffer.concat([chunk, tail]);
				const cut = start === 0 ? -1 : buf.indexOf(10);
				if (start > 0 && cut < 0) {
					tail = buf;
					pos = start;
					continue;
				}
				const parts = buf.subarray(cut + 1).toString("utf8").split("\n");
				// A torn last line (no newline) isn't an entry.
				if (first) parts.pop();
				first = false;
				for (let i = parts.length - 1; i >= 0 && out.length < want; i--) {
					try {
						const entry = JSON.parse(parts[i]);
						if (isEntry(entry)) out.push(entry);
					} catch {}
				}
				tail = buf.subarray(0, cut + 1);
				pos = start;
			}
			return out;
		} finally {
			closeSync(fd);
		}
	}

	close() {
		this.flush();
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
	}

	/** Writes the held entry, if any. */
	private release() {
		const held = this.held;
		if (!held) return;
		this.held = undefined;
		clearTimeout(held.timer);
		this.write(held.entry);
	}

	private write(fields: Omit<JournalEntry, "seq" | "hash">) {
		const unhashed = { seq: this.seq + 1, ...fields };
		const entry: JournalEntry = { ...unhashed, hash: entryHash(this.previous, unhashed) };
		try {
			const fd = this.open();
			let line = JSON.stringify(entry) + "\n";
			if (this.checkEnd) {
				// End a torn line first, so this entry starts a line of its own; the torn one stays.
				const size = fstatSync(fd).size;
				const last = Buffer.alloc(1);
				if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) line = "\n" + line;
				this.checkEnd = false;
			}
			const bytes = Buffer.from(line);
			let done = 0;
			while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
		} catch (error) {
			this.dropped++;
			this.failed(error);
			return;
		}
		this.seq = entry.seq;
		this.previous = entry.hash;
		this.entries++;
		if (!this.writable) this.log(`writing ${this.file} again`);
		this.writable = true;
		this.scheduleSync();
	}

	private open() {
		if (this.fd !== null) return this.fd;
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		// Read access too, to see whether the file ends mid-line.
		this.fd = openSync(this.file, "a+", 0o600);
		return this.fd;
	}

	private scheduleSync() {
		if (this.syncTimer) return;
		this.syncTimer = setTimeout(() => this.sync(), this.opts.syncMs ?? SYNC_MS);
		this.syncTimer.unref?.();
	}

	private sync() {
		clearTimeout(this.syncTimer);
		this.syncTimer = undefined;
		if (this.fd === null) return;
		try {
			fsyncSync(this.fd);
		} catch (error) {
			this.failed(error);
		}
	}

	/** A write or sync failed: report it, and start over with a fresh descriptor next time. */
	private failed(error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (this.writable || message !== this.error) this.log(`can't write ${this.file}: ${message}`);
		this.writable = false;
		this.error = message;
		this.checkEnd = true; // a partial write may have left a torn line
		if (this.fd !== null)
			try {
				closeSync(this.fd);
			} catch {}
		this.fd = null;
	}

	private log(line: string) {
		(this.opts.log ?? ((l: string) => console.error(l)))(`change journal: ${line}`);
	}
}
