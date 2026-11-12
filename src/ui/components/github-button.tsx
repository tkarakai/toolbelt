import type { ComponentProps } from "react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useRecoveryClock } from "./update-recovery";

export function rateLimitTooltip(retryAt: number, now: number) {
  const minutes = Math.max(1, Math.ceil((retryAt - now) / 60000));
  return `GitHub is rate limiting requests. Checks resume at ${new Date(retryAt).toLocaleString()}. Please try in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
/** A focusable wrapper keeps the explanation accessible while its button is disabled. */
export function GitHubButton({ retryAt, hint, disabled, ...props }: ComponentProps<typeof Button> & { retryAt?: number; hint?: string }) {
  const now = useRecoveryClock();
  const blocked = (retryAt ?? 0) > now;
  const text = blocked ? rateLimitTooltip(retryAt!, now) : hint;
  const button = <Button {...props} disabled={disabled || blocked}/>;
  if (!text) return button;
  return <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span className="inline-flex max-w-full" tabIndex={disabled || blocked ? 0 : undefined}>{button}</span></TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip></TooltipProvider>;
}
