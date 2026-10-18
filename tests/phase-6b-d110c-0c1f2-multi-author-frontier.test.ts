import "fake-indexeddb/auto";

import { beforeAll, describe, expect, it } from "vitest";

import { proveD110c0c1f2MissingMultiAuthorFrontier } from "./fixtures/phase-6b-d110c-0c1f2/multi-author-frontier-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

describe("D.110c-0c1f2 bounded multi-author issuance frontier", () => {
	it("authenticates the exact creator-signed frontiers from a genuine two-writer close", async () => {
		await expect(proveD110c0c1f2MissingMultiAuthorFrontier()).resolves.toBeUndefined();
	});
});
