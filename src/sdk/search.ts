// Search for plugin lists: every word of the query must match a record, either as a substring
// of its text (so "504" finds pid 50493 and "web-app" a folder), or — for words of 4+ letters —
// a word in it at most one typo away ("codes" finds "codex"). It also collects what matched,
// for the page's `highlight`.

/** Optimal string alignment distance, stopping early above `max`. */
export function editDistance(a: string, b: string, max = 1): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		let rowMin = Infinity;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			rowMin = Math.min(rowMin, d[i][j]);
		}
		if (rowMin > max) return max + 1;
	}
	return d[a.length][b.length];
}

export type Search = {
	/** No query: everything matches. */
	readonly empty: boolean;
	/** Does a record with these texts match? Remembers what matched, for `highlight()`. */
	test(texts: (string | number | undefined | null)[]): boolean;
	/** The query words and the typo-matched words seen in matching records. */
	highlight(): string[];
};

export function search(query: string): Search {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits = new Set(words);
	return {
		empty: words.length === 0,
		test(texts) {
			if (!words.length) return true;
			const hay = texts.filter((t) => t !== undefined && t !== null && t !== "").join("\n").toLowerCase();
			let tokens: string[] | null = null;
			const found: string[] = [];
			for (const w of words) {
				if (hay.includes(w)) continue;
				if (w.length < 4) return false;
				tokens ??= [...new Set(hay.split(/[^a-z0-9]+/).filter((t) => t.length >= 3))];
				// A whole word one typo away, or a word that starts with one (codes → codex-cli).
				let match: string | undefined;
				for (const t of tokens) {
					if (editDistance(w, t) <= 1) match = t;
					else if (t.length > w.length) match = [w.length, w.length + 1, w.length - 1].map((n) => t.slice(0, n)).find((p) => editDistance(w, p) <= 1);
					if (match) break;
				}
				if (!match) return false;
				found.push(match);
			}
			for (const f of found) hits.add(f);
			return true;
		},
		highlight: () => (words.length ? [...hits] : []),
	};
}
