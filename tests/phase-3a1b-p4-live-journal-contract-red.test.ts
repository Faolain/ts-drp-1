import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { parseStorageObjectId } from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	BROWSER_DEATH_TUPLES,
	BROWSER_SCHEMA,
	createLiveJournalMaterial,
	createRegistryConstraintMutations,
	decideLocalDuplicate,
	DUPLICATE_MATRIX,
	type ExistingRow,
	LIVE_JOURNAL_DOMAINS,
	LIVE_JOURNAL_FAILURE_KINDS,
	LIVE_JOURNAL_INSTALL_KEYS,
	LIVE_JOURNAL_LOCAL_KEYS,
	LIVE_JOURNAL_METHODS,
	LIVE_JOURNAL_RECEIVED_KEYS,
	LIVE_JOURNAL_SCOPE_KEYS,
	NODE_DEATH_TUPLES,
	NODE_SCHEMA,
} from "./fixtures/phase-3a1b-p4/live-journal-contract.js";
import {
	captureLiveJournalInput,
	createLiveJournalSnapshotValidation,
	deriveLiveJournalSnapshot,
	deriveLiveJournalSnapshotReadiness,
} from "../packages/live-journal/src/contract.js";

describe("live-journal readiness projection", () => {
	function durableReceived(count: number) {
		const material = createLiveJournalMaterial();
		const scope = { anchorDigest: material.anchorDigest, epoch: 0, objectId: material.objectId };
		const vertex = decodeCanonical(material.vertexBytes) as Record<string, unknown>;
		return {
			scope: {
				detachedAnchorSignature: material.signature,
				exactCanonicalAnchorPreimageBytes: material.anchorBytes,
				exactCanonicalParametersCarrierBytes: material.parametersBytes,
				nextJournalSequence: count,
				parametersDigest: material.parametersDigest,
				scope,
			},
			rows: Array.from({ length: count }, (_, journalSequence) => {
				const exactCanonicalPreimageBytes = encodeCanonical({ ...vertex,
					authorSequence: journalSequence, logicalTime: journalSequence + 1,
					operation: { payload: "r".repeat(256 + journalSequence) },
				});
				return {
					detachedSignature: new Uint8Array(material.signature),
					exactCanonicalPreimageBytes,
					journalSequence, scope, sourceKind: "received" as const,
					vertexDigest: Buffer.from(hashDomain("ts-drp/vertex/v3", exactCanonicalPreimageBytes)).toString("hex"),
				};
			}),
		};
	}

	it("removes exactly the discarded received-row copies while preserving exact tokens and detached replay rows", () => {
		const durable = durableReceived(4);
		const NativeUint8Array = globalThis.Uint8Array;
		function measured<T>(action: () => T) {
			let copies = 0;
			let bytes = 0;
			globalThis.Uint8Array = new Proxy(NativeUint8Array, {
				construct(target, arguments_) {
					const input = arguments_[0];
					if (input instanceof NativeUint8Array) { copies++; bytes += input.byteLength; }
					return Reflect.construct(target, arguments_, target);
				},
			});
			try { return { value: action(), copies, bytes }; }
			finally { globalThis.Uint8Array = NativeUint8Array; }
		}
		for (const highWatermark of [0, 2, 4]) {
			const full = measured(() => deriveLiveJournalSnapshot({ durable, highWatermark }));
			const readiness = measured(() => deriveLiveJournalSnapshotReadiness({ durable, highWatermark }));
			expect(full.value.ok).toBe(true);
			expect(readiness.value.ok).toBe(true);
			if (!full.value.ok || !readiness.value.ok) throw new Error("valid fixture refused");
			expect(readiness.value).toEqual({ ok: true, rowCount: highWatermark, token: full.value.token });
			expect(Object.hasOwn(readiness.value, "rows")).toBe(false);
			expect(Object.isFrozen(readiness.value)).toBe(true);
			expect(full.copies - readiness.copies).toBe(2 * highWatermark);
			expect(full.bytes - readiness.bytes).toBe(durable.rows.slice(0, highWatermark)
				.reduce((sum, row) => sum + row.detachedSignature.byteLength + row.exactCanonicalPreimageBytes.byteLength, 0));
			for (let index = 0; index < highWatermark; index++) {
				const row = full.value.rows[index];
				expect(Object.isFrozen(row)).toBe(true);
				if (row.sourceKind !== "received") throw new Error("wrong row variant");
				expect(row.detachedSignature).not.toBe(durable.rows[index].detachedSignature);
				expect(row.exactCanonicalPreimageBytes).not.toBe(durable.rows[index].exactCanonicalPreimageBytes);
			}
		}
	});

	it("reuses only exact private leaf facts and preserves fresh closure/refusal laws", () => {
		const validation = createLiveJournalSnapshotValidation();
		const durable = durableReceived(3);
		const fresh = () => structuredClone(durable);
		const derive = (value: ReturnType<typeof fresh>) => deriveLiveJournalSnapshot({durable: value, validation});
		const baseline = derive(fresh()); expect(baseline.ok).toBe(true);
		if (!baseline.ok) throw new Error("valid fixture refused");
		const first = baseline.rows[0];
		if (first.sourceKind !== "received") throw new Error("wrong row kind");
		first.exactCanonicalPreimageBytes.fill(255); first.detachedSignature.fill(255);
		expect(derive(fresh())).toEqual(deriveLiveJournalSnapshot({durable: fresh()}));
		const cases = [
			(value: ReturnType<typeof fresh>) => { value.rows[0].exactCanonicalPreimageBytes.fill(255); },
			(value: ReturnType<typeof fresh>) => { value.rows[0].detachedSignature.fill(7); },
			(value: ReturnType<typeof fresh>) => { value.rows[0].vertexDigest = "f".repeat(64); },
			(value: ReturnType<typeof fresh>) => { value.rows[1] = {...value.rows[0], journalSequence: 1}; },
			(value: ReturnType<typeof fresh>) => { value.rows[1].scope = {...value.rows[1].scope, epoch: 1}; },
			(value: ReturnType<typeof fresh>) => { value.scope.exactCanonicalAnchorPreimageBytes.fill(255); },
			(value: ReturnType<typeof fresh>) => { value.scope.exactCanonicalParametersCarrierBytes.fill(255); },
			(value: ReturnType<typeof fresh>) => { value.scope.detachedAnchorSignature = new Uint8Array(63); },
			(value: ReturnType<typeof fresh>) => { value.scope.nextJournalSequence--; },
		];
		for (const change of cases) {
			const value = fresh(); change(value);
			expect(derive(value)).toEqual(deriveLiveJournalSnapshot({durable: value}));
			expect(deriveLiveJournalSnapshotReadiness({durable: value, highWatermark: 0, validation}))
				.toEqual(deriveLiveJournalSnapshotReadiness({durable: value, highWatermark: 0}));
		}
		validation.release();
		expect(derive(fresh())).toEqual(deriveLiveJournalSnapshot({durable: fresh()}));
		// A structural lookalike supplies no facts and cannot bypass validation.
		const bad = fresh(); bad.rows[0].exactCanonicalPreimageBytes.fill(255);
		expect(deriveLiveJournalSnapshot({durable: bad, validation: {release() {}}}))
			.toEqual({ok: false, kind: "store-poisoned"});
	});

	it("keeps complete-image poison, stale-prefix and digest refusals identical", () => {
		const durable = durableReceived(3);
		const good = deriveLiveJournalSnapshot({ durable, highWatermark: 1 });
		if (!good.ok) throw new Error("valid fixture refused");
		const cases = [
			{ input: { durable, highWatermark: 4 }, kind: "stale-snapshot" },
			{ input: { durable, highWatermark: -1 }, kind: "store-poisoned" },
			{ input: { durable, highWatermark: 1, supplied: { ...good.token, snapshotDigest: "f".repeat(64) } }, kind: "digest-mismatch" },
			{ input: { durable: { ...durable, rows: durable.rows.slice(0, 2) }, highWatermark: 1 }, kind: "store-poisoned" },
			{ input: { durable: { ...durable, rows: durable.rows.map((row, index) => index === 2
				? { ...row, exactCanonicalPreimageBytes: new Uint8Array([0xff]) } : row) }, highWatermark: 1 }, kind: "store-poisoned" },
			{ input: { durable: { ...durable, rows: durable.rows.map((row, index) => index === 2
				? { ...durable.rows[0], journalSequence: index } : row) }, highWatermark: 1 }, kind: "store-poisoned" },
		];
		for (const { input, kind } of cases) {
			expect(deriveLiveJournalSnapshot(input)).toEqual({ ok: false, kind });
			expect(deriveLiveJournalSnapshotReadiness(input)).toEqual({ ok: false, kind });
		}
	});

	it("falls back to original validation beyond retained-byte capacity instead of refusing work", () => {
		const validation = createLiveJournalSnapshotValidation();
		const durable = durableReceived(1);
		const row = durable.rows[0];
		const vertex = decodeCanonical(row.exactCanonicalPreimageBytes) as Record<string, unknown>;
		row.exactCanonicalPreimageBytes = encodeCanonical({...vertex, operation: {payload: "r".repeat(2_097_153)}});
		row.vertexDigest = Buffer.from(hashDomain("ts-drp/vertex/v3", row.exactCanonicalPreimageBytes)).toString("hex");
		const expected = deriveLiveJournalSnapshotReadiness({durable}); expect(expected.ok).toBe(true);
		for (let repeat = 0; repeat < 2; repeat++) {
			const original = TextDecoder.prototype.decode;
			let strings = 0;
			TextDecoder.prototype.decode = function (...args) { strings++; return original.apply(this, args); };
			try { expect(deriveLiveJournalSnapshotReadiness({durable, validation})).toEqual(expected); }
			finally { TextDecoder.prototype.decode = original; }
			expect(strings).toBeGreaterThan(0); // Oversized syntax facts are not retained.
		}
		validation.release();
	});

	it("never treats caller-overridden array mapping as a private validated row capture", () => {
		const durable = durableReceived(1);
		const original = durable.rows[0];
		Object.defineProperty(durable.rows, "map", {value: () => [{...original, detachedSignature: new Uint8Array(0)}]});
		const validation = createLiveJournalSnapshotValidation();
		for (const owner of [undefined, validation])
			expect(deriveLiveJournalSnapshotReadiness({durable, validation: owner})).toEqual({ok: false, kind: "store-poisoned"});
		validation.release();
	});
});

describe("current optional author-share live-journal install contract", () => {
	const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
	const decodedRecord = (bytes: Uint8Array): Record<string, unknown> => {
		const value = decodeCanonical(bytes);
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new TypeError("invalid fixture record");
		return { ...value };
	};
	const parameters = (): Record<string, unknown> => decodedRecord(createLiveJournalMaterial().parametersBytes);
	const inputFor = (
		operation: "install" | "installEpochAnchor",
		selected: Record<string, unknown>
	): {
		input: {
			detachedAnchorSignature: Uint8Array;
			objectId: string;
			exactCanonicalAnchorPreimageBytes: Uint8Array;
			exactCanonicalParametersCarrierBytes: Uint8Array;
		};
		parametersDigest: string;
		scope: { objectId: string; epoch: number; anchorDigest: string };
	} => {
		const material = createLiveJournalMaterial();
		const exactCanonicalParametersCarrierBytes = encodeCanonical(selected);
		const parametersDigest = hex(hashDomain("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes));
		const anchor = {
			...decodedRecord(material.anchorBytes),
			epoch: operation === "install" ? 0 : 1,
			parametersDigest,
		};
		const exactCanonicalAnchorPreimageBytes = encodeCanonical(anchor);
		return {
			input: {
				detachedAnchorSignature: new Uint8Array(material.signature),
				objectId: material.objectId,
				exactCanonicalAnchorPreimageBytes,
				exactCanonicalParametersCarrierBytes,
			},
			parametersDigest,
			scope: {
				objectId: material.objectId,
				epoch: anchor.epoch,
				anchorDigest: hex(hashDomain("ts-drp/epoch-anchor/v3", exactCanonicalAnchorPreimageBytes)),
			},
		};
	};
	for (const operation of ["install", "installEpochAnchor"] as const) {
		it.each([undefined, 1, 4, 1_000_000])(`${operation} preserves exact optional multiplier %s`, (multiplier) => {
			const selected = parameters();
			if (multiplier !== undefined) selected.authorShareMultiplier = multiplier;
			const { input, parametersDigest, scope } = inputFor(operation, selected);
			expect(captureLiveJournalInput(operation, input)).toEqual({
				ok: true,
				value: {
					parametersDigest,
					stored: {
						detachedAnchorSignature: input.detachedAnchorSignature,
						exactCanonicalAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
						exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
						nextJournalSequence: 0,
						parametersDigest,
						scope,
					},
				},
			});
		});
		it.each(["zero", "negative", "fraction", "over-maximum", "unknown-extra", "missing-mandatory"])(
			`${operation} rejects optional contract violation %s`,
			(kind) => {
				const selected = { ...parameters(), authorShareMultiplier: 4 };
				const mutated: Record<string, unknown> = selected;
				if (kind === "zero") mutated.authorShareMultiplier = 0;
				if (kind === "negative") mutated.authorShareMultiplier = -1;
				if (kind === "fraction") mutated.authorShareMultiplier = 1.5;
				if (kind === "over-maximum") mutated.authorShareMultiplier = 1_000_001;
				if (kind === "unknown-extra") mutated.unregistered = 4;
				if (kind === "missing-mandatory") delete mutated.maxEpochVertices;
				expect(captureLiveJournalInput(operation, inputFor(operation, mutated).input)).toEqual({
					ok: false,
					kind: "noncanonical-preimage",
				});
			}
		);
		it(`${operation} distinguishes absent and present-one identity without stripping or defaults`, () => {
			const absent = inputFor(operation, parameters());
			const present = inputFor(operation, { ...parameters(), authorShareMultiplier: 1 });
			expect(absent.parametersDigest).not.toBe(present.parametersDigest);
			expect(absent.input.exactCanonicalParametersCarrierBytes).not.toEqual(
				present.input.exactCanonicalParametersCarrierBytes
			);
			for (const [anchor, carrier] of [
				[absent, present],
				[present, absent],
			] as const) {
				expect(
					captureLiveJournalInput(operation, {
						...anchor.input,
						exactCanonicalParametersCarrierBytes: carrier.input.exactCanonicalParametersCarrierBytes,
					})
				).toEqual({ ok: false, kind: "digest-mismatch" });
			}
		});
	}
});

function exactRegistryConstraintIds(): readonly string[] {
	const pairs = (prefix: string, fields: readonly string[]): readonly string[] =>
		fields.flatMap((field) => [`${prefix}-missing-${field}`, `${prefix}-wrong-type-${field}`]);
	const anchorFields = [
		"kind",
		"protocolMajor",
		"objectId",
		"epoch",
		"previousAnchor",
		"cutDigest",
		"stateDigest",
		"aclDigest",
		"historyRoot",
		"historySize",
		"archiveIndexRoot",
		"blueprintDigest",
		"signerSetDigest",
		"parametersDigest",
		"profileDigest",
		"cryptoSuiteId",
	];
	const parameterFields = [
		"maxEpochVertices",
		"maxEpochBytes",
		"maxDependencies",
		"snapshotChunkBytes",
		"maxSnapshotBytes",
		"maxPendingEntries",
		"maxPendingBytes",
	];
	const vertexFields = [
		"kind",
		"protocolMajor",
		"objectId",
		"epoch",
		"anchor",
		"author",
		"authorSequence",
		"logicalTime",
		"dependencies",
		"operation",
	];
	const anchorDigests = [
		"previousAnchor",
		"cutDigest",
		"stateDigest",
		"aclDigest",
		"historyRoot",
		"archiveIndexRoot",
		"blueprintDigest",
		"signerSetDigest",
		"parametersDigest",
		"profileDigest",
	];
	return Object.freeze([
		...pairs("anchor", anchorFields),
		...pairs("parameters", parameterFields),
		...pairs("vertex", vertexFields),
		"anchor-extra",
		"parameters-extra",
		"vertex-extra",
		"anchor-kind",
		"anchor-protocol",
		"anchor-object-empty",
		"anchor-object-long",
		"anchor-epoch-negative",
		"anchor-history-size-negative",
		"anchor-suite-reserved",
		...(["protocolMajor", "epoch", "historySize"] as const).map((field) => `anchor-${field}-fractional`),
		...anchorDigests.flatMap((field) => ["charset", "case", "length"].map((kind) => `anchor-${field}-digest-${kind}`)),
		"anchor-creator-previous-nonzero",
		"anchor-creator-cut-nonzero",
		"anchor-creator-history-nonzero",
		"anchor-foreign-object",
		...parameterFields.flatMap((field) =>
			["below", "above", "fractional"].map((kind) => `parameters-${field}-${kind}`)
		),
		"vertex-kind",
		"vertex-protocol",
		"vertex-object-empty",
		"vertex-object-long",
		"vertex-epoch-negative",
		"vertex-anchor-digest",
		"vertex-author-empty",
		"vertex-author-long",
		"vertex-author-sequence-negative",
		"vertex-logical-time-zero",
		"vertex-dependencies-empty",
		"vertex-dependencies-duplicate",
		"vertex-dependencies-unsorted",
		"vertex-dependency-digest",
		"vertex-operation-not-object",
		...(["protocolMajor", "epoch", "authorSequence", "logicalTime"] as const).map(
			(field) => `vertex-${field}-fractional`
		),
		"vertex-anchor-digest-case",
		"vertex-anchor-digest-length",
		"vertex-dependency-digest-case",
		"vertex-dependency-digest-length",
		"vertex-foreign-object",
		"vertex-foreign-epoch",
		"vertex-foreign-anchor",
	]);
}

interface Scope {
	readonly anchorDigest: string;
	readonly epoch: 0;
	readonly objectId: string;
}

interface JournalStore {
	appendAccepted(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	close(): Promise<void>;
	installGenesis(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readiness(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readPage(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

interface NodeCandidate {
	createNodeDurableLiveJournalStore(options: { readonly primaryFilename: string }): JournalStore;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const NODE_CANDIDATE = resolve(REPOSITORY_ROOT, "packages/storage-node/src/live-journal.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function openCandidateStore(): Promise<JournalStore> {
	const directory = await mkdtemp(resolve(tmpdir(), "ts-drp-p4-shared-"));
	temporaryDirectories.push(directory);
	let loaded: NodeCandidate;
	try {
		loaded = (await import(pathToFileURL(NODE_CANDIDATE).href)) as NodeCandidate;
	} catch (error) {
		throw new Error("PHASE_3A1B_P4_NODE_CANDIDATE_UNAVAILABLE", { cause: error });
	}
	if (typeof loaded.createNodeDurableLiveJournalStore !== "function") {
		throw new Error("PHASE_3A1B_P4_NODE_FACTORY_MISSING");
	}
	return loaded.createNodeDurableLiveJournalStore({ primaryFilename: resolve(directory, "primary.sqlite") });
}

function exactInputs(): {
	readonly install: Readonly<Record<string, unknown>>;
	readonly local: Readonly<Record<string, unknown>>;
	readonly received: Readonly<Record<string, unknown>>;
	readonly scope: Scope;
} {
	const material = createLiveJournalMaterial();
	const scope = Object.freeze({ anchorDigest: material.anchorDigest, epoch: 0 as const, objectId: material.objectId });
	return {
		install: Object.freeze({
			detachedAnchorSignature: new Uint8Array(material.signature),
			exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
			exactCanonicalParametersCarrierBytes: new Uint8Array(material.parametersBytes),
			objectId: material.objectId,
		}),
		local: Object.freeze({
			author: "creator",
			authorSequence: 0,
			scope,
			sourceKind: "local-issued",
			vertexDigest: material.vertexDigest,
		}),
		received: Object.freeze({
			detachedSignature: new Uint8Array(material.signature),
			exactCanonicalPreimageBytes: new Uint8Array(material.vertexBytes),
			scope,
			sourceKind: "received",
			vertexDigest: material.vertexDigest,
		}),
		scope,
	};
}

function localRow(digest: string, ref: string): ExistingRow {
	return Object.freeze({ digest, kind: "local-issued", ref });
}

function receivedRow(digest: string): ExistingRow {
	return Object.freeze({ digest, kind: "received", ref: null });
}

function lowerHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function expectedSingleReceivedSnapshot(): Readonly<Record<string, unknown>> {
	const material = createLiveJournalMaterial();
	const rowCommitmentDigest = lowerHex(
		hashDomain(
			LIVE_JOURNAL_DOMAINS.row,
			encodeCanonical({
				kind: "v3-live-journal-received-row-1",
				objectId: material.objectId,
				epoch: 0,
				anchorDigest: material.anchorDigest,
				journalSequence: 0,
				sourceKind: "received",
				vertexDigest: material.vertexDigest,
				exactCanonicalPreimageBytes: material.vertexBytes,
				detachedSignature: material.signature,
			})
		)
	);
	const orderedRowDigest = lowerHex(
		hashDomain(
			LIVE_JOURNAL_DOMAINS.order,
			encodeCanonical({
				kind: "v3-live-journal-order-1",
				objectId: material.objectId,
				epoch: 0,
				anchorDigest: material.anchorDigest,
				highWatermark: 1,
				rowCommitmentDigests: [rowCommitmentDigest],
			})
		)
	);
	const snapshotDigest = lowerHex(
		hashDomain(
			LIVE_JOURNAL_DOMAINS.snapshot,
			encodeCanonical({
				kind: "v3-live-journal-snapshot-1",
				objectId: material.objectId,
				epoch: 0,
				anchorDigest: material.anchorDigest,
				highWatermark: 1,
				genesisDigest: material.anchorDigest,
				parametersDigest: material.parametersDigest,
				orderedRowDigest,
			})
		)
	);
	return Object.freeze({
		genesisDigest: material.anchorDigest,
		highWatermark: 1,
		kind: "v3-live-journal-snapshot-token-1",
		orderedRowDigest,
		parametersDigest: material.parametersDigest,
		scope: Object.freeze({ anchorDigest: material.anchorDigest, epoch: 0, objectId: material.objectId }),
		snapshotDigest,
	});
}

describe("D.93.34 p4-a frozen shared contract", () => {
	it("freezes the exact seven methods, fifteen failures, three domains and closed input keys", () => {
		expect(LIVE_JOURNAL_METHODS).toEqual([
			"appendAccepted",
			"close",
			"installEpochAnchor",
			"installGenesis",
			"readAnchorPreimage",
			"readiness",
			"readPage",
		]);
		expect(LIVE_JOURNAL_FAILURE_KINDS).toHaveLength(15);
		expect(LIVE_JOURNAL_FAILURE_KINDS[0]).toBe("malformed-input");
		expect(LIVE_JOURNAL_FAILURE_KINDS.at(-1)).toBe("internal-invariant");
		expect(LIVE_JOURNAL_DOMAINS).toEqual({
			order: "ts-drp/live-journal-order/v1",
			row: "ts-drp/live-journal-row/v1",
			snapshot: "ts-drp/live-journal-snapshot/v1",
		});
		expect(LIVE_JOURNAL_SCOPE_KEYS).toEqual(["anchorDigest", "epoch", "objectId"]);
		expect(LIVE_JOURNAL_INSTALL_KEYS).toEqual([
			"detachedAnchorSignature",
			"exactCanonicalAnchorPreimageBytes",
			"exactCanonicalParametersCarrierBytes",
			"objectId",
		]);
		expect(LIVE_JOURNAL_RECEIVED_KEYS).toEqual([
			"detachedSignature",
			"exactCanonicalPreimageBytes",
			"scope",
			"sourceKind",
			"vertexDigest",
		]);
		expect(LIVE_JOURNAL_LOCAL_KEYS).toEqual(["author", "authorSequence", "scope", "sourceKind", "vertexDigest"]);
	});

	it("executes every registry-v1 anchor, parameters and received-vertex constraint adversarially", async () => {
		const mutations = createRegistryConstraintMutations();
		expect(mutations.map(({ id }) => id)).toEqual(exactRegistryConstraintIds());
		expect(new Set(mutations.map(({ id }) => id))).toHaveLength(exactRegistryConstraintIds().length);
		for (const mutation of mutations) {
			const store = await openCandidateStore();
			const values = exactInputs();
			try {
				if (mutation.carrier === "anchor") {
					expect(
						await store.installGenesis({ ...values.install, exactCanonicalAnchorPreimageBytes: mutation.bytes }),
						mutation.id
					).toEqual({ kind: mutation.expectedKind, ok: false });
				} else if (mutation.carrier === "parameters") {
					expect(
						await store.installGenesis({ ...values.install, exactCanonicalParametersCarrierBytes: mutation.bytes }),
						mutation.id
					).toEqual({ kind: mutation.expectedKind, ok: false });
				} else {
					await store.installGenesis(values.install);
					const candidate = {
						...values.received,
						exactCanonicalPreimageBytes: mutation.bytes,
						vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", mutation.bytes)),
					};
					expect(await store.appendAccepted(candidate), mutation.id).toEqual({
						kind: mutation.expectedKind,
						ok: false,
					});
				}
			} finally {
				await store.close();
			}
		}
	}, 30_000);

	it("pins the complete deterministic local duplicate/conflict precedence matrix", () => {
		const digest = "d".repeat(64);
		const otherDigest = "e".repeat(64);
		const sameRef = "creator/0";
		const otherRef = "creator/1";
		const same = localRow(digest, sameRef);
		const otherByDigest = localRow(digest, otherRef);
		const otherByRef = localRow(otherDigest, sameRef);
		const cases = [
			decideLocalDuplicate({ candidateDigest: digest, candidateRef: sameRef, digestRow: null, refRow: null }),
			decideLocalDuplicate({ candidateDigest: digest, candidateRef: sameRef, digestRow: same, refRow: same }),
			decideLocalDuplicate({ candidateDigest: digest, candidateRef: sameRef, digestRow: otherByDigest, refRow: same }),
			decideLocalDuplicate({ candidateDigest: digest, candidateRef: sameRef, digestRow: null, refRow: otherByRef }),
			decideLocalDuplicate({
				candidateDigest: digest,
				candidateRef: sameRef,
				digestRow: receivedRow(digest),
				refRow: null,
			}),
			decideLocalDuplicate({ candidateDigest: digest, candidateRef: sameRef, digestRow: otherByDigest, refRow: null }),
			decideLocalDuplicate({ candidateDigest: digest, candidateRef: sameRef, digestRow: same, refRow: otherByRef }),
		];
		expect(DUPLICATE_MATRIX.map(({ id }) => id)).toEqual([
			"both-absent",
			"both-same-local",
			"digest-and-ref-distinct",
			"only-ref",
			"only-digest-received",
			"only-digest-local-other-ref",
			"ref-different-digest-wins",
		]);
		expect(cases).toEqual([
			{ action: "append" },
			{ action: "idempotent", retainedKind: "local-issued" },
			{ action: "conflict" },
			{ action: "conflict" },
			{ action: "idempotent", retainedKind: "received" },
			{ action: "conflict" },
			{ action: "conflict" },
		]);
	});

	it("compile-pins the public package and both exact adapter subpaths", () => {
		const result = spawnSync(
			process.execPath,
			[
				resolve(REPOSITORY_ROOT, "node_modules/typescript/lib/tsc.js"),
				"-p",
				resolve(import.meta.dirname, "fixtures/phase-3a1b-p4/tsconfig.test.json"),
			],
			{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
		);
		expect(`${result.stdout}${result.stderr}`).toBe("");
		expect(result.status).toBe(0);
	});

	it("installs exact creator genesis and exposes only one frozen six-method capability", async () => {
		const store = await openCandidateStore();
		try {
			expect(Object.keys(store).sort()).toEqual([...LIVE_JOURNAL_METHODS].sort());
			expect(Reflect.ownKeys(store)).toEqual(LIVE_JOURNAL_METHODS);
			expect(Object.isFrozen(store)).toBe(true);
			const { install, scope } = exactInputs();
			const first = await store.installGenesis(install);
			expect(first).toEqual({
				idempotent: false,
				ok: true,
				parametersDigest: createLiveJournalMaterial().parametersDigest,
				scope,
			});
			const repeat = await store.installGenesis(install);
			expect(repeat).toEqual({ ...first, idempotent: true });
		} finally {
			await store.close();
		}
	});

	it("retains the first received/local label and allocates no duplicate sequence", async () => {
		const store = await openCandidateStore();
		try {
			const { install, local, received } = exactInputs();
			await store.installGenesis(install);
			const first = await store.appendAccepted(local);
			expect(first).toMatchObject({ idempotent: false, journalSequence: 0, ok: true, sourceKind: "local-issued" });
			const echo = await store.appendAccepted(received);
			expect(echo).toMatchObject({ idempotent: true, journalSequence: 0, ok: true, sourceKind: "local-issued" });
		} finally {
			await store.close();
		}
	});

	it("derives a durable-prefix token and keeps later appends invisible to capped pages", async () => {
		const store = await openCandidateStore();
		try {
			const { install, received, scope } = exactInputs();
			await store.installGenesis(install);
			await store.appendAccepted(received);
			const readiness = await store.readiness({ scope });
			expect(readiness).toMatchObject({ ok: true, ready: true, rowCount: 1, scope });
			const snapshot = readiness.snapshot;
			expect(snapshot).toEqual(expectedSingleReceivedSnapshot());
			const page = await store.readPage({ afterSequence: null, limit: 1, scope, snapshot });
			expect(page).toMatchObject({ nextSequence: null, ok: true, rows: [{ journalSequence: 0 }], scope, snapshot });
			expect(Object.isFrozen(snapshot)).toBe(true);
			expect(Object.isFrozen(page)).toBe(true);
			expect(Object.isFrozen(page.rows)).toBe(true);
		} finally {
			await store.close();
		}
	});

	it("copies retained evidence before the first await and returns fresh detached typed-array leaves", async () => {
		const store = await openCandidateStore();
		try {
			const { install, received, scope } = exactInputs();
			await store.installGenesis(install);
			const preimage = received.exactCanonicalPreimageBytes as Uint8Array;
			const signature = received.detachedSignature as Uint8Array;
			const expectedPreimage = new Uint8Array(preimage);
			const expectedSignature = new Uint8Array(signature);
			const pending = store.appendAccepted(received);
			preimage.fill(0);
			signature.fill(0);
			expect(await pending).toMatchObject({ idempotent: false, journalSequence: 0, ok: true });
			const ready = await store.readiness({ scope });
			const first = await store.readPage({ scope, snapshot: ready.snapshot });
			const second = await store.readPage({ scope, snapshot: ready.snapshot });
			const firstRow = first.rows[0];
			const secondRow = second.rows[0];
			expect(firstRow.exactCanonicalPreimageBytes).toEqual(expectedPreimage);
			expect(firstRow.detachedSignature).toEqual(expectedSignature);
			expect(firstRow.exactCanonicalPreimageBytes).not.toBe(preimage);
			expect(firstRow.detachedSignature).not.toBe(signature);
			expect(firstRow.exactCanonicalPreimageBytes).not.toBe(secondRow.exactCanonicalPreimageBytes);
			expect(firstRow.detachedSignature).not.toBe(secondRow.detachedSignature);
			expect(firstRow.exactCanonicalPreimageBytes.buffer).not.toBe(preimage.buffer);
			expect(firstRow.detachedSignature.buffer).not.toBe(signature.buffer);
		} finally {
			await store.close();
		}
	});

	it("rejects hostile records and shared byte backing without dispatching accessors", async () => {
		const store = await openCandidateStore();
		try {
			const accessor = Object.defineProperty({}, "objectId", {
				enumerable: true,
				get: () => {
					throw new Error("P4_ACCESSOR_DISPATCHED");
				},
			});
			expect(await store.installGenesis(accessor)).toEqual({ kind: "malformed-input", ok: false });
			const values = exactInputs();
			const invalidObjectIds = [
				"creator",
				`:`,
				`creator:${"a".repeat(31)}`,
				`creator:${"a".repeat(33)}`,
				`creator:${"A".repeat(32)}`,
				`creator:${"a".repeat(32)}:extra`,
				`creator\0:${"a".repeat(32)}`,
				`${"x".repeat(992)}:${"a".repeat(32)}`,
				`creator:\ud800${"a".repeat(32)}`,
			];
			for (const objectId of invalidObjectIds) {
				expect(parseStorageObjectId(objectId)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
				expect(await store.installGenesis({ ...values.install, objectId })).toEqual({
					kind: "malformed-input",
					ok: false,
				});
			}
			let snapshotOwnKeys = 0;
			let snapshotDescriptors = 0;
			const descriptorSnapshot = new Proxy(values.install, {
				getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
					snapshotDescriptors += 1;
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
				ownKeys(target): (string | symbol)[] {
					snapshotOwnKeys += 1;
					return Reflect.ownKeys(target);
				},
			});
			expect(await store.installGenesis(descriptorSnapshot)).toMatchObject({ ok: true });
			expect(snapshotOwnKeys).toBe(1);
			expect(snapshotDescriptors).toBe(4);
			let recordOwnKeys = 0;
			const hostileRecord = new Proxy(values.install, {
				ownKeys: (): never => {
					recordOwnKeys += 1;
					throw new Error("P4_RECORD_OWN_KEYS_DISPATCHED");
				},
			});
			await expect(store.installGenesis(hostileRecord)).resolves.toEqual({ kind: "malformed-input", ok: false });
			expect(recordOwnKeys).toBe(1);
			let typedOwnKeys = 0;
			const hostileBytes = new Proxy(values.install.exactCanonicalAnchorPreimageBytes as Uint8Array, {
				getOwnPropertyDescriptor: (): never => {
					throw new Error("P4_TYPED_DESCRIPTOR_DISPATCHED");
				},
				ownKeys: (): never => {
					typedOwnKeys += 1;
					throw new Error("P4_TYPED_OWN_KEYS_DISPATCHED");
				},
			});
			await expect(
				store.installGenesis({ ...values.install, exactCanonicalAnchorPreimageBytes: hostileBytes })
			).resolves.toEqual({ kind: "malformed-input", ok: false });
			expect(typedOwnKeys).toBe(0);
			const shared = new Uint8Array(new SharedArrayBuffer(values.install.exactCanonicalAnchorPreimageBytes.byteLength));
			expect(
				await store.installGenesis({
					...values.install,
					exactCanonicalAnchorPreimageBytes: shared,
				})
			).toEqual({ kind: "malformed-input", ok: false });
			expect(await store.installGenesis({ ...values.install, extra: true })).toEqual({
				kind: "malformed-input",
				ok: false,
			});
			for (const input of [
				{ ...values.install, detachedAnchorSignature: "not-bytes" },
				{ ...values.install, detachedAnchorSignature: new Uint8Array(63) },
				{ ...values.install, exactCanonicalParametersCarrierBytes: new Uint8Array() },
			]) {
				expect(await store.installGenesis(input)).toEqual({ kind: "malformed-input", ok: false });
			}
		} finally {
			await store.close();
		}
	});

	it("requires exact plain page inputs and freezes scope precedence before received semantics", async () => {
		const unopened = await openCandidateStore();
		const values = exactInputs();
		const invalidVertex = createRegistryConstraintMutations().find(({ id }) => id === "vertex-logical-time-zero");
		if (invalidVertex === undefined) throw new Error("P4_VERTEX_MUTANT_MISSING");
		const received = {
			...values.received,
			exactCanonicalPreimageBytes: invalidVertex.bytes,
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", invalidVertex.bytes)),
		};
		try {
			expect(await unopened.appendAccepted(received)).toEqual({ kind: "not-installed", ok: false });
			await unopened.installGenesis(values.install);
			expect(
				await unopened.appendAccepted({
					...received,
					scope: { ...values.scope, anchorDigest: "f".repeat(64) },
				})
			).toEqual({ kind: "wrong-scope", ok: false });
			expect(await unopened.appendAccepted(received)).toEqual({ kind: "noncanonical-preimage", ok: false });

			const ready = await unopened.readiness({ scope: values.scope });
			const snapshot = ready.snapshot;
			for (const afterSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				expect(await unopened.readPage({ afterSequence, scope: values.scope, snapshot })).toEqual({
					kind: "malformed-input",
					ok: false,
				});
			}
			for (const limit of [0, 129, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				expect(await unopened.readPage({ limit, scope: values.scope, snapshot })).toEqual({
					kind: "malformed-input",
					ok: false,
				});
			}
			class NonPlainPageInput {
				public sentinel(): void {}
			}
			expect(
				await unopened.readPage(Object.assign(new NonPlainPageInput(), { scope: values.scope, snapshot }))
			).toEqual({
				kind: "malformed-input",
				ok: false,
			});
			expect(await unopened.readPage({ extra: true, scope: values.scope, snapshot })).toEqual({
				kind: "malformed-input",
				ok: false,
			});
			const foreignScope = { ...values.scope, anchorDigest: "f".repeat(64) };
			expect(
				await unopened.readPage({
					afterSequence: Number.MAX_SAFE_INTEGER,
					scope: foreignScope,
					snapshot: {
						...snapshot,
						highWatermark: Number.MAX_SAFE_INTEGER,
						scope: foreignScope,
						snapshotDigest: "f".repeat(64),
					},
				})
			).toEqual({ kind: "wrong-scope", ok: false });
			for (const local of [
				{ ...values.local, author: "" },
				{ ...values.local, author: "x".repeat(1025) },
				{ ...values.local, author: "creator\ud800" },
				{ ...values.local, authorSequence: Number.MAX_SAFE_INTEGER + 1 },
				{ ...values.local, sourceKind: "received-ish" },
				{ ...values.local, vertexDigest: "A".repeat(64) },
				{ ...values.local, vertexDigest: "a".repeat(62) },
			]) {
				expect(await unopened.appendAccepted(local)).toEqual({ kind: "malformed-input", ok: false });
			}
		} finally {
			await unopened.close();
		}
	});

	it("freezes wrong-scope, digest/evidence conflict and post-close precedence without allocating rows", async () => {
		const store = await openCandidateStore();
		const values = exactInputs();
		expect(await store.appendAccepted(values.received)).toEqual({ kind: "not-installed", ok: false });
		await store.installGenesis(values.install);
		expect(
			await store.appendAccepted({
				...values.received,
				scope: { ...values.scope, anchorDigest: "f".repeat(64) },
			})
		).toEqual({ kind: "wrong-scope", ok: false });
		await store.appendAccepted(values.received);
		expect(await store.appendAccepted({ ...values.received, detachedSignature: new Uint8Array(64).fill(9) })).toEqual({
			kind: "evidence-conflict",
			ok: false,
		});
		expect(await store.appendAccepted({ ...values.local, vertexDigest: "f".repeat(64) })).toMatchObject({
			idempotent: false,
			journalSequence: 1,
			ok: true,
			sourceKind: "local-issued",
		});
		expect(await store.appendAccepted({ ...values.local, vertexDigest: "e".repeat(64) })).toEqual({
			kind: "evidence-conflict",
			ok: false,
		});
		const close = store.close();
		expect(store.close()).toBe(close);
		await close;
		expect(await store.readiness({ scope: values.scope })).toEqual({ kind: "store-closed", ok: false });
	});

	it("freezes distinct Node and Browser durability matrices without borrowing either claim", () => {
		expect(NODE_DEATH_TUPLES).toHaveLength(36);
		expect(BROWSER_DEATH_TUPLES).toHaveLength(36);
		expect(new Set(NODE_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(36);
		expect(new Set(BROWSER_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(36);
		expect(NODE_SCHEMA.scopes).toContain("WITHOUT ROWID");
		expect(NODE_SCHEMA.acceptedEntries).toContain("UNIQUE (object_id, epoch, anchor_digest, vertex_digest)");
		expect(BROWSER_SCHEMA.localRefUniq).toEqual([
			"objectId",
			"epoch",
			"anchorDigest",
			"localAuthor",
			"localAuthorSequence",
		]);
	});
});
