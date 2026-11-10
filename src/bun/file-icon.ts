// The icons macOS shows for files and apps (Finder's), as PNG data URLs — for `app:<path>` and
// `file:<path>` icons in plugin trees. NSWorkspace draws them; we reach it through JavaScript
// for Automation (`osascript -l JavaScript`, always present), many paths per call, and cache the
// results in memory and on disk. No Electrobun imports, so the browser preview can use it too.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const SIZE = 64; // px: 32 pt at 2x

const SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const out = argv[0], size = ${SIZE};
  for (let i = 1; i < argv.length; i += 2) {
    const img = $.NSWorkspace.sharedWorkspace.iconForFile(argv[i]);
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
    $.NSGraphicsContext.restoreGraphicsState;
    rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(out + "/" + argv[i + 1] + ".png", true);
  }
}`;

export class FileIcons {
	private memory = new Map<string, string | null>();
	private waiting = new Map<string, ((url: string | null) => void)[]>();
	private queue = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;

	constructor(private readonly cacheDir: string) {}

	/** The icon of `path` as a data URL, or null when there's no such file. */
	get(path: string): Promise<string | null> {
		if (this.memory.has(path)) return Promise.resolve(this.memory.get(path)!);
		return new Promise((resolve) => {
			const list = this.waiting.get(path) ?? [];
			list.push(resolve);
			this.waiting.set(path, list);
			this.queue.add(path);
			// Gather the requests of one render into one osascript call.
			clearTimeout(this.timer);
			this.timer = setTimeout(() => void this.flush(), 30);
		});
	}

	private file(path: string) {
		return join(this.cacheDir, createHash("sha1").update(path).digest("hex").slice(0, 16) + ".png");
	}

	private done(path: string, url: string | null) {
		this.memory.set(path, url);
		for (const r of this.waiting.get(path) ?? []) r(url);
		this.waiting.delete(path);
	}

	private async flush() {
		const paths = [...this.queue];
		this.queue.clear();
		const todo: { path: string; real: string; key: string }[] = [];
		for (const path of paths) {
			let real: string;
			try {
				real = realpathSync(path); // an alias (/Applications/Safari.app) would get the arrow badge
			} catch {
				this.done(path, null);
				continue;
			}
			const cached = this.file(real);
			if (existsSync(cached)) this.done(path, dataUrl(cached));
			else todo.push({ path, real, key: cached.slice(this.cacheDir.length + 1, -4) });
		}
		if (!todo.length) return;
		try {
			mkdirSync(this.cacheDir, { recursive: true });
			const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", SCRIPT, this.cacheDir, ...todo.flatMap((t) => [t.real, t.key])], { stdout: "ignore", stderr: "pipe" });
			const timeout = setTimeout(() => proc.kill(), 15_000);
			await proc.exited;
			clearTimeout(timeout);
		} catch (e) {
			console.error(`file icons: ${(e as Error).message}`);
		}
		for (const t of todo) {
			const f = this.file(t.real);
			this.done(t.path, existsSync(f) ? dataUrl(f) : null);
		}
	}
}

const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
