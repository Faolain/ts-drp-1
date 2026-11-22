import type { AheDurableStore, StorageObjectId } from "@ts-drp/storage";
import { describe, expect, it } from "vitest";

// The package entry installs the live registry before creator close loads.
import "../src/index.js";
import { inspectHead } from "../src/creator-close.js";

// A refused native recovery must stay diagnosable: the original store result,
// including its typed reason and substrate cause, travels with the refusal.
describe("creator close head inspection", () => {
	it("keeps the store's refusal reason and cause in the error it throws", async () => {
		const cause = new Error("database is locked");
		const refused = Object.freeze({ ok: false as const, reason: "SUBSTRATE_FAILURE" as const, cause });
		const store = {
			recoverActiveGeneration: () => Promise.resolve(refused),
			getBlob: () => Promise.reject(new Error("unreachable")),
		} as unknown as AheDurableStore;
		const failure = await inspectHead(store, "creator:inspect-head-reason" as StorageObjectId).then(
			() => undefined,
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(TypeError);
		expect((failure as TypeError).message).toBe(
			"creator close active generation is unavailable: SUBSTRATE_FAILURE: database is locked"
		);
		expect((failure as TypeError).cause).toBe(refused);
	});
});
