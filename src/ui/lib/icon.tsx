// Plugins name lucide icons in kebab-case ("square-terminal"); look them up by name. Or
// `app:<path>` / `file:<path>`: the icon macOS shows for that app or file, fetched once from the
// main process and cached for the session.
import { useEffect, useState } from "react";
import { icons, type LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/store";

const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export const isFileIcon = (name?: string) => !!name && /^(app|file):/.test(name);

export function Icon({ name, ...props }: { name?: string } & LucideProps) {
	if (isFileIcon(name)) return <FileIcon path={name!.replace(/^(app|file):/, "")} className={props.className} />;
	const C = (name && icons[pascal(name) as keyof typeof icons]) || icons.Box;
	return <C {...props} />;
}

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function load(path: string): Promise<string | null> {
	if (cache.has(path)) return Promise.resolve(cache.get(path)!);
	let p = pending.get(path);
	if (!p) {
		p = rpc.request.fileIcon({ path }).then(
			(url) => (cache.set(path, url), url),
			() => (cache.set(path, null), null),
		);
		pending.set(path, p);
	}
	return p;
}

/** Finder's icon for a path; a neutral app glyph until it arrives (or if there's none). */
function FileIcon({ path, className }: { path: string; className?: string }) {
	const [url, setUrl] = useState(() => cache.get(path) ?? null);
	useEffect(() => {
		let live = true;
		void load(path).then((u) => live && setUrl(u));
		return () => {
			live = false;
		};
	}, [path]);
	if (!url) return <icons.AppWindow className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
	return <img src={url} alt="" draggable={false} className={cn("size-4 shrink-0 object-contain animate-in fade-in-0 duration-200", className)} />;
}
