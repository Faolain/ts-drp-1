import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assertRecovery } from "./assertions.js";
import {
	type AuthFaultGraph,
	type AuthFaultPlan,
	planAuthFault,
	verifyAuthFaultPersistence,
} from "./auth-fault-plan.js";
import { type AuthEvent, AuthObservationError, createAuthObserver } from "./auth-observer.js";
import { authenticationTransform, transformAuthentication } from "./auth-transform.js";
import type { RecoveryReport, RestartBootstrap, SetupReport } from "./types.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "../../../packages/storage/dist/src/index.js";

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
	if (!result.ok) throw new Error("CONTROL_VALUE");
	return result.value;
}
const objectId = value(parseStorageObjectId(`creator:${"a".repeat(32)}`));
const bootstrap: RestartBootstrap = {
	identity: "control",
	author: "a",
	catalogDigest: "b",
	detachedSignature: "c",
	exactCanonicalAnchorPreimageBytes: "d",
	exactCanonicalParametersCarrierBytes: "e",
	exactCanonicalPinnedGenesisBootstrapOperationBytes: "f",
	pinnedGenesisAnchorDigest: "g",
	expectedRoomHead: { objectId, epoch: 1, currentAnchorDigest: "a".repeat(64) },
};

function fixture(duplicateTarget = false): AuthFaultGraph {
	const records: Record<string, unknown>[] = [
		{
			kind: "drp-anchor-trust-state",
			objectId,
			currentEpoch: 1,
			detachedCurrentAnchorSignature: new Uint8Array(64).fill(7),
		},
		{ kind: "drp-hard-epoch-cut", objectId, epoch: 0, previousAnchor: "a".repeat(64) },
		{ kind: "drp-seal-qc", objectId, epoch: 0, phase: "commit", proposalDigest: "b".repeat(64) },
		{ kind: "control-dependent-original", signature: new Uint8Array([1, 2, 3]) },
	];
	if (duplicateTarget) records.push({ ...records[0], detachedCurrentAnchorSignature: new Uint8Array(64).fill(8) });
	const blobs = records.map((record) => {
		const bytes = encodeCanonical(record);
		return { digest: value(digestBlob(bytes)), bytes };
	});
	const closure = blobs
		.map((blob) => ({ digest: blob.digest, byteLength: blob.bytes.byteLength }))
		.sort((left, right) => (left.digest < right.digest ? -1 : 1));
	const closureDigest = value(digestClosure(closure));
	const previous = value(parseGenerationId("1".repeat(64))),
		proposed = value(parseGenerationId("2".repeat(64))),
		active = value(parseGenerationId("3".repeat(64)));
	const previousHead = {
		kind: "present" as const,
		objectId,
		generationId: previous,
		closureDigest,
		revision: value(parseHeadRevision(1)),
	};
	const proposedHead = { ...previousHead, generationId: proposed, revision: value(parseHeadRevision(2)) };
	const head = { ...previousHead, generationId: active, revision: value(parseHeadRevision(3)) };
	return {
		headRecord: encodeHeadRecordV1(head),
		blobs,
		generations: [
			{
				generationId: previous,
				record: encodeGenerationRecordV1({
					objectId,
					generationId: previous,
					closure,
					closureDigest,
					state: "Superseded",
					baseExpectedHead: { kind: "none", objectId },
				}),
			},
			{
				generationId: proposed,
				record: encodeGenerationRecordV1({
					objectId,
					generationId: proposed,
					closure,
					closureDigest,
					state: "Superseded",
					baseExpectedHead: previousHead,
				}),
			},
			{
				generationId: active,
				record: encodeGenerationRecordV1({
					objectId,
					generationId: active,
					closure,
					closureDigest,
					state: "Adopted",
					baseExpectedHead: proposedHead,
				}),
			},
		],
		promotions: [previous, proposed, active].flatMap((generationId) =>
			closure.map((ref) => ({ generationId, digest: ref.digest }))
		),
	};
}
function applyPlan(graph: AuthFaultGraph, plan: AuthFaultPlan): AuthFaultGraph {
	const blobs = new Map(graph.blobs.map((row) => [row.digest, row]));
	blobs.set(plan.blob.digest, plan.blob);
	return {
		headRecord: plan.headRecord ?? graph.headRecord,
		blobs: [...blobs.values()],
		generations: graph.generations.map(
			(row) => plan.generations.find((write) => write.generationId === row.generationId) ?? row
		),
		promotions: graph.promotions.map((row) => {
			const write = plan.promotions.find(
				(item) => item.generationId === row.generationId && item.fromDigest === row.digest
			);
			return write === undefined ? row : { generationId: row.generationId, digest: write.toDigest };
		}),
	};
}

void test("planner changes only the original field and rebinds every storage dependency without modifying input", () => {
	for (const mode of ["bad-trust", "bad-cut", "bad-qc"] as const) {
		const graph = fixture(),
			before = encodeCanonical(graph),
			plan = planAuthFault(graph, bootstrap, mode),
			after = applyPlan(graph, plan);
		assert.deepEqual(encodeCanonical(graph), before);
		verifyAuthFaultPersistence(graph, after, plan);
		assert.notEqual(plan.receipt.oldRef.digest, plan.receipt.newRef.digest);
		assert.equal(plan.receipt.changedClosures, 3);
		assert.equal(plan.receipt.changedBases, 2);
		assert.equal(plan.promotions.length, 3);
		const oldBytes = graph.blobs.find((blob) => blob.digest === plan.receipt.oldRef.digest)?.bytes;
		assert.ok(oldBytes);
		const oldRecord = decodeCanonical(oldBytes) as Record<string, unknown>,
			changed = decodeCanonical(plan.blob.bytes) as Record<string, unknown>;
		const field =
			mode === "bad-trust"
				? "detachedCurrentAnchorSignature"
				: mode === "bad-cut"
					? "previousAnchor"
					: "proposalDigest";
		assert.notDeepEqual(changed[field], oldRecord[field]);
		changed[field] = oldRecord[field];
		assert.deepEqual(encodeCanonical(changed), oldBytes);
		for (const blob of graph.blobs)
			assert.deepEqual(after.blobs.find((row) => row.digest === blob.digest)?.bytes, blob.bytes);
		for (const row of after.generations) {
			const generation = value(decodeGenerationRecordV1(row.record));
			assert.equal(generation.closureDigest, value(digestClosure(generation.closure)));
			for (const ref of generation.closure) {
				const blob = after.blobs.find((candidate) => candidate.digest === ref.digest);
				assert.ok(blob);
				assert.equal(value(digestBlob(blob.bytes)), ref.digest);
			}
			if (generation.baseExpectedHead.kind === "present") {
				const parentId = generation.baseExpectedHead.generationId;
				const parent = after.generations.find((candidate) => candidate.generationId === parentId);
				assert.ok(parent);
				assert.equal(
					generation.baseExpectedHead.closureDigest,
					value(decodeGenerationRecordV1(parent.record)).closureDigest
				);
			}
		}
		const head = value(decodeHeadRecordV1(after.headRecord));
		assert.equal(head.kind, "present");
		if (head.kind === "present") {
			const generation = after.generations.find((row) => row.generationId === head.generationId);
			assert.ok(generation);
			assert.equal(head.closureDigest, value(decodeGenerationRecordV1(generation.record)).closureDigest);
		}
	}
});
void test("no-op is byte-identical and raw bitrot preserves stale storage references", () => {
	const graph = fixture(),
		noop = planAuthFault(graph, bootstrap, "rehash-noop");
	assert.deepEqual(applyPlan(graph, noop), graph);
	verifyAuthFaultPersistence(graph, applyPlan(graph, noop), noop);
	for (const mode of ["storage-corrupt-trust", "storage-corrupt-cut", "storage-corrupt-qc"] as const) {
		const plan = planAuthFault(graph, bootstrap, mode),
			after = applyPlan(graph, plan);
		assert.equal(plan.blob.digest, plan.receipt.oldRef.digest);
		assert.notEqual(value(digestBlob(plan.blob.bytes)), plan.blob.digest);
		assert.deepEqual(after.generations, graph.generations);
		assert.deepEqual(after.headRecord, graph.headRecord);
		assert.deepEqual(after.promotions, graph.promotions);
		verifyAuthFaultPersistence(graph, after, plan);
	}
});
void test("planner refuses missing or duplicate targets, stale input hashes, missing promotions and wrong object", () => {
	const graph = fixture();
	const firstBlob = graph.blobs[0];
	assert.ok(firstBlob);
	assert.throws(() => planAuthFault({ ...graph, blobs: [] }, bootstrap, "bad-trust"), /PROPOSED_BLOB_MISSING/u);
	assert.throws(
		() => planAuthFault({ ...graph, blobs: [...graph.blobs, firstBlob] }, bootstrap, "bad-trust"),
		/DUPLICATE_BLOB/u
	);
	assert.throws(() => planAuthFault(fixture(true), bootstrap, "bad-trust"), /TARGET_COUNT:2/u);
	assert.throws(() => planAuthFault({ ...graph, promotions: [] }, bootstrap, "bad-trust"), /PROMOTION/u);
	assert.throws(
		() =>
			planAuthFault(
				graph,
				{ ...bootstrap, expectedRoomHead: { ...bootstrap.expectedRoomHead, objectId: "elsewhere" } },
				"bad-trust"
			),
		/HEAD_OBJECT/u
	);
	const corrupt = {
		...graph,
		blobs: graph.blobs.map((row, index) => (index === 0 ? { ...row, bytes: new Uint8Array([1]) } : row)),
	};
	assert.throws(() => planAuthFault(corrupt, bootstrap, "bad-trust"), /ORIGINAL_BLOB_DIGEST/u);
	const missingTarget = { ...bootstrap, expectedRoomHead: { ...bootstrap.expectedRoomHead, epoch: 9 } };
	assert.throws(() => planAuthFault(graph, missingTarget, "bad-trust"), /TARGET_COUNT:0/u);
});
void test("post-write verifier kills omitted promotion, closure, head and signed-dependent-preservation mutants", () => {
	const graph = fixture(),
		plan = planAuthFault(graph, bootstrap, "bad-qc"),
		after = applyPlan(graph, plan);
	for (const mutant of [
		{ ...after, promotions: graph.promotions },
		{ ...after, generations: graph.generations },
		{ ...after, headRecord: graph.headRecord },
		{ ...after, blobs: after.blobs.slice(1) },
		{ ...after, blobs: after.blobs.map((row, index) => (index === 0 ? { ...row, bytes: new Uint8Array([0]) } : row)) },
	])
		assert.throws(() => verifyAuthFaultPersistence(graph, mutant, plan), /AUTH_FAULT_PLAN/u);
});

void test("authentication observer rejects missing/duplicate registrations and preserves actual result identity", async () => {
	for (const count of [0, 1, 3]) {
		const observer = createAuthObserver();
		for (let index = 0; index < count; index++) observer.register(index === 0 ? "cold" : "successor");
		await assert.rejects(
			observer.observe(
				() => {},
				(): Promise<never> => assert.fail("must not run")
			),
			/AUTH_OBSERVER_HOOKS/u
		);
	}
	const observer = createAuthObserver();
	observer.register("cold");
	observer.register("successor");
	const result = Object.freeze({ ok: false, reason: "native" }),
		events: AuthEvent[] = [];
	observer.event("cold-successor", result);
	assert.equal(
		await observer.observe(
			(event) => {
				events.push(event);
			},
			async () => {
				observer.event("cold-successor", result);
				await assert.rejects(
					observer.observe(
						() => {},
						() => Promise.resolve(result)
					),
					/ALREADY_ACTIVE/u
				);
				return result;
			}
		),
		result
	);
	observer.event("cold-successor", result);
	assert.deepEqual(events, [{ site: "cold-successor", ...result }]);
});
void test("authentication observer failures cannot throw into authentication or replace primary exceptions", async () => {
	const observer = createAuthObserver();
	observer.register("cold");
	observer.register("successor");
	const result = Object.freeze({ ok: true });
	await assert.rejects(
		observer.observe(
			() => {
				throw new Error("observer");
			},
			() => {
				assert.doesNotThrow(() => observer.event("cold-successor", result));
				return Promise.resolve(result);
			}
		),
		(error: unknown) => error instanceof AuthObservationError && error.productionResult === result
	);
	const primary = Object.freeze({ thrown: true });
	await assert.rejects(
		observer.observe(
			() => {
				throw new Error("observer");
			},
			() => {
				observer.event("cold-successor", result);
				return Promise.reject(primary);
			}
		),
		(error: unknown) => error === primary
	);
	assert.equal(
		await observer.observe(
			() => {},
			() => Promise.resolve(result)
		),
		result
	);
});
void test("observer bounds and late registration fail the harness after leaving production untouched", async () => {
	for (const lateRegistration of [false, true]) {
		const observer = createAuthObserver();
		observer.register("cold");
		observer.register("successor");
		const actual = Object.freeze({ ok: true });
		let observed = 0;
		await assert.rejects(
			observer.observe(
				() => {
					observed++;
				},
				() => {
					if (lateRegistration) observer.register("cold");
					else
						for (let index = 0; index < 17; index++)
							assert.doesNotThrow(() => observer.event("cold-successor", actual));
					return Promise.resolve(actual);
				}
			),
			(error: unknown) => error instanceof AuthObservationError && error.productionResult === actual
		);
		assert.equal(observed, lateRegistration ? 0 : 16);
	}
});
void test("auth instrumentation is insertion-only and rejects ambiguous/missing/substituted production calls", () => {
	for (const module of ["cold", "successor"] as const) {
		const path =
			module === "cold"
				? "packages/node/dist/src/creator-adoption.js"
				: "packages/protocol-v3/dist/src/creator-close.js";
		const raw = readFileSync(path, "utf8"),
			observed = transformAuthentication(raw, module);
		let reconstructed = raw;
		for (const insertion of [...observed.insertions].sort((left, right) => right.offset - left.offset))
			reconstructed = reconstructed.slice(0, insertion.offset) + insertion.text + reconstructed.slice(insertion.offset);
		assert.equal(observed.code, reconstructed);
		assert.throws(() => transformAuthentication("", module), /SITE_NOT_UNIQUE/u);
		assert.throws(() => transformAuthentication(raw + raw, module), /SITE_NOT_UNIQUE/u);
		assert.throws(() => transformAuthentication(observed.code, module), /ALREADY_PRESENT/u);
		const callee = module === "cold" ? "openCreatorCheckpointTrust" : "verifySealQC";
		assert.throws(
			() => transformAuthentication(raw.replaceAll(`${callee}({`, "fakeAuthentication({"), module),
			/NOT_UNIQUE_OR_GENUINE/u
		);
		const variable = module === "cold" ? "openedCheckpoint" : "verified";
		const owner = module === "cold" ? "reopenCreatorSuccessorMaterial" : "openCreatorSuccessorTrust";
		const ownerOffset = raw.indexOf(`function ${owner}(`);
		const declarationOffset = raw.indexOf(`const ${variable} =`, ownerOffset);
		assert.ok(ownerOffset >= 0 && declarationOffset > ownerOffset);
		const duplicate =
			raw.slice(0, declarationOffset) + `const ${variable} = ${callee}({});\n` + raw.slice(declarationOffset);
		assert.throws(() => transformAuthentication(duplicate, module), /RESULT_SITE_NOT_UNIQUE/u);
		assert.throws(
			() => transformAuthentication(raw.replaceAll(`const ${variable} =`, `const hidden${variable} =`), module),
			/NOT_UNIQUE_OR_GENUINE/u
		);
		if (module === "successor")
			assert.throws(
				() => transformAuthentication(raw.replaceAll(", cutBytes)", ", wrongCutBytes)"), module),
				/CUT_DIGEST_SITE_CHANGED/u
			);
	}
	assert.throws(() => authenticationTransform("unused").finish(), /LOADED_MODULE_COUNT:0/u);
});

function authReport(): { report: RecoveryReport; setup: SetupReport } {
	const graph = fixture(),
		receipt = planAuthFault(graph, bootstrap, "bad-cut").receipt;
	return {
		setup: {
			bootstrap,
			oracle: {
				expectedState: 0,
				lookupScope: { objectId, epoch: 0, anchor: "a".repeat(64), manifestDigest: "b".repeat(64) },
				closeEpochs: [0],
				states: [0],
			},
		},
		report: {
			mode: "bad-cut",
			result: { ok: false, kind: "chain-invalid" },
			classification: "REACHED",
			effects: {
				lookupScopes: [],
				lookupStates: [],
				lookupRetentions: [],
				acquisitions: 0,
				reads: 0,
				completes: 0,
				recoverObjects: [objectId],
				recoverResults: [{ ok: true, kind: "active" }],
				authEvents: [
					{ site: "cold-genesis", ok: true },
					{ site: "successor-qc", ok: true },
					{ site: "successor-cut-binding", matches: false },
					{ site: "cold-successor", ok: false, reason: "CERTIFIED_VALUE_MISMATCH" },
				],
				authMutation: receipt,
				signs: 0,
				subscriptions: 0,
				publications: 0,
				mutations: 1,
				events: [],
			},
		},
	};
}
void test("gate assertions kill storage-masked, missing-auth, wrong-cut/QC-gate and downstream-effects mutants", () => {
	const { report, setup } = authReport();
	assert.doesNotThrow(() => assertRecovery(report, setup));
	for (const effects of [
		{ ...report.effects, recoverResults: [{ ok: false as const, reason: "ADOPTED_BLOB_CORRUPT" }] },
		{ ...report.effects, authEvents: [] },
		{
			...report.effects,
			authEvents: report.effects.authEvents.map((event) =>
				event.site === "successor-cut-binding" ? { ...event, matches: true } : event
			),
		},
		{
			...report.effects,
			authEvents: report.effects.authEvents.map((event) =>
				event.site === "successor-qc" ? { ...event, ok: false, reason: "proposal-hash-mismatch" } : event
			),
		},
		{ ...report.effects, reads: 1 },
		{ ...report.effects, signs: 1 },
	])
		assert.throws(() => assertRecovery({ ...report, effects }, setup));
	const bitrot: RecoveryReport = {
		...report,
		mode: "storage-corrupt-cut",
		result: { ok: false, kind: "storage-failed" },
		effects: {
			...report.effects,
			recoverResults: [{ ok: false, reason: "ADOPTED_BLOB_CORRUPT" }],
			authEvents: [],
			authMutation: planAuthFault(fixture(), bootstrap, "storage-corrupt-cut").receipt,
		},
	};
	assert.doesNotThrow(() => assertRecovery(bitrot, setup));
	assert.throws(() =>
		assertRecovery({ ...bitrot, effects: { ...bitrot.effects, authEvents: report.effects.authEvents } }, setup)
	);
});
