import "fake-indexeddb/auto";

import { describe, it } from "vitest";

import { proveD110c0c1f2MissingMultiAuthorFrontier } from "./fixtures/phase-6b-d110c-0c1f2/multi-author-frontier-contract.js";

describe("D.110c-0c1f2 compact multi-author issuance-frontier RED", () => {
	it("requires a bounded authenticated frontier for every admitted successor writer", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		await proveD110c0c1f2MissingMultiAuthorFrontier();
	});
});
