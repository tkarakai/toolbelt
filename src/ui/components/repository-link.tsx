import { ExternalLink } from "lucide-react";
import { openUrl } from "@/lib/store";

export function RepositoryLink({repo}: {repo: string}) {
    const url = `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}`;
    return <a href={url} className="group mt-1 inline-flex max-w-full items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={event => {
        event.preventDefault();
        openUrl(url);
    }}><span className="min-w-0 break-all underline-offset-2 group-hover:underline group-focus-visible:underline">{repo}</span><ExternalLink aria-hidden="true" className="size-3 shrink-0 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"/></a>;
}
