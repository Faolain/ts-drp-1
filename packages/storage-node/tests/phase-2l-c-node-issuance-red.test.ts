import { ed25519 } from "@noble/curves/ed25519.js";
import { build } from "esbuild";
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	applySettlementPlanEffect,
	assertSettlementPlanProgressTransition,
	cloneSettlementPlan,
	copySettlementPlan,
} from "@ts-drp/issuance-store";
import {
	captureIssuanceNativeSignInput,
	decodeIssuanceRetirementControl,
	durableIssuancePruningMaintenanceForStore,
	encodeIssuanceRetirementControl,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementImage,
	issuanceUnsignedContinuationWidths,
	issuanceUnsignedPostimageWidths,
	issuanceUnsignedSuccessorFenceWidths,
} from "@ts-drp/issuance-store/maintenance";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	derivedFilename,
	errorShape,
	loadPhase2lCNodeModule,
	phase2lCCommit,
	PHASE_2L_C_AMBIGUITY_CASES,
	PHASE_2L_C_DDL,
	PHASE_2L_C_SCOPE,
	PHASE_2L_C_V3_DDL,
} from "./fixtures/phase-2l-c-node-issuance-contract.js";
import contract from "../../../tests/fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import { encodeCanonical } from "../../canonical/dist/src/index.js";
import type {
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "../../issuance-store/dist/src/index.js";
import registry from "../../protocol-v3/registry/registry-v1.json" with { type: "json" };
import {
	createAdmissionBoundTransactionalVertexIssuer,
	createTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	verifyReceivedVertex,
} from "../../protocol-v3/src/index.js";

const temporaryDirectories: string[] = [];
const lockFixture = new URL("./fixtures/phase-2l-c-node-lock-child.mjs", import.meta.url);
const raceFixture = new URL("./fixtures/phase-2l-c-node-race-child.mjs", import.meta.url);
const admissionObserverFixture = new URL("./fixtures/phase-2l-c-node-admission-observer-child.mjs", import.meta.url);

const currencySeed = new Uint8Array(Buffer.from(contract.privateKeySeedHex, "hex"));
const currencyPublicKey = ed25519.getPublicKey(currencySeed);
const currencyScope = { objectId: contract.vertex.objectId, author: Buffer.from(currencyPublicKey).toString("hex") };
const currencyPackageBytes = encodeCanonical(contract.package);
const currencyPrepared = prepareBlueprintAdmission({
	canonicalBlueprintPackageBytes: currencyPackageBytes,
	expectedBlueprintDigest: Buffer.from(hashDomain("ts-drp/blueprint-admission/v3", currencyPackageBytes)).toString(
		"hex"
	),
});
const currencyInput = { ...contract.vertex, epoch: 1, operation: contract.validOperation };

describe("Node exact-held recovery census producer", () => {
	const input = {objectId: currencyScope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS};
	const nativeStore = (store: DurableIssuanceStore) => store as DurableIssuanceStore & {
		acquireNativeReadReservation(input: {objectId: string}): Promise<import("@ts-drp/storage").NativeReadReservation>;
	};

	it("checks genuine current observations freshly without rereading their complete native census", async () => {
		const filename = primary("census-probe-checks"), {createNodeDurableIssuanceStore} = await loadPhase2lCNodeModule();
		const store = nativeStore(createNodeDurableIssuanceStore({primaryFilename: filename}));
		let lease: Awaited<ReturnType<typeof store.acquireNativeReadReservation>> | undefined;
		const original = DatabaseSync.prototype.prepare;
		let rowReads = 0, nativeChecks = 0;
		try {
			await currencyIssuer(store, undefined, digest => Promise.resolve(ed25519.sign(digest, currencySeed))).issue(currencyInput);
			const reader = durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus!;
			expect(Object.isFrozen(reader)).toBe(true);
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			DatabaseSync.prototype.prepare = function (sql: string) {
				if (/FROM (lineages|issued_records|issuance_outbox|settlement_plans)\b/.test(sql)) rowReads++;
				if (sql === "SELECT name FROM sqlite_schema LIMIT 1") nativeChecks++;
				return original.call(this, sql);
			};
			const observation = await reader(input), reads = rowReads;
			expect(reads).toBeGreaterThan(0);
			expect(reader.captureCurrentProbe).toBeTypeOf("function");
			const probe = reader.captureCurrentProbe!.call(reader, input, observation)!;
			expect(probe).toBeDefined();
			expect(reader.captureCurrentProbe!.call(reader, input, observation)).toBeUndefined();
			const beforeChecks = nativeChecks;
			for (let index = 0; index < 5; index++) expect(await probe.checkCurrent()).toBe(true);
			expect(nativeChecks - beforeChecks).toBe(5);
			expect(rowReads).toBe(reads);
			await expect(probe.checkCurrent.call({...probe})).rejects.toMatchObject({code: "ISSUANCE_INVALID_ARGUMENT"});
			await lease.release(); lease = undefined;
			expect(await probe.checkCurrent()).toBe(false);
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			expect(await probe.checkCurrent()).toBe(false);
			const fresh = await reader(input);
			expect(rowReads).toBeGreaterThan(reads);
			expect(reader.captureCurrentProbe!.call(reader, input, fresh)).toBeDefined();
		} finally {DatabaseSync.prototype.prepare = original; await lease?.release(); await store.close();}
	});

	it("refuses copied, mutated, wrong-input, accessor and foreign-producer enrollment", async () => {
		const filename = primary("census-probe-enrollment"), {createNodeDurableIssuanceStore} = await loadPhase2lCNodeModule();
		const store = nativeStore(createNodeDurableIssuanceStore({primaryFilename: filename}));
		let lease: Awaited<ReturnType<typeof store.acquireNativeReadReservation>> | undefined;
		try {
			await currencyIssuer(store, undefined, digest => Promise.resolve(ed25519.sign(digest, currencySeed))).issue(currencyInput);
			const reader = durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus!;
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			const observation = await reader(input), capture = reader.captureCurrentProbe!;
			expect(capture).toBeTypeOf("function");
			expect(capture.call(reader, input, structuredClone(observation))).toBeUndefined();
			expect(capture.call(reader, {...input, objectId: "foreign"}, observation)).toBeUndefined();
			expect(capture.call(reader, {...input, limits: {...input.limits, maxRows: input.limits.maxRows - 1}}, observation)).toBeUndefined();
			let getters = 0;
			const accessor = Object.defineProperty({}, "objectId", {enumerable: true, get() {getters++; return input.objectId;}});
			expect(capture.call(reader, accessor as typeof input, observation)).toBeUndefined();
			expect(getters).toBe(0);
			const wrapper = ((value: typeof input) => reader(value));
			expect(capture.call(wrapper, input, observation)).toBeUndefined();
			expect(capture.call(reader, input, Object.defineProperty({...observation}, "rows", {enumerable: true,
				get() {getters++; return observation.rows;}}))).toBeUndefined();
			expect(getters).toBe(0);
			observation.rows.issued[0]!.signature[0] ^= 1;
			expect(capture.call(reader, input, observation)).toBeUndefined();
			const fresh = await reader(input), probe = capture.call(reader, input, fresh)!;
			expect(await probe.checkCurrent()).toBe(true);
		} finally {await lease?.release(); await store.close();}
	});

	it("revokes immediately and joins admitted checks before releasing foreign native exclusion", async () => {
		const filename = primary("census-probe-join"), {createNodeDurableIssuanceStore} = await loadPhase2lCNodeModule();
		const store = nativeStore(createNodeDurableIssuanceStore({primaryFilename: filename}));
		const foreign = new DatabaseSync(derivedFilename(filename)); foreign.exec("PRAGMA busy_timeout=0");
		let lease: Awaited<ReturnType<typeof store.acquireNativeReadReservation>> | undefined;
		try {
			const reader = durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus!;
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			const observation = await reader(input), probe = reader.captureCurrentProbe!.call(reader, input, observation)!;
			const check = probe.checkCurrent();
			await Promise.resolve(); // The original fresh native check has entered; delivery is pending.
			const released = lease.release();
			const revokedCheck = lease.check();
			expect(reader.captureCurrentProbe!.call(reader, input, observation)).toBeUndefined();
			expect(() => foreign.exec("BEGIN IMMEDIATE")).toThrow();
			await expect(revokedCheck).rejects.toThrow("NATIVE_READ_RESERVATION_RELEASED");
			expect(await check).toBe(false);
			await released; lease = undefined;
			foreign.exec("BEGIN IMMEDIATE"); foreign.exec("ROLLBACK");
			expect(await probe.checkCurrent()).toBe(false);
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			const next = await reader(input), nextProbe = reader.captureCurrentProbe!.call(reader, input, next)!;
			const pending = nextProbe.checkCurrent(), closing = store.close();
			await expect(pending).rejects.toMatchObject({code: "ISSUANCE_STORE_CLOSED"});
			await closing; lease = undefined;
			await expect(nextProbe.checkCurrent()).rejects.toMatchObject({code: "ISSUANCE_STORE_CLOSED"});
		} finally {await lease?.release(); foreign.close(); await store.close();}
	});

	it("revalidates raw corruption after release rather than extending a released probe into a new read", async () => {
		const filename = primary("census-probe-corruption"), {createNodeDurableIssuanceStore} = await loadPhase2lCNodeModule();
		const store = nativeStore(createNodeDurableIssuanceStore({primaryFilename: filename}));
		let lease: Awaited<ReturnType<typeof store.acquireNativeReadReservation>> | undefined;
		try {
			await currencyIssuer(store, undefined, digest => Promise.resolve(ed25519.sign(digest, currencySeed))).issue(currencyInput);
			const reader = durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus!;
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			const observation = await reader(input), probe = reader.captureCurrentProbe!.call(reader, input, observation)!;
			await lease.release(); lease = undefined;
			const raw = new DatabaseSync(derivedFilename(filename));
			try {
				raw.function("issuance_retirement_connection", {varargs: true}, () => 1);
				raw.function("issuance_retirement_record", {varargs: true}, () => 1);
				raw.prepare("UPDATE issued_records SET canonical_preimage=?").run(Uint8Array.of(255));
			} finally {raw.close();}
			lease = await store.acquireNativeReadReservation({objectId: input.objectId});
			expect(await probe.checkCurrent()).toBe(false);
			await expect(reader(input)).rejects.toBeInstanceOf(Error);
			expect(reader.captureCurrentProbe!.call(reader, input, observation)).toBeUndefined();
		} finally {await lease?.release(); await store.close();}
	});

	it("bounds image retention through escaping ended same-job probes", async () => {
		const filename = primary("census-probe-retention"), {createNodeDurableIssuanceStore} = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({primaryFilename: filename});
		try {
			await store.transactIssue(PHASE_2L_C_SCOPE, async sequence => {
				const commit = phase2lCCommit(sequence);
				const envelope = {...commit.envelope, canonicalPreimageBytes: encodeCanonical({...PHASE_2L_C_SCOPE,
					kind: "drp-vertex", protocolMajor: 3, epoch: 0, authorSequence: sequence, payload: new Uint8Array(131_072)})};
				return {...commit, envelope, issuedRecord: {...commit.issuedRecord, envelope}, outboxEntry: {...commit.outboxEntry, envelope}};
			});
		} finally {await store.close();}
		const output = path.join(path.dirname(filename), "census-probe-retention.mjs");
		await build({bundle: true, platform: "node", format: "esm", target: "node22", outfile: output,
			stdin: {resolveDir: import.meta.dirname, sourcefile: "census-probe-retention-child.ts", contents: `
				import {createNodeDurableIssuanceStore} from "../src/issuance.ts";
				import {durableIssuancePruningMaintenanceForStore, ISSUANCE_RETIREMENT_LIMITS} from "@ts-drp/issuance-store/maintenance";
				const store = createNodeDurableIssuanceStore({primaryFilename:process.argv[2],initialization:"reopen"});
				const input={objectId:process.argv[3],limits:ISSUANCE_RETIREMENT_LIMITS}, probes=[];
				const reader=durableIssuancePruningMaintenanceForStore(store).readBoundedRecoveryCensus;
				global.gc(); const before=process.memoryUsage().arrayBuffers; let imageBytes=0;
				for(let index=0;index<24;index++) {
					const held=await store.acquireNativeReadReservation({objectId:input.objectId});
					try {const image=await reader(input); imageBytes=image.image.logicalBytes;
						const probe=reader.captureCurrentProbe?.call(reader,input,image);
						if(!probe) throw Error("original current producer probe missing"); probes.push(probe);
					} finally {await held.release();}
				}
				global.gc(); const after=process.memoryUsage().arrayBuffers;
				for(const probe of probes) if(await probe.checkCurrent()) throw Error("released probe became current");
				console.log(JSON.stringify({retained:after-before,imageBytes,count:probes.length})); await store.close();
			`}});
		const child = spawnSync(process.execPath, ["--expose-gc", "--no-concurrent-array-buffer-sweeping", output, filename, PHASE_2L_C_SCOPE.objectId],
			{encoding: "utf8", timeout: 15_000});
		expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout.trim()) as {retained: number; imageBytes: number; count: number};
		console.info("native census ended probe retention", result);
		expect(result.count).toBe(24); expect(result.retained).toBeLessThan(result.imageBytes * 4);
	});
});

describe("R9 native inherited settlement reference", () => {
	it("retains and charges the exact reference through SQLite reopen without granting replacement authority", async () => {
		const primaryFilename = primary("r9-inherited-reference");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		let store = createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const issuer = currencyIssuer(store, undefined, (digest) => Promise.resolve(ed25519.sign(digest, currencySeed)));
			const source = await issuer.issue(currencyInput);
			const inheritance = {
				sourceObjectId: "r9-source",
				targetObjectId: currencyScope.objectId,
				targetAuthor: currencyScope.author,
				targetAuthorSequence: 3,
				targetVertexDigest: new Uint8Array(32).fill(7),
			};
			const plan = {
				scope: currencyScope,
				revision: 0,
				fenceSequence: null,
				entries: [
					{
						sourceSequence: source.authorSequence,
						sourceDigest: new Uint8Array(32).fill(6),
						disposition: "inherited" as const,
						replacementSequence: null,
						inheritance,
					},
				],
			};
			const captured = copySettlementPlan(plan, currencyScope);
			expect(plan.entries[0]?.sourceDigest).not.toEqual(source.envelope.digest);
			expect(captured).toEqual(plan);
			if (captured === undefined) throw new Error("inherited structural reference was refused");
			const detached = cloneSettlementPlan(captured);
			expect(() =>
				applySettlementPlanEffect(captured, { kind: "replacement", sourceSequence: source.authorSequence }, 4)
			).toThrow();
			expect(detached.entries[0]?.inheritance?.targetVertexDigest).not.toBe(inheritance.targetVertexDigest);
			for (const malformed of [
				{ ...plan.entries[0], inheritance: undefined },
				{ ...plan.entries[0], disposition: "rebase" },
				{ ...plan.entries[0], replacementSequence: 3 },
				{ ...plan.entries[0], inheritance: { ...inheritance, targetVertexDigest: Uint8Array.of(7) } },
				{ ...plan.entries[0], inheritance: { ...inheritance, portableAuthority: true } },
			])
				expect(copySettlementPlan({ ...plan, entries: [malformed] }, currencyScope)).toBeUndefined();
			const maintenance = durableIssuancePruningMaintenanceForStore(store);
			if (!maintenance?.readBoundedRecoveryCensus) throw new Error("bounded native census missing");
			const priorCensus = await maintenance.readBoundedRecoveryCensus({
				objectId: currencyScope.objectId,
				limits: ISSUANCE_RETIREMENT_LIMITS,
			});
			await store.transactWriteSettlementPlan({ scope: currencyScope, expectedRevision: null, plan });
			const before = currencyNativeImage(primaryFilename);
			const changed = {
				...plan,
				revision: 1,
				entries: [
					{ ...plan.entries[0], inheritance: { ...inheritance, targetVertexDigest: new Uint8Array(32).fill(8) } },
				],
			};
			expect(() => assertSettlementPlanProgressTransition(plan, changed)).toThrow();
			await expect(
				store.transactWriteSettlementPlan({ scope: currencyScope, expectedRevision: 0, plan: changed })
			).rejects.toMatchObject({ code: "ISSUANCE_RETRY_REQUIRED" });
			expect(currencyNativeImage(primaryFilename)).toEqual(before);
			const census = await maintenance.readBoundedRecoveryCensus({
				objectId: currencyScope.objectId,
				limits: ISSUANCE_RETIREMENT_LIMITS,
			});
			expect(census.image.planCount).toBe(1);
			expect(census.rows.plans).toEqual([captured]);
			const ordinaryEntries = captured.entries.map(({ inheritance: _reference, ...entry }) => ({
				...entry,
				disposition: "rebase" as const,
			}));
			expect(() =>
				issuanceRetirementImage(
					{
						...census.rows,
						plans: [{ ...captured, entries: ordinaryEntries }],
					},
					currencyScope.objectId
				)
			).toThrow("issuance retirement plan source is unclassified");
			expect(census.image.logicalBytes - priorCensus.image.logicalBytes).toBeGreaterThan(
				encodeCanonical(captured.entries[0]?.inheritance).byteLength
			);
			await store.close();
			store = createNodeDurableIssuanceStore({ primaryFilename });
			expect(await store.readSettlementPlan(currencyScope)).toEqual(captured);
		} finally {
			await store.close();
		}
	});
	it("protects pending inherited target records across local authors before published pruning", async () => {
		const primaryFilename = primary("r9-inherited-cross-author");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		try {
			await currencyIssuer(store, undefined, (digest) => Promise.resolve(ed25519.sign(digest, currencySeed))).issue(
				currencyInput
			);
			const targetSeed = new Uint8Array(32).fill(11),
				targetKey = ed25519.getPublicKey(targetSeed);
			const targetAuthor = Buffer.from(targetKey).toString("hex");
			const targetScope = { objectId: currencyScope.objectId, author: targetAuthor };
			const target = await createTransactionalVertexIssuer({
				author: targetAuthor,
				privateKeySeed: targetSeed,
				publicKey: { bytes: targetKey, format: "raw" },
				transactIssue: (scope, build) => store.transactIssue(scope, build),
			}).issue(currencyInput);
			await store.compareAndMarkOutboxPublished({
				scope: targetScope,
				authorSequence: target.authorSequence,
				digest: target.envelope.digest,
			});
			await store.transactWriteSettlementPlan({
				scope: currencyScope,
				expectedRevision: null,
				plan: {
					scope: currencyScope,
					revision: 0,
					fenceSequence: null,
					entries: [
						{
							sourceSequence: 0,
							sourceDigest: new Uint8Array(32).fill(6),
							disposition: "inherited",
							replacementSequence: null,
							inheritance: {
								sourceObjectId: "r9-external-source",
								targetObjectId: targetScope.objectId,
								targetAuthor,
								targetAuthorSequence: target.authorSequence,
								targetVertexDigest: target.envelope.digest,
							},
						},
					],
				},
			});
			const maintenance = durableIssuancePruningMaintenanceForStore(store);
			if (maintenance === undefined) throw new Error("native pruning owner unavailable");
			const before = currencyNativeImage(primaryFilename);
			await expect(
				maintenance.prunePublishedPrefix({
					closedEpoch: 1,
					commitQcRef: { byteLength: 1, digest: "e".repeat(64) },
					expectedLineage: { exhausted: false, next: 1 },
					expectedPrunedThroughAuthorSequence: null,
					scope: targetScope,
					snapshotManifestDigest: "f".repeat(64),
					throughAuthorSequence: target.authorSequence,
				})
			).rejects.toThrow("issuance inherited target dependency remains pending");
			expect(currencyNativeImage(primaryFilename)).toEqual(before);
		} finally {
			await store.close();
		}
	});
});

function currencyNativeImage(primaryFilename: string): unknown {
	const database = new DatabaseSync(derivedFilename(primaryFilename), { readOnly: true });
	try {
		return Object.fromEntries(
			["lineages", "issued_records", "issuance_outbox", "settlement_plans", "retirement_controls"].map((table) => [
				table,
				database
					.prepare(
						`SELECT * FROM ${table} ORDER BY object_id${table === "retirement_controls" ? "" : ",author"}${table === "issued_records" || table === "issuance_outbox" ? ",author_sequence" : ""}`
					)
					.all(),
			])
		);
	} finally {
		database.close();
	}
}

async function currencyContext(
	store: DurableIssuanceStore
): Promise<{ expectedIssuanceImageDigest: string; expectedIssuanceControlBytes: Uint8Array | null }> {
	const maintenance = durableIssuancePruningMaintenanceForStore(store);
	if (!maintenance?.readBoundedRecoveryCensus) throw new Error("original noncreating census missing");
	const captured = await maintenance.readBoundedRecoveryCensus({
		objectId: currencyScope.objectId,
		limits: ISSUANCE_RETIREMENT_LIMITS,
	});
	return {
		expectedIssuanceImageDigest: captured.image.imageDigest,
		expectedIssuanceControlBytes:
			captured.control === null || captured.control === undefined
				? null
				: encodeIssuanceRetirementControl(captured.control),
	};
}

function currencyIssuer(
	store: DurableIssuanceStore,
	context: unknown,
	sign: (digest: Uint8Array) => Promise<Uint8Array>
): ReturnType<typeof createAdmissionBoundTransactionalVertexIssuer> {
	return createAdmissionBoundTransactionalVertexIssuer({
		author: currencyScope.author,
		preparedBlueprintAdmission: currencyPrepared,
		publicKey: { bytes: currencyPublicKey, format: "raw" },
		signRegisteredVertexDigest: sign,
		transactIssue: (selected, build) =>
			store.transactIssue(selected, (sequence, nativeSignAdmission) =>
				build(sequence, (bytes: Uint8Array, task: () => Promise<Uint8Array>, effect?: object) => {
					if (!nativeSignAdmission) throw new Error("original native job hook missing");
					return nativeSignAdmission(bytes, task, { ...effect, ...(context as object) });
				})
			),
	});
}

describe("R8 mechanical native currency CAS", () => {
	it("matching complete context with null control permits genuine once NEW", async () => {
		const primaryFilename = primary("currency-match");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		let entered = 0;
		try {
			const context = await currencyContext(store);
			expect(context.expectedIssuanceControlBytes).toBeNull();
			const committed = await currencyIssuer(store, context, (digest) => {
				entered++;
				const signature = ed25519.sign(digest, currencySeed);
				expect(ed25519.verify(signature, digest, currencyPublicKey)).toBe(true);
				return Promise.resolve(signature);
			}).issue(currencyInput);
			expect(entered).toBe(1);
			expect(committed.authorSequence).toBe(0);
			expect(await store.readLineage(currencyScope)).toEqual({ next: 1, exhausted: false });
			expect((await store.readIssued(currencyScope, 0))?.envelope).toEqual(committed.envelope);
			expect(await store.readOutboxPage({ scope: currencyScope })).toHaveLength(1);
			console.log(
				"R8_CURRENCY_MATCH_ONCE_NEW",
				JSON.stringify({ entered, sequence: committed.authorSequence, next: 1, outbox: 1, priorControl: null })
			);
		} finally {
			await store.close();
		}
	});

	it("same rows with a changed original control refuse before crypto without effects", async () => {
		const primaryFilename = primary("currency-control");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const old = await currencyContext(store);
			const maintenance = durableIssuancePruningMaintenanceForStore(store);
			if (!maintenance?.acquireRetirementControl) throw new Error("original control owner missing");
			const birth = await maintenance.acquireRetirementControl({ objectId: currencyScope.objectId });
			await birth.release();
			const current = await currencyContext(store);
			expect(current.expectedIssuanceImageDigest).toBe(old.expectedIssuanceImageDigest);
			expect(old.expectedIssuanceControlBytes).toBeNull();
			expect(current.expectedIssuanceControlBytes).not.toBeNull();
			const before = currencyNativeImage(primaryFilename);
			let entered = 0;
			await expect(
				currencyIssuer(store, old, (digest) => {
					entered++;
					return Promise.resolve(ed25519.sign(digest, currencySeed));
				}).issue(currencyInput)
			).rejects.toMatchObject({ code: "ISSUANCE_RETRY_REQUIRED" });
			expect(entered).toBe(0);
			expect(currencyNativeImage(primaryFilename)).toEqual(before);
			console.log(
				"R8_CURRENCY_CONTROL_STALE",
				JSON.stringify({ sameRows: true, changedControl: true, entered, unchangedAllFiveTables: true })
			);
		} finally {
			await store.close();
		}
	});

	it("stale rows refuse even with matching current control before crypto without effects", async () => {
		const primaryFilename = primary("currency-rows");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const first = await currencyIssuer(store, {}, (digest) =>
				Promise.resolve(ed25519.sign(digest, currencySeed))
			).issue(currencyInput);
			const old = await currencyContext(store);
			await store.compareAndMarkOutboxPublished({
				scope: currencyScope,
				authorSequence: first.authorSequence,
				digest: first.envelope.digest,
			});
			const current = await currencyContext(store);
			expect(current.expectedIssuanceImageDigest).not.toBe(old.expectedIssuanceImageDigest);
			const stale = { ...current, expectedIssuanceImageDigest: old.expectedIssuanceImageDigest };
			const before = currencyNativeImage(primaryFilename);
			let entered = 0;
			await expect(
				currencyIssuer(store, stale, (digest) => {
					entered++;
					return Promise.resolve(ed25519.sign(digest, currencySeed));
				}).issue(currencyInput)
			).rejects.toMatchObject({ code: "ISSUANCE_RETRY_REQUIRED" });
			expect(entered).toBe(0);
			expect(currencyNativeImage(primaryFilename)).toEqual(before);
			console.log(
				"R8_CURRENCY_ROWS_STALE",
				JSON.stringify({
					changedRows: true,
					expectedControlMatchesCurrent: true,
					entered,
					unchangedAllFiveTables: true,
				})
			);
		} finally {
			await store.close();
		}
	});

	it("malformed paired currency contexts refuse before crypto without effects", async () => {
		const primaryFilename = primary("currency-malformed");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const valid = await currencyContext(store);
			const before = currencyNativeImage(primaryFilename);
			const invalid = [
				{ expectedIssuanceImageDigest: valid.expectedIssuanceImageDigest },
				{ expectedIssuanceControlBytes: null },
				{ ...valid, expectedIssuanceControlBytes: undefined },
				{ ...valid, expectedIssuanceControlBytes: Uint8Array.of(1) },
				{ ...valid, expectedIssuanceImageDigest: "not-a-digest" },
				{ ...valid, callerEligible: true },
			];
			let entered = 0;
			for (const context of invalid) {
				await expect(
					currencyIssuer(store, context, (digest) => {
						entered++;
						return Promise.resolve(ed25519.sign(digest, currencySeed));
					}).issue(currencyInput)
				).rejects.toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
				expect(currencyNativeImage(primaryFilename)).toEqual(before);
			}
			expect(entered).toBe(0);
			console.log(
				"R8_CURRENCY_MALFORMED",
				JSON.stringify({ cases: invalid.length, entered, unchangedAllFiveTables: true })
			);
		} finally {
			await store.close();
		}
	});

	it("inherited entered debt with stale currency returns UNKNOWN at local zero and retains exact identity", async () => {
		const primaryFilename = primary("currency-inherited");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const original = createNodeDurableIssuanceStore({ primaryFilename });
		const old = await currencyContext(original);
		let originalEntered = 0;
		try {
			await expect(
				currencyIssuer(original, {}, (digest) => {
					originalEntered++;
					const signature = ed25519.sign(digest, currencySeed);
					expect(ed25519.verify(signature, digest, currencyPublicKey)).toBe(true);
					return Promise.reject(new Error("R8_TEST_ENTERED_CRYPTO_DELIVERY_LOST"));
				}).issue(currencyInput)
			).rejects.toMatchObject({ code: "ISSUANCE_OUTCOME_UNKNOWN" });
		} finally {
			await original.close();
		}
		expect(originalEntered).toBe(1);
		const cold = createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const current = await currencyContext(cold);
			expect(current.expectedIssuanceImageDigest).not.toBe(old.expectedIssuanceImageDigest);
			expect(current.expectedIssuanceControlBytes).not.toEqual(old.expectedIssuanceControlBytes);
			const before = currencyNativeImage(primaryFilename);
			const raw = new DatabaseSync(derivedFilename(primaryFilename), { readOnly: true });
			try {
				const pending = raw
					.prepare("SELECT pending_unsigned FROM lineages WHERE object_id=? AND author=?")
					.get(currencyScope.objectId, currencyScope.author)?.pending_unsigned;
				expect(pending).toBeInstanceOf(Uint8Array);
				expect(decodeCanonical(pending as Uint8Array)).toMatchObject({ phase: "entered", authorSequence: 0 });
			} finally {
				raw.close();
			}
			let entered = 0;
			await expect(
				currencyIssuer(cold, old, (digest) => {
					entered++;
					return Promise.resolve(ed25519.sign(digest, currencySeed));
				}).issue(currencyInput)
			).rejects.toMatchObject({ code: "ISSUANCE_OUTCOME_UNKNOWN", cause: { code: "ISSUANCE_RETRY_REQUIRED" } });
			expect(entered).toBe(0);
			expect(currencyNativeImage(primaryFilename)).toEqual(before);
			expect(await cold.readLineage(currencyScope)).toEqual({ next: 0, exhausted: false });
			expect(await cold.readIssued(currencyScope, 0)).toBeNull();
			console.log(
				"R8_CURRENCY_INHERITED_UNKNOWN",
				JSON.stringify({
					originalEntered,
					entered,
					code: "ISSUANCE_OUTCOME_UNKNOWN",
					cause: "ISSUANCE_RETRY_REQUIRED",
					unchangedAllFiveTables: true,
					retainedIdentity: true,
					next: 0,
					pair: 0,
				})
			);
		} finally {
			await cold.close();
		}
	});
});

describe("R8 mechanical native currency writer gap", () => {
	it("rechecks currency after reserved COMMIT before crypto when another author publishes in the writer gap", async () => {
		const primaryFilename = primary("currency-writer-gap");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		const foreign = createNodeDurableIssuanceStore({ primaryFilename });
		const foreignSeed = new Uint8Array(currencySeed);
		foreignSeed[0] ^= 1;
		const foreignPublicKey = ed25519.getPublicKey(foreignSeed);
		const foreignScope = { objectId: currencyScope.objectId, author: Buffer.from(foreignPublicKey).toString("hex") };
		const originalExec = DatabaseSync.prototype.exec;
		let armed = false,
			interposed = false,
			entered = 0;
		let publication: Promise<void> | undefined;
		let afterInterposition: unknown;
		try {
			const foreignIssuer = createAdmissionBoundTransactionalVertexIssuer({
				author: foreignScope.author,
				preparedBlueprintAdmission: currencyPrepared,
				publicKey: { bytes: foreignPublicKey, format: "raw" },
				signRegisteredVertexDigest: (digest) => {
					const signature = ed25519.sign(digest, foreignSeed);
					expect(ed25519.verify(signature, digest, foreignPublicKey)).toBe(true);
					return Promise.resolve(signature);
				},
				transactIssue: (scope, build) => foreign.transactIssue(scope, build),
			});
			const earlier = await foreignIssuer.issue(currencyInput);
			const context = await currencyContext(store);
			DatabaseSync.prototype.exec = function (sql: string): void {
				originalExec.call(this, sql);
				if (!armed || sql.trim().toUpperCase() !== "COMMIT") return;
				const raw = new DatabaseSync(derivedFilename(primaryFilename), { readOnly: true });
				let pending: unknown;
				try {
					const bytes = raw
						.prepare("SELECT pending_unsigned FROM lineages WHERE object_id=? AND author=?")
						.get(currencyScope.objectId, currencyScope.author)?.pending_unsigned;
					if (bytes instanceof Uint8Array) pending = decodeCanonical(bytes);
				} finally {
					raw.close();
				}
				if (pending === null || typeof pending !== "object" || Reflect.get(pending, "phase") !== "reserved") return;
				armed = false;
				interposed = true;
				// Original native method performs its real atomic publication synchronously
				// before returning its Promise; no mutation of primary receiver/SQL/transaction.
				publication = foreign.compareAndMarkOutboxPublished({
					scope: foreignScope,
					authorSequence: earlier.authorSequence,
					digest: earlier.envelope.digest,
				});
				afterInterposition = currencyNativeImage(primaryFilename);
			};
			armed = true;
			const result = await settled(() =>
				currencyIssuer(store, context, (digest) => {
					entered++;
					const signature = ed25519.sign(digest, currencySeed);
					expect(ed25519.verify(signature, digest, currencyPublicKey)).toBe(true);
					return Promise.resolve(signature);
				}).issue(currencyInput)
			);
			await publication;
			const foreignOutbox = await foreign.readOutboxPage({ scope: foreignScope });
			console.log(
				"R8_CURRENCY_RESERVED_WRITER_GAP",
				JSON.stringify({
					interposed,
					entered,
					foreignPublished: foreignOutbox[0]?.publishState === "published",
					result: result.ok
						? { ok: true, sequence: result.value.authorSequence }
						: { ok: false, code: Reflect.get(result.error as object, "code") },
					primaryNext: (await store.readLineage(currencyScope)).next,
					pair: (await store.readIssued(currencyScope, 0)) !== null,
					onlyAllowedInterpositionPreserved:
						JSON.stringify(currencyNativeImage(primaryFilename)) === JSON.stringify(afterInterposition),
				})
			);
			expect(interposed).toBe(true);
			expect(foreignOutbox[0]?.publishState).toBe("published");
			expect(entered).toBe(0);
			expect(result).toMatchObject({ ok: false, error: { code: "ISSUANCE_RETRY_REQUIRED" } });
			// Original finally permits only this job's definitely-unentered exact
			// reserved cancellation: clear its carrier and bump original control once.
			// It may not advance next/floors, touch another row or clear entered debt.
			const expected = afterInterposition as Record<string, Array<Record<string, unknown>>>;
			const expectedAfterDefiniteCancellation = {
				...expected,
				lineages: expected.lineages.map((row) =>
					row.author === currencyScope.author ? { ...row, pending_unsigned: null } : row
				),
				retirement_controls: expected.retirement_controls.map((row) => {
					const control = decodeIssuanceRetirementControl(row.record);
					return { ...row, record: encodeIssuanceRetirementControl({ ...control, revision: control.revision + 1 }) };
				}),
			};
			expect(await store.readLineage(currencyScope)).toEqual({ next: 0, exhausted: false });
			expect(await store.readIssued(currencyScope, 0)).toBeNull();
			expect(currencyNativeImage(primaryFilename)).toEqual(expectedAfterDefiniteCancellation);
		} finally {
			armed = false;
			DatabaseSync.prototype.exec = originalExec;
			await publication;
			await store.close();
			await foreign.close();
		}
	});
});

describe("R8 mechanical native raw context bounds", () => {
	it("rejects actual oversized control view before copying despite shadowed length and buffer", async () => {
		const primaryFilename = primary("currency-shadowed-view");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		const originalConstructor = globalThis.Uint8Array;
		let copies = 0,
			entered = 0;
		try {
			const valid = await currencyContext(store);
			const raw = new originalConstructor(ISSUANCE_RETIREMENT_LIMITS.maxBytes + 1);
			Object.defineProperties(raw, { byteLength: { value: 1 }, buffer: { value: null } });
			expect(raw.byteLength).toBe(1);
			const before = currencyNativeImage(primaryFilename);
			// Exact original construction semantics; observe only copying this raw
			// carrier. This is not a heap/RSS benchmark or a general allocation proof.
			globalThis.Uint8Array = new Proxy(originalConstructor, {
				construct(target, argumentsList, newTarget): Uint8Array {
					if (argumentsList[0] === raw) copies++;
					return Reflect.construct(target, argumentsList, newTarget);
				},
			});
			const result = await settled(() =>
				currencyIssuer(store, { ...valid, expectedIssuanceControlBytes: raw }, (digest) => {
					entered++;
					return Promise.resolve(ed25519.sign(digest, currencySeed));
				}).issue(currencyInput)
			);
			globalThis.Uint8Array = originalConstructor;
			console.log(
				"R8_CURRENCY_SHADOWED_RAW_VIEW",
				JSON.stringify({
					actualLength: ISSUANCE_RETIREMENT_LIMITS.maxBytes + 1,
					shadowedLength: raw.byteLength,
					shadowedBuffer: raw.buffer,
					copies,
					entered,
					result: result.ok ? { ok: true } : { ok: false, code: Reflect.get(result.error as object, "code") },
					unchangedAllFiveTables: JSON.stringify(currencyNativeImage(primaryFilename)) === JSON.stringify(before),
				})
			);
			expect(result).toMatchObject({ ok: false, error: { code: "ISSUANCE_INVALID_ARGUMENT" } });
			expect(entered).toBe(0);
			expect(currencyNativeImage(primaryFilename)).toEqual(before);
			expect(copies).toBe(0);
		} finally {
			globalThis.Uint8Array = originalConstructor;
			await store.close();
		}
	});
});

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-2l-c-${label}-`));
	temporaryDirectories.push(directory);
	return path.join(directory, "primary.sqlite");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function pragma(database: DatabaseSync, name: string): unknown {
	const statement = database.prepare(`PRAGMA ${name}`);
	statement.setReadBigInts(false);
	const row = statement.get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function schema(filename: string): unknown {
	const database = new DatabaseSync(filename, { readOnly: true });
	try {
		const statement = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name");
		statement.setReadBigInts(false);
		return {
			busyTimeout: pragma(database, "busy_timeout"),
			journalMode: pragma(database, "journal_mode"),
			pageSize: pragma(database, "page_size"),
			rows: statement.all(),
			synchronous: pragma(database, "synchronous"),
			userVersion: pragma(database, "user_version"),
		};
	} finally {
		database.close();
	}
}

function createCatalogFixture(
	filename: string,
	statements: readonly string[],
	options: { readonly journalMode?: "DELETE" | "WAL"; readonly pageSize?: number; readonly userVersion?: number } = {}
): void {
	const database = new DatabaseSync(filename);
	try {
		database.exec(`PRAGMA page_size=${options.pageSize ?? 4096}`);
		database.prepare(`PRAGMA journal_mode=${options.journalMode ?? "WAL"}`).get();
		database.exec("BEGIN IMMEDIATE");
		for (const statement of statements) database.exec(statement);
		database.exec(`PRAGMA user_version=${options.userVersion ?? 1}`);
		database.exec("COMMIT");
	} finally {
		database.close();
	}
}

function commit(scope: DurableIssueScope, authorSequence: number, seed = 7): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
	};
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly error: unknown; readonly ok: false };

async function settled<T>(run: () => T | Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return { error, ok: false };
	}
}

async function withStore<T>(primaryFilename: string, run: (store: DurableIssuanceStore) => Promise<T>): Promise<T> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	const store = createNodeDurableIssuanceStore({ primaryFilename });
	try {
		return await run(store);
	} finally {
		await store.close();
	}
}

describe("Phase 2l-c synchronous factory and exact SQLite admission", () => {
	it("exports one runtime factory and returns the frozen eight-member capability synchronously", async () => {
		const namespace = await loadPhase2lCNodeModule();
		expect(Object.keys(namespace)).toEqual(["createNodeDurableIssuanceStore"]);
		const result = namespace.createNodeDurableIssuanceStore({ primaryFilename: primary("surface") });
		expect(result).not.toBeInstanceOf(Promise);
		expect(Object.keys(result).sort()).toEqual([
			"close",
			"compareAndMarkOutboxPublished",
			"readIssued",
			"readLineage",
			"readOutboxPage",
			"readSettlementPlan",
			"transactIssue",
			"transactWriteSettlementPlan",
		]);
		expect(Reflect.ownKeys(result).sort()).toEqual([
			"close",
			"compareAndMarkOutboxPublished",
			"readIssued",
			"readLineage",
			"readOutboxPage",
			"readSettlementPlan",
			"transactIssue",
			"transactWriteSettlementPlan",
		]);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(Object.isFrozen(result)).toBe(true);
		const closeA = result.close();
		const closeB = result.close();
		expect(closeA).toBe(closeB);
		await expect(closeA).resolves.toBeUndefined();
	});

	it("uses one-pass captured descriptors and rejects the complete closed-record misuse table before open", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const invalidPath = primary("invalid-options");
		const invalid: Array<{ label: string; value: unknown }> = [
			{ label: "undefined", value: undefined },
			{ label: "null", value: null },
			{ label: "plain", value: "legacy" },
			{ label: "array", value: [] },
			{ label: "boxed", value: new String("boxed") },
			{ label: "empty", value: { primaryFilename: "" } },
			{ label: "value-null", value: { primaryFilename: null } },
			{ label: "value-number", value: { primaryFilename: 1 } },
			{ label: "value-boolean", value: { primaryFilename: false } },
			{ label: "value-object", value: { primaryFilename: {} } },
			{ label: "alias", value: { filename: invalidPath } },
			{ label: "extra", value: { primaryFilename: invalidPath, extra: true } },
			{
				label: "symbol",
				value: { primaryFilename: invalidPath, [Symbol("hidden")]: true },
			},
			{
				label: "inherited",
				value: Object.create({ primaryFilename: invalidPath }) as unknown,
			},
			{
				label: "custom-prototype",
				value: Object.assign(Object.create({ marker: true }) as object, { primaryFilename: invalidPath }),
			},
			{
				label: "accessor",
				value: Object.defineProperty({}, "primaryFilename", { enumerable: true, get: () => invalidPath }),
			},
			{
				label: "non-enumerable",
				value: Object.defineProperty({}, "primaryFilename", { enumerable: false, value: invalidPath }),
			},
			{
				label: "hidden-extra",
				value: Object.defineProperty({ primaryFilename: invalidPath }, "hidden", { value: true }),
			},
			{ label: "nul-only", value: { primaryFilename: "\0" } },
			{ label: "nul-prefix", value: { primaryFilename: `\0${invalidPath}` } },
			{ label: "nul-suffix", value: { primaryFilename: `${invalidPath}\0` } },
			{ label: "nul-middle", value: { primaryFilename: `${invalidPath}\0tail` } },
		];
		for (const row of invalid) {
			let synchronous: unknown;
			try {
				Reflect.apply(createNodeDurableIssuanceStore, undefined, [row.value]);
			} catch (error) {
				synchronous = error;
			}
			expect.soft(errorShape(synchronous), row.label).toMatchObject({
				code: "ISSUANCE_INVALID_ARGUMENT",
				name: "DurableIssuanceTypeError",
			});
		}
		expect(fs.existsSync(derivedFilename(invalidPath))).toBe(false);

		let getCalls = 0;
		let ownKeysCalls = 0;
		let descriptorCalls = 0;
		let prototypeCalls = 0;
		const captured = primary("captured");
		const optionsTarget = { primaryFilename: captured };
		const options = new Proxy(optionsTarget, {
			get(target, key, receiver): unknown {
				getCalls++;
				return Reflect.get(target, key, receiver);
			},
			getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
				descriptorCalls++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			getPrototypeOf(target): object | null {
				prototypeCalls++;
				return Reflect.getPrototypeOf(target);
			},
			ownKeys(target): ArrayLike<string | symbol> {
				ownKeysCalls++;
				return Reflect.ownKeys(target);
			},
		});
		const store = createNodeDurableIssuanceStore(options);
		expect(getCalls).toBe(0);
		expect(ownKeysCalls).toBe(1);
		expect(descriptorCalls).toBe(1);
		expect(prototypeCalls).toBe(1);
		optionsTarget.primaryFilename = `${captured}-mutated`;
		expect(fs.existsSync(derivedFilename(captured))).toBe(true);
		expect(fs.existsSync(derivedFilename(optionsTarget.primaryFilename))).toBe(false);
		await store.close();
		const nullPrototypePath = primary("null-prototype");
		const nullPrototypeOptions = Object.assign(Object.create(null) as object, {
			primaryFilename: nullPrototypePath,
		});
		const nullPrototypeStore = createNodeDurableIssuanceStore(nullPrototypeOptions as { primaryFilename: string });
		await nullPrototypeStore.close();
		expect(fs.existsSync(derivedFilename(nullPrototypePath))).toBe(true);

		for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
			const hostile = new Proxy(
				{ primaryFilename: invalidPath },
				{
					[trap](): never {
						throw new Error(`hostile ${trap}`);
					},
				}
			);
			expect(() => createNodeDurableIssuanceStore(hostile)).toThrow(
				expect.objectContaining({ code: "ISSUANCE_INVALID_ARGUMENT", name: "DurableIssuanceTypeError" })
			);
		}
	});

	it("derives verbatim while never touching primary identity or creating parents", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "phase-2l-c-opacity-"));
		temporaryDirectories.push(directory);
		for (const [name, setup] of [
			["absent", (): void => undefined],
			["sentinel", (filename: string): void => fs.writeFileSync(filename, "sentinel")],
			["directory", (filename: string): void => fs.mkdirSync(filename)],
		] as const) {
			const primaryFilename = path.join(directory, name);
			setup(primaryFilename);
			const before = fs.existsSync(primaryFilename)
				? fs.statSync(primaryFilename).isFile()
					? fs.readFileSync(primaryFilename)
					: "directory"
				: "absent";
			const store = createNodeDurableIssuanceStore({ primaryFilename });
			await store.close();
			expect(fs.existsSync(derivedFilename(primaryFilename))).toBe(true);
			const after = fs.existsSync(primaryFilename)
				? fs.statSync(primaryFilename).isFile()
					? fs.readFileSync(primaryFilename)
					: "directory"
				: "absent";
			expect(after).toEqual(before);
		}
		const missingParent = path.join(directory, "missing", "primary");
		expect(() => createNodeDurableIssuanceStore({ primaryFilename: missingParent })).toThrow(
			expect.objectContaining({ code: "ISSUANCE_SUBSTRATE_FAILURE", retryClass: "permanent" })
		);
		expect(fs.existsSync(path.dirname(missingParent))).toBe(false);
		const whitespace = path.join(directory, " opaque name ");
		const whitespaceStore = createNodeDurableIssuanceStore({ primaryFilename: whitespace });
		await whitespaceStore.close();
		expect(fs.existsSync(derivedFilename(whitespace))).toBe(true);
		expect(fs.existsSync(derivedFilename(whitespace.trim()))).toBe(false);
	});

	it("creates, byte-verifies and reopens exactly one authority at schema v3 in the stable v1-derived file", async () => {
		const primaryFilename = primary("schema");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const first = createNodeDurableIssuanceStore({ primaryFilename });
		await first.close();
		const filename = derivedFilename(primaryFilename);
		const observed = schema(filename) as {
			journalMode: string;
			pageSize: number;
			rows: Record<string, unknown>[];
			userVersion: number;
		};
		expect(observed).toMatchObject({ journalMode: "wal", pageSize: 4096, userVersion: 3 });
		expect(observed.rows).toEqual([
			expect.objectContaining({ name: "issuance_outbox", sql: PHASE_2L_C_DDL.issuance_outbox, type: "table" }),
			expect.objectContaining({ name: "issued_records", sql: PHASE_2L_C_DDL.issued_records, type: "table" }),
			expect.objectContaining({ name: "lineages", sql: PHASE_2L_C_DDL.lineages, type: "table" }),
			expect.objectContaining({ name: "settlement_plans", sql: PHASE_2L_C_V3_DDL.settlement_plans, type: "table" }),
		]);
		const reopened = createNodeDurableIssuanceStore({ primaryFilename });
		await reopened.close();
		expect(schema(filename)).toEqual(observed);
	});

	it("pins native constructor booleans, FULL/busy pragmas and explicit numeric statement reads", async () => {
		const primaryFilename = primary("native-options");
		const child = spawn(process.execPath, [admissionObserverFixture.pathname, primaryFilename], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const observation = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("native admission observer timed out"));
			}, 10_000);
			child.once("error", reject);
			child.on("message", (message: Record<string, unknown>) => {
				if (message.kind === "observation") resolve(message);
				if (message.kind === "child-error") reject(new Error(String(message.message)));
			});
			child.once("exit", (code) => {
				clearTimeout(timeout);
				if (code !== 0) reject(new Error(`native admission observer exited ${String(code)}`));
			});
		});
		expect(observation.constructorCalls).toEqual([
			{
				location: derivedFilename(primaryFilename),
				options: {
					allowExtension: false,
					enableDoubleQuotedStringLiterals: false,
					enableForeignKeyConstraints: false,
					readOnly: false,
				},
			},
		]);
		expect(observation.allResultBearingConfigured).toBe(true);
		const events = observation.events as Array<{ kind: string; result?: Record<string, unknown>; sql: string }>;
		expect(
			events.filter(({ kind, sql }) => kind === "exec" && /^CREATE TABLE\b/u.test(sql)).map(({ sql }) => sql)
		).toEqual(Object.values(PHASE_2L_C_V3_DDL));
		const busyWrite = events.findIndex(({ sql }) => /^\s*PRAGMA\s+busy_timeout\s*=\s*1000\s*$/iu.test(sql));
		const busyRead = events.findIndex(
			({ result, sql }, index) =>
				index > busyWrite && /^\s*PRAGMA\s+busy_timeout\s*$/iu.test(sql) && result?.timeout === 1000
		);
		const synchronousWrite = events.findIndex(({ sql }) => /^\s*PRAGMA\s+synchronous\s*=\s*FULL\s*$/iu.test(sql));
		const synchronousRead = events.findIndex(
			({ result, sql }, index) =>
				index > synchronousWrite && /^\s*PRAGMA\s+synchronous\s*$/iu.test(sql) && result?.synchronous === 2
		);
		expect([busyWrite, busyRead, synchronousWrite, synchronousRead].every((index) => index >= 0)).toBe(true);
		expect(busyWrite).toBeLessThan(busyRead);
		expect(synchronousWrite).toBeLessThan(synchronousRead);
	});

	it("retries an interrupted empty catalog but rejects partial, AHE-shaped and extra-schema files without repair", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const retryPrimary = primary("empty-retry");
		const retryFilename = derivedFilename(retryPrimary);
		const empty = new DatabaseSync(retryFilename);
		empty.exec("PRAGMA page_size=4096");
		empty.prepare("PRAGMA journal_mode=WAL").get();
		empty.close();
		const recovered = createNodeDurableIssuanceStore({ primaryFilename: retryPrimary });
		await recovered.close();
		expect(schema(retryFilename)).toMatchObject({ journalMode: "wal", pageSize: 4096, userVersion: 3 });

		for (const [label, statements] of [
			["partial", [PHASE_2L_C_DDL.lineages]],
			["ahe", ["CREATE TABLE objects (object_id TEXT PRIMARY KEY)"]],
			["extra", [...Object.values(PHASE_2L_C_V3_DDL), "CREATE TABLE foreign_table (id TEXT PRIMARY KEY)"]],
		] as const) {
			const primaryFilename = primary(label);
			const filename = derivedFilename(primaryFilename);
			createCatalogFixture(filename, statements);
			const before = schema(filename);
			expect(() => createNodeDurableIssuanceStore({ primaryFilename })).toThrow(
				expect.objectContaining({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" })
			);
			expect(schema(filename)).toEqual(before);
		}
		for (const [label, statements, options] of [
			[
				"ddl-bytes",
				[
					PHASE_2L_C_DDL.lineages.replace("next INTEGER", "next  INTEGER"),
					PHASE_2L_C_DDL.issued_records,
					PHASE_2L_C_DDL.issuance_outbox,
					PHASE_2L_C_V3_DDL.settlement_plans,
				],
				{ userVersion: 3 },
			],
			["wrong-version", Object.values(PHASE_2L_C_V3_DDL), { userVersion: 4 }],
			["wrong-page", Object.values(PHASE_2L_C_V3_DDL), { pageSize: 8192, userVersion: 3 }],
			["wrong-journal", Object.values(PHASE_2L_C_V3_DDL), { journalMode: "DELETE", userVersion: 3 }],
		] as const) {
			const primaryFilename = primary(label);
			const filename = derivedFilename(primaryFilename);
			createCatalogFixture(filename, statements, options);
			const before = schema(filename);
			expect(() => createNodeDurableIssuanceStore({ primaryFilename })).toThrow(
				expect.objectContaining({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" })
			);
			expect(schema(filename)).toEqual(before);
		}
	});
});

describe("R8 SQLite bounded outbox materialization", () => {
	it.skipIf(typeof Reflect.get(globalThis, "gc") !== "function")(
		"retains native streamed outbox statements across forced GC",
		async () => {
			await withStore(primary("r8-outbox-iterator-gc"), async (store) => {
				for (let sequence = 0; sequence < 3; sequence++)
					await store.transactIssue(PHASE_2L_C_SCOPE, (selected) =>
						Promise.resolve(commit(PHASE_2L_C_SCOPE, selected))
					);
				const nativeIterate = StatementSync.prototype.iterate;
				const collect = Reflect.get(globalThis, "gc") as () => void;
				let collections = 0;
				StatementSync.prototype.iterate = function (
					this: StatementSync,
					...parameters: unknown[]
				): ReturnType<StatementSync["iterate"]> {
					const iterator = Reflect.apply(nativeIterate, this, parameters) as ReturnType<StatementSync["iterate"]>;
					const guarded: ReturnType<StatementSync["iterate"]> = new Proxy(iterator, {
						get(target, key): unknown {
							if (key === Symbol.iterator) return (): typeof guarded => guarded;
							const value: unknown = Reflect.get(target, key);
							if (key === "next")
								return (...args: unknown[]): unknown => {
									collect();
									collections++;
									return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
								};
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					return guarded;
				} as typeof StatementSync.prototype.iterate;
				try {
					const page = await store.readOutboxPage({ scope: PHASE_2L_C_SCOPE, limit: 2 });
					expect(page.map((row) => row.commit.authorSequence)).toEqual([0, 1]);
					expect(collections).toBeGreaterThanOrEqual(6);
					console.info(JSON.stringify({ site: "native-outbox-statement-gc", collections, rows: page.length }));
				} finally {
					StatementSync.prototype.iterate = nativeIterate;
				}
				await store.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(commit(PHASE_2L_C_SCOPE, selected)));
				expect(
					(await store.readOutboxPage({ scope: PHASE_2L_C_SCOPE })).map((row) => row.commit.authorSequence)
				).toEqual([0, 1, 2, 3]);
			});
		}
	);

	it("initial outbox validation does not materialize whole-store SELECT arrays", async () => {
		await withStore(primary("r8-outbox-materialization"), async (store) => {
			const scopes = [
				{ author: "foreign-before", objectId: "a" },
				PHASE_2L_C_SCOPE,
				{ author: "foreign-after", objectId: "z" },
			];
			for (const scope of scopes) {
				for (let sequence = 0; sequence < 64; sequence++) {
					await store.transactIssue(scope, (selected) => Promise.resolve(commit(scope, selected)));
				}
			}
			const originalAll = StatementSync.prototype.all;
			const arrays: Array<{ rows: number; sql: string }> = [];
			StatementSync.prototype.all = function (
				this: StatementSync,
				...parameters: unknown[]
			): ReturnType<StatementSync["all"]> {
				const result = Reflect.apply(originalAll, this, parameters) as ReturnType<StatementSync["all"]>;
				const sql = this.sourceSQL;
				if (/^\s*SELECT\b[\s\S]*\bFROM\s+(?:lineages|issued_records|issuance_outbox)\b/iu.test(sql)) {
					arrays.push({ rows: result.length, sql });
				}
				return result;
			} as typeof StatementSync.prototype.all;
			try {
				const page = await store.readOutboxPage({
					afterKey: [PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 0],
					limit: 2,
					scope: PHASE_2L_C_SCOPE,
				});
				const projected = page.map(({ commit: value, publishState }) => ({
					sequence: value.authorSequence,
					scope: value.issuedRecord.scope,
					publishState,
				}));
				console.log("R8_SQLITE_OUTBOX_MATERIALIZATION", JSON.stringify({ arrays, page: projected }));
				expect(projected).toEqual(
					[1, 2].map((sequence) => ({
						sequence,
						scope: PHASE_2L_C_SCOPE,
						publishState: "pending",
					}))
				);
				expect(arrays).toEqual([]);
			} finally {
				StatementSync.prototype.all = originalAll;
			}
		});
	});

	it("bounded global selection preserves UTF-16 inversion, afterKey and detached bytes", async () => {
		await withStore(primary("r8-outbox-utf16"), async (store) => {
			const scopes = [
				{ author: "a", objectId: "\ue000" },
				{ author: "\ue000", objectId: "a" },
				{ author: "a", objectId: "\u{10000}" },
				{ author: "\u{10000}", objectId: "a" },
			];
			for (const scope of scopes) {
				await store.transactIssue(scope, (selected) => Promise.resolve(commit(scope, selected)));
			}
			const first = await store.readOutboxPage({ limit: 2 });
			expect(first.map(({ commit: value }) => value.issuedRecord.scope)).toEqual([scopes[3], scopes[1]]);
			const rest = await store.readOutboxPage({ afterKey: ["a", "\ue000", 0], limit: 2 });
			expect(rest.map(({ commit: value }) => value.issuedRecord.scope)).toEqual([scopes[2], scopes[0]]);
			const expected = commit(scopes[3] as DurableIssueScope, 0);
			const firstRow = first[0];
			if (firstRow === undefined) throw new Error("requested first page row missing");
			firstRow.commit.envelope.digest.fill(255);
			firstRow.commit.envelope.signature.fill(255);
			firstRow.commit.envelope.canonicalPreimageBytes.fill(255);
			const fresh = await store.readOutboxPage({ limit: 1 });
			expect(fresh[0]?.commit).toEqual(expected);
			expect(fresh[0]?.commit).not.toBe(first[0]?.commit);
			expect(await store.readOutboxPage({ scope: { objectId: "absent", author: "none" }, limit: 1 })).toEqual([]);
		});
	});

	for (const caseId of [
		"orphan-issued-before",
		"orphan-outbox-after",
		"digest-after",
		"unconsumed-after",
		"pruned-after",
		"malformed-issued-after",
		"malformed-tail-lineage",
	] as const) {
		it(`complete global closure refuses ${caseId} after a full requested page`, async () => {
			const primaryFilename = primary(`r8-outbox-${caseId}`);
			const foreignScope = { objectId: caseId === "orphan-issued-before" ? "a" : "z", author: "foreign" };
			await withStore(primaryFilename, async (store) => {
				for (let sequence = 0; sequence < 3; sequence++) {
					await store.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)));
				}
				await store.transactIssue(foreignScope, (selected) => Promise.resolve(commit(foreignScope, selected)));
			});
			const raw = new DatabaseSync(derivedFilename(primaryFilename));
			try {
				// This raw fixture injects corruption, not authorized retirement.
				// Keep native triggers/catalog intact; production connections retain
				// their original guarded functions and must refuse the poisoned image.
				raw.function("issuance_retirement_connection", { varargs: true }, () => 1);
				raw.function("issuance_retirement_record", { varargs: true }, () => 1);
				const keys = [foreignScope.objectId, foreignScope.author];
				if (caseId === "orphan-issued-before") {
					raw.prepare("DELETE FROM issuance_outbox WHERE object_id=? AND author=?").run(...keys);
				} else if (caseId === "orphan-outbox-after") {
					raw.prepare("DELETE FROM issued_records WHERE object_id=? AND author=?").run(...keys);
				} else if (caseId === "digest-after") {
					raw.prepare("UPDATE issuance_outbox SET digest=X'FFFF' WHERE object_id=? AND author=?").run(...keys);
				} else if (caseId === "unconsumed-after") {
					raw.prepare("UPDATE lineages SET next=0 WHERE object_id=? AND author=?").run(...keys);
				} else if (caseId === "pruned-after") {
					raw
						.prepare("UPDATE lineages SET pruned_through_author_sequence=0 WHERE object_id=? AND author=?")
						.run(...keys);
				} else if (caseId === "malformed-issued-after") {
					raw.prepare("UPDATE issued_records SET canonical_preimage=X'01' WHERE object_id=? AND author=?").run(...keys);
				} else {
					raw
						.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)")
						.run("zz-tail", "unused", 0, 1);
				}
			} finally {
				raw.close();
			}
			await withStore(primaryFilename, async (store) => {
				const outcome = await settled(() => store.readOutboxPage({ scope: PHASE_2L_C_SCOPE, limit: 2 }));
				expect(outcome.ok).toBe(false);
				const failure = outcome.ok ? undefined : outcome.error;
				expect(errorShape(failure)).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
				await expect(store.readOutboxPage({ scope: { objectId: "absent", author: "none" }, limit: 1 })).rejects.toBe(
					failure
				);
				await expect(store.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(failure);
			});
		});
	}
});

describe("Phase 2l-c real transaction, lifecycle and paging contract", () => {
	it("commits one detached closure, returns fresh reads and preserves pending outbox", async () => {
		await withStore(primary("issue"), async (store) => {
			let builds = 0;
			const result = await store.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
				builds++;
				return Promise.resolve(phase2lCCommit(selected));
			});
			expect(builds).toBe(1);
			expect(result.authorSequence).toBe(0);
			result.envelope.digest[0] = 255;
			const issuedA = await store.readIssued(PHASE_2L_C_SCOPE, 0);
			const issuedB = await store.readIssued(PHASE_2L_C_SCOPE, 0);
			expect(issuedA?.envelope.digest).toEqual(Uint8Array.of(7, 0xd1));
			expect(issuedA).not.toBe(issuedB);
			expect(issuedA?.envelope).not.toBe(issuedB?.envelope);
			expect(await store.readLineage(PHASE_2L_C_SCOPE)).toEqual({ exhausted: false, next: 1 });
			expect(await store.readOutboxPage()).toEqual([
				expect.objectContaining({ commit: expect.objectContaining({ authorSequence: 0 }), publishState: "pending" }),
			]);
		});
	});

	it("copies pooled Buffer input into plain private bytes and rejects SharedArrayBuffer without mutation", async () => {
		await withStore(primary("byte-ownership"), async (store) => {
			const pooled = Buffer.from([7, 0xd1]);
			const result = await store.transactIssue(PHASE_2L_C_SCOPE, (authorSequence) => {
				const canonicalPreimageBytes = Buffer.from(encodeCanonical({ ...PHASE_2L_C_SCOPE, authorSequence }));
				const signature = Buffer.from([7, 0x51]);
				const envelope = { canonicalPreimageBytes, digest: pooled, signature };
				return Promise.resolve({
					authorSequence,
					envelope,
					issuedRecord: { authorSequence, envelope, scope: PHASE_2L_C_SCOPE },
					outboxEntry: { authorSequence, envelope, scope: PHASE_2L_C_SCOPE },
				});
			});
			pooled[0] = 255;
			for (const bytes of [result.envelope.canonicalPreimageBytes, result.envelope.digest, result.envelope.signature]) {
				expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
				expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
				expect(bytes.byteOffset).toBe(0);
				expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
			}
			expect(result.envelope.digest).toEqual(Uint8Array.of(7, 0xd1));

			const sharedPreimage = new Uint8Array(new SharedArrayBuffer(result.envelope.canonicalPreimageBytes.byteLength));
			sharedPreimage.set(result.envelope.canonicalPreimageBytes);
			const invalidEnvelope = {
				canonicalPreimageBytes: sharedPreimage,
				digest: Uint8Array.of(8),
				signature: Uint8Array.of(8),
			};
			await expect(
				store.transactIssue(PHASE_2L_C_SCOPE, (authorSequence) =>
					Promise.resolve({
						authorSequence,
						envelope: invalidEnvelope,
						issuedRecord: { authorSequence, envelope: invalidEnvelope, scope: PHASE_2L_C_SCOPE },
						outboxEntry: { authorSequence, envelope: invalidEnvelope, scope: PHASE_2L_C_SCOPE },
					})
				)
			).rejects.toMatchObject({ code: "ISSUANCE_COMMIT_INVALID" });
			expect(await store.readLineage(PHASE_2L_C_SCOPE)).toEqual({ exhausted: false, next: 1 });
			expect(await store.readIssued(PHASE_2L_C_SCOPE, 1)).toBeNull();
		});
	});

	it("uses shared UTF-16 order rather than SQLite BINARY order, including the inversion pair", async () => {
		await withStore(primary("order"), async (store) => {
			const scopes = [
				{ author: "a", objectId: "a" },
				{ author: "a", objectId: "\u{10000}" },
				{ author: "a", objectId: "\ue000" },
			] as const;
			for (const scope of scopes)
				await store.transactIssue(scope, (selected) => Promise.resolve(commit(scope, selected)));
			const page = await store.readOutboxPage();
			expect(page.map(({ commit: value }) => value.issuedRecord.scope.objectId)).toEqual(["a", "\u{10000}", "\ue000"]);
			expect(
				(await store.readOutboxPage({ afterKey: ["\u{10000}", "a", 0], limit: 1 }))[0]?.commit.issuedRecord.scope
					.objectId
			).toBe("\ue000");
		});
	});

	it("applies the shared default page bound, afterKey, scope filter and closed input grammar", async () => {
		const primaryFilename = primary("paging");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const admitted = createNodeDurableIssuanceStore({ primaryFilename });
		await admitted.close();
		const raw = new DatabaseSync(derivedFilename(primaryFilename));
		const issued = raw.prepare(
			"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
		);
		const outbox = raw.prepare(
			"INSERT INTO issuance_outbox(object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)"
		);
		const lineage = raw.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)");
		raw.exec("BEGIN IMMEDIATE");
		for (let authorSequence = 0; authorSequence < 65; authorSequence++) {
			const value = commit(PHASE_2L_C_SCOPE, authorSequence);
			issued.run(
				PHASE_2L_C_SCOPE.objectId,
				PHASE_2L_C_SCOPE.author,
				authorSequence,
				value.envelope.canonicalPreimageBytes,
				value.envelope.digest,
				value.envelope.signature
			);
			outbox.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, authorSequence, value.envelope.digest, "pending");
		}
		lineage.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 65, 0);
		for (const [scope, seed] of [
			[{ author: "alice", objectId: "y-foreign" }, 11],
			[{ author: "alice", objectId: "z-target" }, 12],
		] as const) {
			const value = commit(scope, 0, seed);
			issued.run(
				scope.objectId,
				scope.author,
				0,
				value.envelope.canonicalPreimageBytes,
				value.envelope.digest,
				value.envelope.signature
			);
			outbox.run(scope.objectId, scope.author, 0, value.envelope.digest, "pending");
			lineage.run(scope.objectId, scope.author, 1, 0);
		}
		raw.exec("COMMIT");
		raw.close();

		await withStore(primaryFilename, async (store) => {
			const first = await store.readOutboxPage();
			expect(first).toHaveLength(64);
			expect(first[0]?.commit.authorSequence).toBe(0);
			expect(first[63]?.commit.authorSequence).toBe(63);
			const last = await store.readOutboxPage({
				afterKey: [PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 63],
				limit: 1,
				scope: PHASE_2L_C_SCOPE,
			});
			expect(last.map(({ commit: value }) => value.authorSequence)).toEqual([64]);
			expect(last[0]?.commit.issuedRecord.scope).toEqual(PHASE_2L_C_SCOPE);
			const filtered = await store.readOutboxPage({
				afterKey: ["x-cursor", "alice", 0],
				limit: 1,
				scope: { author: "alice", objectId: "z-target" },
			});
			expect(filtered[0]?.commit.issuedRecord.scope.objectId).toBe("z-target");
			for (const input of [
				{ limit: 0 },
				{ limit: 129 },
				{ afterKey: [PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, -1] },
				{ extra: true },
			]) {
				await expect(store.readOutboxPage(input as never)).rejects.toMatchObject({
					code: "ISSUANCE_INVALID_ARGUMENT",
				});
			}
		});
	});

	it("makes one of eight same-scope candidates win and permits progress plus reentrancy during builders", async () => {
		const primaryFilename = primary("race");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const stores = Array.from({ length: 8 }, () => createNodeDurableIssuanceStore({ primaryFilename }));
		const first = stores[0] as DurableIssuanceStore;
		const second = stores[1] as DurableIssuanceStore;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => (release = resolve));
		let ready = 0;
		let builds = 0;
		const build = async (selected: number): Promise<DurableIssueCommit> => {
			const seed = ++builds;
			ready++;
			if (ready === stores.length) release();
			await barrier;
			return phase2lCCommit(selected, seed);
		};
		const race = await Promise.allSettled(stores.map((store) => store.transactIssue(PHASE_2L_C_SCOPE, build)));
		expect(builds).toBe(8);
		expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const rejected = race.filter((value): value is PromiseRejectedResult => value.status === "rejected");
		expect(rejected).toHaveLength(7);
		expect(rejected.map(({ reason }) => errorShape(reason))).toEqual(
			Array.from({ length: 7 }, () => expect.objectContaining({ code: "ISSUANCE_RETRY_REQUIRED" }))
		);
		expect(await first.readLineage(PHASE_2L_C_SCOPE)).toEqual({ exhausted: false, next: 1 });
		expect(await first.readOutboxPage({ scope: PHASE_2L_C_SCOPE })).toHaveLength(1);
		const fulfilled = race.find(
			(value): value is PromiseFulfilledResult<DurableIssueCommit> => value.status === "fulfilled"
		);
		const durableWinner = await first.readIssued(PHASE_2L_C_SCOPE, 0);
		expect(durableWinner).toEqual(fulfilled?.value);
		expect([1, 2, 3, 4, 5, 6, 7, 8]).toContain(fulfilled?.value.envelope.digest[0]);

		let releaseA!: () => void;
		const held = new Promise<void>((resolve) => (releaseA = resolve));
		let enteredA!: () => void;
		const entered = new Promise<void>((resolve) => (enteredA = resolve));
		const scopeA = { author: "alice", objectId: "scope-a" };
		const scopeB = { author: "alice", objectId: "scope-b" };
		const pendingA = first.transactIssue(scopeA, async (selected) => {
			enteredA();
			await held;
			return commit(scopeA, selected);
		});
		await entered;
		await expect(
			second.transactIssue(scopeB, (selected) => Promise.resolve(commit(scopeB, selected)))
		).resolves.toMatchObject({
			authorSequence: 0,
		});
		releaseA();
		await pendingA;

		const outer = { author: "alice", objectId: "scope-outer" };
		const inner = { author: "alice", objectId: "scope-inner" };
		await expect(
			first.transactIssue(outer, async (selected) => {
				await first.transactIssue(inner, (innerSelected) => Promise.resolve(commit(inner, innerSelected)));
				return commit(outer, selected);
			})
		).resolves.toMatchObject({ authorSequence: 0 });

		const children = [1, 2].map((seed) =>
			spawn(process.execPath, [raceFixture.pathname, primaryFilename, String(seed)], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			})
		);
		const processOutcomes: Array<Record<string, unknown>> = [];
		await Promise.all(
			children.map(
				(child) =>
					new Promise<void>((resolve, reject) => {
						let ready = false;
						const timeout = setTimeout(() => {
							child.kill("SIGKILL");
							reject(new Error("two-process issuance race timed out"));
						}, 10_000);
						child.once("error", reject);
						child.on("message", (message: Record<string, unknown>) => {
							if (message.kind === "ready") {
								ready = true;
								Reflect.set(child, "phase2lCReady", true);
								if (children.every((candidate) => Reflect.get(candidate, "phase2lCReady") === true)) {
									for (const candidate of children) candidate.send("go");
								}
							} else if (message.kind === "child-error") reject(new Error(String(message.message)));
							else processOutcomes.push(message);
						});
						child.once("exit", (code) => {
							clearTimeout(timeout);
							if (!ready || code !== 0) reject(new Error(`two-process child exited ${String(code)}`));
							else resolve();
						});
					})
			)
		);
		expect(processOutcomes.filter(({ kind }) => kind === "fulfilled")).toHaveLength(1);
		expect(processOutcomes.filter(({ kind }) => kind === "rejected")).toEqual([
			expect.objectContaining({ code: "ISSUANCE_RETRY_REQUIRED" }),
		]);
		const processWinner = processOutcomes.find(({ kind }) => kind === "fulfilled");
		const processScope = { author: "alice", objectId: "room:process-race" };
		expect((await first.readIssued(processScope, 0))?.envelope.digest[0]).toBe(processWinner?.digest0);
		await Promise.all(stores.map((store) => store.close()));
	});

	it("uses one synchronous writer then one bounded readonly snapshot with no microtask in the writer", async () => {
		const originalExec = DatabaseSync.prototype.exec;
		const originalAll = StatementSync.prototype.all;
		const originalGet = StatementSync.prototype.get;
		const originalPrepare = DatabaseSync.prototype.prepare;
		const originalRun = StatementSync.prototype.run;
		const sqlByStatement = new WeakMap<StatementSync, string>();
		const databaseByStatement = new WeakMap<StatementSync, DatabaseSync>();
		const trace: string[] = [];
		const pointReads: Array<{
			database: DatabaseSync | undefined;
			expandedSql: string;
			parameters: unknown[];
			sql: string;
		}> = [];
		const mutationDatabases = new WeakSet<DatabaseSync>();
		let sawMutationDatabase = false;
		let readonlyUsedMutationDatabase = false;
		function recordPointRead(statement: StatementSync, parameters: unknown[]): void {
			if (!armed) return;
			const sql = sqlByStatement.get(statement) ?? "";
			if (/^\s*SELECT\b[\s\S]*\bFROM\s+(?:lineages|issued_records|issuance_outbox)\b/iu.test(sql)) {
				pointReads.push({
					database: databaseByStatement.get(statement),
					expandedSql: statement.expandedSQL,
					parameters,
					sql,
				});
			}
		}
		let armed = false;
		let microtaskRan = false;
		DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
			const statement = originalPrepare.call(this, sql);
			sqlByStatement.set(statement, sql);
			databaseByStatement.set(statement, this);
			return statement;
		};
		DatabaseSync.prototype.exec = function (sql: string): void {
			originalExec.call(this, sql);
			if (!armed) return;
			const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
			if (normalized === "BEGIN IMMEDIATE") {
				mutationDatabases.add(this);
				sawMutationDatabase = true;
				trace.push("begin-immediate");
				queueMicrotask(() => (microtaskRan = true));
			} else if (normalized === "BEGIN") {
				readonlyUsedMutationDatabase = mutationDatabases.has(this);
				trace.push("readonly-begin");
			} else if (normalized === "COMMIT") {
				const readonly = trace.includes("readonly-begin");
				trace.push(readonly ? "readonly-commit" : "mutation-commit");
				if (!readonly) expect(microtaskRan).toBe(false);
			}
		};
		StatementSync.prototype.get = function (
			this: StatementSync,
			...parameters: unknown[]
		): ReturnType<StatementSync["get"]> {
			const result = Reflect.apply(originalGet, this, parameters) as ReturnType<StatementSync["get"]>;
			if (armed) {
				const sql = sqlByStatement.get(this) ?? "";
				if (/^\s*SELECT\b[\s\S]*\bFROM\s+lineages\b/iu.test(sql)) trace.push("lineage-select");
				else if (/^\s*SELECT\b[\s\S]*\bFROM\s+issued_records\b/iu.test(sql)) trace.push("issued-read");
				else if (/^\s*SELECT\b[\s\S]*\bFROM\s+issuance_outbox\b/iu.test(sql)) trace.push("outbox-read");
			}
			recordPointRead(this, parameters);
			return result;
		} as typeof StatementSync.prototype.get;
		StatementSync.prototype.all = function (
			this: StatementSync,
			...parameters: unknown[]
		): ReturnType<StatementSync["all"]> {
			const result = Reflect.apply(originalAll, this, parameters) as ReturnType<StatementSync["all"]>;
			recordPointRead(this, parameters);
			return result;
		} as typeof StatementSync.prototype.all;
		StatementSync.prototype.run = function (
			this: StatementSync,
			...parameters: unknown[]
		): ReturnType<StatementSync["run"]> {
			const result = Reflect.apply(originalRun, this, parameters) as ReturnType<StatementSync["run"]>;
			if (!armed) return result;
			const sql = sqlByStatement.get(this) ?? "";
			if (/^\s*(?:INSERT\s+INTO|UPDATE)\s+lineages\b/iu.test(sql)) trace.push("lineage-write");
			else if (/^\s*INSERT\s+INTO\s+issued_records\b/iu.test(sql)) trace.push("issued-insert");
			else if (/^\s*INSERT\s+INTO\s+issuance_outbox\b/iu.test(sql)) trace.push("outbox-insert");
			return result;
		} as typeof StatementSync.prototype.run;
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename: primary("writer-trace") });
		armed = true;
		try {
			await store.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)));
			expect(trace).toEqual([
				"begin-immediate",
				"lineage-select",
				"lineage-write",
				"issued-insert",
				"outbox-insert",
				"mutation-commit",
				"readonly-begin",
				"lineage-select",
				"issued-read",
				"outbox-read",
				"readonly-commit",
			]);
			expect(sawMutationDatabase).toBe(true);
			expect(readonlyUsedMutationDatabase).toBe(true);
			expect(pointReads.every(({ database }) => database !== undefined && mutationDatabases.has(database))).toBe(true);
			const readback = pointReads.slice(-3);
			expect(readback).toHaveLength(3);
			for (const { expandedSql, sql } of readback) {
				expect(sql).toMatch(/\bWHERE\b/iu);
				expect(expandedSql).toMatch(/\bobject_id\s*=\s*'room:alpha'/iu);
				expect(expandedSql).toMatch(/\bauthor\s*=\s*'alice'/iu);
			}
			expect(readback[1]?.expandedSql).toMatch(/\bauthor_sequence\s*=\s*0\b/iu);
			expect(readback[2]?.expandedSql).toMatch(/\bauthor_sequence\s*=\s*0\b/iu);
			expect(readback[0]?.parameters).toEqual(
				expect.arrayContaining([PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author])
			);
			expect(readback[1]?.parameters).toEqual(
				expect.arrayContaining([PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 0])
			);
			expect(readback[2]?.parameters).toEqual(
				expect.arrayContaining([PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 0])
			);
		} finally {
			armed = false;
			DatabaseSync.prototype.exec = originalExec;
			DatabaseSync.prototype.prepare = originalPrepare;
			StatementSync.prototype.all = originalAll;
			StatementSync.prototype.get = originalGet;
			StatementSync.prototype.run = originalRun;
			await store.close();
		}
	});

	it("maps cross-process writer expiry as transient and latches child-key collision corruption", async () => {
		const primaryFilename = primary("busy");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		const child = spawn(process.execPath, [lockFixture.pathname, derivedFilename(primaryFilename)], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.on("message", (message: { kind?: string; message?: string }) => {
				if (message.kind === "held") resolve();
				if (message.kind === "child-error") reject(new Error(message.message));
			});
		});
		const originalExec = DatabaseSync.prototype.exec;
		let writerAttempts = 0;
		DatabaseSync.prototype.exec = function (sql: string): void {
			if (sql.trim().replace(/\s+/gu, " ").toUpperCase() === "BEGIN IMMEDIATE") writerAttempts++;
			originalExec.call(this, sql);
		};
		try {
			let builds = 0;
			const started = performance.now();
			const outcome = await settled(() =>
				store.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
					builds++;
					return Promise.resolve(phase2lCCommit(selected));
				})
			);
			const elapsed = performance.now() - started;
			expect(outcome.ok).toBe(false);
			expect(errorShape(outcome.ok ? undefined : outcome.error)).toMatchObject({
				code: "ISSUANCE_SUBSTRATE_FAILURE",
				retryClass: "transient",
			});
			expect(builds).toBe(1);
			expect(writerAttempts).toBe(1);
			expect(elapsed).toBeGreaterThanOrEqual(700);
			expect(elapsed).toBeLessThan(4_000);
		} finally {
			DatabaseSync.prototype.exec = originalExec;
			if (child.connected) child.send("release");
			await childExit;
			await store.close();
		}

		const poisonPrimary = primary("poison");
		const seed = createNodeDurableIssuanceStore({ primaryFilename: poisonPrimary });
		await seed.close();
		const raw = new DatabaseSync(derivedFilename(poisonPrimary));
		const candidate = phase2lCCommit(0);
		raw
			.prepare(
				"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
			)
			.run(
				PHASE_2L_C_SCOPE.objectId,
				PHASE_2L_C_SCOPE.author,
				0,
				candidate.envelope.canonicalPreimageBytes,
				candidate.envelope.digest,
				candidate.envelope.signature
			);
		raw.close();
		const poisoned = createNodeDurableIssuanceStore({ primaryFilename: poisonPrimary });
		let firstFailure: unknown;
		try {
			await poisoned.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)));
		} catch (error) {
			firstFailure = error;
		}
		expect(errorShape(firstFailure)).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		await expect(poisoned.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(firstFailure);
		await expect(poisoned.readOutboxPage()).rejects.toBe(firstFailure);
		await poisoned.close();
		await expect(poisoned.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(firstFailure);
	});

	it("close never awaits a suspended builder, validates malformed before closed, and MAX commits exactly once", async () => {
		const primaryFilename = primary("lifecycle");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => (entered = resolve));
		const pending = store.transactIssue(PHASE_2L_C_SCOPE, async (selected) => {
			entered();
			await held;
			return phase2lCCommit(selected);
		});
		await ready;
		const closeA = store.close();
		expect(closeA).toBe(store.close());
		await expect(closeA).resolves.toBeUndefined();
		release();
		await expect(pending).rejects.toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });

		const malformedStore = createNodeDurableIssuanceStore({ primaryFilename: primary("malformed-close") });
		let releaseMalformed!: () => void;
		const malformedHeld = new Promise<void>((resolve) => (releaseMalformed = resolve));
		const malformed = malformedStore.transactIssue(PHASE_2L_C_SCOPE, async () => {
			await malformedHeld;
			return {} as DurableIssueCommit;
		});
		await malformedStore.close();
		releaseMalformed();
		await expect(malformed).rejects.toMatchObject({ code: "ISSUANCE_COMMIT_INVALID" });

		const maxPrimary = primary("max");
		const seeded = createNodeDurableIssuanceStore({ primaryFilename: maxPrimary });
		await seeded.close();
		const raw = new DatabaseSync(derivedFilename(maxPrimary));
		// Seed the original guarded native schema without bypassing production
		// admission. The MAX arithmetic/lifecycle assertions below are unchanged.
		raw.function("issuance_retirement_connection", {varargs: true}, () => 1);
		raw.function("issuance_retirement_record", {varargs: true}, () => 1);
		raw
			.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)")
			.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, Number.MAX_SAFE_INTEGER, 0);
		raw.close();
		const maximum = createNodeDurableIssuanceStore({ primaryFilename: maxPrimary });
		let builds = 0;
		await expect(
			maximum.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
				builds++;
				return Promise.resolve(phase2lCCommit(selected));
			})
		).resolves.toMatchObject({ authorSequence: Number.MAX_SAFE_INTEGER });
		expect(await maximum.readLineage(PHASE_2L_C_SCOPE)).toEqual({
			exhausted: true,
			next: Number.MAX_SAFE_INTEGER,
		});
		await expect(
			maximum.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)))
		).rejects.toMatchObject({
			code: "ISSUANCE_EXHAUSTED",
		});
		expect(builds).toBe(1);
		await maximum.close();
	});
});

describe("Phase 2l-c terminal suppression through the real adapter", () => {
	it("classifies all five bounded ambiguity outcomes without exposing candidate bytes", async () => {
		const originalExec = DatabaseSync.prototype.exec;
		const observations: Array<{
			candidate: DurableIssueCommit;
			caseId: string;
			outcome: Settled<DurableIssueCommit>;
		}> = [];
		for (const caseId of PHASE_2L_C_AMBIGUITY_CASES) {
			const primaryFilename = primary(`ambiguity-${caseId}`);
			const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
			const store = createNodeDurableIssuanceStore({ primaryFilename });
			let armed = true;
			let blockReadback = false;
			let builderCandidate: DurableIssueCommit | undefined;
			DatabaseSync.prototype.exec = function (sql: string): void {
				const normalized = sql.trim().toUpperCase();
				if (armed && normalized === "COMMIT") {
					armed = false;
					if (caseId === "absent-old") originalExec.call(this, "ROLLBACK");
					else {
						originalExec.call(this, sql);
						if (caseId === "foreign-pair") {
							this.exec(
								"UPDATE issued_records SET digest=X'F001',signature=X'F002';UPDATE issuance_outbox SET digest=X'F001'"
							);
						} else if (caseId === "torn-or-inconsistent") this.exec("DELETE FROM issuance_outbox");
						else if (caseId === "unreadable") blockReadback = true;
					}
					throw new Error(`suppressed terminal ${caseId}`);
				}
				if (blockReadback && normalized === "BEGIN") throw new Error("bounded readback unavailable");
				originalExec.call(this, sql);
			};
			try {
				const outcome = await settled(() =>
					store.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
						builderCandidate = phase2lCCommit(selected);
						return Promise.resolve(builderCandidate);
					})
				);
				expect(builderCandidate).toBeDefined();
				observations.push({ candidate: builderCandidate as DurableIssueCommit, caseId, outcome });
				if (caseId === "torn-or-inconsistent" && !outcome.ok) {
					await expect(store.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(outcome.error);
				}
				if (caseId === "unreadable") {
					blockReadback = false;
					await expect(
						store.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected, 9)))
					).resolves.toMatchObject({ authorSequence: 1 });
				}
			} finally {
				DatabaseSync.prototype.exec = originalExec;
				await store.close();
			}
		}
		expect(observations.map(({ caseId }) => caseId)).toEqual(PHASE_2L_C_AMBIGUITY_CASES);
		expect(
			observations.map(({ outcome }) => (outcome.ok ? "RESOLVED" : Reflect.get(errorShape(outcome.error), "code")))
		).toEqual([
			"RESOLVED",
			"ISSUANCE_SUBSTRATE_FAILURE",
			"ISSUANCE_RETRY_REQUIRED",
			"ISSUANCE_RECOVERY_CORRUPT",
			"ISSUANCE_OUTCOME_UNKNOWN",
		]);
		const exact = observations[0]?.outcome;
		expect(exact?.ok).toBe(true);
		if (exact?.ok) {
			const candidate = observations[0]?.candidate as DurableIssueCommit;
			expect(exact.value).toEqual(phase2lCCommit(0));
			expect(exact.value).not.toBe(candidate);
			expect(exact.value.envelope).not.toBe(candidate.envelope);
			expect(exact.value.envelope.canonicalPreimageBytes.buffer).not.toBe(
				candidate.envelope.canonicalPreimageBytes.buffer
			);
			expect(exact.value.envelope.digest.buffer).not.toBe(candidate.envelope.digest.buffer);
			expect(exact.value.envelope.signature.buffer).not.toBe(candidate.envelope.signature.buffer);
		}
		for (const { outcome } of observations.slice(1)) {
			expect(outcome.ok).toBe(false);
			if (outcome.ok) continue;
			expect(
				Object.keys(outcome.error as object).every((key) => ["code", "name", "retryClass", "scope"].includes(key))
			).toBe(true);
			for (const key of [
				"authorSequence",
				"candidate",
				"canonicalPreimageBytes",
				"commit",
				"digest",
				"envelope",
				"signature",
				"token",
			]) {
				expect(outcome.error).not.toHaveProperty(key);
			}
		}
		const unknown = observations.find(({ caseId }) => caseId === "unreadable")?.outcome;
		expect(unknown?.ok).toBe(false);
		if (unknown !== undefined && !unknown.ok) {
			expect(Reflect.get(unknown.error as object, "scope")).toEqual(PHASE_2L_C_SCOPE);
			expect(Reflect.get(unknown.error as object, "scope")).not.toBe(PHASE_2L_C_SCOPE);
		}
	});
});

describe("R8 native unsigned phase codec widths", () => {
	it("matches complete native continuation widths through ACKs and initialized split progress", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const primaryFilename = primary("continuation-widths");
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		const observer = createNodeDurableIssuanceStore({ primaryFilename });
		const maintenance = durableIssuancePruningMaintenanceForStore(observer);
		if (!maintenance?.readBoundedRecoveryCensus) throw new Error("original native census missing");
		const read = () =>
			maintenance.readBoundedRecoveryCensus!({ objectId: currencyScope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		const originalExec = DatabaseSync.prototype.exec;
		let armed = false,
			capturing = false,
			entered = 0;
		const observations: Array<ReturnType<typeof read>> = [];
		const intents: Array<Parameters<typeof issuanceUnsignedContinuationWidths>[2]> = [];
		const sign = async (digest: Uint8Array) => {
			entered++;
			const signature = ed25519.sign(digest, currencySeed);
			expect(ed25519.verify(signature, digest, currencyPublicKey)).toBe(true);
			return signature;
		};
		try {
			const baseIssuer = currencyIssuer(store, undefined, sign);
			const sources = [await baseIssuer.issue(currencyInput), await baseIssuer.issue(currencyInput)];
			const foreignSeed = new Uint8Array(32).fill(9);
			const foreignAuthor = Buffer.from(ed25519.getPublicKey(foreignSeed)).toString("hex");
			const foreignIssuer = createTransactionalVertexIssuer({
				author: foreignAuthor,
				privateKeySeed: foreignSeed,
				publicKey: { bytes: ed25519.getPublicKey(foreignSeed), format: "raw" },
				transactIssue: (scope, build) => store.transactIssue(scope, build),
			});
			await foreignIssuer.issue(currencyInput);
			await store.transactWriteSettlementPlan({
				scope: currencyScope,
				expectedRevision: null,
				plan: {
					scope: currencyScope,
					revision: 0,
					fenceSequence: null,
					entries: sources.map((source) => ({
						sourceSequence: source.authorSequence,
						sourceDigest: source.envelope.digest,
						disposition: "rebase" as const,
						replacementSequence: null,
					})),
				},
			});
			const before = await read();
			DatabaseSync.prototype.exec = function (sql: string): void {
				originalExec.call(this, sql);
				if (!armed || capturing || sql.trim().toUpperCase() !== "COMMIT") return;
				capturing = true;
				try {
					observations.push(read());
				} finally {
					capturing = false;
				}
			};
			const issue = async (effect: NonNullable<DurableIssueCommit["planEffect"]>, logicalTime: number) => {
				const plan = await store.readSettlementPlan(currencyScope);
				if (!plan) throw new Error("genuine current plan missing");
				const issuer = createTransactionalVertexIssuer({
					author: currencyScope.author,
					privateKeySeed: currencySeed,
					publicKey: { bytes: currencyPublicKey, format: "raw" },
					transactIssue: (scope, build) =>
						store.transactIssue(scope, async (sequence, admission) => {
							const commit = await build(sequence, (bytes, task) => {
								if (!admission) throw new Error("original lexical admission missing");
								const captured = captureIssuanceNativeSignInput({ scope, exactCanonicalUnsignedVertexBytes: bytes });
								intents.push({
									kind: "v3-issuance-pending-unsigned-1",
									authorSequence: sequence,
									canonicalPreimageBytes: captured.bytes,
									digest: captured.digest,
									planEffect: effect,
									exactCanonicalPlanBytes: encodeCanonical(plan),
								});
								armed = true;
								return admission(
									bytes,
									async () => {
										const signature = await task();
										entered++;
										expect(ed25519.verify(signature, captured.digest, currencyPublicKey)).toBe(true);
										return signature;
									},
									{ planEffect: effect }
								);
							});
							return { ...commit, planEffect: effect };
						}),
				});
				try {
					return await issuer.issue({
						...currencyInput,
						epoch: 2,
						logicalTime,
						operation:
							effect.kind === "fence"
								? { action: "$drp.author-fence.v1", fenceSequence: 2, version: 1 }
								: currencyInput.operation,
					});
				} finally {
					armed = false;
				}
			};
			const ack = async () => {
				for (const row of await store.readOutboxPage({ scope: currencyScope })) {
					if (row.publishState !== "pending") continue;
					await store.compareAndMarkOutboxPublished({
						scope: currencyScope,
						authorSequence: row.commit.authorSequence,
						digest: row.commit.envelope.digest,
					});
				}
			};
			await issue({ kind: "fence" }, 90);
			const immediate = await read();
			if (!immediate.control) throw new Error("genuine immediate control missing");
			await ack();
			await issue({ kind: "replacement", sourceSequence: 0 }, 98);
			await ack();
			const intentDigest = hashDomain(
				"ts-drp/settlement-replacement-intents/v1",
				encodeCanonical([currencyInput.operation, currencyInput.operation])
			);
			const initializeProgress = { sourceSequence: 1, intentCount: 2, intentDigest };
			const plan = await store.readSettlementPlan(currencyScope);
			if (!plan) throw new Error("genuine split plan missing");
			await store.transactWriteSettlementPlan({
				scope: currencyScope,
				expectedRevision: plan.revision,
				plan: {
					...plan,
					revision: plan.revision + 1,
					entries: plan.entries.map((entry) =>
						entry.sourceSequence === 1
							? { ...entry, replacementProgress: { version: 1, intentCount: 2, intentDigest, chunks: [] } }
							: entry
					),
				},
			});
			await issue({ kind: "replacement", sourceSequence: 1, fromIntent: 0, throughIntent: 1, intentDigest }, 100);
			await ack();
			await issue({ kind: "replacement", sourceSequence: 1, fromIntent: 1, throughIntent: 2, intentDigest }, 102);
			await ack();
			const final = await read();
			const phases = await Promise.all(observations);
			expect(intents).toHaveLength(4);
			const forecast = issuanceUnsignedContinuationWidths(
				before.rows,
				currencyScope,
				intents[0]!,
				before.control ?? null,
				intents.slice(1).map((intent, index) => ({ intent, ...(index === 1 ? { initializeProgress } : {}) }))
			);
			const actual = (image: Awaited<ReturnType<typeof read>>) => {
				if (!image.control) throw new Error("genuine native control missing");
				const canonicalRowBytes = [
					...image.rows.lineages,
					...image.rows.issued,
					...image.rows.outbox,
					...image.rows.plans,
				].map((row) => encodeCanonical(row).byteLength);
				return {
					rowCount: canonicalRowBytes.length,
					canonicalRowBytes,
					canonicalRowsBytes: encodeCanonical(image.rows).byteLength,
					encodedControlBytes: encodeIssuanceRetirementControl(image.control).byteLength,
					nativeCensusBytes: encodeCanonical(image).byteLength,
					nativeImageBytes: encodeCanonical(image.image).byteLength,
					controlRevisionDelta: image.control.revision - immediate.control!.revision,
				};
			};
			for (const projected of forecast.phases) {
				const image = phases.find((image) =>
					projected.phase === "final"
						? image.rows.issued.some(
								(row) => row.author === currencyScope.author && row.authorSequence === projected.authorSequence
							) && image.rows.lineages.find((row) => row.author === currencyScope.author)?.pendingUnsigned === undefined
						: image.rows.lineages.some(
								(row) =>
									row.author === currencyScope.author &&
									row.pendingUnsigned?.authorSequence === projected.authorSequence &&
									row.pendingUnsigned.phase === projected.phase
							)
				);
				if (!image) throw new Error(`native phase absent: ${projected.authorSequence}/${projected.phase}`);
				expect(projected.widths).toEqual(actual(image));
			}
			expect(forecast.final).toEqual(actual(final));
			expect(
				forecast.finalRows.issued
					.filter((row) => row.author === currencyScope.author && row.authorSequence >= 2)
					.every((row) => !Object.hasOwn(row, "signature"))
			).toBe(true);
			expect(final.rows.outbox.filter((row) => row.author === foreignAuthor)).toEqual(
				before.rows.outbox.filter((row) => row.author === foreignAuthor)
			);
			expect(final.rows.plans[0]?.entries.map((entry) => entry.replacementSequence)).toEqual([3, 5]);
			expect(
				final.rows.plans[0]?.entries[1]?.replacementProgress?.chunks.map((chunk) => chunk.lastLogicalTime)
			).toEqual([100, 102]);
			expect(entered).toBe(6);
			console.log(
				"R9_NATIVE_CONTINUATION_WIDTHS",
				JSON.stringify({
					phases: forecast.phases.length,
					final: forecast.final,
					actualFinal: actual(final),
					entered,
					foreignPendingUnchanged: true,
				})
			);
		} finally {
			armed = false;
			DatabaseSync.prototype.exec = originalExec;
			await Promise.allSettled(observations);
			const joined = await Promise.allSettled([store.close(), observer.close()]);
			expect(joined.every((result) => result.status === "fulfilled")).toBe(true);
		}
	});
	it("matches genuine reserved entered and paired native census encodings including a real settlement effect", async () => {
		const primaryFilename = primary("unsigned-phase-widths");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		const observer = createNodeDurableIssuanceStore({ primaryFilename });
		const maintenance = durableIssuancePruningMaintenanceForStore(observer);
		if (!maintenance?.readBoundedRecoveryCensus) throw new Error("original native census missing");
		const readCensus = maintenance.readBoundedRecoveryCensus;
		const read = (): ReturnType<NonNullable<typeof maintenance.readBoundedRecoveryCensus>> =>
			readCensus.call(maintenance, {
				objectId: currencyScope.objectId,
				limits: { maxRows: ISSUANCE_RETIREMENT_LIMITS.maxRows, maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes },
			});
		const originalExec = DatabaseSync.prototype.exec;
		let armed = false,
			capturing = false;
		const observations: Array<ReturnType<typeof read>> = [];
		try {
			DatabaseSync.prototype.exec = function (sql: string): void {
				originalExec.call(this, sql);
				if (!armed || capturing || sql.trim().toUpperCase() !== "COMMIT") return;
				capturing = true;
				try {
					observations.push(read());
				} finally {
					capturing = false;
				}
			};
			for (const settlement of [false, true]) {
				if (settlement) {
					const first = await store.readIssued(currencyScope, 0);
					if (first === null) throw new Error("genuine prior source missing");
					await store.transactWriteSettlementPlan({
						expectedRevision: null,
						scope: currencyScope,
						plan: {
							scope: currencyScope,
							revision: 0,
							fenceSequence: null,
							entries: [
								{
									sourceSequence: 0,
									sourceDigest: first.envelope.digest,
									disposition: "rebase",
									replacementSequence: null,
								},
							],
						},
					});
				}
				const before = await read();
				observations.length = 0;
				let widths: ReturnType<typeof issuanceUnsignedPostimageWidths> | undefined;
				let intent: Parameters<typeof issuanceUnsignedPostimageWidths>[2] | undefined;
				let entered = 0;
				const planEffect = settlement ? { kind: "replacement" as const, sourceSequence: 0 } : undefined;
				const issuer = createAdmissionBoundTransactionalVertexIssuer({
					author: currencyScope.author,
					preparedBlueprintAdmission: currencyPrepared,
					publicKey: { bytes: currencyPublicKey, format: "raw" },
					signRegisteredVertexDigest: (digest) => {
						entered++;
						const signature = ed25519.sign(digest, currencySeed);
						expect(ed25519.verify(signature, digest, currencyPublicKey)).toBe(true);
						return Promise.resolve(signature);
					},
					transactIssue: (scope, build) =>
						store.transactIssue(scope, async (sequence, nativeAdmission) => {
							const candidate = await build(sequence, (bytes, sign) => {
								if (nativeAdmission === undefined) throw new Error("original lexical admission missing");
								const captured = captureIssuanceNativeSignInput({ scope, exactCanonicalUnsignedVertexBytes: bytes });
								const plan = before.rows.plans.find((p) => p.scope.author === scope.author);
								intent = {
									kind: "v3-issuance-pending-unsigned-1",
									authorSequence: sequence,
									canonicalPreimageBytes: captured.bytes,
									digest: captured.digest,
									...(planEffect === undefined ? {} : { planEffect, exactCanonicalPlanBytes: encodeCanonical(plan) }),
								};
								widths = issuanceUnsignedPostimageWidths(before.rows, scope, intent, before.control ?? null);
								armed = true;
								return nativeAdmission(bytes, sign, planEffect === undefined ? undefined : { planEffect });
							});
							return planEffect === undefined ? candidate : { ...candidate, planEffect };
						}),
				});
				const committed = await issuer.issue(currencyInput);
				armed = false;
				const phases = await Promise.all(observations);
				if (widths === undefined || intent === undefined) throw new Error("original width capture missing");
				const actual = (
					captured: Awaited<ReturnType<typeof read>>
				): ReturnType<typeof issuanceUnsignedPostimageWidths>["reserved"] => {
					const canonicalRowBytes = [
						...captured.rows.lineages,
						...captured.rows.issued,
						...captured.rows.outbox,
						...captured.rows.plans,
					].map((row) => encodeCanonical(row).byteLength);
					if (captured.control == null) throw new Error("actual born control missing");
					return {
						rowCount: canonicalRowBytes.length,
						canonicalRowBytes,
						canonicalRowsBytes: encodeCanonical(captured.rows).byteLength,
						encodedControlBytes: encodeIssuanceRetirementControl(captured.control).byteLength,
						nativeCensusBytes: encodeCanonical(captured).byteLength,
					};
				};
				const reserved = phases.find(
					(value) =>
						value.rows.lineages.find((l) => l.author === currencyScope.author)?.pendingUnsigned?.phase === "reserved"
				);
				const marked = phases.find(
					(value) =>
						value.rows.lineages.find((l) => l.author === currencyScope.author)?.pendingUnsigned?.phase === "entered"
				);
				const final = phases.find((value) =>
					value.rows.issued.some(
						(row) => row.author === currencyScope.author && row.authorSequence === committed.authorSequence
					)
				);
				if (reserved === undefined || marked === undefined || final === undefined)
					throw new Error("actual committed phase absent");
				expect(widths.reserved).toEqual(actual(reserved));
				expect(widths.entered).toEqual(actual(marked));
				expect(widths.final).toEqual(actual(final));
				const inherited = issuanceUnsignedPostimageWidths(marked.rows, currencyScope, intent, marked.control ?? null);
				expect(inherited.reserved).toEqual(actual(marked));
				expect(inherited.entered).toEqual(actual(marked));
				expect(inherited.final).toEqual(actual(final));
				expect(entered).toBe(1);
				expect(ed25519.verify(committed.envelope.signature, committed.envelope.digest, currencyPublicKey)).toBe(true);
				if (settlement) expect(final.rows.plans[0]?.entries[0]?.replacementSequence).toBe(committed.authorSequence);
				console.log(
					"R8_UNSIGNED_NATIVE_PHASE_WIDTHS",
					JSON.stringify({
						settlement,
						sequence: committed.authorSequence,
						entered,
						controlBorn: before.control == null,
						reserved: widths.reserved,
						enteredPhase: widths.entered,
						final: widths.final,
					})
				);
			}
		} finally {
			armed = false;
			DatabaseSync.prototype.exec = originalExec;
			await Promise.allSettled(observations);
			const joined = await Promise.allSettled([store.close(), observer.close()]);
			expect(joined.every((value) => value.status === "fulfilled")).toBe(true);
		}
	});
});

describe("R8 successor fence transient native widths", () => {
	it("matches genuine future fence reserved entered and paired encodings without future byte placeholders", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		for (const priorControl of [false, true]) {
			const primaryFilename = primary(`successor-fence-widths-${Number(priorControl)}`);
			const store = createNodeDurableIssuanceStore({ primaryFilename });
			const observer = createNodeDurableIssuanceStore({ primaryFilename });
			const maintenance = durableIssuancePruningMaintenanceForStore(observer);
			if (!maintenance?.readBoundedRecoveryCensus) throw new Error("original native census missing");
			const readCensus = maintenance.readBoundedRecoveryCensus;
			const read = (): ReturnType<typeof readCensus> =>
				readCensus.call(maintenance, {
					objectId: currencyScope.objectId,
					limits: ISSUANCE_RETIREMENT_LIMITS,
				});
			const originalExec = DatabaseSync.prototype.exec;
			const observations: Array<ReturnType<typeof read>> = [];
			let armed = false,
				capturing = false,
				entered = 0;
			try {
				const candidateIssuer = currencyIssuer(store, undefined, (digest) => {
					const signature = ed25519.sign(digest, currencySeed);
					expect(ed25519.verify(signature, digest, currencyPublicKey)).toBe(true);
					return Promise.resolve(signature);
				});
				if (priorControl) await candidateIssuer.issue(currencyInput);
				const foreignSeed = new Uint8Array(32).fill(9);
				const foreignPublicKey = ed25519.getPublicKey(foreignSeed);
				const foreignScope = { ...currencyScope, author: Buffer.from(foreignPublicKey).toString("hex") };
				if (priorControl) {
					const foreignIssuer = createTransactionalVertexIssuer({
						author: foreignScope.author,
						privateKeySeed: foreignSeed,
						publicKey: { bytes: foreignPublicKey, format: "raw" },
						transactIssue: (scope, build) => store.transactIssue(scope, build),
					});
					const foreign = await foreignIssuer.issue(currencyInput);
					expect(ed25519.verify(foreign.envelope.signature, foreign.envelope.digest, foreignPublicKey)).toBe(true);
				}
				const before = await read();
				expect(before.control == null).toBe(!priorControl);
				const candidate = await candidateIssuer.issue(currencyInput);
				const afterImmediate = await read();
				if (!afterImmediate.control) throw new Error("original immediate control missing");
				const immediateControl = afterImmediate.control;
				const foreignBefore = before.rows.outbox.filter((row) => row.author === foreignScope.author);
				expect(foreignBefore).toHaveLength(priorControl ? 1 : 0);
				if (priorControl) expect(foreignBefore[0]?.publishState).toBe("pending");
				const captured = captureIssuanceNativeSignInput({
					scope: currencyScope,
					exactCanonicalUnsignedVertexBytes: candidate.envelope.canonicalPreimageBytes,
				});
				const intent = {
					kind: "v3-issuance-pending-unsigned-1" as const,
					authorSequence: captured.sequence,
					canonicalPreimageBytes: captured.bytes,
					digest: captured.digest,
				};
				for (const outbox of await store.readOutboxPage({ scope: currencyScope })) {
					await store.compareAndMarkOutboxPublished({
						scope: currencyScope,
						authorSequence: outbox.commit.authorSequence,
						digest: outbox.commit.envelope.digest,
					});
				}
				const plan = { scope: currencyScope, revision: 0, fenceSequence: null, entries: [] };
				await store.transactWriteSettlementPlan({ scope: currencyScope, expectedRevision: null, plan });
				DatabaseSync.prototype.exec = function (sql: string): void {
					originalExec.call(this, sql);
					if (!armed || capturing || sql.trim().toUpperCase() !== "COMMIT") return;
					capturing = true;
					try {
						observations.push(read());
					} finally {
						capturing = false;
					}
				};
				let widths: ReturnType<typeof issuanceUnsignedSuccessorFenceWidths> | undefined;
				const fenceSequence = candidate.authorSequence + 1;
				const fenceIssuer = createTransactionalVertexIssuer({
					author: currencyScope.author,
					privateKeySeed: currencySeed,
					publicKey: { bytes: currencyPublicKey, format: "raw" },
					transactIssue: (scope, build) =>
						store.transactIssue(scope, async (sequence, nativeAdmission) => {
							const commit = await build(sequence, (bytes, sign) => {
								if (!nativeAdmission) throw new Error("original lexical admission missing");
								const fence = captureIssuanceNativeSignInput({ scope, exactCanonicalUnsignedVertexBytes: bytes });
								expect(fence.sequence).toBe(fenceSequence);
								expect(fence.bytes.byteLength).toBeGreaterThanOrEqual(128);
								widths = issuanceUnsignedSuccessorFenceWidths(before.rows, scope, intent, before.control ?? null, {
									plan,
									canonicalPreimageByteLength: fence.bytes.byteLength,
								});
								armed = true;
								return nativeAdmission(
									bytes,
									async () => {
										entered++;
										const signature = await sign();
										expect(ed25519.verify(signature, fence.digest, currencyPublicKey)).toBe(true);
										return signature;
									},
									{ planEffect: { kind: "fence" } }
								);
							});
							return { ...commit, planEffect: { kind: "fence" } };
						}),
				});
				const committed = await fenceIssuer.issue({
					...currencyInput,
					epoch: 2,
					dependencies: [currencyInput.anchor],
					logicalTime: Number.MAX_SAFE_INTEGER,
					operation: { action: "$drp.author-fence.v1", fenceSequence, version: 1 },
				});
				armed = false;
				const phases = await Promise.all(observations);
				if (!widths) throw new Error("future width projection missing");
				const actual = (
					image: Awaited<ReturnType<typeof read>>
				): ReturnType<typeof issuanceUnsignedSuccessorFenceWidths>["reserved"] => {
					if (!image.control) throw new Error("genuine native control absent");
					return {
						rowCount:
							image.rows.lineages.length +
							image.rows.issued.length +
							image.rows.outbox.length +
							image.rows.plans.length,
						canonicalRowBytes: [
							...image.rows.lineages,
							...image.rows.issued,
							...image.rows.outbox,
							...image.rows.plans,
						].map((row) => encodeCanonical(row).byteLength),
						canonicalRowsBytes: encodeCanonical(image.rows).byteLength,
						encodedControlBytes: encodeIssuanceRetirementControl(image.control).byteLength,
						nativeCensusBytes: encodeCanonical(image).byteLength,
						nativeImageBytes: encodeCanonical(image.image).byteLength,
						controlRevisionDelta: image.control.revision - immediateControl.revision,
					};
				};
				const reserved = phases.find((image) =>
					image.rows.lineages.some((row) => row.pendingUnsigned?.phase === "reserved")
				);
				const marked = phases.find((image) =>
					image.rows.lineages.some((row) => row.pendingUnsigned?.phase === "entered")
				);
				const final = phases.find((image) =>
					image.rows.issued.some((row) => row.author === currencyScope.author && row.authorSequence === fenceSequence)
				);
				if (!reserved || !marked || !final) throw new Error("original native phase checkpoint absent");
				expect(widths.reserved).toEqual(actual(reserved));
				expect(widths.entered).toEqual(actual(marked));
				expect(widths.final).toEqual(actual(final));
				for (const image of [reserved, marked, final]) {
					expect(image.rows.outbox.filter((row) => row.author === foreignScope.author)).toEqual(foreignBefore);
					expect(image.rows.issued.filter((row) => row.author === foreignScope.author)).toEqual(
						before.rows.issued.filter((row) => row.author === foreignScope.author)
					);
				}
				expect(reserved.rows.plans[0]?.fenceSequence).toBeNull();
				expect(marked.rows.plans[0]?.fenceSequence).toBeNull();
				expect(final.rows.plans[0]?.fenceSequence).toBe(fenceSequence);
				expect(entered).toBe(1);
				expect(
					verifyReceivedVertex({
						domain: registry.domains.vertex,
						suiteId: registry.cryptoSuites.active.find((suite) => suite.role === "identityAndVertex")?.suiteId ?? "",
						expectedAnchor: currencyInput.anchor,
						receivedCanonicalPreimageBytes: committed.envelope.canonicalPreimageBytes,
						resolveAuthorPublicKey: () => ({ bytes: currencyPublicKey, format: "raw" }),
						signature: committed.envelope.signature,
					}).accepted
				).toBe(true);
				console.log(
					"R8_SUCCESSOR_FENCE_PHASE_WIDTHS",
					JSON.stringify({ priorControl, entered, sequence: fenceSequence, widths })
				);
			} finally {
				armed = false;
				DatabaseSync.prototype.exec = originalExec;
				await Promise.allSettled(observations);
				const joined = await Promise.allSettled([store.close(), observer.close()]);
				expect(joined.every((result) => result.status === "fulfilled")).toBe(true);
			}
		}
	});
});
