import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { journalRetirementFrameDigest } from "@ts-drp/live-journal";
import { expect, test } from "vitest";

import { createBrowserDurableLiveJournalStore } from "../src/live-journal.js";

// Browser parity for storage-node's "R10 exact empty header drain ... reconstructs original source after
// reopen" (retirement-image-cas.test.ts). fix/maintenance-image-capacity (i): the journal observation carrier no
// longer holds drainSource; every site that needs the pre-drain journal reads the adapter's own
// read.drainSource, which each adapter rebuilds from (control, image, residual rows) in its own frame format
// (browser: camelCase acceptedEntries). This pins that the browser reconstruction equals the pre-drain read,
// between batches and across a reopen. Mechanism test over fake-indexeddb, not native browser evidence (G28).

// The storage fixture carriers of tests/fixtures/journal-anchor-read/material.ts (signatures are storage fixtures,
// not external authority), built on the package's own codec import so the clean tracked-file gate needs no dist.
const archived = JSON.parse(readFileSync(new URL("../../../tests/fixtures/phase-3a1b-p4/material.json", import.meta.url), "utf8")) as
	{ anchorHex: string; objectId: string; parametersHex: string; signatureHex: string };
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], part => Number.parseInt(part, 16));
function anchorMaterial(epoch: number) {
	const genesis = fromHex(archived.anchorHex);
	const bytes = epoch === 0 ? genesis : encodeCanonical({ ...(decodeCanonical(genesis) as Record<string, unknown>), epoch });
	const anchorDigest = Array.from(hashDomain("ts-drp/epoch-anchor/v3", bytes), byte => byte.toString(16).padStart(2, "0")).join("");
	return { scope: { objectId: archived.objectId, epoch, anchorDigest }, install: { objectId: archived.objectId,
		exactCanonicalAnchorPreimageBytes: bytes, detachedAnchorSignature: fromHex(archived.signatureHex),
		exactCanonicalParametersCarrierBytes: fromHex(archived.parametersHex) } };
}

type Store = Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; kind?: string }>;
function must<T>(result: Result<T>): T {
	if (!result.ok) throw new TypeError(`browser retirement fixture failed: ${String(result.kind)}`);
	return result.value;
}
function retirement(store: Store) {
	if (store.readRetirementImage === undefined || store.acquireRetirementControl === undefined)
		throw new TypeError("browser journal store lacks its retirement surface");
	return { read: store.readRetirementImage, acquire: store.acquireRetirementControl };
}

test("browser drainSource equals the pre-drain rows between batches and across reopen", async () => {
	const primaryDatabaseName = `journal-drain-source-reopen-${Date.now()}`;
	let store = await createBrowserDurableLiveJournalStore({ primaryDatabaseName });
	const materials = Array.from({ length: 20 }, (_, epoch) => anchorMaterial(epoch));
	const selector = { objectId: materials[0]!.scope.objectId };
	const read = async () => must(await retirement(store).read(selector));
	const acquire = async () => must(await retirement(store).acquire(selector));
	try {
		expect(await store.installGenesis(materials[0]!.install)).toMatchObject({ ok: true });
		for (const material of materials.slice(1)) expect(await store.installEpochAnchor(material.install)).toMatchObject({ ok: true });
		expect(await store.appendAccepted({ scope: materials[1]!.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: 0, vertexDigest: "a".repeat(64) })).toMatchObject({ ok: true });
		const prepare = await acquire();
		must(await prepare.prepareFence({ throughEpoch: 18, protectedScopes: [materials[18]!.scope],
			decisionDigest: "e".repeat(64), sourceProofDigest: "f".repeat(64) }));
		await prepare.release();
		const commit = await acquire();
		must(await commit.commitPrepared()); await commit.release();
		const source = await read();
		if (source.control === null) throw new Error("original floor missing");
		expect(source.drainSource).toBeUndefined();
		const decoded = source.canonicalRows.map(bytes =>
			[bytes, decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>]] as const);
		// Browser frames: camelCase acceptedEntries rows (storage-node's are snake_case accepted_entries).
		const rows = decoded.flatMap(([bytes, [table, , row]]) => table === "acceptedEntries" ? [{
			journalSequence: row.journalSequence as number,
			vertexDigest: row.vertexDigest as string,
			author: row.localAuthor as string,
			authorSequence: row.localAuthorSequence as number,
			nativeFrameDigest: journalRetirementFrameDigest(bytes) }] : []);
		expect(rows).toHaveLength(1);
		const headers = decoded.flatMap(([bytes, [table, key]]) => {
			const epoch = key[1];
			return table === "scopes" && typeof epoch === "number" && epoch >= 2 && epoch <= 17
				? [{ scope: materials[epoch]!.scope, exactCanonicalNativeFrameBytes: bytes }] : [];
		});
		expect(headers).toHaveLength(16);
		const plan = { baseControl: source.control, sourceImage: source.image, prefixes: [{ scope: materials[1]!.scope, highWatermark: 1, rows }],
			retiredEmptyHeaders: headers, protectedHeaderScopes: [materials[0]!.scope, materials[18]!.scope, materials[19]!.scope] };
		const begin = await acquire(); must(await begin.beginDrain(plan)); await begin.release();
		const pre = { control: source.control, image: source.image, canonicalRows: source.canonicalRows };
		const first = await acquire(); must(await first.drainBatch()); await first.release();
		const partial = await read();
		// One bounded batch (16 items) retired the local row and 15 headers; the plan holds the original frames.
		expect(partial.control?.drain).toMatchObject({ cursor: 16, batches: 1 });
		expect(partial.image).toMatchObject({ rowCount: 0 });
		expect(partial.canonicalRows.length).toBeLessThan(source.canonicalRows.length);
		expect(partial.drainSource).toEqual(pre);
		// Byte identity, not structural equality only: every reconstructed frame is the original frame.
		expect(encodeCanonical(partial.drainSource!.canonicalRows)).toEqual(encodeCanonical(source.canonicalRows));
		await store.close();
		store = await createBrowserDurableLiveJournalStore({ primaryDatabaseName });
		expect(await read()).toEqual(partial);
		const last = await acquire(); must(await last.drainBatch()); await last.release();
		const complete = await read();
		expect(complete.control?.drain).toMatchObject({ cursor: 17, batches: 2 });
		expect(complete.drainSource).toEqual(pre);
		await store.close();
		store = await createBrowserDurableLiveJournalStore({ primaryDatabaseName });
		expect((await read()).drainSource).toEqual(pre);
		// The next ordinary mutation ends the drain; nothing reconstructs afterwards.
		expect(await store.appendAccepted({ scope: materials[19]!.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: 1, vertexDigest: "b".repeat(64) })).toMatchObject({ ok: true });
		const advanced = await read();
		expect(advanced.control?.drain).toBeNull(); expect(advanced.drainSource).toBeUndefined();
		expect(advanced.control?.completed).toEqual(source.control.completed);
	} finally {
		await store.close();
	}
});
