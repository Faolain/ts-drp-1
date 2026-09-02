import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	digestBlob,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	type PresentHead,
} from "@ts-drp/storage";
import { beforeAll, describe, expect, it } from "vitest";

import {
	type GenuineCreatorAdoptionFixture,
	openGenuineCreatorAdoptionFixture,
} from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { activateCreatorSuccessorAdoption } from "../packages/node/src/creator-adoption-activate.js";
import { commitCreatorSuccessorAdoption } from "../packages/node/src/creator-adoption-commit.js";
import * as recoverSurface from "../packages/node/src/creator-adoption-recover.js";
import * as stageSurface from "../packages/node/src/creator-adoption-stage.js";

const { recoverPendingCreatorSuccessorAdoption } = recoverSurface;
const { publishStagedCreatorSuccessorAdoption, stageCreatorSuccessorAdoption } = stageSurface;

const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

function record(value: unknown): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("D.110c-0b0a canonical record is invalid");
	}
	return value as Readonly<Record<string, unknown>>;
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

async function verifiedIntent(fixture: GenuineCreatorAdoptionFixture): Promise<unknown> {
	const verified = await fixture.modules.verifyCreatorSuccessorAdoption({
		catalog: fixture.catalog,
		handle: fixture.handle,
	});
	if (verified.ok !== true) throw new TypeError(`D.110c-0b0a verification failed: ${String(verified.kind)}`);
	return verified.intent;
}

function recoveryInput(fixture: GenuineCreatorAdoptionFixture): Readonly<Record<string, unknown>> {
	const candidate = fixture.evidence.current.candidates.find(
		({ ref }) =>
			ref.byteLength === fixture.evidence.closeResult.currentTrustRef.byteLength &&
			ref.digest === fixture.evidence.closeResult.currentTrustRef.digest
	);
	if (candidate === undefined) throw new TypeError("D.110c-0b0a current trust carrier is unavailable");
	const trust = record(decodeCanonical(candidate.bytes));
	if (
		!(trust.detachedCurrentAnchorSignature instanceof Uint8Array) ||
		!(trust.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
	) {
		throw new TypeError("D.110c-0b0a current trust carrier is malformed");
	}
	return Object.freeze({
		authenticationProfile: "creator-only",
		catalog: fixture.catalog,
		detachedSignature: Uint8Array.from(trust.detachedCurrentAnchorSignature),
		exactCanonicalAnchorPreimageBytes: Uint8Array.from(trust.exactCanonicalCurrentAnchorPreimageBytes),
		exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
		expectedNextRoomHead: Object.freeze({
			currentAnchorDigest: fixture.evidence.closeResult.successorAnchorDigest,
			epoch: fixture.evidence.closeResult.successorEpoch,
			objectId: fixture.evidence.currentTrust.objectId,
		}),
		expectedPreviousRoomHead: Object.freeze({
			currentAnchorDigest: fixture.evidence.currentTrust.currentAnchorDigest,
			epoch: fixture.evidence.currentTrust.currentEpoch,
			objectId: fixture.evidence.currentTrust.objectId,
		}),
		pinnedGenesisAnchorDigest: fixture.evidence.currentTrust.genesisAnchorDigest,
		snapshotDeclaration: fixture.evidence.declaration,
		snapshotStore: fixture.evidence.snapshotStore,
		store: fixture.evidence.aheStore,
	});
}

async function generations(fixture: GenuineCreatorAdoptionFixture): Promise<readonly GenerationRecord[]> {
	const page = await fixture.evidence.aheBackend.readGenerationPage({
		limit: 128,
		objectId: fixture.evidence.proposed.head.objectId,
	});
	if (!page.ok || page.value.nextCursor !== null) throw new TypeError("D.110c-0b0a lineage is unavailable");
	return page.value.generations;
}

async function installDifferentClosureCandidate(fixture: GenuineCreatorAdoptionFixture): Promise<void> {
	const complete = (await generations(fixture)).filter(({ state }) => state === "Complete");
	if (complete.length !== 1) throw new TypeError("D.110c-0b0a fork control requires one complete candidate");
	const original = complete[0] as GenerationRecord;
	const originalProjectionDigest = digestBlob(fixture.evidence.exactCanonicalProjectionBytes);
	if (!originalProjectionDigest.ok) throw new TypeError("D.110c-0b0a projection digest is invalid");
	const variantBytes = encodeCanonical({
		...record(decodeCanonical(fixture.evidence.exactCanonicalProjectionBytes)),
		forkControl: "different-authenticated-closure",
	});
	const variantDigest = digestBlob(variantBytes);
	if (!variantDigest.ok) throw new TypeError("D.110c-0b0a fork projection digest is invalid");
	const variantRef: GenerationRef = Object.freeze({
		byteLength: variantBytes.byteLength,
		digest: variantDigest.value,
	});
	const closure = Object.freeze(
		original.closure
			.map((ref) => (ref.digest === originalProjectionDigest.value ? variantRef : ref))
			.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
	);
	const random = new Uint8Array(32);
	crypto.getRandomValues(random);
	const generationId = parseGenerationId(Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join(""));
	if (!generationId.ok || original.baseExpectedHead.kind !== "present") {
		throw new TypeError("D.110c-0b0a fork generation identity is invalid");
	}
	const scope = Object.freeze({ generationId: generationId.value, objectId: original.objectId });
	const begun = await fixture.evidence.aheBackend.beginGeneration({
		...scope,
		baseExpectedHead: original.baseExpectedHead,
		closure,
	});
	if (!begun.ok) throw new TypeError(`D.110c-0b0a fork begin failed: ${begun.reason}`);
	const cached = await fixture.evidence.aheBackend.putCachedBlob({
		...scope,
		bytes: variantBytes,
		digest: variantDigest.value,
	});
	if (!cached.ok) throw new TypeError(`D.110c-0b0a fork cache failed: ${cached.reason}`);
	for (const ref of closure) {
		const promoted = await fixture.evidence.aheBackend.promoteReference({ ...scope, digest: ref.digest });
		if (!promoted.ok) throw new TypeError(`D.110c-0b0a fork promotion failed: ${promoted.reason}`);
	}
	const completed = await fixture.evidence.aheBackend.completeGeneration(scope);
	if (!completed.ok) throw new TypeError(`D.110c-0b0a fork completion failed: ${completed.reason}`);
}

describe("D.110c-0b0a staged adoption and pending recovery GREEN", () => {
	it("stages without a head swap and publishes through one owner-bound CAS", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		const foreign = await openGenuineCreatorAdoptionFixture();
		try {
			expect(Object.keys(stageSurface).sort()).toEqual([
				"publishStagedCreatorSuccessorAdoption",
				"stageCreatorSuccessorAdoption",
			]);
			expect(Object.keys(recoverSurface)).toEqual(["recoverPendingCreatorSuccessorAdoption"]);
			expect(await stageCreatorSuccessorAdoption({ handle: fixture.handle })).toMatchObject({
				kind: "malformed-input",
				ok: false,
			});
			const before = await fixture.evidence.aheBackend.readHead(fixture.evidence.proposed.head.objectId);
			if (!before.ok || before.value.kind !== "present") throw new TypeError("D.110c-0b0a head is unavailable");
			fixture.controls.aheOperationCounts.clear();
			const staged = await stageCreatorSuccessorAdoption({
				handle: fixture.handle,
				intent: await verifiedIntent(fixture),
			});
			expect(Object.keys(staged).sort()).toEqual(["capability", "descriptor", "lifecycle", "ok", "recovery"]);
			expect(staged).toMatchObject({ lifecycle: "successor-staged", ok: true, recovery: "pending-old" });
			const afterStage = await fixture.evidence.aheBackend.readHead(fixture.evidence.proposed.head.objectId);
			if (!afterStage.ok || afterStage.value.kind !== "present") {
				throw new TypeError("D.110c-0b0a staged head is unavailable");
			}
			expect(sameHead(before.value, afterStage.value)).toBe(true);
			expect(fixture.controls.aheOperationCounts.get("swapHead") ?? 0).toBe(0);
			expect((await generations(fixture)).filter(({ state }) => state === "Complete")).toHaveLength(1);

			expect(await commitCreatorSuccessorAdoption({ handle: fixture.handle, intent: staged.capability })).toMatchObject(
				{ kind: "intent-unavailable", ok: false }
			);
			expect(
				await activateCreatorSuccessorAdoption({
					capability: staged.capability,
					handle: fixture.handle,
					...fixture.runtimeBindings,
				})
			).toMatchObject({ kind: "capability-unavailable", ok: false });
			expect(
				await publishStagedCreatorSuccessorAdoption({ capability: staged.capability, handle: foreign.handle })
			).toMatchObject({ kind: "intent-unavailable", ok: false });
			expect(
				await publishStagedCreatorSuccessorAdoption({
					capability: { ...record(staged.capability) },
					handle: fixture.handle,
				})
			).toMatchObject({ kind: "intent-unavailable", ok: false });
			expect(
				await publishStagedCreatorSuccessorAdoption({
					capability: staged.capability,
					extra: true,
					handle: fixture.handle,
				})
			).toMatchObject({ kind: "malformed-input", ok: false });

			const published = await publishStagedCreatorSuccessorAdoption({
				capability: staged.capability,
				handle: fixture.handle,
			});
			expect(Object.keys(published).sort()).toEqual([
				"capability",
				"descriptor",
				"head",
				"lifecycle",
				"ok",
				"recovery",
			]);
			expect(published).toMatchObject({ lifecycle: "successor-prepared", ok: true, recovery: "active-new" });
			expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);
			expect(
				await publishStagedCreatorSuccessorAdoption({ capability: staged.capability, handle: fixture.handle })
			).toMatchObject({ kind: "intent-unavailable", ok: false });
		} finally {
			await Promise.all([fixture.close(), foreign.close()]);
		}
	});

	it("recovers equivalent Complete retries deterministically across both AHE orderings", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const first = await verifiedIntent(fixture);
			const second = await verifiedIntent(fixture);
			expect(await stageCreatorSuccessorAdoption({ handle: fixture.handle, intent: first })).toMatchObject({
				ok: true,
			});
			expect(await stageCreatorSuccessorAdoption({ handle: fixture.handle, intent: second })).toMatchObject({
				ok: true,
			});
			const completeIds = (await generations(fixture))
				.filter(({ state }) => state === "Complete")
				.map(({ generationId }) => generationId)
				.sort();
			expect(completeIds).toHaveLength(2);
			fixture.controls.aheOperationCounts.clear();
			fixture.controls.aheMutationHook = ({ edge, operation }): void => {
				if (edge === "after-request" && operation === "swapHead") {
					throw new TypeError("D.110c-0b0a committed CAS response lost");
				}
			};
			const input = recoveryInput(fixture);
			const recovered = await recoverPendingCreatorSuccessorAdoption(input);
			expect(Object.keys(recovered).sort()).toEqual(["head", "lifecycle", "ok", "recovery"]);
			expect(recovered).toMatchObject({
				head: input.expectedNextRoomHead,
				lifecycle: "successor-published",
				ok: true,
				recovery: "active-new",
			});
			expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);
			const active = await fixture.evidence.aheBackend.readHead(fixture.evidence.proposed.head.objectId);
			if (!active.ok || active.value.kind !== "present") throw new TypeError("D.110c-0b0a active head is unavailable");
			expect(active.value.generationId).toBe(completeIds[0]);

			fixture.controls.aheMutationHook = undefined;
			const swapCount = fixture.controls.aheOperationCounts.get("swapHead");
			expect(await recoverPendingCreatorSuccessorAdoption(input)).toMatchObject({ ok: true, recovery: "active-new" });
			expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(swapCount);
		} finally {
			await fixture.close();
		}
	});

	it("fails closed for absent, incomplete, wrong-head, malformed, and true-fork candidates", async () => {
		const absent = await openGenuineCreatorAdoptionFixture();
		const incomplete = await openGenuineCreatorAdoptionFixture();
		const forked = await openGenuineCreatorAdoptionFixture();
		try {
			const absentInput = recoveryInput(absent);
			expect(await recoverPendingCreatorSuccessorAdoption(absentInput)).toMatchObject({
				kind: "pending-missing",
				ok: false,
			});
			expect(
				await recoverPendingCreatorSuccessorAdoption({
					...absentInput,
					expectedNextRoomHead: {
						...(absentInput.expectedNextRoomHead as Readonly<Record<string, unknown>>),
						currentAnchorDigest: "f".repeat(64),
					},
				})
			).toMatchObject({ ok: false });
			expect(await recoverPendingCreatorSuccessorAdoption({ ...absentInput, extra: true })).toMatchObject({
				kind: "malformed-input",
				ok: false,
			});

			incomplete.controls.aheMutationHook = ({ edge, operation }): void => {
				if (edge === "before-request" && operation === "completeGeneration") {
					throw new TypeError("D.110c-0b0a controlled incomplete candidate");
				}
			};
			expect(
				await stageCreatorSuccessorAdoption({ handle: incomplete.handle, intent: await verifiedIntent(incomplete) })
			).toMatchObject({ kind: "pending-old", ok: false });
			incomplete.controls.aheMutationHook = undefined;
			expect(await recoverPendingCreatorSuccessorAdoption(recoveryInput(incomplete))).toMatchObject({
				kind: "pending-missing",
				ok: false,
			});

			expect(
				await stageCreatorSuccessorAdoption({ handle: forked.handle, intent: await verifiedIntent(forked) })
			).toMatchObject({ ok: true });
			await installDifferentClosureCandidate(forked);
			expect(await recoverPendingCreatorSuccessorAdoption(recoveryInput(forked))).toMatchObject({
				kind: "true-fork",
				ok: false,
			});
		} finally {
			await Promise.all([absent.close(), incomplete.close(), forked.close()]);
		}
	});
});
