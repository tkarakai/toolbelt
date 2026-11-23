import { COLLECTION, OVERLAY, isShown, ownsKey } from "./keyboard";

/** Renderer-only keyboard ownership for collections (tables, lists). Inside a dialog, and in
 * popover panes, a collection responds only while focused. On ordinary screens one collection
 * answers: the one holding focus, or, with focus elsewhere (a toolbar button, the page), the
 * screen's first table, so a page with two tables doesn't move both selections at once. Lists
 * outside the popover answer only while focused, so arrows still scroll a page that merely
 * contains one. A focused widget keeps its own keys (`ownsKey`): ←/→ on tabs or a segmented
 * control stay theirs. */
export function ownsCollectionKeyboard(element: HTMLElement | null, e?: KeyboardEvent): boolean {
  if (!element || !isShown(element)) return false;
  const target = (e?.target instanceof Element ? e.target : document.activeElement) ?? document.body;
  if (e && ownsKey(e, element)) return false;
  const overlay = target.closest(OVERLAY);
  if (overlay) return overlay.contains(element) && element.contains(target);
  if (document.querySelector(OVERLAY) && !element.closest(OVERLAY)) return false;
  const pane = element.closest<HTMLElement>("[data-keyboard-pane]");
  if (pane) return pane.dataset.keyboardActive === "true" && element.contains(document.activeElement);
  const focused = target.closest<HTMLElement>(COLLECTION);
  if (focused) return focused === element;
  if (!element.matches("[data-table-focus]")) return false;
  const first = [...document.querySelectorAll<HTMLElement>(`${COLLECTION}[data-table-focus]`)].find((el) => isShown(el) && !el.closest(OVERLAY));
  return first === element;
}

export function focusPopoverCollection(element: HTMLElement | null) {
  if (element?.closest("[data-keyboard-pane]")) element.focus({ preventScroll: true });
}

export { COLLECTION };
const CONTROLS = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']";
export type PaneBookmark = { collection?: string; control: number };
function controls(pane: HTMLElement) {
  return [...pane.querySelectorAll<HTMLElement>(CONTROLS)].filter(el => el.getClientRects().length && !el.closest("[inert], [hidden]"));
}
export function paneBookmark(pane: HTMLElement, target: HTMLElement): PaneBookmark {
  return { collection: target.closest<HTMLElement>(COLLECTION)?.dataset.navigationCollection, control: controls(pane).indexOf(target) };
}
export function restorePaneFocus(pane: HTMLElement, bookmark?: PaneBookmark) {
  const collections = [...pane.querySelectorAll<HTMLElement>(COLLECTION)];
  const remembered = bookmark?.collection ? collections.find(el => el.dataset.navigationCollection === bookmark.collection) : undefined;
  const selected = collections.find(el => el.querySelector("[data-item-id][data-active=true], [data-row-id][data-selected=true]"));
  const target = selected ?? remembered ?? (bookmark && !bookmark.collection ? controls(pane)[bookmark.control] : undefined) ?? collections[0] ?? controls(pane.querySelector<HTMLElement>("[data-quick-content]") ?? pane)[0] ?? controls(pane)[0] ?? pane;
  target.focus({ preventScroll: true });
}

/** Hover moves the highlight only when the pointer itself moved. WebKit also sends
 * mouseenter/mousemove when content moves under a still pointer (a list re-sorting, a panel
 * resizing): those repeat the coordinates of the last real move and must not select. Keep
 * one tracker per collection. */
export function pointerTracker() {
  let last: { x: number; y: number } | null = null;
  return (e: { screenX: number; screenY: number }) => {
    const moved = !last || last.x !== e.screenX || last.y !== e.screenY;
    last = { x: e.screenX, y: e.screenY };
    return moved;
  };
}

/** Layout/scroll changes under a stationary pointer must not override keyboard selection. */
export function canHoverNavigate(element: HTMLElement | null): boolean {
  return element?.closest<HTMLElement>("[data-pointer-navigation]")?.dataset.pointerNavigation !== "false";
}

export function selectedPaneItem(pane: HTMLElement | null, rememberedCollection?: string) {
  if (!pane) return undefined;
  const focused = document.activeElement instanceof HTMLElement && pane.contains(document.activeElement)
    ? document.activeElement.closest<HTMLElement>(COLLECTION) : null;
  const collections = [...pane.querySelectorAll<HTMLElement>(COLLECTION)];
  const collection = focused ?? collections.find(el => el.dataset.navigationCollection === rememberedCollection)
    ?? collections.find(el => el.querySelector("[data-item-id][data-active=true], [data-row-id][data-selected=true]"));
  const item = collection?.querySelector<HTMLElement>("[data-item-id][data-active=true], [data-row-id][data-selected=true]");
  return item ? { item: item.dataset.itemId ?? item.dataset.rowId!, collection: collection?.dataset.navigationCollection } : undefined;
}
