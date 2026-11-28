// Which view sent each recent plugin event, by event id (docs/architecture.md, "Transport and
// rendering"): a plugin's navigation tagged with an event goes back to that view (the Mac's window
// or popover, a paired device, a preview tab). Entries last as long as the host honors navigation.
import { NAVIGATE_GRACE_MS } from "./host";

export class EventRoutes<V> {
  private routes = new Map<string, { view: V; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Remembers the view that sent event `id` (null: the host refused the event; nothing to remember). */
  record(id: string | null, view: V) {
    if (id === null) return;
    const now = this.now();
    for (const [key, route] of this.routes) if (now - route.at > NAVIGATE_GRACE_MS) this.routes.delete(key);
    this.routes.set(id, { view, at: now });
  }

  /** The view that sent event `id`, while its navigation may still be honored. */
  viewOf(id: string): V | undefined {
    const route = this.routes.get(id);
    return route && this.now() - route.at <= NAVIGATE_GRACE_MS ? route.view : undefined;
  }
}
