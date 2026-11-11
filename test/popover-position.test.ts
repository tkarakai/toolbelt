import { test, expect } from "bun:test";
import { popoverPosition, popoverLayout } from "../src/shared/popover";
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

test("details choose the open side while the plugin list keeps its tray anchor", () => {
  const leftTray = { x: 100, y: 1130, width: 18, height: 18 };
  const rightTray = { x: 1700, y: 1130, width: 18, height: 18 };
  const right = popoverLayout(leftTray, display, 300, true);
  expect(right.side).toBe("right");
  expect(right.x).toBe(popoverPosition(leftTray, display).x);
  const left = popoverLayout(rightTray, display, 300, true);
  expect(left.side).toBe("left");
  expect(left.x + left.detailWidth - left.overlap).toBe(popoverPosition(rightTray, display).x);
  expect(left.height).toBe(520);
  expect(left.width).toBe(754);
});

test("combined panels fit small work areas and lists without selection stay compact", () => {
  const small = { bounds: { height: 450 }, workArea: { x: 100, y: 25, width: 600, height: 400 } };
  const frame = popoverLayout({ x: 0, y: 0, width: 0, height: 0 }, small, 300, true);
  expect(frame.x).toBeGreaterThanOrEqual(104);
  expect(frame.x + frame.width).toBeLessThanOrEqual(696);
  expect(frame.height).toBe(400);
  expect(frame.menuWidth + frame.detailWidth - frame.overlap).toBe(frame.width);
  const list = popoverLayout({ x: 0, y: 0, width: 0, height: 0 }, display, 250, false);
  expect(list.width).toBe(380);
  expect(list.height).toBe(250);
  expect(list.detailWidth).toBe(0);
});


test("submenu aligns with the selected row, overlaps the list, and stays above the work-area bottom", () => {
  const roomy = { ...display, workArea: { ...display.workArea, height: 1080 } };
  const frame = popoverLayout({ x: 1700, y: 1130, width: 18, height: 18 }, roomy, 400, true, 196);
  expect(frame.detailTop).toBe(196);
  expect(frame.overlap).toBe(6);
  expect(frame.menuHeight).toBe(400);
  expect(frame.detailHeight).toBe(520);
  expect(frame.height).toBe(716);
  const short = popoverLayout({ x: 1700, y: 1130, width: 18, height: 18 },
    { ...roomy, workArea: { ...roomy.workArea, height: 600 } }, 400, true, 350);
  expect(short.detailTop).toBe(80);
  expect(short.height).toBe(600);
});


test("closing quick views retain enough window height until their exit completes", () => {
  const roomy = { ...display, workArea: { ...display.workArea, height: 1080 } };
  const frame = popoverLayout({ x: 1700, y: 1130, width: 18, height: 18 }, roomy, 400, true, 40, 800);
  expect(frame.detailTop).toBe(40);
  expect(frame.height).toBe(800);
  expect(popoverLayout({ x: 0, y: 0, width: 0, height: 0 }, roomy, 400, true, 40, 9999).height).toBe(1080);
});
