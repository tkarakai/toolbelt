// The person's view of each plugin surface (docs/plugins.md, Views): search, filters, sort and
// page controls, shared by the window, the popover and paired devices. The host saves it in
// `views.json` in the plugin profile, so it survives restarts, plugin updates and reinstalls;
// plugins report changes and get it back when the person's instance opens.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ViewState } from "../shared/protocol";
import { validateViewState } from "../shared/validation";
import type { PersonViews } from "./host";

/** Above this, a saved view is dropped rather than kept (a plugin reporting nonsense). */
const MAX_VIEW_BYTES = 64 * 1024;

export class ViewStore implements PersonViews {
	private views: Record<string, Record<string, ViewState>> = {};
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly file: string, private readonly delayMs = 250) {
		try {
			if (existsSync(file)) {
				const saved = JSON.parse(readFileSync(file, "utf8"));
				if (saved && typeof saved === "object")
					for (const [plugin, surfaces] of Object.entries(saved as Record<string, unknown>)) {
						if (!surfaces || typeof surfaces !== "object") continue;
						for (const [surface, view] of Object.entries(surfaces as Record<string, unknown>)) {
							try {
								validateViewState(view);
								(this.views[plugin] ??= {})[surface] = view as ViewState;
							} catch {}
						}
					}
			}
		} catch {
			// A damaged file means default views, not a broken host.
		}
	}

	load(plugin: string, surface: string): ViewState | undefined {
		return this.views[plugin]?.[surface];
	}

	save(plugin: string, surface: string, view: ViewState) {
		if (JSON.stringify(view).length > MAX_VIEW_BYTES) return;
		(this.views[plugin] ??= {})[surface] = view;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), this.delayMs);
	}

	/** Writes pending changes now (on quit). */
	flush() {
		clearTimeout(this.timer);
		this.timer = undefined;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const temp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(this.views, null, "\t"));
			renameSync(temp, this.file);
		} catch (error) {
			console.error(`views: couldn't save ${this.file}: ${(error as Error).message}`);
		}
	}
}
