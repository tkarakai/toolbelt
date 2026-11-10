import { expect, test } from "bun:test";
import { assignLetters } from "../src/shared/letters";

const tools = (...names: string[]) => names.map((name) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name }));

test("first letter of the name", () => {
	expect([...assignLetters(tools("Processes", "Showcase"))]).toEqual([
		["processes", "p"],
		["showcase", "s"],
	]);
});

test("a clash moves on to the next word's start, then the rest of the name", () => {
	const m = assignLetters(tools("Processes", "Port Scanner", "Ports"));
	expect(m.get("processes")).toBe("p");
	expect(m.get("port-scanner")).toBe("s");
	expect(m.get("ports")).toBe("o");
});

test("falls back to any free letter, and stops after 26", () => {
	const many = tools(...Array.from({ length: 30 }, (_, i) => `A${i}`));
	const m = assignLetters(many);
	expect(m.size).toBe(26);
	expect(new Set(m.values()).size).toBe(26);
	expect(m.get("a0")).toBe("a");
	expect(m.get("a1")).toBe("b");
});
