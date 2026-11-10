// How the process list is organized — a port of running's (src/ui/App.tsx, and
// mac/…/Model/Grouping.swift): sections by where jobs run (terminal app, tmux pane, detached),
// then the folder each job was started in (with its git branch), then jobs. A job's processes,
// and jobs started from it, nest under it. Sorting applies at every level. Pure functions, so
// test/processes-model.test.ts can check them.
import { homedir } from "node:os";
import type { Row, Tone } from "../../src/sdk";
import { search, type Search } from "../../src/sdk/search";
import type { Agent, Listen, Member, ProcRow, Snapshot, SortKey } from "./core";

const home = homedir();
export const tildify = (p: string) => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
export const dur = (s: number) =>
	s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
export const mem = (kb: number) => (kb > 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
export const displayName = (r: ProcRow) => r.agent?.title || r.command || r.argvCommand;
export const sectionLabel = (where: string) => (where === "detached" ? "Detached" : where || "Unknown");

/** "working", "idle 12m" — like running's agent rows. `lastActive` is epoch ms (or s). */
export function agentState(a: Agent, now = Date.now()) {
	if (a.status === "working") return "working";
	if (a.status === "new") return "new";
	if (!a.lastActive) return "idle";
	const ms = a.lastActive > 1e12 ? a.lastActive : a.lastActive * 1000;
	return `idle ${dur(Math.max(0, (now - ms) / 1000))}`;
}
/** paused / zombie / waiting on disk, from ps's STAT. */
export const stateLabel = (stat: string) => (stat.includes("Z") ? "zombie" : stat.includes("T") ? "paused" : stat.startsWith("D") ? "waiting on disk" : "");

const KIND_RANK: Record<string, number> = { job: 0, term: 0, server: 1, daemon: 2, app: 3 };

type Val = number | string;
export type Options = {
	query: string;
	/** Show app and system servers (running hides them until `a`). */
	showAll: boolean;
	sort: SortKey;
	desc: boolean;
	/** Recent CPU % and memory KB per pid, oldest first, for sparklines. */
	history?: Map<number, { cpu: number[]; mem: number[] }>;
	now?: number;
};

export type Built = {
	rows: Row[];
	search: Search;
	/** Jobs shown, of the jobs there are. */
	shown: number;
	total: number;
	/** App/system jobs left out (showAll off). */
	hiddenApps: number;
};

export function webUrl(snap: Snapshot, r: { listen: Listen[] }) {
	return snap.probes.find((p) => p.web && r.listen.some((l) => l.pid === p.pid && l.port === p.port))?.url;
}
const probeTitles = (snap: Snapshot, r: { listen: Listen[] }) => snap.probes.filter((p) => p.title && r.listen.some((l) => l.pid === p.pid && l.port === p.port)).map((p) => p.title!);

/** Everything a person might type to find a job. */
export function searchable(snap: Snapshot, r: ProcRow): (string | number | undefined)[] {
	const a = r.agent;
	const keptName = r.keptIndex !== undefined ? snap.kept.find((k) => k.index === r.keptIndex)?.name : undefined;
	return [
		displayName(r), r.command, r.argvCommand, r.cwd, tildify(r.cwd), r.pid, r.kind, sectionLabel(r.where), r.termLabel, r.tty, r.exe, stateLabel(r.stat), keptName,
		...r.listen.flatMap((l) => [`:${l.port}`, l.host]),
		snap.branches[r.cwd] ?? undefined, webUrl(snap, r), ...probeTitles(snap, r),
		a?.harness, a?.title, a?.model, a && agentState(a), a?.branch, a?.sessionId,
		...r.members.flatMap(memberSearchable),
	];
}
const memberSearchable = (m: Member) => [m.pid, m.argvCommand, tildify(m.cwd), ...m.listen.map((l) => `:${l.port}`)];

export function statusTone(r: ProcRow): Tone {
	if (r.agent) return r.agent.status === "working" ? "info" : "muted";
	if (stateLabel(r.stat)) return "warning";
	return r.listen.length ? "success" : "info";
}

export function build(snap: Snapshot, o: Options): Built {
	const s = search(o.query);
	const sign = o.desc ? -1 : 1;
	const cmp = (a: Val, b: Val) => sign * (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
	const jobVal = (j: ProcRow): Val => (o.sort === "started" ? j.etimeSec : o.sort === "memory" ? j.rssKb : o.sort === "cpu" ? j.cpu : displayName(j).toLowerCase());
	const memberVal = (m: Member): Val => (o.sort === "started" ? m.etimeSec : o.sort === "memory" ? m.rssKb : o.sort === "cpu" ? m.cpu : m.argvCommand.toLowerCase());
	const sum = o.sort === "memory" || o.sort === "cpu";
	const groupVal = (js: ProcRow[], label: string): Val => (sum ? js.reduce((t, j) => t + (jobVal(j) as number), 0) : label);
	const byKey = (a: ProcRow, b: ProcRow) => cmp(jobVal(a), jobVal(b)) || a.pid - b.pid;

	const all = snap.rows;
	const apps = all.filter((r) => r.kind === "app");
	const visible = all.filter((r) => (o.showAll || r.kind !== "app") && s.test(searchable(snap, r)));

	// Sections: by where, terminals before servers before apps, then by name (or by total).
	const sections = new Map<string, ProcRow[]>();
	for (const j of visible) sections.set(j.where, [...(sections.get(j.where) ?? []), j]);
	const rank = (js: ProcRow[]) => Math.min(...js.map((j) => KIND_RANK[j.kind] ?? 9));
	let ordered = [...sections.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || sectionLabel(a[0]).localeCompare(sectionLabel(b[0])));
	if (sum) ordered = ordered.sort((a, b) => cmp(groupVal(a[1], a[0]), groupVal(b[1], b[0])));

	const rows: Row[] = [];
	for (const [where, js] of ordered) {
		const isApp = js.every((j) => j.kind === "app");
		const section = {
			id: `w:${where}`,
			label: sectionLabel(where),
			tag: where === "detached" ? "no terminal" : isApp ? "app" : undefined,
			muted: isApp,
			icon: where === "detached" ? "unplug" : isApp ? "app-window" : where.startsWith("tmux") ? "columns-2" : "square-terminal",
		};
		const pids = new Set(js.map((j) => j.pid));
		const roots = js.filter((j) => j.parentRow === undefined || !pids.has(j.parentRow));
		const dirs = new Map<string, ProcRow[]>();
		for (const j of roots) dirs.set(j.cwd, [...(dirs.get(j.cwd) ?? []), j]);
		const dirList = [...dirs.entries()].sort((a, b) => (sum ? cmp(groupVal(a[1], a[0]), groupVal(b[1], b[0])) : tildify(a[0]).localeCompare(tildify(b[0]), undefined, { numeric: true })));
		for (const [dir, djs] of dirList) {
			const branch = dir && dir !== "/" ? (snap.branches[dir] ?? undefined) : undefined;
			const group = [section, { id: `d:${where}:${dir}`, label: tildify(dir) || "—", sub: branch ?? undefined }];
			const place = (j: ProcRow): Row => {
				const childJobs = js.filter((c) => c.parentRow === j.pid).sort(byKey);
				const members = sortTree(j.members, memberVal, cmp).map((m) => memberRow(snap, j, m, o));
				// Expanded when jobs were started from it, or the search matched one of its processes.
				const memberHit = !s.empty && j.members.some((m) => s.test(memberSearchable(m)));
				const children = [...nestMembers(j, members), ...childJobs.map(place)];
				return { ...jobRow(snap, j, o), children: children.length ? children : undefined, open: childJobs.length > 0 || memberHit || undefined };
			};
			for (const j of djs.sort(byKey)) rows.push({ ...place(j), group });
		}
	}
	return { rows, search: s, shown: visible.length, total: all.length, hiddenApps: o.showAll ? 0 : apps.length };
}

/** Siblings follow the sort; parents stay above their children. Flat, parent first. */
export function sortTree(members: Member[], value: (m: Member) => Val, cmp: (a: Val, b: Val) => number): Member[] {
	const pids = new Set(members.map((m) => m.pid));
	const kids = new Map<number, Member[]>();
	const tops: Member[] = [];
	for (const m of members) (pids.has(m.ppid) ? kids.set(m.ppid, [...(kids.get(m.ppid) ?? []), m]) : tops.push(m));
	const out: Member[] = [];
	const walk = (list: Member[]) => {
		for (const m of list.sort((a, b) => cmp(value(a), value(b)) || a.pid - b.pid)) {
			out.push(m);
			walk(kids.get(m.pid) ?? []);
		}
	};
	walk(tops);
	return out;
}

/** Member rows (flat, sorted) into a tree by parent pid. */
function nestMembers(job: ProcRow, flat: Row[]): Row[] {
	const byPid = new Map(job.members.map((m) => [String(m.pid), m]));
	const rows = new Map(flat.map((r) => [r.id, { ...r, children: [] as Row[] }]));
	const tops: Row[] = [];
	for (const r of flat) {
		const m = byPid.get(r.id)!;
		const parent = rows.get(String(m.ppid));
		(parent ? parent.children : tops).push(rows.get(r.id)!);
	}
	const clean = (r: Row & { children: Row[] }): Row => ({ ...r, children: r.children.length ? r.children.map((c) => clean(c as Row & { children: Row[] })) : undefined });
	return tops.map((r) => clean(r as Row & { children: Row[] }));
}

const spark = (o: Options, pid: number, key: "cpu" | "mem") => {
	const h = o.history?.get(pid)?.[key];
	return h && h.length > 1 ? h : undefined;
};

function jobRow(snap: Snapshot, r: ProcRow, o: Options): Row {
	const a = r.agent;
	const url = webUrl(snap, r);
	const kept = r.keptIndex !== undefined ? snap.kept.find((k) => k.index === r.keptIndex) : undefined;
	const titles = probeTitles(snap, r);
	const sub = [
		a ? a.harness : r.kind,
		a ? agentState(a, o.now) : stateLabel(r.stat),
		r.leaderGone ? `launcher exited · ${r.pidCount} left running` : r.pidCount > 1 ? `${r.pidCount} processes` : "",
		r.source === "history" ? "command guessed from history" : "",
		kept ? `kept as “${kept.name ?? kept.command}”` : "",
	].filter(Boolean).join(" · ");
	const branch = snap.branches[r.cwd];
	return {
		id: String(r.pid),
		cells: {
			name: { text: (r.leaderGone ? "⤷ " : "") + displayName(r), sub, dot: statusTone(r), mono: !a },
			ports: { text: "", chips: r.listen.map((l) => `:${l.port}`) },
			cpu: { text: `${r.cpu.toFixed(1)}%`, spark: spark(o, r.pid, "cpu"), mono: true },
			mem: { text: mem(r.rssKb), spark: spark(o, r.pid, "mem"), mono: true },
			uptime: dur(r.etimeSec),
		},
		actions: ["focus", ...(url ? ["open"] : []), "output", "copy", kept ? "edit-kept" : "keep", "restart", "stop", "kill", ...(stateLabel(r.stat) ? ["why"] : [])],
		details: [
			{ label: "Command", value: r.command, mono: true },
			...(r.command !== r.argvCommand ? [{ label: "Running as", value: r.argvCommand, mono: true }] : []),
			{ label: "Directory", value: tildify(r.cwd), mono: true },
			...(branch ? [{ label: "Git branch", value: branch, mono: true }] : []),
			{ label: "Where", value: [sectionLabel(r.where), r.termLabel && r.termLabel !== r.where ? r.termLabel : ""].filter(Boolean).join(" · ") },
			{ label: "PID", value: `${r.pid}${r.pgid ? ` · group ${r.pgid}` : ""}`, mono: true },
			...(r.tty ? [{ label: "TTY", value: r.tty, mono: true }] : []),
			...(url ? [{ label: "URL", value: url, mono: true }] : []),
			...(titles.length ? [{ label: "Page", value: titles.join(" · ") }] : []),
			{ label: "CPU · Memory", value: `${r.cpu.toFixed(1)}% · ${mem(r.rssKb)}` },
			{ label: "Running for", value: dur(r.etimeSec) },
			...(stateLabel(r.stat) ? [{ label: "State", value: stateLabel(r.stat) }] : []),
			...(r.leaderGone ? [{ label: "Launcher", value: "exited — these processes were left running" }] : []),
			...(a
				? [
						{ label: "Agent", value: [a.harness, a.model].filter(Boolean).join(" · ") },
						{ label: "Status", value: agentState(a, o.now) },
						...(a.tokens ? [{ label: "Tokens", value: a.tokens.toLocaleString() + (a.costUsd ? ` · $${a.costUsd.toFixed(2)}` : "") }] : []),
						...(a.branch ? [{ label: "Agent branch", value: a.branch, mono: true }] : []),
						...(a.resume ? [{ label: "Resume with", value: a.resume, mono: true }] : []),
					]
				: []),
			...(kept ? [{ label: "Kept as", value: kept.name ?? kept.command }] : []),
		],
	};
}

function memberRow(snap: Snapshot, job: ProcRow, m: Member, o: Options): Row {
	const url = webUrl(snap, m);
	return {
		id: String(m.pid),
		cells: {
			name: { text: m.argvCommand, sub: [`pid ${m.pid}`, stateLabel(m.stat), m.pidCount > 1 ? `${m.pidCount} processes` : ""].filter(Boolean).join(" · "), dot: m.listen.length ? "success" : stateLabel(m.stat) ? "warning" : "muted", mono: true },
			ports: { text: "", chips: m.listen.map((l) => `:${l.port}`) },
			cpu: { text: `${m.cpu.toFixed(1)}%`, spark: spark(o, m.pid, "cpu"), mono: true },
			mem: { text: mem(m.rssKb), spark: spark(o, m.pid, "mem"), mono: true },
			uptime: dur(m.etimeSec),
		},
		actions: [...(url ? ["open"] : []), "output", "copy", "stop", "kill", ...(stateLabel(m.stat) ? ["why"] : [])],
		details: [
			{ label: "Command", value: m.argvCommand, mono: true },
			{ label: "Directory", value: tildify(m.cwd), mono: true },
			{ label: "PID · parent", value: `${m.pid} · ${m.ppid}`, mono: true },
			{ label: "Part of", value: displayName(job) },
			...(url ? [{ label: "URL", value: url, mono: true }] : []),
			{ label: "CPU · Memory", value: `${m.cpu.toFixed(1)}% · ${mem(m.rssKb)}` },
			{ label: "Running for", value: dur(m.etimeSec) },
			...(stateLabel(m.stat) ? [{ label: "State", value: stateLabel(m.stat) }] : []),
		],
	};
}

/** The job a pid belongs to, and the member if it isn't the job itself. */
export function locate(snap: Snapshot | null, pid: number): { row: ProcRow; member?: Member } | undefined {
	for (const row of snap?.rows ?? []) {
		if (row.pid === pid) return { row };
		const member = row.members.find((m) => m.pid === pid);
		if (member) return { row, member };
	}
}

/** Strip terminal escape codes (colors, cursor moves) from output lines. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

/** A peek source's name: the terminal, an agent's conversation, or a log file. */
export const sourceLabel = (s: string | undefined) => (s === undefined ? "Terminal" : s === "@transcript" ? "Conversation" : (s.split("/").pop() ?? s));
