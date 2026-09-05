import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { digestClosure, type GenerationRef, type PresentHead } from "@ts-drp/storage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
	classifyD108cTerminal,
	CREATOR_ADOPTION_COMMIT_EXPORTS,
	CREATOR_ADOPTION_COMMIT_FAILURE_KINDS,
	CREATOR_ADOPTION_COMMIT_INPUT_KEYS,
	CREATOR_ADOPTION_COMMIT_SUCCESS_KEYS,
	D108C_GREEN_PATHS,
	D108C_MUTATION_OPERATIONS,
	D108C_RED_PATHS,
	D108C_REQUEST_EDGES,
	type D108cCandidateModule,
	d108cReadiness,
	d108cRequestFaultRoster,
	d108cSourceGovernance,
	d108cTransactionFaultRoster,
	deriveD108cCandidateClosure,
	REPOSITORY_ROOT,
} from "./fixtures/phase-6a-v3/creator-adoption-commit-contract.js";
import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";

const readiness = d108cReadiness();

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

async function candidate(): Promise<D108cCandidateModule> {
	return import(pathToFileURL(resolve(REPOSITORY_ROOT, D108C_GREEN_PATHS[0])).href) as Promise<D108cCandidateModule>;
}

async function verifiedIntent(
	fixture: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>
): Promise<unknown> {
	const verifier = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts")).href
	)) as {
		verifyCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
	};
	const verified = await verifier.verifyCreatorSuccessorAdoption({ catalog: fixture.catalog, handle: fixture.handle });
	if (verified.ok !== true) throw new TypeError(`D.108c verifier failed: ${String(verified.kind)}`);
	return verified.intent;
}

function syntheticHead(generationId: string, revision: number, closureDigest: string): PresentHead {
	return {
		closureDigest,
		generationId: generationId as PresentHead["generationId"],
		kind: "present",
		objectId: `creator:${"a".repeat(32)}` as PresentHead["objectId"],
		revision,
	};
}

function genuineCandidateRefCount(fixture: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>): number {
	const oldLive = fixture.evidence.current.candidates.filter(({ bytes, ref }) => {
		try {
			const decoded = decodeCanonical(bytes) as Readonly<Record<string, unknown>>;
			return (
				decoded.kind === "v3-live-generation-1" &&
				fixture.evidence.proposed.references.some(
					(candidate) => candidate.digest === ref.digest && candidate.byteLength === ref.byteLength
				)
			);
		} catch {
			return false;
		}
	});
	if (oldLive.length !== 1) throw new TypeError("D.108c predecessor projection classification failed");
	return deriveD108cCandidateClosure(
		fixture.evidence.proposed.references,
		oldLive[0]?.ref as GenerationRef,
		fixture.evidence.exactCanonicalProjectionBytes
	).closure.length;
}

function requestFaultTarget(value: string): Readonly<{
	readonly edge: "after-request" | "before-request";
	readonly occurrence: number;
	readonly operation: "beginGeneration" | "completeGeneration" | "promoteReference" | "putCachedBlob" | "swapHead";
}> {
	const [operation, occurrenceOrEdge, maybeEdge] = value.split(":");
	const edge = maybeEdge ?? occurrenceOrEdge;
	return Object.freeze({
		edge: edge === "before-request" ? "before-request" : "after-request",
		occurrence: maybeEdge === undefined ? 0 : Number(occurrenceOrEdge),
		operation: operation as
			| "beginGeneration"
			| "completeGeneration"
			| "promoteReference"
			| "putCachedBlob"
			| "swapHead",
	});
}

describe("D.108c one-CAS creator adoption RED", () => {
	it("freezes exactly ten RED and four GREEN owners", () => {
		expect(D108C_RED_PATHS).toHaveLength(10);
		expect(D108C_GREEN_PATHS).toHaveLength(4);
		expect(new Set(D108C_RED_PATHS).size).toBe(10);
		expect(D108C_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108C_GREEN_PATHS).toEqual([
			"packages/node/src/creator-adoption-commit.ts",
			"packages/node/src/internal/creator-adoption-intent.ts",
			"packages/node/src/creator-adoption.ts",
			"packages/node/package.json",
		]);
	});

	it("freezes the closed public contract and finite fault vocabulary", () => {
		expect(CREATOR_ADOPTION_COMMIT_EXPORTS).toEqual(["commitCreatorSuccessorAdoption"]);
		expect(CREATOR_ADOPTION_COMMIT_INPUT_KEYS).toEqual(["handle", "intent"]);
		expect(CREATOR_ADOPTION_COMMIT_SUCCESS_KEYS).toEqual([
			"capability",
			"descriptor",
			"head",
			"lifecycle",
			"ok",
			"recovery",
		]);
		expect(CREATOR_ADOPTION_COMMIT_FAILURE_KINDS).toEqual([
			"malformed-input",
			"intent-unavailable",
			"recovery-failed",
			"chain-invalid",
			"pending-old",
			"stale-head",
			"storage-failed",
			"internal-invariant",
		]);
		expect(D108C_MUTATION_OPERATIONS).toEqual([
			"beginGeneration",
			"putCachedBlob",
			"promoteReference",
			"completeGeneration",
			"swapHead",
		]);
		expect(D108C_REQUEST_EDGES).toEqual(["before-request", "commit-then-throw", "after-request"]);
		expect(d108cRequestFaultRoster(5)).toHaveLength(27);
		expect(d108cTransactionFaultRoster(5)).toHaveLength(18);
	});

	it("constructs one sorted generation-2 replacement without a manifest ref", () => {
		const oldLive = { byteLength: 2, digest: "b".repeat(64) } as GenerationRef;
		const pending = Object.freeze([
			{ byteLength: 3, digest: "1".repeat(64) },
			oldLive,
			{ byteLength: 4, digest: "f".repeat(64) },
		]) as readonly GenerationRef[];
		const projection = encodeCanonical({ kind: "v3-live-generation-2", snapshotManifestDigest: "c".repeat(64) });
		const derived = deriveD108cCandidateClosure(pending, oldLive, projection);
		expect(derived.closure).toHaveLength(3);
		expect(derived.closure).not.toContainEqual(oldLive);
		expect(derived.closure).toContainEqual(derived.projectionRef);
		expect(derived.closure.map(({ digest }) => digest)).toEqual(
			[...derived.closure.map(({ digest }) => digest)].sort()
		);
	});

	it("classifies exact active-new independently of a retrying generation id", () => {
		const closure = Object.freeze([{ byteLength: 1, digest: "2".repeat(64) }]) as readonly GenerationRef[];
		const pending = syntheticHead("3".repeat(64), 7, "4".repeat(64));
		const active = syntheticHead("5".repeat(64), 8, "0".repeat(64));
		const digest = digestClosure(closure);
		if (!digest.ok) throw new TypeError("synthetic closure digest failed");
		expect(
			classifyD108cTerminal({
				candidateClosure: closure,
				pendingHead: pending,
				recovered: { head: { ...active, closureDigest: digest.value }, references: closure, state: "Adopted" },
			})
		).toBe("active-new");
		expect(
			classifyD108cTerminal({
				candidateClosure: closure,
				pendingHead: pending,
				recovered: { head: pending, references: closure, state: "Adopted" },
			})
		).toBe("pending-old");
		expect(
			classifyD108cTerminal({
				candidateClosure: closure,
				pendingHead: pending,
				recovered: { head: { ...active, closureDigest: "f".repeat(64) }, references: closure, state: "Adopted" },
			})
		).toBe("stale-head");
	});

	it("keeps root/product/transport/issuance/activation owners outside the GREEN roster", () => {
		expect(d108cSourceGovernance()).toEqual({
			exactFailureVocabulary: readiness.ready,
			exactNonRootExport: readiness.ready,
			noActivationOrIssueEffects: true,
			noDirectChatCommitConsumer: true,
			noRootExport: true,
			privateCapabilityConsumer: readiness.ready,
			retainedCommitHasNoProductConsumer: true,
			roomOwnsStagedPublicationWhenProductExists: true,
		});
		expect(D108C_GREEN_PATHS).not.toContain("packages/node/src/index.ts");
		expect(D108C_GREEN_PATHS.every((path) => !/(?:transport|issuance|v3-live|examples)/u.test(path))).toBe(true);
	});

	it("[RED readiness] requires all four candidate owners and the non-root package export", () => {
		expect(readiness, `missing D.108c owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)(
		"consumes only a genuine owner-bound intent and commits one exact successor",
		async () => {
			const fixture = await openGenuineCreatorAdoptionFixture();
			try {
				fixture.controls.aheMutationCount = 0;
				fixture.controls.aheOperationCounts.clear();
				const commit = (await candidate()).commitCreatorSuccessorAdoption;
				if (commit === undefined) throw new TypeError("D.108c export missing");
				const intent = await verifiedIntent(fixture);
				for (const malformed of [
					{ handle: fixture.handle },
					{ intent },
					{ handle: fixture.handle, intent, objectId: fixture.evidence.proposed.head.objectId },
					{ handle: fixture.handle, intent, store: Object.freeze({}) },
				]) {
					const rejected = await commit(malformed);
					expect(Object.keys(rejected).sort()).toEqual(["detail", "kind", "ok"]);
					expect(rejected).toMatchObject({ kind: "malformed-input", ok: false });
				}
				const forged = await commit({ handle: fixture.handle, intent: Object.freeze({}) });
				expect(Object.keys(forged).sort()).toEqual(["detail", "kind", "ok"]);
				expect(forged).toMatchObject({
					kind: "intent-unavailable",
					ok: false,
				});
				expect(fixture.controls.aheMutationCount).toBe(0);
				const result = await commit({ handle: fixture.handle, intent });
				expect(Object.keys(result).sort()).toEqual([...CREATOR_ADOPTION_COMMIT_SUCCESS_KEYS].sort());
				expect(result).toMatchObject({ lifecycle: "successor-prepared", ok: true, recovery: "active-new" });
				expect(Object.keys(result.capability as object)).toEqual([]);
				expect(result.capability).not.toHaveProperty("activate");
				expect(result.capability).not.toHaveProperty("issueLocal");
				const live = (await import(pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts")).href)) as {
					activateV3LivePlane(input: unknown): Readonly<Record<string, unknown>>;
				};
				expect(
					live.activateV3LivePlane({
						capability: result.capability,
						messageQueueManager: Object.freeze({}),
						networkNode: Object.freeze({}),
						onAdmittedVertex: () => undefined,
					})
				).toMatchObject({ kind: "capability-consumed", ok: false });
				expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);
			} finally {
				await fixture.close();
			}
		}
	);

	it.skipIf(!readiness.ready)("accepts a byte-identical second intent without a second head swap", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const first = await verifiedIntent(fixture);
			const second = await verifiedIntent(fixture);
			fixture.controls.aheMutationCount = 0;
			fixture.controls.aheOperationCounts.clear();
			const commit = (await candidate()).commitCreatorSuccessorAdoption;
			if (commit === undefined) throw new TypeError("D.108c export missing");
			expect(await commit({ handle: fixture.handle, intent: first })).toMatchObject({
				ok: true,
				recovery: "active-new",
			});
			const countsAfterFirst = new Map(fixture.controls.aheOperationCounts);
			expect(await commit({ handle: fixture.handle, intent: first })).toMatchObject({
				kind: "intent-unavailable",
				ok: false,
			});
			expect(fixture.controls.aheOperationCounts).toEqual(countsAfterFirst);
			expect(await commit({ handle: fixture.handle, intent: second })).toMatchObject({
				ok: true,
				recovery: "active-new",
			});
			expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)(
		"reopens pending-old or exact active-new at every logical request fault",
		async () => {
			const sample = await openGenuineCreatorAdoptionFixture();
			const refCount = genuineCandidateRefCount(sample);
			await sample.close();
			for (const row of d108cRequestFaultRoster(refCount)) {
				const fixture = await openGenuineCreatorAdoptionFixture();
				try {
					const intent = await verifiedIntent(fixture);
					const target = requestFaultTarget(row);
					fixture.controls.aheMutationCount = 0;
					fixture.controls.aheOperationCounts.clear();
					fixture.controls.aheMutationHook = (observation): void => {
						if (
							observation.operation === target.operation &&
							observation.occurrence === target.occurrence &&
							observation.edge === target.edge
						) {
							throw new Error(`D108C_FAULT:${row}`);
						}
					};
					const commit = (await candidate()).commitCreatorSuccessorAdoption;
					if (commit === undefined) throw new TypeError("D.108c export missing");
					const result = await commit({ handle: fixture.handle, intent });
					const afterCommittedSwap = target.operation === "swapHead" && target.edge === "after-request";
					expect(result, row).toMatchObject(
						afterCommittedSwap ? { ok: true, recovery: "active-new" } : { kind: "pending-old", ok: false }
					);
					expect(fixture.controls.aheOperationCounts.get("swapHead") ?? 0, row).toBeLessThanOrEqual(1);
				} finally {
					await fixture.close();
				}
			}
		},
		600_000
	);
});
