import "fake-indexeddb/auto";

import { decodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
	d108d1aRetainedMessage,
	signD108d1aVertexDigest,
} from "./fixtures/phase-6a-v3/creator-successor-handle-identity-contract.js";
import { D109F_PROOF_KIND_REGISTRY } from "./fixtures/phase-6b/differential-exit-contract.js";
import {
	createD109dReceipts,
	D109D_CENSUS_KEYS,
	D109D_ERROR_CODES,
	D109D_GREEN_PATHS,
	D109D_IDENTITY_MUTANTS,
	D109D_INPUT_KEYS,
	D109D_PRECEDENCE,
	D109D_RECEIPT_MUTANTS,
	D109D_RED_PATHS,
	D109D_REPLAY_AUTHORITY_MUTANTS,
	D109D_REPLAY_OUTCOME_FIELDS,
	D109D_SUCCESS_KEYS,
	d109dCandidate,
	d109dDeepFrozen,
	d109dErrorCode,
	d109dReadiness,
	d109dSourceGovernance,
	openD109dColdFixture,
	openD109dHotFixture,
	REPOSITORY_ROOT,
} from "./fixtures/phase-6b/runtime-reclamation-contract.js";

const readiness = d109dReadiness();

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("D109D_TEST_RECORD_EXPECTED");
	}
	return value as Record<string, unknown>;
}

function values(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new TypeError("D109D_TEST_ARRAY_EXPECTED");
	return value;
}

function changedDigest(value: unknown): string {
	return value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
}

async function eventually(check: () => Promise<boolean>, attempts = 100): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (await check()) return;
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	throw new TypeError("D109D_EVENTUALLY_TIMED_OUT");
}

async function reclaim(
	fixture: Awaited<ReturnType<typeof openD109dHotFixture>>,
	receipts: Awaited<ReturnType<typeof createD109dReceipts>>,
	options: Readonly<{
		readonly aheReceipt?: unknown;
		readonly issuanceReceipt?: unknown;
		readonly successor?: object;
	}> = {}
): Promise<Readonly<Record<string, unknown>>> {
	const candidate = await d109dCandidate();
	if (candidate.reclaimInstalledV3Runtime === undefined) throw new TypeError("D109D_CANDIDATE_MISSING");
	return candidate.reclaimInstalledV3Runtime({
		aheReceipt: options.aheReceipt ?? receipts.aheReceipt,
		issuanceReceipt: options.issuanceReceipt ?? receipts.issuanceReceipt,
		successor: options.successor ?? fixture.successor,
	});
}

function receiptMutant(
	name: (typeof D109D_RECEIPT_MUTANTS)[number],
	fixture: Awaited<ReturnType<typeof openD109dHotFixture>>,
	receipts: Awaited<ReturnType<typeof createD109dReceipts>>
): unknown {
	const ahe = structuredClone(receipts.aheReceipt) as Record<string, unknown>;
	const issuance = structuredClone(receipts.issuanceReceipt) as Record<string, unknown>;
	const input: Record<string, unknown> = { aheReceipt: ahe, issuanceReceipt: issuance, successor: fixture.successor };
	switch (name) {
		case "missing-ahe-receipt":
			delete input.aheReceipt;
			return input;
		case "missing-issuance-receipt":
			delete input.issuanceReceipt;
			return input;
		case "extra-input-key":
			input.extra = true;
			return input;
		case "accessor-input": {
			const accessor = { issuanceReceipt: issuance, successor: fixture.successor };
			Object.defineProperty(accessor, "aheReceipt", { enumerable: true, get: () => ahe });
			return accessor;
		}
		case "proxy-input":
			return new Proxy(input, {
				ownKeys: (): never => {
					throw new TypeError("D109D_HOSTILE_PROXY");
				},
			});
		case "issuance-extra-key":
			issuance.extra = true;
			return input;
		case "ahe-extra-key":
			ahe.extra = true;
			return input;
		case "shared-object":
			record(issuance.scope).objectId = `creator:${"b".repeat(32)}`;
			return input;
		case "shared-closed-epoch":
			issuance.closedEpoch = Number(issuance.closedEpoch) + 1;
			return input;
		case "issuance-scope-author":
			record(issuance.scope).author = "b".repeat(64);
			return input;
		case "issuance-scope-object":
			record(issuance.scope).objectId = `creator:${"c".repeat(32)}`;
			return input;
		case "snapshot-manifest-digest":
			issuance.snapshotManifestDigest = changedDigest(issuance.snapshotManifestDigest);
			return input;
		case "commit-qc-digest":
			record(issuance.commitQcRef).digest = changedDigest(record(issuance.commitQcRef).digest);
			return input;
		case "commit-qc-byte-length":
			record(issuance.commitQcRef).byteLength = Number(record(issuance.commitQcRef).byteLength) + 1;
			return input;
		case "commit-qc-duplicate":
			record(issuance.commitQcRef).digest = "d".repeat(64);
			return input;
		case "ahe-head-object": {
			const objectId = `creator:${"d".repeat(32)}`;
			ahe.objectId = objectId;
			record(issuance.scope).objectId = objectId;
			record(ahe.expectedHead).objectId = objectId;
			record(record(ahe.floor).expectedFormerBaseExpectedHead).objectId = objectId;
			record(record(ahe.floor).replacementBaseExpectedHead).objectId = objectId;
			return input;
		}
		case "ahe-head-revision":
			record(ahe.expectedHead).revision = Number(record(ahe.expectedHead).revision) + 1;
			return input;
		case "ahe-head-generation": {
			const generationId = changedDigest(record(ahe.expectedHead).generationId);
			record(ahe.expectedHead).generationId = generationId;
			ahe.activeGenerationId = generationId;
			return input;
		}
		case "ahe-active-generation":
			ahe.activeGenerationId = changedDigest(ahe.activeGenerationId);
			return input;
		case "ahe-availability-policy":
			ahe.availabilityPolicyDigest = changedDigest(ahe.availabilityPolicyDigest);
			return input;
		case "ahe-rollback-first":
			values(ahe.rollbackGenerationIds)[0] = values(ahe.rollbackGenerationIds)[1];
			return input;
		case "ahe-rollback-floor":
			values(ahe.rollbackGenerationIds)[1] = values(ahe.rollbackGenerationIds)[0];
			return input;
		case "ahe-floor-generation":
			record(ahe.floor).generationId = changedDigest(record(ahe.floor).generationId);
			return input;
		case "ahe-floor-former-head":
			record(record(ahe.floor).expectedFormerBaseExpectedHead).objectId = `creator:${"e".repeat(32)}`;
			return input;
		case "ahe-floor-replacement-head":
			record(ahe.floor).replacementBaseExpectedHead = structuredClone(ahe.expectedHead);
			return input;
		case "issuance-partial-prefix":
			input.issuanceReceipt = receipts.issuancePartialReceipt;
			return input;
		case "issuance-boundary-above":
			issuance.prunedThroughAuthorSequence = Number(issuance.prunedThroughAuthorSequence) + 1;
			record(issuance.observedLineage).next = Number(record(issuance.observedLineage).next) + 1;
			return input;
	}
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
	const result = await run();
	expect(result).toEqual({ code, ok: false });
	expect(d109dErrorCode(result)).toBe(code);
	expect(d109dDeepFrozen(result)).toBe(true);
}

function successorIssue(logicalTime: number): Readonly<Record<string, unknown>> {
	return Object.freeze({
		operations: Object.freeze([
			Object.freeze({ logicalTime, operation: Object.freeze({ action: "add", value: logicalTime }) }),
		]),
		signRegisteredVertexDigest: signD108d1aVertexDigest,
	});
}

function goldenIssue(logicalTime: number, value: number): Readonly<Record<string, unknown>> {
	return Object.freeze({
		operations: Object.freeze([Object.freeze({ logicalTime, operation: Object.freeze({ action: "add", value }) })]),
		signRegisteredVertexDigest: signD108d1aVertexDigest,
	});
}

describe("D.109d receipt-gated installed-v3 runtime reclamation RED", () => {
	it("freezes the original RED owners and corrected GREEN owner set", () => {
		expect(D109D_RED_PATHS).toEqual([
			"tests/fixtures/phase-6b/runtime-reclamation-contract.ts",
			"tests/phase-6b-runtime-reclamation-red.test.ts",
		]);
		expect(D109D_GREEN_PATHS).toEqual([
			"packages/node/src/internal/runtime-reclamation.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/src/creator-close.ts",
			"packages/node/src/creator-adoption.ts",
			"packages/node/src/internal/creator-successor-live.ts",
		]);
		expect(new Set([...D109D_RED_PATHS, ...D109D_GREEN_PATHS]).size).toBe(7);
		expect(D109D_RED_PATHS.every((entry) => readFileSync(resolve(REPOSITORY_ROOT, entry)).byteLength > 0)).toBe(true);
	});

	it("freezes the closed input, result, error and precedence contracts", () => {
		expect(D109D_INPUT_KEYS).toEqual(["aheReceipt", "issuanceReceipt", "successor"]);
		expect(D109D_SUCCESS_KEYS).toEqual([
			"after",
			"before",
			"closedEpoch",
			"objectId",
			"ok",
			"replay",
			"successorEpoch",
		]);
		expect(D109D_ERROR_CODES).toEqual([
			"D109D_INVALID_ARGUMENT",
			"D109D_RECEIPT_MISMATCH",
			"D109D_IDENTITY_MISMATCH",
			"D109D_RUNTIME_NOT_READY",
			"D109D_INTERNAL_INVARIANT",
		]);
		expect(D109D_PRECEDENCE).toEqual([
			"shape",
			"receipt-internal",
			"identity",
			"registration-bound",
			"readiness",
			"internal",
		]);
	});

	it("freezes the complete receipt, identity, replay and census matrices", () => {
		expect(D109D_RECEIPT_MUTANTS).toHaveLength(27);
		expect(D109D_IDENTITY_MUTANTS).toHaveLength(7);
		expect(D109D_REPLAY_AUTHORITY_MUTANTS).toHaveLength(14);
		expect(D109D_REPLAY_OUTCOME_FIELDS).toEqual([
			"issuanceReceipt.deletedAuthorSequenceRange",
			"aheReceipt.deletedBlobDigests",
			"aheReceipt.deletedGenerationIds",
			"aheReceipt.deletedPromotionCount",
			"aheReceipt.floor.normalizedThisCall",
		]);
		expect(D109D_REPLAY_AUTHORITY_MUTANTS).toContain("issuance-observed-lineage");
		expect(D109D_REPLAY_AUTHORITY_MUTANTS).toContain("ahe-reclaimed-generation-ids");
		expect(D109D_REPLAY_OUTCOME_FIELDS.some((field) => /observedLineage|reclaimedGenerationIds/u.test(field))).toBe(
			false
		);
		expect(D109D_CENSUS_KEYS).toHaveLength(22);
		expect(new Set(D109D_CENSUS_KEYS).size).toBe(D109D_CENSUS_KEYS.length);
	});

	it("keeps runtime reclamation internal and the legacy object runtime detached", () => {
		expect(d109dSourceGovernance()).toEqual({
			noLegacyObjectBinding: true,
			noManifestExport: true,
			noProductHandleMethod: true,
			noRootExport: true,
		});
	});

	it("[RED readiness] requires the private runtime and creator-close release kernels", () => {
		expect(readiness, "D109D_RUNTIME_RECLAMATION_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("uses genuine close, verify, commit and hot activation identities", async () => {
		const fixture = await openD109dHotFixture();
		try {
			expect(fixture.successor).not.toBe(fixture.predecessor);
			expect(fixture.oracle.epoch).toBe(1);
			expect(fixture.successor.topic).toBe(fixture.oracle.stableTopic);
			const receipts = await createD109dReceipts(fixture);
			const candidate = await d109dCandidate();
			const result = await candidate.reclaimInstalledV3Runtime?.({
				aheReceipt: receipts.aheReceipt,
				issuanceReceipt: receipts.issuanceReceipt,
				successor: fixture.successor,
			});
			expect(result).toMatchObject({
				closedEpoch: 0,
				objectId: fixture.oracle.objectId,
				ok: true,
				replay: false,
				successorEpoch: 1,
			});
			expect(Object.keys(result ?? {}).sort()).toEqual([...D109D_SUCCESS_KEYS].sort());
			expect(d109dDeepFrozen(result)).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("enforces the exact refusal matrix and precedence with zero writes", async () => {
		const fixture = await openD109dHotFixture();
		try {
			const receipts = await createD109dReceipts(fixture);
			const candidate = await d109dCandidate();
			if (candidate.reclaimInstalledV3Runtime === undefined) throw new TypeError("D109D_CANDIDATE_MISSING");
			for (const name of D109D_RECEIPT_MUTANTS) {
				const input = receiptMutant(name, fixture, receipts);
				const malformed = new Set([
					"missing-ahe-receipt",
					"missing-issuance-receipt",
					"extra-input-key",
					"accessor-input",
					"proxy-input",
					"issuance-extra-key",
					"ahe-extra-key",
					"ahe-floor-former-head",
				]);
				await expectCode(
					() => candidate.reclaimInstalledV3Runtime?.(input) ?? Promise.reject(new TypeError("missing")),
					malformed.has(name) ? "D109D_INVALID_ARGUMENT" : "D109D_RECEIPT_MISMATCH"
				);
			}

			const internallyInconsistent = structuredClone(receipts.issuanceReceipt) as Record<string, unknown>;
			internallyInconsistent.closedEpoch = Number(internallyInconsistent.closedEpoch) + 1;
			await expectCode(
				() =>
					candidate.reclaimInstalledV3Runtime?.({
						aheReceipt: receipts.aheReceipt,
						issuanceReceipt: internallyInconsistent,
						successor: {},
					}) ?? Promise.reject(new TypeError("missing")),
				"D109D_RECEIPT_MISMATCH"
			);
			for (const name of D109D_IDENTITY_MUTANTS) {
				if (name === "inactive-handle") continue;
				const identity =
					name === "predecessor-handle"
						? fixture.predecessor
						: name === "proxy-handle"
							? new Proxy(fixture.successor, {})
							: name === "copied-handle"
								? Object.freeze({ ...fixture.successor })
								: Object.freeze({ name });
				await expectCode(() => reclaim(fixture, receipts, { successor: identity }), "D109D_IDENTITY_MISMATCH");
			}
			const success = await reclaim(fixture, receipts);
			expect(success).toMatchObject({ ok: true, replay: false });
			await fixture.successor.deactivate();
			await expectCode(() => reclaim(fixture, receipts), "D109D_IDENTITY_MISMATCH");
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("accepts hot and cold real receipts and latches every authority field", async () => {
		for (const open of [openD109dHotFixture, openD109dColdFixture]) {
			const fixture = await open();
			try {
				const receipts = await createD109dReceipts(fixture);
				const result = await reclaim(fixture, receipts);
				expect(result).toMatchObject({ ok: true, replay: false });
				const before = record(result.before);
				expect(before.hotPredecessor).toBe(open === openD109dHotFixture);
				expect(before.displacedSource).toBe(true);
				expect(before.creatorCloseGraph).toBe(true);
				expect(before.creatorCloseStagedSnapshot).toBe(true);
				expect(before.creatorClosePersistedSnapshot).toBe(true);
				expect(before.creatorCloseDerivedCommitment).toBe(true);
				expect(before.creatorCloseDurableReplay).toBe(true);
				expect(result.after).toMatchObject({
					creatorCloseDerivedCommitment: false,
					creatorCloseDurableReplay: false,
					creatorCloseGraph: false,
					creatorClosePersistedSnapshot: false,
					creatorCloseStagedSnapshot: false,
					displacedSource: false,
					hotPredecessor: false,
				});
			} finally {
				await fixture.close();
			}
		}
	});

	it.skipIf(!readiness.ready)("serializes behind successor and predecessor gates with atomic observation", async () => {
		const fixture = await openD109dHotFixture();
		try {
			const receipts = await createD109dReceipts(fixture);
			const order: string[] = [];
			const successorWork = fixture.successor.issueLocal(successorIssue(20)).then((result) => {
				order.push("successor");
				return result;
			});
			const reclaimed = reclaim(fixture, receipts).then((result) => {
				order.push("reclaim");
				return result;
			});
			const [issued, result] = await Promise.all([successorWork, reclaimed]);
			expect(issued).toMatchObject({ ok: true });
			expect(result).toMatchObject({ ok: true });
			expect(order.at(-1)).toBe("reclaim");
			const source = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts"), "utf8");
			expect(source).toMatch(/if \(predecessor\?\.gate !== undefined\) await predecessor\.gate;/u);
			expect(source).toMatch(/const rechecked = predecessorReference\.deref\(\);/u);
			expect(await fixture.successor.publishPending()).toMatchObject({ ok: true });
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)(
		"D.109f preserves owner-observed Discord and MMORPG projections with zero deleted durable reads",
		async () => {
			const lifecycleOwnerKeys = D109F_PROOF_KIND_REGISTRY.flatMap((entry): string[] =>
				"ownerKey" in entry ? [entry.ownerKey] : []
			).sort();
			for (const control of [
				{ label: "discord", logicalTime: 41, open: openD109dHotFixture, value: 7 },
				{ label: "mmorpg", logicalTime: 43, open: openD109dColdFixture, value: 11 },
			] as const) {
				const fixture = await control.open();
				try {
					const receipts = await createD109dReceipts(fixture);
					const admittedBefore = fixture.readAdmittedVertices().length;
					const deletedGenerationIds = new Set<string>(receipts.aheReceipt.deletedGenerationIds);
					const deletedBlobDigests = new Set<string>(receipts.aheReceipt.deletedBlobDigests);
					const deletedThrough = receipts.issuanceReceipt.prunedThroughAuthorSequence;
					const observations: Readonly<{ readonly identity: number | string; readonly owner: string }>[] = [];
					fixture.base.controls.durableReadHook = (observation): void => {
						const deletedAhe =
							(observation.owner === "ahe-generation" && deletedGenerationIds.has(String(observation.identity))) ||
							(observation.owner === "ahe-blob" && deletedBlobDigests.has(String(observation.identity)));
						const deletedIssuance =
							(observation.owner === "issuance-record" || observation.owner === "issuance-outbox") &&
							typeof observation.identity === "number" &&
							observation.identity <= deletedThrough;
						if (deletedAhe || deletedIssuance) {
							throw new TypeError(`D109F_RAW_DEPENDENCY_READ:${observation.owner}:${String(observation.identity)}`);
						}
						observations.push(observation);
					};

					const reclaimed = await reclaim(fixture, receipts);
					expect(reclaimed).toMatchObject({ ok: true, replay: false });
					expect(Object.keys(record(reclaimed.before)).sort()).toEqual(lifecycleOwnerKeys);
					expect(Object.keys(record(reclaimed.after)).sort()).toEqual(lifecycleOwnerKeys);
					const scope = Object.freeze({
						anchorDigest: fixture.oracle.anchorDigest,
						epoch: 1,
						objectId: fixture.oracle.objectId,
					});
					const beforeReadiness = await fixture.base.journal.readiness({ scope });
					if (!beforeReadiness.ok || !beforeReadiness.ready) {
						throw new TypeError(`D109F_${control.label.toUpperCase()}_JOURNAL_NOT_READY`);
					}
					const beforePage = await fixture.base.journal.readPage({
						afterSequence: null,
						limit: 64,
						scope,
						snapshot: beforeReadiness.snapshot,
					});
					if (!beforePage.ok) throw new TypeError(`D109F_${control.label.toUpperCase()}_JOURNAL_READ_FAILED`);
					const issued = await fixture.successor.issueLocal(goldenIssue(control.logicalTime, control.value));
					expect(issued).toMatchObject({ kind: "accepted", ok: true });
					expect(await fixture.successor.publishPending()).toMatchObject({ ok: true });

					const journalReadiness = await fixture.base.journal.readiness({ scope });
					if (!journalReadiness.ok || !journalReadiness.ready) {
						throw new TypeError(`D109F_${control.label.toUpperCase()}_JOURNAL_NOT_READY`);
					}
					const page = await fixture.base.journal.readPage({
						afterSequence: null,
						limit: 64,
						scope,
						snapshot: journalReadiness.snapshot,
					});
					if (!page.ok) throw new TypeError(`D109F_${control.label.toUpperCase()}_JOURNAL_READ_FAILED`);
					const acceptedDigests = Object.freeze(page.rows.map(({ vertexDigest }) => vertexDigest));
					expect(acceptedDigests).toContain(String(issued.digest));
					expect(acceptedDigests).toHaveLength(beforePage.rows.length + 1);
					const admitted = fixture.readAdmittedVertices();
					expect(admitted).toHaveLength(admittedBefore + 1);
					const delivery = record(admitted.at(-1));
					const vertex = record(delivery.vertex);
					const exactPreimage = decodeCanonical(delivery.exactReceivedCanonicalPreimageBytes as Uint8Array);
					expect(record(exactPreimage).operation).toEqual(vertex.operation);
					expect(Array.from(vertex.digest as Uint8Array, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
						String(issued.digest)
					);
					expect(vertex.operation).toEqual({ action: "add", value: control.value });
					const projection =
						control.label === "discord"
							? Object.freeze({
									channelOperation: vertex.operation,
									messageDigests: acceptedDigests,
								})
							: Object.freeze({
									inventoryOperation: vertex.operation,
									worldEventDigests: acceptedDigests,
								});
					expect(Object.values(projection)).toContain(vertex.operation);
					expect(Object.values(projection)).toContain(acceptedDigests);
					expect(await fixture.base.handle.inspectDurableHead()).toMatchObject({ head: fixture.committedHead });
					expect(observations.some(({ owner }) => owner === "ahe-generation")).toBe(true);
					expect(observations.some(({ owner }) => owner === "ahe-blob")).toBe(true);
					expect(observations.some(({ owner }) => owner === "issuance-outbox")).toBe(true);
					expect(observations.some(({ owner }) => owner === "live-journal-row")).toBe(true);
				} finally {
					fixture.base.controls.durableReadHook = undefined;
					await fixture.close();
				}
			}
		}
	);

	it.skipIf(!readiness.ready)("releases every predecessor owner while preserving the live successor", async () => {
		const fixture = await openD109dHotFixture();
		try {
			const receipts = await createD109dReceipts(fixture);
			const result = await reclaim(fixture, receipts);
			expect(Object.keys(record(result.before)).sort()).toEqual([...D109D_CENSUS_KEYS].sort());
			expect(Object.keys(record(result.after)).sort()).toEqual([...D109D_CENSUS_KEYS].sort());
			expect(result.before).toEqual({
				applicationAuthors: 2,
				applicationCharges: 3,
				applicationVertices: 3,
				blueprintState: true,
				causalityIndex: 3,
				creatorCloseDerivedCommitment: true,
				creatorCloseDurableReplay: true,
				creatorCloseGraph: true,
				creatorClosePersistedSnapshot: true,
				creatorCloseStagedSnapshot: true,
				displacedRebaseCursor: false,
				displacedSource: true,
				epochBytes: 1754,
				graphVersion: 2,
				hotPredecessor: true,
				latchedOperations: 0,
				pendingIngress: 0,
				pendingIngressBytes: 0,
				publication: false,
				quarantine: 0,
				rebase: false,
				retainedPayloadMetadata: true,
			});
			expect(result.after).toEqual({
				applicationAuthors: 0,
				applicationCharges: 1,
				applicationVertices: 1,
				blueprintState: false,
				causalityIndex: 1,
				creatorCloseDerivedCommitment: false,
				creatorCloseDurableReplay: false,
				creatorCloseGraph: false,
				creatorClosePersistedSnapshot: false,
				creatorCloseStagedSnapshot: false,
				displacedRebaseCursor: false,
				displacedSource: false,
				epochBytes: 962,
				graphVersion: 1,
				hotPredecessor: false,
				latchedOperations: 0,
				pendingIngress: 0,
				pendingIngressBytes: 0,
				publication: false,
				quarantine: 0,
				rebase: false,
				retainedPayloadMetadata: true,
			});
			expect(await fixture.successor.readRebaseOutbox()).toEqual({ kind: "empty", ok: true });
			const issued = await fixture.successor.issueLocal(successorIssue(30));
			expect(issued).toMatchObject({ kind: "accepted", ok: true });
			expect(await fixture.successor.publishPending()).toMatchObject({ ok: true });
			const live = (await import(new URL("../packages/node/src/v3-live.ts", import.meta.url).href)) as Readonly<{
				routeV3RetainedIngress(handle: object, message: unknown): boolean;
			}>;
			const remote = d108d1aRetainedMessage({
				anchorDigest: fixture.oracle.anchorDigest,
				author: fixture.base.evidence.issuanceScope.author,
				authorSequence: Number(issued.authorSequence) + 1,
				dependency: String(issued.digest),
				objectId: fixture.oracle.objectId,
				sender: `d109d-remote-${crypto.randomUUID()}`,
				topic: fixture.successor.topic,
			});
			expect(live.routeV3RetainedIngress(fixture.successor, remote.message)).toBe(true);
			await eventually(async () => {
				const readiness = await fixture.base.journal.readiness({
					scope: {
						anchorDigest: fixture.oracle.anchorDigest,
						epoch: 1,
						objectId: fixture.oracle.objectId,
					},
				});
				if (!readiness.ok || !readiness.ready) return false;
				const page = await fixture.base.journal.readPage({
					afterSequence: null,
					limit: 32,
					scope: readiness.scope,
					snapshot: readiness.snapshot,
				});
				return page.ok && page.rows.some((row) => row.vertexDigest === remote.digest);
			});
			const liveSource = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts"), "utf8");
			const exportStart = liveSource.indexOf("function exportLiveSnapshotPayload(");
			const exportEnd = liveSource.indexOf("\nfunction makeV3BlueprintLiveHandle(", exportStart);
			const snapshotExportOwner = liveSource.slice(exportStart, exportEnd);
			expect(exportStart).toBeGreaterThanOrEqual(0);
			expect(exportEnd).toBeGreaterThan(exportStart);
			expect(snapshotExportOwner).toMatch(/registration\.blueprintMachine/u);
			expect(snapshotExportOwner).not.toMatch(/displacedSource|hotPredecessor/u);
			const closeHandle = fixture.base.handle as Readonly<{
				inspectDurableHead(): Promise<Readonly<Record<string, unknown>>>;
				status(): Readonly<Record<string, unknown>>;
			}>;
			expect(closeHandle.status()).toMatchObject({ lifecycle: "successor-adopted" });
			expect(await closeHandle.inspectDurableHead()).toMatchObject({ head: fixture.committedHead });
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("returns frozen replay success and refuses changed authority after release", async () => {
		const fixture = await openD109dHotFixture();
		try {
			const receipts = await createD109dReceipts(fixture);
			const first = await reclaim(fixture, receipts);
			expect(first).toMatchObject({ ok: true, replay: false });
			const replay = await reclaim(fixture, receipts, {
				aheReceipt: receipts.aheReplayReceipt,
				issuanceReceipt: receipts.issuanceReplayReceipt,
			});
			expect(replay).toEqual({ ...first, replay: true });
			expect(d109dDeepFrozen(replay)).toBe(true);

			for (const name of D109D_REPLAY_AUTHORITY_MUTANTS) {
				const ahe = structuredClone(receipts.aheReplayReceipt) as Record<string, unknown>;
				const issuance = structuredClone(receipts.issuanceReplayReceipt) as Record<string, unknown>;
				switch (name) {
					case "object-id":
					case "issuance-scope":
						record(issuance.scope).author = "b".repeat(64);
						break;
					case "closed-epoch":
					case "successor-epoch":
						issuance.closedEpoch = Number(issuance.closedEpoch) + 1;
						ahe.closedEpoch = Number(ahe.closedEpoch) + 1;
						break;
					case "issuance-boundary":
						issuance.prunedThroughAuthorSequence = Number(issuance.prunedThroughAuthorSequence) - 1;
						break;
					case "issuance-observed-lineage":
						record(issuance.observedLineage).next = Number(record(issuance.observedLineage).next) + 1;
						break;
					case "snapshot-manifest-digest":
						issuance.snapshotManifestDigest = changedDigest(issuance.snapshotManifestDigest);
						break;
					case "commit-qc-ref":
						record(issuance.commitQcRef).digest = changedDigest(record(issuance.commitQcRef).digest);
						break;
					case "ahe-adopted-head":
						record(ahe.expectedHead).revision = Number(record(ahe.expectedHead).revision) + 1;
						break;
					case "ahe-active-generation": {
						const id = changedDigest(ahe.activeGenerationId);
						ahe.activeGenerationId = id;
						record(ahe.expectedHead).generationId = id;
						break;
					}
					case "ahe-reclaimed-generation-ids":
						values(ahe.reclaimedGenerationIds).push("c".repeat(64));
						break;
					case "ahe-rollback-identities":
						values(ahe.rollbackGenerationIds)[0] = "b".repeat(64);
						break;
					case "ahe-floor-identities": {
						const id = "a".repeat(64);
						record(ahe.floor).generationId = id;
						values(ahe.rollbackGenerationIds)[1] = id;
						break;
					}
					case "availability-policy":
						ahe.availabilityPolicyDigest = changedDigest(ahe.availabilityPolicyDigest);
						break;
				}
				await expectCode(
					() => reclaim(fixture, receipts, { aheReceipt: ahe, issuanceReceipt: issuance }),
					"D109D_RECEIPT_MISMATCH"
				);
			}
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)(
		"keeps precommit construction failure byte-identical and subsequently usable",
		async () => {
			const fixture = await openD109dHotFixture();
			try {
				const receipts = await createD109dReceipts(fixture);
				const malformed = structuredClone(receipts.aheReceipt) as Record<string, unknown>;
				malformed.deletedGenerationIds = Object.freeze(["f".repeat(64)]);
				await expectCode(() => reclaim(fixture, receipts, { aheReceipt: malformed }), "D109D_RECEIPT_MISMATCH");
				expect(await fixture.successor.issueLocal(successorIssue(40))).toMatchObject({ ok: true });
				const result = await reclaim(fixture, receipts);
				expect(result).toMatchObject({ ok: true, replay: false });
				expect(await fixture.successor.publishPending()).toMatchObject({ ok: true });
				const source = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts"), "utf8");
				const kernelStart = source.indexOf("async function reclaimV3RuntimeKernel(");
				const kernelEnd = source.indexOf("\nfunction activationFailure(", kernelStart);
				const kernel = source.slice(kernelStart, kernelEnd);
				const firstWrite = kernel.indexOf("closePlan.release()");
				for (const marker of [
					"d109dCensus(",
					"new CausalityIndex(",
					"d109dAfterCensus(",
					"const result = ObjectFreeze(",
				]) {
					expect(kernel.indexOf(marker)).toBeGreaterThanOrEqual(0);
					expect(kernel.indexOf(marker)).toBeLessThan(firstWrite);
				}
			} finally {
				await fixture.close();
			}
		}
	);
});
