// agent-audit.jsonl (docs/agent-interface.md): one line per agent operation, appended and kept forever.
// Read back newest first, filtered, in pages: an entry's id is the byte offset of its line, so
// paging stays stable while new entries are appended.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { auditMatches, type AuditEntry, type AuditFilter, type AuditPage, type AuditRecord } from "../../shared/agents";

/** Bytes read per step, going back through the file. */
const CHUNK = 256 * 1024;
/** Bytes one query may scan before it returns what it has, with a cursor to go on. */
const SCAN_BUDGET = 8 * 1024 * 1024;
/** Entries are appended in time order; this much clock adjustment is tolerated when a time range
 *  lets a query skip ahead or stop early. */
const CLOCK_SLACK = 5 * 60_000;

export type AuditQuery = {
	limit?: number;
	/** Entries before this id (the previous page's `next`). */
	before?: number;
	/** Entries after this id (the newest one already shown). */
	after?: number;
	filter?: AuditFilter;
};

export class AuditLog {
	constructor(readonly file: string, private readonly budget = SCAN_BUDGET) {}

	append(entry: AuditEntry) {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
		} catch (error) {
			console.error(`agent audit: ${String(error)}`);
		}
	}

	/** The newest entries matching `filter`, newest first. */
	query({ limit = 50, before, after, filter }: AuditQuery = {}): AuditPage {
		const entries: AuditRecord[] = [];
		let fd: number;
		try {
			fd = openSync(this.file, "r");
		} catch {
			return { entries, next: null };
		}
		try {
			const size = fstatSync(fd).size;
			// Lines start at `floor` or later; `after` is itself a line start (and excluded).
			const floor = after !== undefined ? Math.min(after, size) : 0;
			let pos = before !== undefined ? Math.min(before, size) : size;
			// A range that ends in the past: start where it ends, found by bisecting the log.
			if (filter?.until !== undefined && after === undefined) pos = Math.min(pos, this.endOf(fd, floor, pos, filter.until + CLOCK_SLACK));
			const stopBefore = filter?.since !== undefined ? filter.since - CLOCK_SLACK : undefined;
			let tail = Buffer.alloc(0);
			let scanned = 0;
			while (pos > floor) {
				const start = Math.max(floor, pos - CHUNK);
				const chunk = Buffer.alloc(pos - start);
				readSync(fd, chunk, 0, chunk.length, start);
				scanned += chunk.length;
				const buf = tail.length ? Buffer.concat([chunk, tail]) : chunk;
				// The first line may be cut, unless the chunk starts where lines do.
				const cut = start === floor ? -1 : buf.indexOf(10);
				if (start !== floor && cut < 0) {
					tail = buf;
					pos = start;
					continue;
				}
				const first = cut + 1;
				const lines = buf.subarray(first).toString("utf8").split("\n");
				// Offsets of each line's start, in bytes.
				const offsets: number[] = [];
				let offset = start + first;
				for (const line of lines) {
					offsets.push(offset);
					offset += Buffer.byteLength(line) + 1;
				}
				for (let i = lines.length - 1; i >= 0; i--) {
					const id = offsets[i];
					if (!lines[i].trim() || (after !== undefined && id <= after)) continue;
					try {
						const entry = JSON.parse(lines[i]) as AuditEntry;
						// Older than the range's start: nothing before it can match.
						if (stopBefore !== undefined && entry.at < stopBefore) return { entries, next: null };
						if (!auditMatches(entry, filter)) continue;
						entries.push({ ...entry, id });
						if (entries.length >= limit) return { entries, next: after !== undefined ? null : id };
					} catch {}
				}
				tail = buf.subarray(0, first);
				pos = start;
				// A long search returns what it found so far; the cursor goes on from here.
				if (scanned >= this.budget && pos > floor) return { entries, next: after !== undefined ? null : start + first };
			}
			return { entries, next: null };
		} finally {
			closeSync(fd);
		}
	}

	/** A line start in [lo, hi] after which every entry is later than `time` (hi if none is found). */
	private endOf(fd: number, lo: number, hi: number, time: number) {
		while (hi - lo > CHUNK) {
			const line = this.lineAt(fd, Math.floor((lo + hi) / 2), hi);
			if (!line) break;
			if (line.at > time) hi = line.start;
			else lo = line.start + 1;
		}
		return hi;
	}

	/** The first whole line starting after `offset` (before `limit`): where it starts and its time. */
	private lineAt(fd: number, offset: number, limit: number): { start: number; at: number } | null {
		const buffer = Buffer.alloc(Math.min(16 * 1024, limit - offset));
		const read = readSync(fd, buffer, 0, buffer.length, offset);
		const first = buffer.subarray(0, read).indexOf(10);
		if (first < 0) return null;
		const end = buffer.subarray(first + 1, read).indexOf(10);
		if (end < 0) return null;
		try {
			const at = (JSON.parse(buffer.subarray(first + 1, first + 1 + end).toString("utf8")) as AuditEntry).at;
			return typeof at === "number" ? { start: offset + first + 1, at } : null;
		} catch {
			return null;
		}
	}
}
