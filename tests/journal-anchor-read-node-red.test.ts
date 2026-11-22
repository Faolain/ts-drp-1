import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

import { type AnchorEvidence, expectedAnchorOutcomes } from "./fixtures/journal-anchor-read/assertions.js";
import { ANCHOR_CASES, type AnchorCase, anchorMaterial } from "./fixtures/journal-anchor-read/material.js";
import { decodeCanonical, hashDomain } from "../packages/canonical/dist/src/index.js";

const execute = promisify(execFile);
let directory: string;
let bundle: string;
beforeAll(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-anchor-node-"));
	bundle = path.join(directory, "child.mjs");
	const built = await build({
		bundle: true,
		entryPoints: [path.resolve("tests/fixtures/journal-anchor-read/node-child.ts")],
		format: "esm",
		metafile: true,
		outfile: bundle,
		platform: "node",
		target: "node22",
	});
	console.log(
		JSON.stringify({
			runtimeBinding: "journal-anchor-node",
			bundleSha256: createHash("sha256").update(fs.readFileSync(bundle)).digest("hex"),
			inputs: Object.keys(built.metafile?.inputs ?? {}).map((file) => ({
				file,
				sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
			})),
		})
	);
});
afterAll(() => fs.rmSync(directory, { force: true, recursive: true }));

async function child(mode: string, filename: string, id: AnchorCase): Promise<Record<string, unknown>> {
	const result = await execute(process.execPath, [bundle, mode, filename, id], {
		timeout: 90_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

for (const id of ["genesis", "non-genesis"] as const)
	it(`control: genuine installed ${id} bytes survive setup process close; native8193 guard nulls BLOB`, async () => {
		const filename = path.join(directory, `control-${id}.sqlite`);
		const setup = await child("setup", filename, id);
		const value = await child("control", filename, id);
		expect(setup.installed).toMatchObject({ ok: true, scope: setup.expectedScope });
		expect(setup.setupPid).not.toBe(value.recoveryPid);
		const census = setup.census as { scopes: { anchor: string }[]; entries: unknown[] };
		expect(census.scopes[0]?.anchor.toLowerCase()).toBe(Buffer.from(setup.expectedBytes as number[]).toString("hex"));
		expect(census.entries).toEqual([]);
		expect(value.gated).toEqual({ boundedAnchor: null, nativeLength: 8193, nativeType: "blob" });
		expect(value.digestSpellingControl).toEqual({ characters: 64, bytes: 128 });
		console.log(JSON.stringify({ id: "native-guard-control", setup, value }));
	});

for (const id of ANCHOR_CASES)
	it(`fresh SQLite exact anchor: ${id}`, async () => {
		const filename = path.join(directory, `${id}.sqlite`);
		const setup = await child("setup", filename, id);
		const value = (await child("recover", filename, id)) as unknown as AnchorEvidence & { recoveryPid: number };
		console.log(JSON.stringify({ id, setup, value }));
		expect(setup.installed).toMatchObject({ ok: true, scope: setup.expectedScope });
		expect(setup.setupPid).not.toBe(value.recoveryPid);
		if (id === "scope") {
			const row = (
				value.before as { scopes: { anchor: string; anchor_digest: string; object_id: string; epoch: number }[] }
			).scopes[0];
			if (row === undefined) throw new Error("missing exact raw scope precondition");
			const actualBytes = Uint8Array.from(Buffer.from(row.anchor, "hex"));
			const decoded = decodeCanonical(actualBytes) as { objectId: string; epoch: number };
			const digest = Buffer.from(hashDomain("ts-drp/epoch-anchor/v3", actualBytes)).toString("hex");
			expect(actualBytes).toEqual(anchorMaterial(1).bytes);
			expect(decoded).toMatchObject({ objectId: row.object_id, epoch: 1 });
			expect(row.epoch).toBe(0);
			expect(row.anchor_digest).toBe(digest);
			expect((value as unknown as { requestedInput: unknown }).requestedInput).toEqual({
				maxBytes: 8192,
				scope: { objectId: row.object_id, epoch: row.epoch, anchorDigest: row.anchor_digest },
			});
			expect(value.expectedScope).toEqual({ objectId: row.object_id, epoch: 0, anchorDigest: digest });
		}
		// A missing API intentionally stops here; no deeper runtime guard claim follows.
		expect(value.results).toEqual(expectedAnchorOutcomes(value, id));
		if (id !== "replace-delete" && id !== "poison-close") expect(value.after).toEqual(value.before);
		expect(value.getterReads).toBe(0);
		if (id === "invalid-input" || id === "close" || id === "capture-close") expect(value.traces).toEqual([]);
		else if (id !== "capture" && id !== "poison-close" && id !== "executing-close" && id !== "independent-session") {
			const sql = value.traces.map((entry) => String(entry.sql ?? "")).join("\n");
			expect(sql).toMatch(/\bBEGIN\b/iu);
			expect(sql).not.toMatch(
				/BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)|\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|accepted_entries|detached_anchor_signature|exact_parameters_carrier)\b/iu
			);
			expect(sql).toMatch(/object_id\s*=\s*\?.*epoch\s*=\s*\?.*anchor_digest\s*=\s*\?/isu);
			if (id === "oversize") {
				expect(sql).toMatch(/typeof\s*\(\s*exact_anchor_preimage\s*\)/iu);
				expect(sql).toMatch(/length\s*\(\s*exact_anchor_preimage\s*\)/iu);
				expect(JSON.stringify(value.traces)).not.toContain('"nativeBytes":8193');
			}
		}
	}, 90_000);

it("SQLite journal exact retries preserve native retirement control while real writes and fences remain", async () => {
	// Original current emitted owner, not archived/candidate adapter code.
	const { createNodeDurableLiveJournalStore } = await import("../packages/storage-node/dist/src/live-journal.js");
	const { encodeCanonical } = await import("../packages/canonical/dist/src/index.js");
	const owner = createNodeDurableLiveJournalStore({ primaryFilename: path.join(directory, "retirement-noops") });
	const materials = [0, 1, 2, 3, 4].map((epoch) => anchorMaterial(epoch));
	const material = (epoch: number): ReturnType<typeof anchorMaterial> => {
		const selected = materials[epoch];
		if (selected === undefined) throw new Error("missing original journal material");
		return selected;
	};
	const objectId = material(0).scope.objectId;
	const row = (epoch: number, sequence: number) => ({
		scope: material(epoch).scope,
		sourceKind: "local-issued" as const,
		author: "c".repeat(64),
		authorSequence: sequence,
		vertexDigest: sequence.toString(16).padStart(64, "0"),
	});
	const read = owner.readRetirementImage,
		acquire = owner.acquireRetirementControl;
	if (read === undefined || acquire === undefined) {
		await owner.close();
		throw new Error("original native journal retirement port missing");
	}
	const successful = <T extends { readonly ok: boolean }>(result: T): T => {
		if (!result.ok) throw new Error("original native journal operation failed: " + JSON.stringify(result));
		return result;
	};
	const snapshot = async () => {
		const result = await read.call(owner, { objectId });
		if (!result.ok) throw new Error("original native journal image capture failed: " + result.kind);
		return result.value;
	};
	const capture = async () => {
		const result = await acquire.call(owner, { objectId });
		if (!result.ok) throw new Error("original native journal control capture failed: " + result.kind);
		return result.value;
	};
	const exact = (actual: unknown, expected: unknown, label: string): void => {
		const a = encodeCanonical(actual),
			b = encodeCanonical(expected);
		if (a.length !== b.length || !a.every((byte, i) => byte === b[i]))
			throw new Error("journal no-op oracle: " + label);
	};
	const transitions: unknown[] = [],
		noops: string[] = [],
		refusals: string[] = [];
	const images: Record<string, unknown> = {};
	let primary: { name: string; message: string } | undefined;
	let cleanup: PromiseSettledResult<void>[] = [];
	try {
		successful(await owner.installGenesis(material(0).install));
		successful(await owner.installEpochAnchor(material(1).install));
		successful(await owner.appendAccepted(row(0, 0)));
		const birth = await capture();
		try {
			if (birth.control.revision !== 0 || birth.control.sequence !== 0)
				throw new Error("journal fixture must start with actual present idle control0");
		} finally {
			await birth.release();
		}
		const initial = await snapshot();
		if (initial.control === null) throw new Error("journal fixture must have actual native control");
		images.initial = initial;
		const retries = [
			["genesis", () => owner.installGenesis(material(0).install)],
			["epoch-anchor", () => owner.installEpochAnchor(material(1).install)],
			["historical-import", () => owner.importHistoricalAnchor({ envelope: material(1).install, maxBytes: 8192 })],
			["append", () => owner.appendAccepted(row(0, 0))],
		] as const;
		for (const [label, retry] of retries) {
			const result = await retry();
			if (!result.ok || !result.idempotent) throw new Error("journal retry was not exact idempotent: " + label);
			exact(await snapshot(), initial, label + " preserves complete control, native frames and image");
			noops.push(label);
		}
		const real = async (
			label: string,
			mutate: () => Promise<{ readonly ok: boolean }>,
			scopes: number,
			rows: number
		): Promise<void> => {
			const before = await snapshot();
			successful(await mutate());
			const after = await snapshot();
			if (before.control === null || after.control === null) throw new Error("journal control unexpectedly absent");
			if (after.control.revision !== before.control.revision + 1)
				throw new Error("journal real write must advance exactly once: " + label);
			exact({ ...after.control, revision: before.control.revision }, before.control, label + " changes only revision");
			if (after.image.scopeCount !== scopes || after.image.rowCount !== rows)
				throw new Error("journal real write did not produce exact native row counts: " + label);
			transitions.push({ label, before: before.control.revision, after: after.control.revision, scopes, rows });
		};
		await real("append-new", () => owner.appendAccepted(row(0, 1)), 2, 2);
		await real("install-new", () => owner.installEpochAnchor(material(2).install), 3, 2);
		await real(
			"import-new",
			() => owner.importHistoricalAnchor({ envelope: material(3).install, maxBytes: 8192 }),
			4,
			2
		);
		await real("append-protected", () => owner.appendAccepted(row(2, 2)), 4, 3);
		images.beforeFence = await snapshot();
		const fence = await capture();
		try {
			successful(
				await fence.prepareFence({
					decisionDigest: "a".repeat(64),
					sourceProofDigest: "b".repeat(64),
					throughEpoch: 3,
					protectedScopes: [material(2).scope],
				})
			);
		} finally {
			await fence.release();
		}
		const prepared = await snapshot();
		images.prepared = prepared;
		for (const [label, retry] of retries) {
			exact(await retry(), { ok: false, kind: "retirement-fenced" }, label + " keeps original admission fence");
			exact(await snapshot(), prepared, label + " fenced retry preserves whole native state");
			refusals.push(label);
		}
		await real("future-install", () => owner.installEpochAnchor(material(4).install), 5, 3);
		images.final = await snapshot();
	} catch (error) {
		primary =
			error instanceof Error
				? { name: error.name, message: error.message }
				: { name: "unknown", message: String(error) };
	} finally {
		cleanup = await Promise.allSettled([owner.close()]);
	}

	console.log(
		JSON.stringify({
			journalNativeExactNoops: {
				primary,
				noops,
				transitions,
				refusals,
				images,
				cleanup,
				cryptoAuthority: false,
				physicalDeletion: false,
			},
		})
	);
	expect(primary).toBeUndefined();
	expect(cleanup.every((entry) => entry.status === "fulfilled")).toBe(true);
	expect(noops).toEqual(["genesis", "epoch-anchor", "historical-import", "append"]);
	expect(refusals).toEqual(noops);
	expect(transitions).toEqual([
		{ label: "append-new", before: 0, after: 1, scopes: 2, rows: 2 },
		{ label: "install-new", before: 1, after: 2, scopes: 3, rows: 2 },
		{ label: "import-new", before: 2, after: 3, scopes: 4, rows: 2 },
		{ label: "append-protected", before: 3, after: 4, scopes: 4, rows: 3 },
		{ label: "future-install", before: 5, after: 6, scopes: 5, rows: 3 },
	]);
});
