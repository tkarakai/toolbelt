type StorageLike = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
const prefix = (store: string) => `${store}.entry.`;

/** Read older aggregate preferences, then overlay independently saved entries. */
export function readUIEntries(storage: StorageLike, store: string): [string, unknown][] {
  const entries = new Map<string, unknown>();
  try {
    const legacy: unknown = JSON.parse(storage.getItem(store) ?? "{}");
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      for (const [key, value] of Object.entries(legacy)) entries.set(key, value);
    }
  } catch {}
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix(store))) continue;
    try {
      entries.set(decodeURIComponent(key.slice(prefix(store).length)), JSON.parse(storage.getItem(key)!));
    } catch {}
  }
  return [...entries];
}

/** One atomic localStorage key per preference prevents independent web views from
 * overwriting each other's stale snapshots of the aggregate UI-state document. */
export function writeUIEntry(storage: StorageLike, store: string, key: string, value: unknown) {
  storage.setItem(prefix(store) + encodeURIComponent(key), JSON.stringify(value));
}
