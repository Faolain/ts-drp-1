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
