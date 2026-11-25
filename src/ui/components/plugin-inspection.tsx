import type { ReactNode } from "react";
import { CircleCheck, CircleX, ShieldCheck, ShieldAlert } from "lucide-react";
import type { PluginInspection } from "../../shared/plugin-inspection";
import type { ManagedPlugin } from "../plugin-manager-model";
import { cn } from "../lib/utils";
import { pillClass } from "../renderer/colors";
import { DiagnosticDisclosure } from "./diagnostic-disclosure";

const day = (at?: number) => (at ? new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : undefined);

/** Requirements the plugin declares that this host doesn't meet, in words. */
export function unmetRequirements(i: PluginInspection) {
  const unmet: string[] = [];
  if (!i.host.ok) unmet.push(`ToolBelt ${i.host.requires}`);
  if (!i.bun.ok) unmet.push(`Bun ${i.bun.requires}`);
  if (!i.platforms.ok) unmet.push(`platform ${i.platforms.declared.join(", ")}`);
  if (!i.protocol.ok) unmet.push(`protocol ${i.protocol.plugin}`);
  const missing = i.capabilities.required.filter((c) => !c.supported);
  if (missing.length) unmet.push(`${missing.length === 1 ? "capability" : "capabilities"} ${missing.map((c) => c.id).join(", ")}`);
  return unmet;
}

/** How the plugin's `agent.access` declaration reads to a person. */
export function agentAccessText(access: PluginInspection["agentAccess"]) {
  if (access === "none") return { label: "Kept from agents", detail: "The plugin declares that agents may not see it." };
  if (access === "read") return { label: "Read only", detail: "The plugin lets agents read its screens. You can lower this in Settings → Agents." };
  if (access === "act") return { label: "Read and act", detail: "The plugin declares agents may act on it. ToolBelt currently allows reading only." };
  return { label: "Not declared", detail: "Made before agent access existed, so it's hidden from agents unless you allow it in Settings → Agents." };
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className="inline-flex min-w-0 items-start gap-1.5">
    {ok ? <CircleCheck aria-label="Met" className="mt-0.5 size-3.5 shrink-0 text-green-600"/> : <CircleX aria-label="Not met" className="mt-0.5 size-3.5 shrink-0 text-destructive"/>}
    <span className="min-w-0 break-words">{children}</span>
  </span>;
}

function Capabilities({ items, optional = false }: { items: { id: string; supported: boolean }[]; optional?: boolean }) {
  if (!items.length) return <span className="text-muted-foreground">None</span>;
  return <ul className="flex flex-wrap gap-1" aria-label={optional ? "Optional capabilities" : "Required capabilities"}>
    {items.map((c) => <li key={c.id} title={c.supported ? "Supported by this ToolBelt" : optional ? "Not in this ToolBelt; the plugin works without it" : "Not in this ToolBelt"}
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px]", pillClass(c.supported ? "muted" : optional ? "warning" : "danger"))}>
      {!c.supported && <span className="sr-only">Unsupported: </span>}{c.id}
    </li>)}
  </ul>;
}

function updateText(p: ManagedPlugin) {
  if (p.local) return "Local archive, not checked for updates";
  if (p.availableVersion) return `Version ${p.availableVersion} is available${p.availablePublishedAt ? `, released ${day(p.availablePublishedAt)}` : ""}`;
  if (p.updateFailure) return "The last check failed";
  if (p.updateCheckedAt) return `Up to date (checked ${day(p.updateCheckedAt)})`;
  return "Not checked yet";
}

/** Compatibility facts for one installed plugin; collapsed by default. */
export function PluginInspectionDetails({ plugin: p }: { plugin: ManagedPlugin }) {
  const i = p.inspection;
  if (!i) return null;
  const unmet = unmetRequirements(i);
  const agent = agentAccessText(i.agentAccess);
  const unsupportedOptional = i.capabilities.optional.filter((c) => !c.supported).length;
  const provides = [`${i.screens} ${i.screens === 1 ? "screen" : "screens"}`, ...(i.quickView ? ["quick view"] : []), ...(i.command ? [`the ${i.command} command`] : [])];
  return <DiagnosticDisclosure
    title="Compatibility and details"
    icon={i.compatible ? <ShieldCheck className="size-4 text-green-600"/> : <ShieldAlert className="size-4 text-destructive"/>}
    metadata={i.compatible ? (unsupportedOptional ? `Compatible · ${unsupportedOptional} optional ${unsupportedOptional === 1 ? "feature" : "features"} unavailable` : "Compatible with this ToolBelt") : `Needs ${unmet.join("; ")}`}
    className="bg-transparent">
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-xs sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)]">
      <dt className="font-medium text-muted-foreground">Released</dt>
      <dd>{day(p.publishedAt) ?? (p.local ? "Local archive" : "Not recorded")}{p.installedAt ? ` · installed ${day(p.installedAt)}` : ""}</dd>
      <dt className="font-medium text-muted-foreground">Updates</dt>
      <dd>{updateText(p)}</dd>
      <dt className="font-medium text-muted-foreground">ToolBelt</dt>
      <dd><Check ok={i.host.ok}>Requires <span className="font-mono">{i.host.requires}</span>; this is <span className="font-mono">{i.host.version}</span></Check></dd>
      <dt className="font-medium text-muted-foreground">Bun</dt>
      <dd><Check ok={i.bun.ok}>Requires <span className="font-mono">{i.bun.requires}</span>; ToolBelt runs <span className="font-mono">{i.bun.version}</span></Check></dd>
      <dt className="font-medium text-muted-foreground">Platforms</dt>
      <dd><Check ok={i.platforms.ok}><span className="font-mono">{i.platforms.declared.join(", ")}</span>; this Mac is <span className="font-mono">{i.platforms.current}</span></Check></dd>
      <dt className="font-medium text-muted-foreground">Protocol</dt>
      <dd><Check ok={i.protocol.ok}>Version <span className="font-mono">{i.protocol.plugin}</span>; ToolBelt speaks <span className="font-mono">{i.protocol.host}</span></Check></dd>
      <dt className="font-medium text-muted-foreground">SDK</dt>
      <dd>{i.sdk ? <span className="font-mono">{i.sdk}</span> : <span className="text-muted-foreground">Reported once the plugin is running</span>}</dd>
      <dt className="font-medium text-muted-foreground">Required capabilities</dt>
      <dd><Capabilities items={i.capabilities.required}/></dd>
      <dt className="font-medium text-muted-foreground">Optional capabilities</dt>
      <dd className="space-y-1"><Capabilities items={i.capabilities.optional} optional/>{unsupportedOptional > 0 && <p className="text-muted-foreground">Highlighted ones aren't in this ToolBelt; the plugin works without them.</p>}</dd>
      <dt className="font-medium text-muted-foreground">Agent access</dt>
      <dd><span className="font-medium">{agent.label}</span><span className="text-muted-foreground"> · {agent.detail}</span></dd>
      <dt className="font-medium text-muted-foreground">Data schema</dt>
      <dd>Version <span className="font-mono">{i.data.schema}</span>{i.data.supports && i.data.supports.length > 1 ? <>; reads <span className="font-mono">{i.data.supports.join(", ")}</span></> : null}</dd>
      <dt className="font-medium text-muted-foreground">Provides</dt>
      <dd>{provides.join(", ").replace(/^./, (c) => c.toUpperCase())}</dd>
    </dl>
  </DiagnosticDisclosure>;
}
