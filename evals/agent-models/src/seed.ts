// The evaluation's OnTrack data: a product engineer's task list, written through OnTrack's own
// model module (the pinned source in .cache) so it is valid for the release the host runs. Dates
// are relative to the moment the world is created, so "overdue" and "today" mean the same on
// every run. The facts the cases check are exported next to the data that makes them true.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceDir } from "./setup";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");
/** Local `YYYY-MM-DD` (optionally `THH:MM`) `days` from `now`. */
export function localDue(now: number, days: number, time?: string) {
	const d = new Date(now + days * DAY);
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return time ? `${date}T${time}` : date;
}

/** Task names the cases refer to. Kept here so a renamed task breaks the build of the cases, not their meaning. */
export const T = {
	expenses: "Submit November expense report",
	vendorContract: "Sign the Northwind vendor contract",
	budget: "Q4 budget review with finance",
	slides: "Draft budget slides for the Q4 review",
	standupNotes: "Send standup notes to the team",
	passport: "Renew passport",
	carInsurance: "Renew car insurance",
	ciRunners: "Migrate CI to the new runners",
	flakyTest: "Fix flaky remote-access test",
	macImage: "Build the macOS runner image",
	launch: "Launch the new marketing website",
	copy: "Final copy for the website pricing page",
	dns: "Switch DNS to the new host",
	legal: "Legal review of the website privacy policy",
	printers: "Quote for the office printers",
	hiring: "Hire a senior backend engineer",
	interviewLoop: "Set up the interview loop for the backend role",
	offsite: "Plan the team offsite",
	venue: "Book the offsite venue",
	talk: "Write the conference talk on local-first apps",
	dentist: "Book a dentist appointment",
	gift: "Buy a birthday present for Anna",
	taxes: "Collect documents for the tax advisor",
	blog: "Write a blog post on agent-native apps",
	onboarding: "Update the onboarding guide",
	sso: "Evaluate SSO providers",
	security: "Answer the customer security questionnaire",
	retro: "Run the sprint retrospective",
	laptop: "Return the old laptop to IT",
	gym: "Cancel the gym membership",
	q3report: "Publish the Q3 metrics report",
	keynote: "Watch the platform keynote recording",
	roadmap: "Draft the 2027 product roadmap",
	analytics: "Fix the broken analytics dashboard",
	plumber: "Call the plumber about the kitchen sink",
	oneOnOne: "Prepare 1:1 notes for Daniel",
	release: "Ship ToolBelt 0.6",
	conference: "Submit the conference travel request",
	docs: "Proofread the API reference",
} as const;

export type Seeded = {
	/** Task name → OnTrack id. */
	ids: Record<string, number>;
	/** Counts the cases check, from the seeded data itself. */
	counts: { inbox: number; working: number; watching: number; snoozed: number; stalled: number; settled: number; archived: number; open: number };
};

export async function seedOnTrack(dataRoot: string, now = Date.now()): Promise<Seeded> {
	const M = await import(join(sourceDir("ontrack"), "src/model.ts"));
	const data = M.seed();
	const label = (name: string) => String(data.labels.find((l: { name: string }) => l.name === name).id);
	const ids: Record<string, number> = {};
	let n = 0;
	// A fixed sequence instead of Math.random, so label colors are the same on every run.
	const random = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
	type Opts = { due?: string; desc?: string; project?: string; priority?: "High" | "Medium" | "Low"; status?: "Todo" | "In progress" | "Blocked"; personal?: boolean; created?: number };
	const add = (name: string, o: Opts = {}) => {
		const labels: Record<string, string | boolean> = {};
		if (o.project) labels[label("Project")] = o.project;
		if (o.priority) labels[label("Priority")] = o.priority;
		if (o.status) labels[label("Status")] = o.status;
		if (o.personal) labels[label("isPersonal")] = true;
		const t = M.addTask(data, { name, due: o.due ?? "", desc: o.desc ?? "", labels }, o.created ?? now - 10 * DAY, random);
		ids[name] = t.id;
		return t;
	};
	const set = (name: string, fields: Record<string, unknown>) => Object.assign(M.findTask(data, ids[name]), fields);
	const update = (name: string, text: string, ago: number) => M.addUpdate(data, ids[name], text, now - ago);

	// ── overdue and due today ──
	add(T.expenses, { due: localDue(now, -3), project: "Finance", priority: "Medium", desc: "Receipts are in the Finance/2026-11 folder. Needs the hotel bill from the Berlin trip." });
	add(T.vendorContract, { due: localDue(now, -1), project: "Finance", priority: "High", status: "Todo", desc: "Northwind sent version 3. Legal approved clause 7 changes." });
	add(T.budget, { due: localDue(now, 0, "15:00"), project: "Finance", priority: "High", status: "In progress", created: now - 14 * DAY });
	add(T.slides, { due: localDue(now, 0, "13:00"), project: "Finance", priority: "Medium", status: "Todo", created: now - 4 * DAY });
	add(T.standupNotes, { due: localDue(now, 0, "17:30"), project: "Team", priority: "Low" });

	// ── upcoming ──
	add(T.passport, { due: localDue(now, 6), priority: "High", personal: true, desc: "Photos are in the desk drawer. Book the appointment on the town hall website; bring the old passport." });
	add(T.ciRunners, { due: localDue(now, 2), project: "ToolBelt", priority: "Medium", status: "In progress", created: now - 20 * DAY });
	add(T.flakyTest, { project: "ToolBelt", priority: "Low", status: "Blocked", desc: "Fails about 1 in 20 runs on CI; timing around the pairing timeout.", created: now - 18 * DAY });
	add(T.macImage, { due: localDue(now, 1), project: "ToolBelt", priority: "High", status: "Todo" });
	add(T.launch, { due: localDue(now, 9), project: "Website", priority: "High", status: "Blocked", desc: "Launch is planned together with the pricing change. Owner: me; marketing contact: Priya." });
	add(T.copy, { due: localDue(now, 4), project: "Website", priority: "High", status: "In progress" });
	add(T.dns, { due: localDue(now, 8), project: "Website", priority: "Medium", status: "Todo" });
	add(T.legal, { project: "Website", priority: "High", status: "Blocked" });
	add(T.offsite, { due: localDue(now, 21), project: "Team", priority: "Medium" });
	add(T.venue, { due: localDue(now, 5), project: "Team", priority: "High", status: "Todo" });
	add(T.talk, { due: localDue(now, 30), project: "Writing", priority: "Medium", status: "In progress" });
	add(T.gift, { due: localDue(now, 3), personal: true, priority: "Medium" });
	add(T.taxes, { due: localDue(now, 14), personal: true, priority: "High" });
	add(T.security, { due: localDue(now, 2), project: "Sales", priority: "High", status: "Todo", desc: "62 questions; sections 4 (encryption) and 9 (incident response) still open." });
	add(T.retro, { due: localDue(now, 1, "10:00"), project: "Team", priority: "Low" });
	add(T.conference, { due: localDue(now, 7), project: "Writing", priority: "Low" });

	// ── no due date ──
	add(T.hiring, { project: "Hiring", priority: "High", status: "In progress", created: now - 30 * DAY });
	add(T.interviewLoop, { project: "Hiring", priority: "High", status: "Todo" });
	add(T.dentist, { personal: true, priority: "Low" });
	add(T.blog, { project: "Writing", priority: "Low", created: now - 2 * DAY });
	add(T.onboarding, { project: "Team", priority: "Low" });
	add(T.sso, { project: "ToolBelt", priority: "High", status: "Todo", desc: "Shortlist: Okta, Auth0, WorkOS. Need SCIM support." });
	add(T.roadmap, { project: "Product", priority: "High", status: "Todo" });
	add(T.analytics, { project: "Product", priority: "Medium", status: "Todo" });
	add(T.plumber, { personal: true, priority: "Medium" });
	add(T.oneOnOne, { project: "Team", priority: "Medium" });
	add(T.docs, { project: "ToolBelt", priority: "Low" });
	add(T.printers, { project: "Office", priority: "Low" });
	add(T.keynote, { project: "Learning", priority: "Low" });

	// ── done ──
	add(T.carInsurance, { due: localDue(now, -12), personal: true, priority: "High" });
	add(T.q3report, { project: "Product", priority: "Medium" });
	add(T.release, { project: "ToolBelt", priority: "High" });
	add(T.laptop, { project: "Office", priority: "Low", created: now - 50 * DAY });
	add(T.gym, { personal: true, priority: "Low", created: now - 90 * DAY });

	// ── history ──
	update(T.budget, "Sent the draft numbers to Maria. Total ask is $412k, up 8% from Q3.", 5 * DAY);
	update(T.budget, "Maria wants the cloud costs split by team before the meeting.", 2 * DAY);
	update(T.budget, "Waiting for the headcount figures from HR; Jonas promised them by noon today.", 3 * HOUR);
	update(T.ciRunners, "Linux jobs moved over; macOS jobs still need the new image.", 3 * DAY);
	update(T.hiring, "Two candidates in the final round: Ines (strong on Postgres) and Marcus (strong on Go).", 4 * DAY);
	update(T.hiring, "Ines accepted another offer. Marcus has his final interview on Thursday.", DAY);
	update(T.printers, "Asked Acme for a quote on 3 printers; they promised one by Friday.", 6 * DAY);
	update(T.copy, "Priya sent the second draft. Pricing tiers: Starter $9, Team $29, Business $79.", DAY);
	update(T.talk, "Outline done: 1) why local-first, 2) sync engines, 3) demo, 4) lessons.", 6 * DAY);
	update(T.venue, "Two options: Lakeside Lodge (40 people, $3,800) and Old Mill (25 people, $2,100).", 2 * DAY);
	update(T.carInsurance, "Renewed with the same insurer; premium went from $1,140 to $1,260 a year.", 11 * DAY);
	update(T.release, "Released; changelog posted.", 3 * DAY);

	// ── relations ──
	M.setParent(data, ids[T.slides], ids[T.budget], now - 4 * DAY);
	M.setParent(data, ids[T.venue], ids[T.offsite], now - 3 * DAY);
	M.setParent(data, ids[T.interviewLoop], ids[T.hiring], now - 10 * DAY);
	M.relate(data, ids[T.macImage], "blocks", ids[T.ciRunners], false, now - 3 * DAY);
	M.relate(data, ids[T.ciRunners], "blocks", ids[T.flakyTest], false, now - 5 * DAY);
	M.relate(data, ids[T.legal], "blocks", ids[T.launch], false, now - 6 * DAY);
	M.relate(data, ids[T.copy], "blocks", ids[T.launch], false, now - 6 * DAY);
	M.relate(data, ids[T.dns], "relatedTo", ids[T.launch], false, now - 6 * DAY);

	// ── states ──
	for (const name of [T.budget, T.ciRunners, T.copy, T.talk, T.hiring, T.security]) set(name, { state: "working", touched: now - DAY, sessions: [{ start: now - 2 * HOUR, end: now - HOUR, by: "me" }] });
	data.order.working = [T.budget, T.security, T.copy, T.ciRunners, T.hiring, T.talk].map((x) => ids[x]);
	set(T.talk, { state: "stalled", stalledAt: now - 2 * DAY, touched: now - 6 * DAY, stalls: 1 });
	set(T.onboarding, { state: "stalled", stalledAt: now - 5 * DAY, touched: now - 9 * DAY, stalls: 2 });
	set(T.dentist, { state: "snoozed", snoozedUntil: now + 5 * DAY });
	set(T.keynote, { state: "snoozed", snoozedUntil: now + 2 * DAY });
	set(T.printers, { state: "watching", watch: { on: "Acme", since: now - 6 * DAY, every: { n: 1, unit: "week" }, anchor: now - 6 * DAY, next: now + DAY, checks: 0 } });
	set(T.legal, { state: "watching", watch: { on: "Legal team (Sofia)", since: now - 4 * DAY, next: now + 2 * DAY, checks: 1, checked: now - DAY } });
	set(T.sso, { state: "watching", watch: { on: "Security team", since: now - 8 * DAY, checks: 0 } });
	set(T.carInsurance, { state: "settled", settledAt: now - 11 * DAY });
	set(T.q3report, { state: "settled", settledAt: now - 2 * DAY });
	set(T.release, { state: "settled", settledAt: now - 3 * DAY });
	set(T.laptop, { state: "settled", settledAt: now - 40 * DAY, archived: true, archivedAt: now - 30 * DAY });
	set(T.gym, { state: "settled", settledAt: now - 60 * DAY, archived: true, archivedAt: now - 45 * DAY });
	set(T.blog, { unread: true, unreadReason: "New" });
	set(T.vendorContract, { unread: true, unreadReason: "Due" });
	data.order.inbox = data.tasks.filter((t: { state: string }) => t.state === "inbox").map((t: { id: number }) => t.id);

	const checked = M.parseData(JSON.parse(JSON.stringify(data)));
	mkdirSync(join(dataRoot, "ontrack"), { recursive: true });
	writeFileSync(join(dataRoot, "ontrack", "ontrack.json"), JSON.stringify(checked, null, "\t"));

	const tasks = checked.tasks as { state: string; archived: boolean }[];
	const count = (s: string) => tasks.filter((t) => t.state === s && !t.archived).length;
	return {
		ids,
		counts: {
			inbox: count("inbox"),
			working: count("working"),
			watching: count("watching"),
			snoozed: count("snoozed"),
			stalled: count("stalled"),
			settled: count("settled"),
			archived: tasks.filter((t) => t.archived).length,
			open: tasks.filter((t) => t.state !== "settled" && !t.archived).length,
		},
	};
}
