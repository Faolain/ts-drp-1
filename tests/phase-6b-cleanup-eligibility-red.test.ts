import "fake-indexeddb/auto";

import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	digestClosure,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { bytesForRef, openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const D109A_SOURCE = "packages/node/src/internal/closed-epoch-cleanup.ts";
const D109A_RED_PATHS = Object.freeze(["tests/phase-6b-cleanup-eligibility-red.test.ts"] as const);
const D109A_GREEN_PATHS = Object.freeze([D109A_SOURCE] as const);
const D109A_POLICY_BYTES_HEX =
	"080405046d6f6465050a6c6f63616c2d6f6e6c79050e6d696e4c6f63616c436f70696573030205116d696e4d6972726f725265636569707473030005166d696e526f6c6c6261636b47656e65726174696f6e730304";
const D109A_POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";
const D109A_REFUSALS = Object.freeze([
	"D109A_QC_INVALID",
	"D109A_ADOPTION_INVALID",
	"D109A_HEAD_MISMATCH",
	"D109A_REVISION_STALE",
	"D109A_IDENTITY_INVALID",
	"D109A_LINEAGE_INVALID",
	"D109A_ROLLBACK_INSUFFICIENT",
	"D109A_SNAPSHOT_MISSING",
	"D109A_POLICY_UNSUPPORTED",
	"D109A_OUTBOX_INCOMPLETE",
] as const);

type D109aRefusal = (typeof D109A_REFUSALS)[number];
type D109aPlanningResult =
	| Readonly<{ readonly ok: false; readonly reason: D109aRefusal }>
	| Readonly<{
			readonly ok: true;
			readonly plan: Readonly<{
				readonly activeGenerationId: GenerationId;
				readonly availabilityPolicyDigest: string;
				readonly closedEpoch: number;
				readonly expectedHead: PresentHead;
				readonly issuance: Readonly<{
					readonly scope: Readonly<{ readonly author: string; readonly objectId: StorageObjectId }>;
					readonly throughAuthorSequence: number;
				}>;
				readonly lineageFloor: Readonly<{
					readonly deleteGenerationIds: readonly GenerationId[];
					readonly expectedBaseExpectedHead: ExpectedHead;
					readonly generationId: GenerationId;
					readonly replacementBaseExpectedHead: Readonly<{
						readonly kind: "none";
						readonly objectId: StorageObjectId;
					}>;
				}>;
				readonly objectId: StorageObjectId;
				readonly rollbackGenerationIds: readonly [GenerationId, GenerationId];
			}>;
	  }>;

interface D109aCandidateModule {
	planClosedEpochCleanup(input: unknown): D109aPlanningResult;
}

interface D109aInput {
	readonly adoption: Readonly<{ readonly activeHead: PresentHead; readonly adopted: boolean }>;
	readonly availabilityPolicyDigest: string;
	readonly close: Readonly<{
		readonly closedEpoch: number;
		readonly commitQcRef: GenerationRef;
		readonly objectId: StorageObjectId;
		readonly verified: boolean;
	}>;
	readonly expectedHead: PresentHead;
	readonly generations: readonly GenerationRecord[];
	readonly issuance: Readonly<{
		readonly complete: boolean;
		readonly rows: readonly Readonly<{
			readonly authorSequence: number;
			readonly epoch: number;
			readonly issued: boolean;
			readonly outbox: boolean;
			readonly publishState: "pending" | "published";
		}>[];
		readonly scope: Readonly<{ readonly author: string; readonly objectId: StorageObjectId }>;
		readonly throughAuthorSequence: number;
	}>;
	readonly snapshot: Readonly<{ readonly adopted: boolean; readonly manifestDigest: string }>;
}

const OBJECT_ID = `creator:${"a".repeat(32)}` as StorageObjectId;

function bytesFromHex(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, "hex"));
}

function generationId(index: number): GenerationId {
	return (index + 1).toString(16).repeat(64) as GenerationId;
}

function generationRef(index: number): GenerationRef {
	return Object.freeze({ byteLength: index + 10, digest: (index + 10).toString(16).repeat(64) });
}

function closureDigest(closure: readonly GenerationRef[]): string {
	const digest = digestClosure(closure);
	if (!digest.ok) throw new TypeError("D.109a synthetic closure digest failed");
	return digest.value;
}

function head(index: number): PresentHead {
	const closure = Object.freeze([generationRef(index)]);
	return Object.freeze({
		closureDigest: closureDigest(closure),
		generationId: generationId(index),
		kind: "present" as const,
		objectId: OBJECT_ID,
		revision: index + 1,
	});
}

function generation(index: number, state: GenerationRecord["state"]): GenerationRecord {
	const closure = Object.freeze([generationRef(index)]);
	return Object.freeze({
		baseExpectedHead: index === 0 ? Object.freeze({ kind: "none" as const, objectId: OBJECT_ID }) : head(index - 1),
		closure,
		closureDigest: closureDigest(closure),
		generationId: generationId(index),
		objectId: OBJECT_ID,
		state,
	});
}

function syntheticInput(): D109aInput {
	const generations = Object.freeze([
		generation(0, "Superseded"),
		generation(1, "Superseded"),
		generation(2, "Superseded"),
		generation(3, "Superseded"),
		generation(4, "Adopted"),
	]);
	return Object.freeze({
		adoption: Object.freeze({ activeHead: head(4), adopted: true }),
		availabilityPolicyDigest: D109A_POLICY_DIGEST,
		close: Object.freeze({
			closedEpoch: 0,
			commitQcRef: generationRef(5),
			objectId: OBJECT_ID,
			verified: true,
		}),
		expectedHead: head(4),
		generations,
		issuance: Object.freeze({
			complete: true,
			rows: Object.freeze([
				Object.freeze({
					authorSequence: 0,
					epoch: 0,
					issued: true,
					outbox: true,
					publishState: "published" as const,
				}),
			]),
			scope: Object.freeze({ author: "a".repeat(64), objectId: OBJECT_ID }),
			throughAuthorSequence: 0,
		}),
		snapshot: Object.freeze({ adopted: true, manifestDigest: "b".repeat(64) }),
	});
}

function replaceInput(input: D109aInput, patch: Partial<D109aInput>): D109aInput {
	return Object.freeze({ ...input, ...patch });
}

function withGeneration(input: D109aInput, index: number, patch: Partial<GenerationRecord>): D109aInput {
	return replaceInput(input, {
		generations: Object.freeze(
			input.generations.map((record, candidateIndex) =>
				candidateIndex === index ? Object.freeze({ ...record, ...patch }) : record
			)
		),
	});
}

function hasDanglingParent(generations: readonly GenerationRecord[]): boolean {
	const ids = new Set(generations.map(({ generationId: value }) => value));
	return generations.some(
		(record) => record.baseExpectedHead.kind === "present" && !ids.has(record.baseExpectedHead.generationId)
	);
}

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = D109A_GREEN_PATHS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

function sourceGovernance(): Readonly<{
	readonly exactRefusalVocabulary: boolean;
	readonly noDeleteLikeCall: boolean;
	readonly noPackageExport: boolean;
	readonly noRootExport: boolean;
}> {
	const sourcePath = resolve(REPOSITORY_ROOT, D109A_SOURCE);
	const source = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
	const root = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/index.ts"), "utf8");
	const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "packages/node/package.json"), "utf8")) as {
		readonly exports?: Readonly<Record<string, unknown>>;
	};
	return Object.freeze({
		exactRefusalVocabulary: D109A_REFUSALS.every((reason) => source.includes(`"${reason}"`)),
		noDeleteLikeCall: !/\.(?:clear|delete|discard)\s*\(|\b(?:clear|delete|discard)[A-Z]\w*\s*\(/u.test(source),
		noPackageExport: !("./closed-epoch-cleanup" in (manifest.exports ?? {})),
		noRootExport: !/closed-epoch-cleanup|planClosedEpochCleanup/u.test(root),
	});
}

function deepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object" || seen.has(value)) return true;
	seen.add(value);
	if (!Object.isFrozen(value)) return false;
	return Object.values(value).every((entry) => deepFrozen(entry, seen));
}

async function candidate(): Promise<D109aCandidateModule> {
	return import(pathToFileURL(resolve(REPOSITORY_ROOT, D109A_SOURCE)).href) as Promise<D109aCandidateModule>;
}

const state = readiness();

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

describe("D.109a closed-epoch cleanup eligibility RED", () => {
	it("freezes one tests-only RED owner, one internal GREEN owner, the policy vector, and refusal precedence", () => {
		expect(D109A_RED_PATHS).toEqual(["tests/phase-6b-cleanup-eligibility-red.test.ts"]);
		expect(D109A_GREEN_PATHS).toEqual(["packages/node/src/internal/closed-epoch-cleanup.ts"]);
		expect(readFileSync(resolve(REPOSITORY_ROOT, D109A_RED_PATHS[0])).byteLength).toBeGreaterThan(0);
		expect(
			Buffer.from(hashDomain("ts-drp/availability-policy/v3", bytesFromHex(D109A_POLICY_BYTES_HEX))).toString("hex")
		).toBe(D109A_POLICY_DIGEST);
		expect(D109A_REFUSALS).toEqual([
			"D109A_QC_INVALID",
			"D109A_ADOPTION_INVALID",
			"D109A_HEAD_MISMATCH",
			"D109A_REVISION_STALE",
			"D109A_IDENTITY_INVALID",
			"D109A_LINEAGE_INVALID",
			"D109A_ROLLBACK_INSUFFICIENT",
			"D109A_SNAPSHOT_MISSING",
			"D109A_POLICY_UNSUPPORTED",
			"D109A_OUTBOX_INCOMPLETE",
		]);
	});

	it("proves the dangling-parent mutant and exact local lineage-floor normalization", () => {
		const input = syntheticInput();
		const unnormalized = input.generations.filter(
			(record) => ![generationId(0), generationId(1)].includes(record.generationId)
		);
		expect(hasDanglingParent(unnormalized)).toBe(true);
		const normalized = unnormalized.map((record) =>
			record.generationId === generationId(2)
				? Object.freeze({
						...record,
						baseExpectedHead: Object.freeze({ kind: "none" as const, objectId: OBJECT_ID }),
					})
				: record
		);
		expect(hasDanglingParent(normalized)).toBe(false);
		expect(normalized.map(({ generationId: value }) => value)).toEqual([
			generationId(2),
			generationId(3),
			generationId(4),
		]);
	});

	it("keeps the candidate package-internal and free of deletion effects", () => {
		expect(sourceGovernance()).toEqual({
			exactRefusalVocabulary: state.ready,
			noDeleteLikeCall: true,
			noPackageExport: true,
			noRootExport: true,
		});
	});

	it("[RED readiness] requires the sole closed-epoch cleanup planner", () => {
		expect(state, "D109A_CLEANUP_PLANNER_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!state.ready)("returns the exact immutable active/two-ancestor/floor plan", async () => {
		const result = (await candidate()).planClosedEpochCleanup(syntheticInput());
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new TypeError(`D.109a positive control refused: ${result.reason}`);
		expect(Object.keys(result).sort()).toEqual(["ok", "plan"]);
		expect(Object.keys(result.plan).sort()).toEqual([
			"activeGenerationId",
			"availabilityPolicyDigest",
			"closedEpoch",
			"expectedHead",
			"issuance",
			"lineageFloor",
			"objectId",
			"rollbackGenerationIds",
		]);
		expect(result.plan).toMatchObject({
			activeGenerationId: generationId(4),
			availabilityPolicyDigest: D109A_POLICY_DIGEST,
			closedEpoch: 0,
			lineageFloor: {
				deleteGenerationIds: [generationId(0), generationId(1)],
				expectedBaseExpectedHead: head(1),
				generationId: generationId(2),
				replacementBaseExpectedHead: { kind: "none", objectId: OBJECT_ID },
			},
			objectId: OBJECT_ID,
			rollbackGenerationIds: [generationId(3), generationId(2)],
		});
		expect(deepFrozen(result)).toBe(true);
	});

	it.skipIf(!state.ready)("rejects every causal mutant with the exact closed reason", async () => {
		const planner = (await candidate()).planClosedEpochCleanup;
		const base = syntheticInput();
		const cases: readonly Readonly<{
			readonly input: D109aInput;
			readonly label: string;
			readonly reason: D109aRefusal;
		}>[] = [
			{
				input: replaceInput(base, { close: Object.freeze({ ...base.close, verified: false }) }),
				label: "missing verified commit QC",
				reason: "D109A_QC_INVALID",
			},
			{
				input: replaceInput(base, { adoption: Object.freeze({ ...base.adoption, adopted: false }) }),
				label: "non-adopted successor",
				reason: "D109A_ADOPTION_INVALID",
			},
			{
				input: replaceInput(base, {
					expectedHead: Object.freeze({ ...base.expectedHead, generationId: generationId(8) }),
				}),
				label: "mismatched expected head",
				reason: "D109A_HEAD_MISMATCH",
			},
			{
				input: replaceInput(base, {
					expectedHead: Object.freeze({ ...base.expectedHead, revision: base.expectedHead.revision - 1 }),
				}),
				label: "stale expected revision",
				reason: "D109A_REVISION_STALE",
			},
			{
				input: replaceInput(base, {
					generations: Object.freeze([...base.generations, base.generations[0] as GenerationRecord]),
				}),
				label: "duplicate generation identity",
				reason: "D109A_IDENTITY_INVALID",
			},
			{
				input: withGeneration(base, 3, { baseExpectedHead: head(0) }),
				label: "wrong but countable rollback pair",
				reason: "D109A_LINEAGE_INVALID",
			},
			{
				input: replaceInput(base, { generations: Object.freeze(base.generations.filter((_, index) => index !== 2)) }),
				label: "missing second rollback ancestor",
				reason: "D109A_ROLLBACK_INSUFFICIENT",
			},
			{
				input: replaceInput(base, { snapshot: Object.freeze({ ...base.snapshot, adopted: false }) }),
				label: "missing adopted local snapshot",
				reason: "D109A_SNAPSHOT_MISSING",
			},
			{
				input: replaceInput(base, { availabilityPolicyDigest: "f".repeat(64) }),
				label: "unsupported availability policy",
				reason: "D109A_POLICY_UNSUPPORTED",
			},
			{
				input: replaceInput(base, { issuance: Object.freeze({ ...base.issuance, complete: false }) }),
				label: "incomplete outbox classification",
				reason: "D109A_OUTBOX_INCOMPLETE",
			},
		];
		for (const testCase of cases) {
			expect(planner(testCase.input), testCase.label).toEqual({ ok: false, reason: testCase.reason });
		}
	});

	it.skipIf(!state.ready)(
		"refuses gaps, surviving branches, wrong floor parents, and incomplete closures",
		async () => {
			const planner = (await candidate()).planClosedEpochCleanup;
			const base = syntheticInput();
			const branch = Object.freeze({
				...generation(5, "Superseded"),
				baseExpectedHead: head(0),
				generationId: generationId(8),
			});
			const cases = [
				replaceInput(base, { generations: Object.freeze(base.generations.filter((_, index) => index !== 1)) }),
				replaceInput(base, { generations: Object.freeze([...base.generations, branch]) }),
				withGeneration(base, 2, { baseExpectedHead: head(0) }),
				withGeneration(base, 2, { closure: Object.freeze([]) }),
			];
			for (const input of cases) {
				expect(planner(input)).toEqual({ ok: false, reason: "D109A_LINEAGE_INVALID" });
			}
		}
	);

	it.skipIf(!state.ready)("applies exact refusal precedence", async () => {
		const base = syntheticInput();
		const result = (await candidate()).planClosedEpochCleanup(
			replaceInput(base, {
				adoption: Object.freeze({ ...base.adoption, adopted: false }),
				availabilityPolicyDigest: "f".repeat(64),
				close: Object.freeze({ ...base.close, verified: false }),
				issuance: Object.freeze({ ...base.issuance, complete: false }),
				snapshot: Object.freeze({ ...base.snapshot, adopted: false }),
			})
		);
		expect(result).toEqual({ ok: false, reason: "D109A_QC_INVALID" });
	});

	it.skipIf(!state.ready)("is permutation-invariant and returns detached output", async () => {
		const planner = (await candidate()).planClosedEpochCleanup;
		const input = syntheticInput();
		const first = planner(input);
		const permuted = planner(replaceInput(input, { generations: Object.freeze([...input.generations].reverse()) }));
		expect(permuted).toEqual(first);
		if (!first.ok) throw new TypeError(`D.109a detached-output control refused: ${first.reason}`);
		const mutable = input.generations.map((record) => ({ ...record, closure: [...record.closure] }));
		const detached = planner(replaceInput(input, { generations: mutable }));
		mutable[0]?.closure.splice(0);
		mutable.reverse();
		expect(detached).toEqual(first);
		expect(deepFrozen(detached)).toBe(true);
	});

	it.skipIf(!state.ready)(
		"accepts genuine Phase-6a close/adoption material without reopening verification",
		async () => {
			const fixture = await openGenuineCreatorAdoptionFixture();
			try {
				const verifier = (await import(
					pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts")).href
				)) as {
					verifyCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
				};
				const committer = (await import(
					pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-commit.ts")).href
				)) as {
					commitCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
				};
				const verified = await verifier.verifyCreatorSuccessorAdoption({
					catalog: fixture.catalog,
					handle: fixture.handle,
				});
				expect(verified).toMatchObject({ ok: true });
				const committed = await committer.commitCreatorSuccessorAdoption({
					handle: fixture.handle,
					intent: verified.intent,
				});
				expect(committed).toMatchObject({ lifecycle: "successor-prepared", ok: true });
				const activeHead = committed.head as PresentHead;
				const committedInspection = await fixture.handle.inspectDurableHead();
				expect(committedInspection.head).toEqual(activeHead);
				const activeClosure = Object.freeze(
					committedInspection.references.map((ref) => Object.freeze({ byteLength: ref.byteLength, digest: ref.digest }))
				);
				const generations = Object.freeze([
					...fixture.evidence.generations.map((record) =>
						Object.freeze({
							...record,
							state:
								record.generationId === fixture.evidence.proposed.head.generationId
									? ("Superseded" as const)
									: record.state,
						})
					),
					Object.freeze({
						baseExpectedHead: fixture.evidence.proposed.head,
						closure: activeClosure,
						closureDigest: activeHead.closureDigest,
						generationId: activeHead.generationId,
						objectId: activeHead.objectId,
						state: "Adopted" as const,
					}),
				]);
				const cut = decodeCanonical(
					bytesForRef(fixture.evidence.proposed, fixture.evidence.closeResult.cutValueRef)
				) as Readonly<Record<string, unknown>>;
				const outbox = await fixture.evidence.issuanceStore.readOutboxPage({
					scope: fixture.evidence.issuanceScope,
				});
				expect(outbox.map(({ commit }) => commit.authorSequence)).toEqual(
					Array.from({ length: fixture.evidence.localIssued.authorSequence + 1 }, (_, index) => index)
				);
				for (const { commit } of outbox) {
					await fixture.evidence.issuanceStore.compareAndMarkOutboxPublished({
						authorSequence: commit.authorSequence,
						digest: new Uint8Array(commit.envelope.digest),
						scope: fixture.evidence.issuanceScope,
					});
				}
				const publishedOutbox = await fixture.evidence.issuanceStore.readOutboxPage({
					scope: fixture.evidence.issuanceScope,
				});
				expect(publishedOutbox.every(({ publishState }) => publishState === "published")).toBe(true);
				const input = replaceInput(syntheticInput(), {
					adoption: Object.freeze({ activeHead, adopted: true }),
					availabilityPolicyDigest: String(cut.availabilityPolicyDigest),
					close: Object.freeze({
						closedEpoch: fixture.evidence.closeResult.epoch,
						commitQcRef: fixture.evidence.closeResult.commitQcRef,
						objectId: activeHead.objectId,
						verified: true,
					}),
					expectedHead: activeHead,
					generations,
					issuance: Object.freeze({
						complete: true,
						rows: Object.freeze(
							publishedOutbox.map(({ commit, publishState }) =>
								Object.freeze({
									authorSequence: commit.authorSequence,
									epoch: fixture.evidence.closeResult.epoch,
									issued: true,
									outbox: true,
									publishState,
								})
							)
						),
						scope: fixture.evidence.issuanceScope,
						throughAuthorSequence: fixture.evidence.localIssued.authorSequence,
					}),
					snapshot: Object.freeze({
						adopted: true,
						manifestDigest: fixture.evidence.declaration.scope.manifestDigest,
					}),
				});
				const result = (await candidate()).planClosedEpochCleanup(input);
				expect(
					result,
					JSON.stringify({
						activeHead,
						generations: generations.map(({ baseExpectedHead, closure, closureDigest, generationId, state }) => ({
							baseExpectedHead,
							closure,
							closureDigest,
							generationId,
							recomputedClosureDigest: digestClosure(closure),
							state,
						})),
						issuance: input.issuance,
						result,
					})
				).toMatchObject({ ok: true });
			} finally {
				await fixture.close();
			}
		}
	);
});
