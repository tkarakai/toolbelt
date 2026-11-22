import type { Node, Row } from "./protocol";
import { flatSections, groupKey, sectionGroup, subSectionParents } from "./sections";

/** Renderer selection, carried by the host when a quick-view item opens the main window. */
export type NavigationSelection = { item: string; collection?: string };
export type WindowNavigation = { plugin: string; screen?: string; selection?: NavigationSelection };
export type SelectionTarget = NavigationSelection & { collection: string; ancestors: string[]; groups: string[] };

/** Which selection a target is. A target is recomputed whenever the plugin sends a new tree, so
 *  a collection reveals (scrolls to, expands) its selection only when this key changes; otherwise
 *  every refresh would undo the person's scrolling and collapsing. */
export const selectionKey = (target: SelectionTarget | null): string | null => (target ? `${target.collection}\0${target.item}` : null);

/** Collections can have different IDs across surfaces; prefer the same collection, then
 * match the stable item ID. Never infer identity from a label or select an unrelated row. */
export function findSelectionTarget(tree: Node, selection: NavigationSelection): SelectionTarget | null {
  const matches: SelectionTarget[] = [];
  const visit = (node: Node) => {
    if (node.type === "list" && node.items.some(item => item.id === selection.item)) {
      matches.push({ ...selection, collection: `list:${node.id}`, ancestors: [], groups: [] });
    }
    if (node.type === "table") {
      // A row in a sub-section sits under its parent section too (`["progressing", "snoozed"]`).
      const parents = subSectionParents(node.sections);
      const rows = (items: Row[], ancestors: string[], groups: string[]) => {
        for (const row of items) {
          let key = "";
          const rowGroups = row.group === undefined ? groups : sectionGroup(row.group, parents).map(group => {
            key += `\0${groupKey(group)}`;
            return key;
          });
          rowGroups.forEach((group, index) => {
            if (selection.item === `\u0001group:${group}`) matches.push({ ...selection, collection: `table:${node.id}`, ancestors: [], groups: rowGroups.slice(0, index) });
          });
          if (row.id === selection.item) matches.push({ ...selection, collection: `table:${node.id}`, ancestors, groups: rowGroups });
          if (row.children) rows(row.children, [...ancestors, row.id], rowGroups);
        }
      };
      rows(node.rows, [], []);
      // Declared sections and sub-sections are headers even with no rows (an empty Pinned, say).
      for (const section of flatSections(node.sections)) {
        const parent = parents.get(section.id);
        const groups = parent ? [`\0${parent.id}`] : [];
        if (selection.item === `\u0001group:${groups[0] ?? ""}\0${section.id}`) matches.push({ ...selection, collection: `table:${node.id}`, ancestors: [], groups });
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return matches.find(match => match.collection === selection.collection) ?? matches[0] ?? null;
}

/** Settings may be the first route opened from the tray, with no prior plugin pane. */
export function settingsReturnHash(previous: string, remembered: string | null, pluginIds: string[]): string {
    const previousPlugin = previous.split("/")[1];
    if (previousPlugin && previousPlugin !== "toolbelt" && pluginIds.includes(previousPlugin)) return previous;
    const fallback = remembered && pluginIds.includes(remembered) ? remembered : pluginIds[0];
    return fallback ? `#/${fallback}` : "#/";
}
