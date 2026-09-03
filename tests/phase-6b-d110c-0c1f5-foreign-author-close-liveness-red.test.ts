import "fake-indexeddb/auto";

import { describe, it, vi } from "vitest";

import { proveD110c0c1f5ForeignAuthorCloseLivenessRequired } from "./fixtures/phase-6b-d110c-0c1f5/foreign-author-close-liveness-contract.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("D.110c-0c1f5 foreign-author close-liveness RED", () => {
	it("requires foreign frontier anomalies to remain author-local while creator corruption stays fail closed", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		await proveD110c0c1f5ForeignAuthorCloseLivenessRequired();
	});
});
