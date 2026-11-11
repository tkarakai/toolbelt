import { openUrl } from "@/lib/store";

export function RepositoryLink({repo}: {repo: string}) {
    const url = `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}`;
    return <a href={url} className="mt-1 inline-block break-all rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={event => {
        event.preventDefault();
        openUrl(url);
    }}>{repo}</a>;
}
