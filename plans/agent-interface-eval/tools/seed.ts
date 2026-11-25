// Seeds the isolated evaluation profile with life-like plugin data:
// OnTrack tasks (through OnTrack 0.14.0's own model) and Upkeep custom recipes whose
// commands only print versions (no real software is checked or updated).
// bun seed.ts <profileRoot> <ontrack checkout> <upkeep checkout>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, ontrack, upkeep] = process.argv.slice(2);
const M = await import(join(ontrack, "src/model.ts"));
const { recipeHash } = await import(join(upkeep, "providers/custom.ts"));

const now = Date.now();
const DAY = 86_400_000;
const data = M.seed();
const add = (name: string, extra: { due?: string; desc?: string; labels?: Record<string, string | boolean> } = {}, at = now) =>
	M.addTask(data, { name, due: extra.due ?? "", desc: extra.desc ?? "", labels: Object.fromEntries(Object.entries(extra.labels ?? {}).map(([k, v]) => [String(data.labels.find((l: { name: string }) => l.name === k).id), v])) }, at, () => 0.3);

const passport = add("Renew passport", { due: "2026-11-28", labels: { Priority: "High", isPersonal: true }, desc: "Photos are in the drawer. Appointment form at the town hall website." }, now - 6 * DAY);
const budget = add("Q4 budget review with finance", { due: "2026-11-25T14:00", labels: { Project: "Finance", Priority: "High", Status: "In progress" } }, now - 9 * DAY);
const slides = add("Draft budget slides", { labels: { Project: "Finance", Priority: "Medium", Status: "Todo" } }, now - 3 * DAY);
const ci = add("Migrate CI to the new runners", { labels: { Project: "ToolBelt", Priority: "Medium", Status: "In progress" } }, now - 12 * DAY);
const flaky = add("Fix flaky remote-access test", { labels: { Project: "ToolBelt", Priority: "Low", Status: "Blocked" }, desc: "Fails about 1 in 20 runs on CI; timing around the pairing timeout." }, now - 15 * DAY);
const dentist = add("Book dentist appointment", { labels: { isPersonal: true } }, now - 20 * DAY);
const quote = add("Vendor quote for office printers (Acme)", { labels: { Project: "Office" } }, now - 10 * DAY);
const blog = add("Write blog post on agent-native apps", { labels: { Project: "Writing", Priority: "Low" } }, now - 2 * DAY);
const expenses = add("Submit November expense report", { due: "2026-11-21", labels: { Project: "Finance", Priority: "Medium" } }, now - 8 * DAY);
const release = add("Ship ToolBelt 0.3.24", { labels: { Project: "ToolBelt" } }, now - 25 * DAY);
const team = add("Plan team offsite agenda", { due: "2026-12-05", labels: { Project: "Office", Priority: "Medium" } }, now - DAY);

M.addUpdate(data, budget.id, "Sent the draft numbers to Maria.", now - 4 * DAY);
M.addUpdate(data, budget.id, "Waiting for the headcount figures from HR before the meeting.", now - DAY);
M.addUpdate(data, ci.id, "Linux jobs moved over; macOS runners still pending the image.", now - 2 * DAY);
M.addUpdate(data, quote.id, "Asked Acme for a quote on 3 printers, they promised one by next week.", now - 7 * DAY);
M.setParent(data, slides.id, budget.id, now - 3 * DAY);
M.relate(data, flaky.id, "blocks", ci.id, false, now - 5 * DAY);

const set = (t: any, fields: Record<string, unknown>) => Object.assign(M.findTask(data, t.id), fields);
for (const t of [budget, slides, ci]) set(t, { state: "working" });
data.order.working = [budget.id, ci.id, slides.id];
set(flaky, { state: "stalled", stalledAt: now - 2 * DAY, touched: now - 6 * DAY, stalls: 1 });
set(dentist, { state: "snoozed", snoozedUntil: new Date(2026, 11, 1, 9, 0).getTime() });
set(quote, { state: "watching", watch: { since: now - 7 * DAY, every: { n: 1, unit: "week" }, anchor: now - 7 * DAY, next: now + 2 * 3_600_000, checks: 0 } });
set(release, { state: "settled", settledAt: now - 4 * DAY });
set(blog, { unread: true, unreadReason: "New" });
data.order.inbox = [expenses.id, passport.id, team.id, blog.id];
void team;

const checked = M.parseData(JSON.parse(JSON.stringify(data)));
const ontrackDir = join(root, "data/ontrack");
mkdirSync(ontrackDir, { recursive: true });
writeFileSync(join(ontrackDir, "ontrack.json"), JSON.stringify(checked, null, "\t"));

const recipe = (name: string, installed: string, latest: string, extra: Record<string, unknown> = {}) => {
	const id = `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	const d = { version: `echo ${installed}`, latest: latest.startsWith("exit") ? latest : `echo ${latest}`, update: `echo "evaluation recipe: nothing to update for ${name}"` };
	return { id, provider: "custom", ref: id, name, kind: "custom", identity: id, data: d, addedAt: now - 30 * DAY, policy: "notify", reviewed: recipeHash(d), state: { outdated: false, nextAt: 0, failures: 0 }, ...extra };
};
const items = [
	recipe("Ollama", "0.5.1", "0.6.2"),
	recipe("Terraform", "1.9.8", "1.9.8"),
	recipe("Node.js LTS", "22.11.0", "24.1.0"),
	recipe("Cursor", "0.42.3", "0.43.1"),
	recipe("Internal deploy CLI", "2.3.0", "exit 3"),
	recipe("Postgres.app", "16.4", "17.2", { pinned: true }),
];
const upkeepDir = join(root, "data/upkeep");
mkdirSync(upkeepDir, { recursive: true });
writeFileSync(join(upkeepDir, "items.json"), JSON.stringify(items, null, "\t"));
console.log(`seeded ${checked.tasks.length} OnTrack tasks and ${items.length} Upkeep recipes`);
