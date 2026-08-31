import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	classifyTerminalSuppression,
	createEphemeralDurableIssuanceStore,
	type TerminalClassificationInput,
} from "../packages/issuance-store/src/conformance.js";
import type { DurableIssueCommit, DurableIssueScope, DurableLineage } from "../packages/issuance-store/src/types.js";

interface IssuanceError extends Error {
	readonly code: string;
	readonly retryClass?: string;
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

function commitFor(authorSequence: number, seed = 0xb6): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({
			author: SCOPE.author,
			authorSequence,
			kind: "drp-vertex",
			objectId: SCOPE.objectId,
			protocolMajor: 3,
		}),
		digest: bytes(seed, 0xd1),
		signature: bytes(seed, 0x51),
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

function expectInvalidArgument(invoke: () => unknown): IssuanceError {
	let observed: unknown;
	try {
		invoke();
	} catch (error) {
		observed = error;
	}
	expect(observed).toBeInstanceOf(TypeError);
	expect(observed).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
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

describe("Phase 2l-a B6 private terminal-transition binding", () => {
	const priorLineage: DurableLineage = { exhausted: false, next: 2 };
	const candidate = commitFor(3);
	const foreign = commitFor(3, 0xf0);
	const mismatchedCases: readonly {
		readonly label: string;
		readonly observation: TerminalClassificationInput["observation"];
	}[] = [
		{
			label: "exact rows",
			observation: {
				issuedRecord: candidate.issuedRecord,
				lineage: { exhausted: false, next: 4 },
				prunedThroughAuthorSequence: null,
				outboxRecord: nativeOutboxRow(candidate),
			},
		},
		{
			label: "foreign rows",
			observation: {
				issuedRecord: foreign.issuedRecord,
				lineage: { exhausted: false, next: 4 },
				prunedThroughAuthorSequence: null,
				outboxRecord: nativeOutboxRow(foreign),
			},
		},
		{
			label: "absent old state",
			observation: {
				issuedRecord: null,
				lineage: priorLineage,
				prunedThroughAuthorSequence: null,
				outboxRecord: null,
			},
		},
		{ label: "unreadable authority", observation: { unreadable: true } },
	];

	it.each(mismatchedCases)("rejects a mismatched selected ordinal before $label classification", ({ observation }) => {
		expectInvalidArgument(() => classifyTerminalSuppression({ candidate, observation, priorLineage, scope: SCOPE }));
	});

	it("rejects an exhausted prior before unreadable classification", () => {
		const finalCandidate = commitFor(Number.MAX_SAFE_INTEGER);
		expectInvalidArgument(() =>
			classifyTerminalSuppression({
				candidate: finalCandidate,
				observation: { unreadable: true },
				priorLineage: { exhausted: true, next: Number.MAX_SAFE_INTEGER },
				scope: SCOPE,
			})
		);
	});

	it("preserves valid ordinary and final-MAX unexhausted transitions", () => {
		const ordinary = commitFor(3);
		expect(
			classifyTerminalSuppression({
				candidate: ordinary,
				observation: {
					issuedRecord: ordinary.issuedRecord,
					lineage: { exhausted: false, next: 4 },
					prunedThroughAuthorSequence: null,
					outboxRecord: nativeOutboxRow(ordinary),
				},
				priorLineage: { exhausted: false, next: 3 },
				scope: SCOPE,
			})
		).toEqual(ordinary);

		const finalCandidate = commitFor(Number.MAX_SAFE_INTEGER);
		expect(
			classifyTerminalSuppression({
				candidate: finalCandidate,
				observation: {
					issuedRecord: finalCandidate.issuedRecord,
					lineage: { exhausted: true, next: Number.MAX_SAFE_INTEGER },
					prunedThroughAuthorSequence: null,
					outboxRecord: nativeOutboxRow(finalCandidate),
				},
				priorLineage: { exhausted: false, next: Number.MAX_SAFE_INTEGER },
				scope: SCOPE,
			})
		).toEqual(finalCandidate);
	});
});

describe("Phase 2l-a B7 sticky poison authority", () => {
	it("keeps one latched recovery-corrupt failure authoritative after caller mutation", async () => {
		const store = createEphemeralDurableIssuanceStore({ initialPoison: "recovery-corrupt" });
		const poison = (await captureRejection(store.readLineage(SCOPE))) as IssuanceError;
		expect(poison).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(poison.retryClass).toBeUndefined();

		for (const [key, value] of [
			["code", "ISSUANCE_RETRY_REQUIRED"],
			["retryClass", "transient"],
			["name", "CallerError"],
			["message", "caller-controlled"],
		] as const) {
			Reflect.set(poison, key, value);
		}

		let buildCalls = 0;
		const laterErrors = await Promise.all(
			[
				store.readLineage(SCOPE),
				store.readIssued(SCOPE, 0),
				store.readOutboxPage(),
				store.transactIssue(SCOPE, (selected) => {
					buildCalls++;
					return Promise.resolve(commitFor(selected));
				}),
			].map(captureRejection)
		);
		for (const error of laterErrors) {
			expect(error).toBe(poison);
			expect(error).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
			expect((error as IssuanceError).retryClass).toBeUndefined();
		}
		expect(buildCalls).toBe(0);
	});
});
