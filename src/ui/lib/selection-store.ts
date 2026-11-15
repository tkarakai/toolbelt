import type { NavigationSelection } from "../../shared/navigation";
type Selection = NavigationSelection | null | undefined;
type StorageLike = Pick<Storage, "getItem" | "setItem">;
/** A selection and when it was chosen (`at`, ms). Messages and storage carry the stamp. */
export type StampedSelection = { selection: NavigationSelection | null; at: number };
const equal = (a: Selection, b: Selection) => a === b || (!!a && !!b && a.item === b.item && a.collection === b.collection);

/** One canonical item per plugin, saved independently so window and popover can update
 * it without replacing unrelated preferences. Undefined means no selection was saved yet.
 *
 * The window and the popover are separate web views: a choice reaches the other one twice
 * (the host's relay and a storage event), possibly late and out of order. Each choice is
 * stamped, and an older one never replaces a newer one — otherwise a late copy would move
 * the highlight back to an item the person already left. */
export function createSelectionStore(storage: StorageLike, prefix: string, onChange?: (plugin: string, selection: NavigationSelection | null, at: number) => void, now: () => number = Date.now) {
  const cache = new Map<string, { value: Selection; at: number }>();
  const listeners = new Set<() => void>();
  const key = (plugin: string) => prefix + encodeURIComponent(plugin);
  let clock = 0;
  const stamp = () => (clock = Math.max(now(), clock + 1));
  const read = (plugin: string): { value: Selection; at: number } => {
    try {
      const raw = storage.getItem(key(plugin));
      if (raw === null) return { value: undefined, at: 0 };
      const value = JSON.parse(raw);
      // Current form: { selection, at }. Older builds saved the bare selection (or null).
      if (value && typeof value === "object" && "at" in value && "selection" in value) {
        const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
        if (value.selection === null) return { value: null, at };
        if (valid(value.selection)) return { value: value.selection, at };
        return { value: undefined, at: 0 };
      }
      if (value === null) return { value: null, at: 0 };
      if (valid(value)) return { value, at: 0 };
    } catch {}
    return { value: undefined, at: 0 };
  };
  const entry = (plugin: string) => {
    let e = cache.get(plugin);
    if (!e) cache.set(plugin, (e = read(plugin)));
    return e;
  };
  const get = (plugin: string) => entry(plugin).value;
  const update = (plugin: string, selection: NavigationSelection | null, at: number, notifyHost: boolean) => {
    const current = entry(plugin);
    // Older than what's here: a late copy of a choice already replaced.
    if (at < current.at) return;
    if (equal(current.value, selection)) {
      if (at > current.at) cache.set(plugin, { value: current.value, at });
      return;
    }
    cache.set(plugin, { value: selection, at });
    clock = Math.max(clock, at);
    if (notifyHost) {
      try { storage.setItem(key(plugin), JSON.stringify({ selection, at })); } catch {}
      onChange?.(plugin, selection, at);
    }
    listeners.forEach(listener => listener());
  };
  return {
    get,
    /** This view's own choice: saved, and sent to the other views. */
    set: (plugin: string, selection: NavigationSelection | null) => update(plugin, selection, stamp(), true),
    /** Another view's choice, relayed by the host. Its sender already saved it. */
    apply: (plugin: string, selection: NavigationSelection | null, at = 0) => update(plugin, selection, at || stamp(), false),
    refresh(changedKey: string | null) {
      if (changedKey !== null && !changedKey.startsWith(prefix)) return;
      let changed = false;
      for (const [plugin, current] of cache) {
        if (changedKey !== null && changedKey !== key(plugin)) continue;
        const next = read(plugin);
        if (next.at < current.at || (next.at === current.at && equal(current.value, next.value))) continue;
        if (equal(current.value, next.value)) { cache.set(plugin, next); continue; }
        cache.set(plugin, next);
        clock = Math.max(clock, next.at);
        changed = true;
      }
      if (changed) listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const valid = (v: unknown): v is NavigationSelection =>
  !!v && typeof v === "object" && typeof (v as NavigationSelection).item === "string" &&
  ((v as NavigationSelection).collection === undefined || typeof (v as NavigationSelection).collection === "string");
