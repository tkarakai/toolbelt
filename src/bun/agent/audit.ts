// agent-audit.jsonl (docs/agents.md): one line per agent operation, appended and kept forever.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry } from "../../shared/agents";

/** How much of the file's end is read for the newest entries. */
const TAIL_BYTES = 1024 * 1024;

export class AuditLog {
	constructor(readonly file: string) {}

	append(entry: AuditEntry) {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
		} catch (error) {
			console.error(`agent audit: ${String(error)}`);
		}
	}

	/** The newest entries (before `before`, epoch ms), newest first. */
	read(limit = 50, before?: number): AuditEntry[] {
		let text = "";
		try {
			const fd = openSync(this.file, "r");
			try {
				const size = fstatSync(fd).size;
				const length = Math.min(size, TAIL_BYTES);
				const buffer = Buffer.alloc(length);
				readSync(fd, buffer, 0, length, size - length);
				text = buffer.toString("utf8");
				// A cut first line is incomplete.
				if (length < size) text = text.slice(text.indexOf("\n") + 1);
			} finally {
				closeSync(fd);
			}
		} catch {
			return [];
		}
		const entries: AuditEntry[] = [];
		for (const line of text.split("\n").reverse()) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as AuditEntry;
				if (before !== undefined && entry.at >= before) continue;
				entries.push(entry);
				if (entries.length >= limit) break;
			} catch {}
		}
		return entries;
	}
}
