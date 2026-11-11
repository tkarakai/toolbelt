import { test, expect } from "bun:test";
import { popoverPosition } from "../src/shared/popover";
const display = {
  bounds: { height: 1156 },
  workArea: { x: 0, y: 25, width: 1800 },
};
test("unlaid-out native tray bounds fall back inside visible work area", () => {
  expect(
    popoverPosition({ x: 0, y: 0, width: 18, height: 18 }, display),
  ).toEqual({ x: 1412, y: 25 });
  expect(popoverPosition({ x: 0, y: 0, width: 0, height: 0 }, display)).toEqual(
    { x: 1412, y: 25 },
  );
});
test("laid-out Cocoa tray bounds anchor below menu bar within screen edges", () => {
  expect(
    popoverPosition({ x: 1700, y: 1130, width: 18, height: 18 }, display),
  ).toEqual({ x: 1416, y: 25 });
});
test("negative native tray geometry cannot position popovers below the display", () => {
  expect(
    popoverPosition(
      { x: 0, y: -33, width: 34, height: 22 },
      { bounds: { height: 1117 }, workArea: { x: 0, y: 33, width: 1728 } },
    ),
  ).toEqual({ x: 1340, y: 33 });
});
