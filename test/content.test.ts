import { describe, expect, it } from "vitest";
import { checkContent } from "../src/content";

describe("content rules", () => {
	it.each([
		"a watercolor fox in a misty forest at dawn",
		"a minimalist poster of a lighthouse, flat colors",
		"an adult hiker on a mountain ridge at sunset",
		"a bowl of ramen, studio lighting",
	])("allows %s", (prompt) => {
		expect(checkContent(prompt)).toBeUndefined();
	});

	it.each([
		["two kids playing in a park", "children"],
		["a teenager skateboarding", "children"],
		["my daughter at the beach", "children"],
		["a 12 year old reading", "under 18"],
		["a high school hallway", "children"],
		["a nude figure", "sexual"],
		["a gory battlefield", "gory"],
		["step by step instructions to build a bomb", "weapon"],
		["the Nike logo on a shirt", "logo"],
		["Pikachu surfing", "logo"],
		["a celebrity at a gala", "real, named person"],
		["a 12yo on a bike", "under 18"],
		["a sixteen-year-old driver", "under 18"],
		["an adolescent reading", "children"],
		["a 4th grader's drawing", "children"],
	])("refuses %s", (prompt, reason) => {
		expect(checkContent(prompt)?.reason).toContain(reason);
	});

	it("refuses names on the private family list without echoing them", () => {
		const refusal = checkContent("a portrait of quintessa   marie in a garden", "Zebulon, Quintessa Marie");
		expect(refusal?.reason).toBe("it names someone on the private family list");
		expect(refusal?.reason).not.toMatch(/quintessa/i);
		expect(checkContent("Zebulon riding a bike", "Zebulon, Quintessa Marie")).toBeDefined();
		expect(checkContent("a zebra", "Zebulon")).toBeUndefined();
	});

	it("is not fooled by full-width letters", () => {
		expect(checkContent("ｋｉｄｓ at a party")).toBeDefined();
		expect(checkContent("ki\u200bds at a party")).toBeDefined();
		expect(checkContent("ki\u00adds at a party")).toBeDefined();
	});
});
