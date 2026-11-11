/** Renderer-only keyboard ownership for adjacent host panes. Ordinary screens retain
 * their existing keyboard behavior; a popover collection responds only while focused. */
export function ownsCollectionKeyboard(element: HTMLElement | null): boolean {
  if (!element) return false;
  const pane = element.closest<HTMLElement>("[data-keyboard-pane]");
  if (!pane) return true;
  if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return false;
  return pane.dataset.keyboardActive === "true" && element.contains(document.activeElement);
}

export function focusPopoverCollection(element: HTMLElement | null) {
  if (element?.closest("[data-keyboard-pane]")) element.focus({ preventScroll: true });
}

export const COLLECTION = "[data-navigation-collection]";
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
