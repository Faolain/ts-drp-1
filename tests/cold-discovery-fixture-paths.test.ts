import "fake-indexeddb/auto";

import { afterEach, expect, it, vi } from "vitest";

import { openD110cARepeatCloseFixture } from "./fixtures/phase-6b-d110c-a/repeat-close-contract.js";

afterEach(() => vi.restoreAllMocks());

it("exercises genuine attempted-close and ordinary strict deletion paths", async () => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
	const deletion = vi.spyOn(indexedDB, "deleteDatabase");
	const fixture = await openD110cARepeatCloseFixture({ retainedControls: false });
	try {
		const adopted = await fixture.advancePendingSuccessor();
		expect(adopted.activation.ok).toBe(true);
		let outcome: unknown;
		try {
			outcome = await fixture.attemptCurrentSuccessorClose();
		} catch (error) {
			outcome = error instanceof Error ? error.message : error;
		}
		expect(typeof outcome).toBe("string");
		expect(deletion.mock.calls.some(([name]) => name.startsWith("d110c-a-next-seal-"))).toBe(true);
		expect(deletion.mock.calls.some(([name]) => name.startsWith("d110c-a-next-snapshot-"))).toBe(true);
	} finally {
		await fixture.close();
	}
	const predecessor = deletion.mock.calls
		.map(([name]) => name)
		.filter(
			(name) => name.startsWith("d110c-a-predecessor-snapshot-") && name.endsWith("--drp-snapshot-quarantine-v1")
		);
	expect(predecessor).toHaveLength(1);
	expect((await indexedDB.databases()).some((database) => predecessor.includes(database.name ?? ""))).toBe(false);
});

it("preserves a genuine post-construction failure while closing the captured predecessor", async () => {
	const primary = new Error("INTENTIONAL_BEFORE_REPEAT_FAILURE");
	const deletion = vi.spyOn(indexedDB, "deleteDatabase");
	await expect(
		openD110cARepeatCloseFixture({ retainedControls: false, beforeRepeatCloseBinding: () => Promise.reject(primary) })
	).rejects.toBe(primary);
	const predecessor = deletion.mock.calls
		.map(([name]) => name)
		.filter(
			(name) => name.startsWith("d110c-a-predecessor-snapshot-") && name.endsWith("--drp-snapshot-quarantine-v1")
		);
	expect(predecessor).toHaveLength(1);
	expect((await indexedDB.databases()).some((database) => predecessor.includes(database.name ?? ""))).toBe(false);
});
