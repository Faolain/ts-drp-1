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
		digest: bytes(0x32, 0xd1),
		signature: bytes(0x32, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: { ...SCOPE } },
		outboxEntry: { authorSequence, envelope, scope: { ...SCOPE } },
	};
}

function nativeOutboxRow(commit: DurableIssueCommit, publishState: "pending" | "published"): NativeOutboxRecord {
	return {
		authorSequence: commit.authorSequence,
		digest: commit.envelope.digest,
		publishState,
		scope: commit.outboxEntry.scope,
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

function exactPairInput(
	lineage: DurableLineage,
	publishState: "pending" | "published" = "pending"
): TerminalClassificationInput {
	const candidate = commitFor(3);
	return {
		candidate,
		observation: {
			issuedRecord: candidate.issuedRecord,
			lineage,
			outboxRecord: nativeOutboxRow(candidate, publishState),
		},
		priorLineage: { exhausted: false, next: 3 },
		scope: SCOPE,
	};
}

describe("Phase 2l-a B2 closed lineage classification", () => {
	it("rejects malformed observed lineage authorities as recovery corruption before classifying success", () => {
		const accessor = { exhausted: false } as Record<string, unknown>;
		Object.defineProperty(accessor, "next", { enumerable: true, get: () => 4 });
		const inherited = Object.create({ next: 4 }, { exhausted: { enumerable: true, value: false } }) as Record<
			string,
			unknown
		>;
		const extra = { exhausted: false, next: 4, revision: 1 };
		const malformed: readonly unknown[] = [
			{ exhausted: "yes", next: 3 },
			{ exhausted: 1, next: 3 },
			{ exhausted: false, next: "4" },
			{ exhausted: false, next: 3.5 },
			{ exhausted: false, next: -1 },
			{ exhausted: false, next: Number.MAX_SAFE_INTEGER + 1 },
			accessor,
			inherited,
			extra,
		];

		for (const lineage of malformed) {
			expectSyncCode(
				() => classifyTerminalSuppression(exactPairInput(lineage as DurableLineage)),
				"ISSUANCE_RECOVERY_CORRUPT"
			);
		}
	});

	it("does not accept structurally malformed observed old-state lineage as definitive old state", () => {
		const accessor = {} as Record<string, unknown>;
		Object.defineProperties(accessor, {
			exhausted: { enumerable: true, get: () => false },
			next: { enumerable: true, value: 3 },
		});
		const inherited = Object.create({ exhausted: false }, { next: { enumerable: true, value: 3 } }) as Record<
			string,
			unknown
		>;
		for (const lineage of [{ exhausted: false, next: 3, extra: true }, accessor, inherited]) {
			const candidate = commitFor(3);
			expectSyncCode(
				() =>
					classifyTerminalSuppression({
						candidate,
						observation: {
							issuedRecord: null,
							lineage: lineage as unknown as DurableLineage,
							outboxRecord: null,
						},
						priorLineage: { exhausted: false, next: 3 },
						scope: SCOPE,
					}),
				"ISSUANCE_RECOVERY_CORRUPT"
			);
		}
	});

	it("classifies malformed caller-supplied prior lineage as synchronous invalid-argument misuse", () => {
		const accessor = {} as Record<string, unknown>;
		Object.defineProperties(accessor, {
			exhausted: { enumerable: true, value: false },
			next: { enumerable: true, get: () => 3 },
		});
		const inherited = Object.create({ exhausted: false }, { next: { enumerable: true, value: 3 } }) as Record<
			string,
			unknown
		>;
		const malformed: readonly unknown[] = [
			{ exhausted: false, next: 3, extra: true },
			{ exhausted: "false", next: 3 },
			{ exhausted: false, next: Number.MAX_SAFE_INTEGER + 1 },
			accessor,
			inherited,
		];
		const candidate = commitFor(3);
		for (const priorLineage of malformed) {
			expectSyncCode(
				() =>
					classifyTerminalSuppression({
						candidate,
						observation: {
							issuedRecord: null,
							lineage: { exhausted: false, next: 3 },
							outboxRecord: null,
						},
						priorLineage: priorLineage as DurableLineage,
						scope: SCOPE,
					}),
				"ISSUANCE_INVALID_ARGUMENT",
				TypeError
			);
		}

		expect(classifyTerminalSuppression(exactPairInput({ exhausted: false, next: 4 }))).toEqual(candidate);
	});

	it("preserves pending, published and final-MAX valid lineage controls", () => {
		for (const publishState of ["pending", "published"] as const) {
			expect(classifyTerminalSuppression(exactPairInput({ exhausted: false, next: 4 }, publishState))).toEqual(
				commitFor(3)
			);
		}
		const candidate = commitFor(Number.MAX_SAFE_INTEGER);
		expect(
			classifyTerminalSuppression({
				candidate,
				observation: {
					issuedRecord: candidate.issuedRecord,
					lineage: { exhausted: true, next: Number.MAX_SAFE_INTEGER },
					outboxRecord: nativeOutboxRow(candidate, "pending"),
				},
				priorLineage: { exhausted: false, next: Number.MAX_SAFE_INTEGER },
				scope: SCOPE,
			})
		).toEqual(candidate);
	});
});

describe("Phase 2l-a B3 closed outbox page input", () => {
	it("rejects every wider or non-own-data options record asynchronously as invalid argument", async () => {
		const store = createEphemeralDurableIssuanceStore();
		const symbolKey = { limit: 1 } as Record<PropertyKey, unknown>;
		symbolKey[Symbol("extra")] = true;
		const inherited = Object.create({ limit: 1 }) as Record<string, unknown>;
		const accessor = {} as Record<string, unknown>;
		Object.defineProperty(accessor, "limit", { enumerable: true, get: () => 1 });
		const nonEnumerableExtra = { limit: 1 } as Record<string, unknown>;
		Object.defineProperty(nonEnumerableExtra, "extra", { enumerable: false, value: true });
		const invalid: readonly unknown[] = [
			{ limt: 1 },
			{ extra: true, limit: 1 },
			symbolKey,
			inherited,
			accessor,
			nonEnumerableExtra,
		];

		for (const input of invalid) {
			let promise!: Promise<readonly DurableIssuanceOutboxRecord[]>;
			expect(() => {
				promise = store.readOutboxPage(input as never);
			}).not.toThrow();
			const error = await captureRejection(promise);
			expect(error).toBeInstanceOf(TypeError);
			expect(error).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		}
	});

	it("keeps omission, the empty record and every lawful optional-key combination valid", async () => {
		const store = createEphemeralDurableIssuanceStore();
		await expect(store.readOutboxPage()).resolves.toEqual([]);
		const inputs = [
			{},
			{ scope: SCOPE },
			{ afterKey: [SCOPE.objectId, SCOPE.author, 0] as const },
			{ limit: 1 },
			{ afterKey: null, scope: SCOPE },
			{ limit: 1, scope: SCOPE },
			{ afterKey: null, limit: 1 },
			{ afterKey: null, limit: 1, scope: SCOPE },
		] as const;
		for (const input of inputs) await expect(store.readOutboxPage(input)).resolves.toEqual([]);
	});
});
