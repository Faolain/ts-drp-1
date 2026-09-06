import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	createSuccessorEpochMaterial,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	REQUIRED_RED_PATHS,
	SUCCESSOR_INSTALL_KEYS,
	SUCCESSOR_JOURNAL_METHODS,
	SUCCESSOR_SCOPE_KEYS,
	successorEpochReadiness,
} from "./fixtures/phase-6a-v3/successor-epoch-contract.js";

interface CandidateJournalStore {
	appendAccepted(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	close(): Promise<void>;
	installEpochAnchor(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	installGenesis(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readiness(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readPage(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

interface CandidateNodeModule {
	createNodeDurableLiveJournalStore(input: { readonly primaryFilename: string }): CandidateJournalStore;
}

const readiness = successorEpochReadiness();
const temporaryDirectories: string[] = [];

async function openStore(): Promise<CandidateJournalStore> {
	const directory = await mkdtemp(resolve(tmpdir(), "ts-drp-phase6a-successor-"));
	temporaryDirectories.push(directory);
	const candidate = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-node/src/live-journal.ts")).href
	)) as CandidateNodeModule;
	return candidate.createNodeDurableLiveJournalStore({
		primaryFilename: resolve(directory, "journal.sqlite"),
	});
}

function lowerHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true }))
	);
});

describe("D.108a successor-epoch live substrate RED", () => {
	it("freezes exactly five RED and six GREEN owners without a new product API", () => {
		expect(REQUIRED_RED_PATHS).toHaveLength(5);
		expect(REQUIRED_GREEN_PATHS).toHaveLength(6);
		expect(REQUIRED_RED_PATHS.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)))).toBe(true);
		expect(SUCCESSOR_JOURNAL_METHODS).toEqual([
			"appendAccepted",
			"close",
			"installEpochAnchor",
			"installGenesis",
			"readiness",
			"readPage",
		]);
		expect(SUCCESSOR_SCOPE_KEYS).toEqual(["anchorDigest", "epoch", "objectId"]);
		expect(SUCCESSOR_INSTALL_KEYS).toEqual([
			"detachedAnchorSignature",
			"exactCanonicalAnchorPreimageBytes",
			"exactCanonicalParametersCarrierBytes",
			"objectId",
		]);
	});

	it("constructs one exact canonical non-genesis anchor and epoch-one vertex independently", () => {
		const material = createSuccessorEpochMaterial();
		const anchor = decodeCanonical(material.anchorBytes) as Readonly<Record<string, unknown>>;
		const vertex = decodeCanonical(material.vertexBytes) as Readonly<Record<string, unknown>>;
		expect(anchor).toMatchObject({
			cutDigest: "6".repeat(64),
			epoch: 1,
			historyRoot: "7".repeat(64),
			historySize: 1,
			objectId: material.objectId,
			previousAnchor: "5".repeat(64),
		});
		expect(vertex).toMatchObject({
			anchor: material.anchorDigest,
			authorSequence: 12,
			epoch: 1,
			objectId: material.objectId,
		});
		expect(encodeCanonical(anchor)).toEqual(material.anchorBytes);
		expect(encodeCanonical(vertex)).toEqual(material.vertexBytes);
		expect(lowerHex(hashDomain("ts-drp/epoch-anchor/v3", material.anchorBytes))).toBe(material.anchorDigest);
		expect(lowerHex(hashDomain("ts-drp/vertex/v3", material.vertexBytes))).toBe(material.vertexDigest);
	});

	it("preserves installGenesis as a genesis-only operation", async () => {
		const store = await openStore();
		try {
			expect(await store.installGenesis(createSuccessorEpochMaterial().install)).toEqual({
				kind: "noncanonical-preimage",
				ok: false,
			});
		} finally {
			await store.close();
		}
	});

	it("[RED readiness] requires the six successor representation owners together", () => {
		expect(readiness, `missing D.108a owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("keeps epoch-zero and epoch-one rows isolated in one durable store", async () => {
		const store = await openStore();
		try {
			expect(Object.keys(store).sort()).toEqual([...SUCCESSOR_JOURNAL_METHODS].sort());
			const material = createSuccessorEpochMaterial();
			expect(await store.installGenesis(material.genesis.install)).toMatchObject({
				idempotent: false,
				ok: true,
				scope: material.genesis.scope,
			});
			expect(await store.appendAccepted(material.genesis.received)).toMatchObject({
				journalSequence: 0,
				ok: true,
				scope: material.genesis.scope,
				vertexDigest: material.genesis.vertexDigest,
			});
			const installed = await store.installEpochAnchor(material.install);
			expect(installed).toEqual({
				idempotent: false,
				ok: true,
				parametersDigest: material.parametersDigest,
				scope: material.scope,
			});
			expect(await store.installEpochAnchor(material.install)).toEqual({ ...installed, idempotent: true });
			expect(await store.appendAccepted(material.received)).toMatchObject({
				idempotent: false,
				journalSequence: 0,
				ok: true,
				scope: material.scope,
				sourceKind: "received",
			});
			const genesisReady = await store.readiness({ scope: material.genesis.scope });
			const successorReady = await store.readiness({ scope: material.scope });
			expect(genesisReady).toMatchObject({ ok: true, ready: true, rowCount: 1, scope: material.genesis.scope });
			expect(successorReady).toMatchObject({ ok: true, ready: true, rowCount: 1, scope: material.scope });
			expect((genesisReady.snapshot as Readonly<Record<string, unknown>>).orderedRowDigest).not.toBe(
				(successorReady.snapshot as Readonly<Record<string, unknown>>).orderedRowDigest
			);
			const genesisPage = await store.readPage({
				limit: 1,
				scope: material.genesis.scope,
				snapshot: genesisReady.snapshot,
			});
			const successorPage = await store.readPage({
				limit: 1,
				scope: material.scope,
				snapshot: successorReady.snapshot,
			});
			expect(genesisPage).toMatchObject({
				nextSequence: null,
				ok: true,
				rows: [{ journalSequence: 0, scope: material.genesis.scope, vertexDigest: material.genesis.vertexDigest }],
				scope: material.genesis.scope,
			});
			expect(successorPage).toMatchObject({
				nextSequence: null,
				ok: true,
				rows: [{ journalSequence: 0, scope: material.scope, vertexDigest: material.vertexDigest }],
				scope: material.scope,
			});
			expect(await store.readPage({ limit: 1, scope: material.scope, snapshot: genesisReady.snapshot })).toMatchObject({
				ok: false,
			});
		} finally {
			await store.close();
		}
	});

	it.skipIf(!readiness.ready)("rejects hostile, noncanonical and unsafe successor epoch inputs closed", async () => {
		const material = createSuccessorEpochMaterial();
		const anchor = decodeCanonical(material.anchorBytes) as Readonly<Record<string, unknown>>;
		const cases = [
			{ id: "genesis", value: { ...anchor, epoch: 0 } },
			{ id: "negative", value: { ...anchor, epoch: -1 } },
			{ id: "fractional", value: { ...anchor, epoch: 1.5 } },
		] as const;
		for (const candidate of cases) {
			const store = await openStore();
			try {
				expect(
					await store.installEpochAnchor({
						...material.install,
						exactCanonicalAnchorPreimageBytes: encodeCanonical(candidate.value),
					}),
					candidate.id
				).toMatchObject({ ok: false });
			} finally {
				await store.close();
			}
		}
		expect(() => encodeCanonical({ ...anchor, epoch: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe range/u);
		const unsafeStore = await openStore();
		try {
			expect(await unsafeStore.readiness({ scope: { ...material.scope, epoch: Number.MAX_SAFE_INTEGER + 1 } })).toEqual(
				{ kind: "malformed-input", ok: false }
			);
		} finally {
			await unsafeStore.close();
		}
		let hostileDispatchCount = 0;
		const hostile = Object.defineProperties(
			{},
			{
				detachedAnchorSignature: { enumerable: true, value: material.signature },
				exactCanonicalAnchorPreimageBytes: { enumerable: true, value: material.anchorBytes },
				exactCanonicalParametersCarrierBytes: { enumerable: true, value: material.parametersBytes },
				objectId: {
					enumerable: true,
					get: () => {
						hostileDispatchCount += 1;
						throw new Error("D108A_ACCESSOR_DISPATCHED");
					},
				},
			}
		);
		const store = await openStore();
		try {
			await expect(store.installEpochAnchor(hostile)).resolves.toEqual({ kind: "malformed-input", ok: false });
			expect(hostileDispatchCount).toBe(0);
			expect(await store.installEpochAnchor({ ...material.install, extra: true })).toEqual({
				kind: "malformed-input",
				ok: false,
			});
		} finally {
			await store.close();
		}
	});
});
