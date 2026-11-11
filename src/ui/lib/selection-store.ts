import type { NavigationSelection } from "../../shared/navigation";
type Selection = NavigationSelection | null | undefined;
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const equal = (a: Selection, b: Selection) => a === b || (!!a && !!b && a.item === b.item && a.collection === b.collection);

/** One canonical item per plugin, saved independently so window and popover can update
 * it without replacing unrelated preferences. Undefined means no selection was saved yet. */
export function createSelectionStore(storage: StorageLike, prefix: string, onChange?: (plugin: string, selection: NavigationSelection | null) => void) {
  const cache = new Map<string, Selection>();
  const listeners = new Set<() => void>();
  const key = (plugin: string) => prefix + encodeURIComponent(plugin);
  const read = (plugin: string): Selection => {
    try {
      const raw = storage.getItem(key(plugin));
      if (raw === null) return undefined;
      const value = JSON.parse(raw);
      if (value === null) return null;
      if (typeof value?.item === "string" && (value.collection === undefined || typeof value.collection === "string")) return value;
    } catch {}
    return undefined;
  };
  const get = (plugin: string) => {
    if (!cache.has(plugin)) cache.set(plugin, read(plugin));
    return cache.get(plugin);
  };
  const update = (plugin: string, selection: NavigationSelection | null, notifyHost: boolean) => {
    if (equal(get(plugin), selection)) return;
    cache.set(plugin, selection);
    try { storage.setItem(key(plugin), JSON.stringify(selection)); } catch {}
    if (notifyHost) onChange?.(plugin, selection);
    listeners.forEach(listener => listener());
  };
  return {
    get,
    set: (plugin: string, selection: NavigationSelection | null) => update(plugin, selection, true),
    apply: (plugin: string, selection: NavigationSelection | null) => update(plugin, selection, false),
    refresh(changedKey: string | null) {
      if (changedKey !== null && !changedKey.startsWith(prefix)) return;
      let changed = false;
      for (const plugin of cache.keys()) {
        if (changedKey !== null && changedKey !== key(plugin)) continue;
        const value = read(plugin);
        if (!equal(cache.get(plugin), value)) { cache.set(plugin, value); changed = true; }
      }
      if (changed) listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
