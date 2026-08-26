import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
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
	it("freezes the exact six methods, fifteen failures, three domains and closed input keys", () => {
		expect(LIVE_JOURNAL_METHODS).toEqual([
			"appendAccepted",
			"close",
			"installEpochAnchor",
			"installGenesis",
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
