import { expect, test } from "bun:test";
import { keyboardInset } from "../src/ui/hooks/use-keyboard-inset";

test("keyboard inset: the covered bottom of the layout viewport, ignoring browser chrome", () => {
	expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0);
	// iOS: the keyboard shrinks the visual viewport, and focusing an input may pan it.
	expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
	expect(keyboardInset(844, { height: 508, offsetTop: 100 })).toBe(236);
	// A collapsing toolbar is not a keyboard.
	expect(keyboardInset(844, { height: 790, offsetTop: 0 })).toBe(0);
});
