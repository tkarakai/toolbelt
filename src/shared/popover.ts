export function popoverPosition(
  bounds: { x: number; y: number; width: number; height: number },
  display: {
    bounds: { height: number };
    workArea: { x: number; y: number; width: number };
  },
  width = 380,
) {
  const convertedY = display.bounds.height - bounds.y - 1;
  const valid =
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x > 0 &&
    bounds.y > 0 &&
    convertedY >= display.workArea.y - 2 &&
    convertedY <= display.workArea.y + 64;
  return {
    x: Math.round(
      valid
        ? Math.min(
            Math.max(bounds.x - 2, display.workArea.x + 4),
            display.workArea.x + display.workArea.width - width - 4,
          )
        : display.workArea.x + display.workArea.width - width - 8,
    ),
    y: Math.round(
      valid ? display.bounds.height - bounds.y - 1 : display.workArea.y,
    ),
  };
}

export type PopoverLayout = {
  x: number; y: number; width: number; height: number;
  menuWidth: number; menuHeight: number; detailWidth: number;
  detailTop: number; detailHeight: number; overlap: number; side: "left" | "right";
};

/** Keep the menu under its tray icon and align the overlapping submenu to its selected row. */
export function popoverLayout(
  bounds: { x: number; y: number; width: number; height: number },
  display: { bounds: { height: number }; workArea: { x: number; y: number; width: number; height?: number } },
  listHeight: number,
  details: boolean,
  anchorTop = 0,
  reserveHeight = 0,
): PopoverLayout {
  const area = display.workArea;
  const available = Math.max(1, area.width - 8);
  const overlap = details ? Math.min(6, available / 4) : 0;
  const width = Math.min(details ? 760 - overlap : 380, available);
  const menuWidth = details ? Math.min(380, (width + overlap) / 2) : width;
  const detailWidth = details ? width - menuWidth + overlap : 0;
  const anchor = popoverPosition(bounds, display, menuWidth);
  const left = anchor.x - area.x - 4;
  const right = area.x + area.width - 4 - anchor.x - menuWidth;
  const sideWidth = details ? detailWidth - overlap : Math.min(374, available / 2);
  const side = right >= sideWidth || right >= left ? "right" : "left";
  const availableHeight = Math.max(1, (area.height ?? 1040) - Math.max(0, anchor.y - area.y));
  const menuHeight = Math.min(Math.max(120, listHeight), 520, availableHeight);
  const detailHeight = details ? Math.min(520, availableHeight) : 0;
  const detailTop = details ? Math.max(0, Math.min(anchorTop, availableHeight - detailHeight)) : 0;
  return {
    x: Math.round(Math.max(area.x + 4, Math.min(area.x + area.width - width - 4,
      anchor.x - (details && side === "left" ? detailWidth - overlap : 0)))),
    y: anchor.y, width, menuWidth, menuHeight, detailWidth, detailTop, detailHeight, overlap, side,
    height: Math.round(Math.max(menuHeight, detailTop + detailHeight, Math.min(reserveHeight, availableHeight))),
  };
}
