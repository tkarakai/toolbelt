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
}
