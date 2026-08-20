import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	classifyTerminalSuppression,
	createEphemeralDurableIssuanceStore,
	type TerminalClassificationInput,
} from "../packages/issuance-store/src/conformance.js";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssueCommit,
	DurableIssueScope,
	DurableLineage,
} from "../packages/issuance-store/src/types.js";

interface IssuanceError extends Error {
	readonly code: string;
}

interface NativeOutboxRecord {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly publishState: "pending" | "published";
	readonly scope: DurableIssueScope;
}

const SCOPE: DurableIssueScope = { author: "alice", objectId: "room:general" };

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function commitFor(authorSequence: number): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({
			author: SCOPE.author,
			authorSequence,
			kind: "drp-vertex",
			objectId: SCOPE.objectId,
			protocolMajor: 3,
		}),
		digest: bytes(0xb4, 0xd1),
		signature: bytes(0xb4, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: { ...SCOPE } },
		outboxEntry: { authorSequence, envelope, scope: { ...SCOPE } },
	};
}

function nativeOutboxRow(commit: DurableIssueCommit): NativeOutboxRecord {
	return {
		authorSequence: commit.authorSequence,
		digest: commit.envelope.digest,
		publishState: "pending",
		scope: commit.outboxEntry.scope,
	};
}

function exactPairInput(lineage: DurableLineage, priorLineage: DurableLineage): TerminalClassificationInput {
	const candidate = commitFor(priorLineage.next);
	return {
		candidate,
		observation: {
			issuedRecord: candidate.issuedRecord,
			lineage,
			outboxRecord: nativeOutboxRow(candidate),
		},
		priorLineage,
		scope: SCOPE,
	};
}

function expectSyncCode(invoke: () => unknown, code: string, errorType: typeof Error = Error): IssuanceError {
	let observed: unknown;
	try {
		invoke();
	} catch (error) {
		observed = error;
	}
	expect(observed).toBeInstanceOf(errorType);
	expect(observed).toMatchObject({ code });
	return observed as IssuanceError;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected promise rejection");
}

describe("Phase 2l-a B4 semantic lineage closure", () => {
	it("rejects every observed exhausted-before-MAX lineage as recovery corruption", () => {
		for (const next of [0, 4, Number.MAX_SAFE_INTEGER - 1]) {
			const selected = next === 0 ? 0 : next - 1;
			expectSyncCode(
				() =>
					classifyTerminalSuppression(exactPairInput({ exhausted: true, next }, { exhausted: false, next: selected })),
				"ISSUANCE_RECOVERY_CORRUPT"
			);
		}
	});

	it("rejects an impossible caller prior lineage as invalid-argument misuse", () => {
		expectSyncCode(
			() => classifyTerminalSuppression(exactPairInput({ exhausted: false, next: 5 }, { exhausted: true, next: 4 })),
			"ISSUANCE_INVALID_ARGUMENT",
			TypeError
		);
	});

	it("poisons an impossible seeded durable lineage before build or exhausted classification", async () => {
		for (const next of [0, 4, Number.MAX_SAFE_INTEGER - 1]) {
			const store = createEphemeralDurableIssuanceStore({
				initialLineages: [{ exhausted: true, next, scope: SCOPE }],
			});
			let buildCalls = 0;
			const errors = await Promise.all(
				[
					store.readLineage(SCOPE),
					store.readIssued(SCOPE, next),
					store.readOutboxPage(),
					store.transactIssue(SCOPE, (selected) => {
						buildCalls++;
						return Promise.resolve(commitFor(selected));
					}),
				].map(captureRejection)
			);
			for (const error of errors) expect(error).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
			expect(new Set(errors)).toHaveLength(1);
			expect(buildCalls).toBe(0);
			await expect(store.close()).resolves.toBeUndefined();
		}
	});

	it("preserves every valid zero, ordinary and MAX lineage state", async () => {
		for (const next of [0, 4]) {
			const store = createEphemeralDurableIssuanceStore({
				initialLineages: [{ exhausted: false, next, scope: SCOPE }],
			});
			await expect(store.readLineage(SCOPE)).resolves.toEqual({ exhausted: false, next });
		}

		const selectable = createEphemeralDurableIssuanceStore({
			initialLineages: [{ exhausted: false, next: Number.MAX_SAFE_INTEGER, scope: SCOPE }],
		});
		await expect(
			selectable.transactIssue(SCOPE, (selected) => Promise.resolve(commitFor(selected)))
		).resolves.toMatchObject({ authorSequence: Number.MAX_SAFE_INTEGER });
		await expect(selectable.readLineage(SCOPE)).resolves.toEqual({
			exhausted: true,
			next: Number.MAX_SAFE_INTEGER,
		});

		const consumed = exactPairInput(
			{ exhausted: true, next: Number.MAX_SAFE_INTEGER },
			{ exhausted: false, next: Number.MAX_SAFE_INTEGER }
		);
		expect(classifyTerminalSuppression(consumed)).toEqual(consumed.candidate);
	});
});

describe("Phase 2l-a B5 present-null outbox options", () => {
	it("rejects null limit and scope while preserving omission and explicit null afterKey", async () => {
		const store = createEphemeralDurableIssuanceStore();
		for (const input of [{ limit: null }, { scope: null }]) {
			let promise!: Promise<readonly DurableIssuanceOutboxRecord[]>;
			expect(() => {
				promise = store.readOutboxPage(input as never);
			}).not.toThrow();
			const error = await captureRejection(promise);
			expect(error).toBeInstanceOf(TypeError);
			expect(error).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		}

		await expect(store.readOutboxPage()).resolves.toEqual([]);
		await expect(store.readOutboxPage({ afterKey: null })).resolves.toEqual([]);
	});
});
