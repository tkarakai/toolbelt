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
