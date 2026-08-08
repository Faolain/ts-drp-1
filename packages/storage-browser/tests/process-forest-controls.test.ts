import { describe, expect, it } from "vitest";

import { parseProcessForest, validateTwoGroupForest } from "./fixtures/process-forest.js";

const VALID_FOREST = [
	" 410 100 410 Fri Aug  7 16:00:00 2026 T node crash-child.js",
	" 420 410 420 Fri Aug  7 16:00:01 2026 T chromium --browser",
	" 421 420 420 Fri Aug  7 16:00:02 2026 T chromium --type=renderer",
].join("\n");

const LINUX_ZYGOTE_FOREST = [
	" 410 100 410 Fri Aug  7 16:00:00 2026 T node crash-child.js",
	" 420 410 420 Fri Aug  7 16:00:01 2026 T chromium --browser",
	" 421 420 420 Fri Aug  7 16:00:02 2026 T chromium --type=zygote",
	" 422 421 420 Fri Aug  7 16:00:03 2026 T chromium --type=renderer",
].join("\n");

describe("Phase 2b synthetic process-forest controls", () => {
	it("parses the exact C-locale process form and proves two groups", () => {
		const forest = parseProcessForest(VALID_FOREST);
		expect(validateTwoGroupForest(forest, 410, 420)).toEqual({
			childPgid: 410,
			browserPgid: 420,
			ownedPids: [410, 420, 421],
		});
	});

	it("accepts a Linux renderer reached transitively through a same-browser-group zygote", () => {
		const forest = parseProcessForest(LINUX_ZYGOTE_FOREST);
		expect(validateTwoGroupForest(forest, 410, 420)).toEqual({
			childPgid: 410,
			browserPgid: 420,
			ownedPids: [410, 420, 421, 422],
		});
	});

	it("rejects malformed, ambiguous, and unsafe renderer topologies", () => {
		expect(() => parseProcessForest("410 100 nope malformed")).toThrow("malformed process line");
		const oneGroup = parseProcessForest(
			[
				" 410 100 410 Fri Aug  7 16:00:00 2026 T node crash-child.js",
				" 420 410 410 Fri Aug  7 16:00:01 2026 T chromium --browser",
				" 421 420 410 Fri Aug  7 16:00:02 2026 T chromium --type=renderer",
			].join("\n")
		);
		expect(() => validateTwoGroupForest(oneGroup, 410, 420)).toThrow("two distinct process groups");
		const rendererFree = parseProcessForest(VALID_FOREST.replace("--type=renderer", "--type=gpu-process"));
		expect(() => validateTwoGroupForest(rendererFree, 410, 420)).toThrow("renderer");
		const crossGroupRenderer = parseProcessForest(LINUX_ZYGOTE_FOREST.replace(" 422 421 420 ", " 422 421 430 "));
		expect(() => validateTwoGroupForest(crossGroupRenderer, 410, 420)).toThrow("renderer");
		const brokenRendererAncestry = parseProcessForest(LINUX_ZYGOTE_FOREST.replace(" 422 421 420 ", " 422 999 420 "));
		expect(() => validateTwoGroupForest(brokenRendererAncestry, 410, 420)).toThrow("renderer");
		const ambiguous = parseProcessForest(`${VALID_FOREST}\n 421 420 420 Fri Aug  7 16:00:02 2026 T chromium duplicate`);
		expect(() => validateTwoGroupForest(ambiguous, 410, 420)).toThrow("ambiguous");
	});
});
