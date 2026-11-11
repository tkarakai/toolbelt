import type { Node, Row } from "./protocol";

/** Renderer selection, carried by the host when a quick-view item opens the main window. */
export type NavigationSelection = { item: string; collection?: string };
export type WindowNavigation = { plugin: string; screen?: string; selection?: NavigationSelection };
export type SelectionTarget = NavigationSelection & { collection: string; ancestors: string[]; groups: string[] };

/** Collections can have different IDs across surfaces; prefer the same collection, then
 * match the stable item ID. Never infer identity from a label or select an unrelated row. */
export function findSelectionTarget(tree: Node, selection: NavigationSelection): SelectionTarget | null {
  const matches: SelectionTarget[] = [];
  const visit = (node: Node) => {
    if (node.type === "list" && node.items.some(item => item.id === selection.item)) {
      matches.push({ ...selection, collection: `list:${node.id}`, ancestors: [], groups: [] });
    }
    if (node.type === "table") {
      const rows = (items: Row[], ancestors: string[], groups: string[]) => {
        for (const row of items) {
          let key = "";
          const rowGroups = row.group === undefined ? groups : (typeof row.group === "string" ? [row.group] : row.group).map(group => {
            key += `\0${typeof group === "string" ? group : group.id ?? group.label}`;
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
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return matches.find(match => match.collection === selection.collection) ?? matches[0] ?? null;
}
