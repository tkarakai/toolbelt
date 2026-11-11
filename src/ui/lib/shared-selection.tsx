import { rpc, selectionListeners } from "./store";
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { findSelectionTarget, type NavigationSelection, type SelectionTarget } from "../../shared/navigation";
import type { Node } from "../../shared/protocol";
import { createSelectionStore } from "./selection-store";
import { SurfaceContext, uiState, useUIState } from "./uistate";

const profile = new URLSearchParams(location.search).get("profile");
const store = createSelectionStore(localStorage, profile ? `toolbelt.profile.${profile}.selection.` : "toolbelt.selection.",
  (plugin, selection) => rpc.send.selectionChanged({ plugin, selection }));
selectionListeners.add(({ plugin, selection }) => store.apply(plugin, selection));
export const refreshSharedSelection = () => store.refresh(null);
window.addEventListener("focus", refreshSharedSelection);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshSharedSelection(); });
window.addEventListener("storage", event => store.refresh(event.key));
export const readSharedSelection = store.get;
export const writeSharedSelection = store.set;
const SharedSelection = createContext<{ target: SelectionTarget | null; select: (selection: NavigationSelection | null) => void } | null>(null);

/** Only main-window legacy selection seeds the canonical model. Old quick-view memories
 * do not create a selection when a plugin is previewed for the first time. */
function legacySelection(node: Node, surface: string): NavigationSelection | null {
  if (node.type === "table" || node.type === "list") {
    const item = uiState.get<string>(surface, `${node.id}:${node.type === "table" ? "selected" : "active"}`);
    if (item && findSelectionTarget(node, { item })) return { item, collection: `${node.type}:${node.id}` };
  }
  if ("children" in node) for (const child of node.children) {
    const match = legacySelection(child, surface);
    if (match) return match;
  }
  return null;
}

export function SharedSelectionProvider({ plugin, tree, seedLegacy = false, children }: { plugin: string; tree: Node; seedLegacy?: boolean; children: ReactNode }) {
  const surface = useContext(SurfaceContext);
  const selection = useSyncExternalStore(store.subscribe, () => store.get(plugin));
  const target = useMemo(() => selection ? findSelectionTarget(tree, selection) : null, [tree, selection]);
  const select = useCallback((next: NavigationSelection | null) => store.set(plugin, next), [plugin]);
  useEffect(() => {
    if (seedLegacy && selection === undefined) {
      const previous = legacySelection(tree, surface);
      if (previous) store.set(plugin, previous);
    }
  }, [seedLegacy, selection, tree, surface, plugin]);
  const value = useMemo(() => ({ target, select }), [target, select]);
  return <SharedSelection.Provider value={value}>{children}</SharedSelection.Provider>;
}

export function useCollectionSelection(name: string, collection: string): [string | null, (id: string | null) => void, SelectionTarget | null] {
  const [local, setLocal] = useUIState<string | null>(name, null);
  const shared = useContext(SharedSelection);
  const target = shared?.target?.collection === collection ? shared.target : null;
  const set = useCallback((id: string | null) => {
    if (shared) shared.select(id === null ? null : { item: id, collection });
    else setLocal(id);
  }, [shared?.select, collection, setLocal]);
  return [shared ? target?.item ?? null : local, set, target];
}

/** Dialog-local choices are not the plugin's selected entity in its main/quick views. */
export function LocalSelectionProvider({ children }: { children: ReactNode }) {
  return <SharedSelection.Provider value={null}>{children}</SharedSelection.Provider>;
}
