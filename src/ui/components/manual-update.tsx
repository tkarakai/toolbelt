import { toast } from "sonner";
import { useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { openUrl } from "../lib/store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

type Props = {
  name: string;
  version: string;
  repo: string;
  failed?: boolean;
  prerelease?: boolean;
  review?: (tag: string) => void;
  busy?: boolean;
};

/** Browser discovery is available independently of the GitHub API check. */
export function ManualUpdate({ name, version, repo, failed, prerelease, review, busy }: Props) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [copied, setCopied] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const page = `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/releases${prerelease ? "" : "/latest"}`;
  async function copyInstructions() {
    const guide = content.current;
    if (!guide) return;
    const description = guide.querySelector("[data-slot=dialog-description]")?.textContent ?? "";
    const steps = [...guide.querySelectorAll("ol li")].map((step, index) => `${index + 1}. ${step.textContent}`).join("\n");
    const note = guide.querySelector("[data-copy-note]")?.textContent ?? "";
    try {
      const text = ["Check for a newer release", description, page, steps, note].join("\n\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const field = document.createElement("textarea");
        const focused = document.activeElement;
        field.value = text;
        field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        guide.appendChild(field);
        try {
          field.focus();
          field.select();
          if (!document.execCommand("copy")) throw new Error("Copy failed");
        } finally {
          field.remove();
          if (focused instanceof HTMLElement) focused.focus();
        }
      }
      setCopied(true);
    } catch {
      toast.error("Couldn’t copy instructions. Please try again.");
    }
  }
  return <>
    {failed && <div role="status" className="space-y-3 rounded-lg bg-muted/50 p-4">
      <div className="space-y-1"><h4 className="text-sm font-medium">Can’t reach the update service</h4>
        <p className="text-xs leading-relaxed text-muted-foreground">GitHub sometimes limits update requests. We couldn’t confirm whether a newer version of {name} is available.</p></div>
      <Button size="sm" onClick={() => setOpen(true)}>Check in your browser<ExternalLink/></Button>
    </div>}
    <Button variant="link" size="sm" className="h-auto max-w-full whitespace-normal px-0 text-xs text-muted-foreground" onClick={() => setOpen(true)}>Check or {review ? "update" : "install"} manually<ExternalLink className="shrink-0"/></Button>
    <Dialog open={open} onOpenChange={value => { setOpen(value); setCopied(false); }}>
      <DialogContent ref={content} className="max-h-[min(42rem,90dvh)] overflow-y-auto sm:max-w-[31.2rem]">
        <DialogHeader><DialogTitle>Check for a newer release</DialogTitle><DialogDescription>You have {name} {version}. Compare it with the {prerelease ? "stable or prerelease" : "latest stable"} {review ? "plugin" : "app"} release on GitHub. If the versions match, you’re already up to date.</DialogDescription></DialogHeader>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-muted-foreground">
          {review ? <>
            <li>Open the releases page and find a newer compatible plugin release.</li>
            <li>Copy its release tag, then enter it below to review the update in ToolBelt.</li>
            <li>Review the publisher, version and compatibility, then approve the update.</li>
          </> : <>
            <li>On GitHub, open Assets and download <span className="inline-block max-w-full overflow-x-auto align-bottom whitespace-nowrap font-medium text-foreground">Toolbelt-&lt;version&gt;-arm64.dmg</span> if its app version is newer than yours.</li>
            <li>Quit ToolBelt completely, including its menu-bar process.</li>
            <li>Open the DMG. Drag ToolBelt into Applications and choose Replace.</li>
            <li>Launch ToolBelt again.</li>
          </>}
        </ol>
        <p data-copy-note className="text-xs leading-relaxed text-muted-foreground">{review ? "ToolBelt still needs GitHub access to verify and install the release. If requests remain blocked, try again later. Your installed plugin stays in place." : "Your settings, installed plugins and plugin data stay in place. If GitHub’s website is also unavailable, try again later."}</p>
        {review && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!tag.trim() || busy) return; setOpen(false); review(tag.trim()); }}>
          <label className="block text-xs font-medium">Release tag<Input value={tag} onChange={event => setTag(event.target.value)} placeholder="For example, v1.2.3" className="mt-1"/></label>
          <Button type="submit" variant="outline" size="sm" disabled={busy || !tag.trim()}>Review release in ToolBelt</Button>
        </form>}
        <DialogFooter className="flex-col gap-3 sm:flex-col">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end"><Button variant="outline" onClick={() => void copyInstructions()}>{copied ? <Check/> : <Copy/>}{copied ? "Copied" : "Copy instructions"}</Button><Button variant="outline" onClick={() => setOpen(false)}>Done</Button><Button onClick={() => openUrl(page)}>Open releases on GitHub<ExternalLink/></Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
