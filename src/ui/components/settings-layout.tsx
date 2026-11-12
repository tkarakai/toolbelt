import type { ReactNode } from "react";

export function SettingsGroup({title, description, actions, children, separated = false}: {title: ReactNode; description?: string; actions?: ReactNode; children: ReactNode; separated?: boolean}) {
    return <section aria-label={typeof title === "string" ? title : undefined} className="min-w-0 space-y-3"><div className="flex min-h-6 flex-wrap items-center justify-between gap-3 px-1"><h2 className="text-base font-semibold">{title}</h2>{actions}</div>{description && <p className="px-1 text-sm text-muted-foreground">{description}</p>}<div className={separated ? "min-w-0 space-y-[5px]" : "min-w-0 divide-y rounded-xl border bg-card shadow-sm"}>{children}</div></section>;
}
export function SettingsRow({title, description, children}: {title: string; description?: ReactNode; children?: ReactNode}) {
    return <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{title}</h3>{description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}</div>{children}</div>;
}
