import { createContext } from "react";
import type { SelectionTarget } from "../../shared/navigation";

/** A single navigation attempt. Renderers apply it once, after matching items arrive. */
export const SelectionHandoffContext = createContext<(SelectionTarget & { token: number; onApplied: () => void }) | null>(null);
export const SelectionRequestContext = createContext<{ token: number } | null>(null);
