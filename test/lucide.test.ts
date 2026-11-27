import { describe, expect, test } from "bun:test";
import { icons } from "lucide-react";
import { lucideIcon } from "../src/ui/lib/lucide";

describe("lucideIcon", () => {
	test("canonical kebab-case names", () => {
		expect(lucideIcon("square-terminal")).toBe(icons.SquareTerminal);
		expect(lucideIcon("rotate-ccw-clock")).toBe(icons.RotateCcwClock);
	});
	test("aliases and renamed icons resolve to the current icon", () => {
		expect(lucideIcon("history")).toBe(icons.RotateCcwClock);
		expect(lucideIcon("trash-2")).toBe(icons.Trash);
	});
	test("unknown names, non-icon exports and odd spellings are null", () => {
		for (const name of [undefined, "", "no-such-icon", "icon", "icons", "create-lucide-icon", "lucide-provider", "history-icon", "lucide-history", "History", "square_terminal", "-x", "constructor", "to-string"]) expect(lucideIcon(name)).toBeNull();
	});
});
