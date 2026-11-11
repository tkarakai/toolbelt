import { useMemo, useSyncExternalStore } from "react";
import type { PluginInfo } from "../../shared/rpc";

const profile = new URLSearchParams(location.search).get("profile");
const key = profile ? `toolbelt.profile.${profile}.pluginOrder` : "toolbelt.pluginOrder";
function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
}
let order = read();
const listeners = new Set<() => void>();
window.addEventListener("storage", (event) => {
  if (event.key !== key && event.key !== null) return;
  order = read();
  listeners.forEach(fn => fn());
});
export function setPluginOrder(ids: string[]) {
  order = ids;
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch {}
  listeners.forEach(fn => fn());
}
export function useOrderedPlugins(plugins: PluginInfo[]) {
  const ids = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => order);
  return useMemo(() => {
    const rank = new Map(ids.map((id, index) => [id, index]));
    return [...plugins].sort((a, b) => (rank.get(a.manifest.id) ?? Infinity) - (rank.get(b.manifest.id) ?? Infinity));
  }, [plugins, ids]);
}
