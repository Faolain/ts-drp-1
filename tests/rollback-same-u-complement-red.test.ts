import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";

import type { Bootstrap } from "./fixtures/rollback-data-observation/types.js";

const execute = promisify(execFile),
	artifacts = process.env.SAME_U_ARTIFACTS,
	evidence = process.env.SAME_U_EVIDENCE;
if (!artifacts || !evidence) throw new Error("FROZEN_ARTIFACTS_AND_RAW_EVIDENCE_REQUIRED");
const bundles = artifacts,
	raw = evidence;
mkdirSync(raw, { recursive: true });
let bootstrap: Bootstrap;
async function child(name: string, args: string[]): Promise<Record<string, unknown>> {
	const result = await execute(process.execPath, [join(bundles, name + ".mjs"), ...args], {
		timeout: 90_000,
		maxBuffer: 5 * 1024 * 1024,
	});
	return JSON.parse(result.stdout) as Record<string, unknown>;
}
beforeAll(async () => {
	const setup = await child("setup", [
		"setup",
		join(raw, "original-signed-source"),
		JSON.stringify({ epoch: 3, settlement: false, legacy: true }),
	]);
	writeFileSync(join(raw, "source-precondition.json"), JSON.stringify(setup, null, 2), { flag: "wx" });
	bootstrap = (setup.report as { bootstrap: Bootstrap }).bootstrap;
	expect(setup.integrity).toMatchObject({ integrityFixtureOnly: true, notShippedCustody: true, oldEpoch: 1 });
	expect(setup.precondition).toMatchObject({
		transition: { ok: true },
		rows: 3,
		targets: [
			{ epoch: 2, state: 66 },
			{ epoch: 1, state: 33, representation: "retirement-only" },
		],
	});
});
it("one genuine original signed first-k1 source is provisioned; synthetic pressure is not published AHE", () => {
	expect(bootstrap.profileId).toBe("creator-trusted-v1");
	expect(bootstrap.identity).toContain("original-signed-source");
});
it("production owner unit: generic initial union, actual anchor billing, equality-only dedup and fixed U", async () => {
	const value = await child("composition", [JSON.stringify(bootstrap), "owner-unit"]);
	writeFileSync(join(raw, "owner-unit.json"), JSON.stringify(value, null, 2), { flag: "wx" });
	expect(value.classification, "WIRING_RED is not reached production accounting").toBe("REACHED_OWNER_UNIT");
	expect(value.finalChargedBytes).toBe(262144);
});
for (const mode of ["below", "equal", "above", "cap", "equal-bytes", "unequal-same-length"] as const) {
	it("actual observer SAME_U unit composition: " + mode, async () => {
		const value = await child("composition", [JSON.stringify(bootstrap), mode]);
		writeFileSync(join(raw, mode + ".json"), JSON.stringify(value, null, 2), { flag: "wx" });
		expect(value.classification, "Missing product API remains explicit wiring RED").toBe(
			"REACHED_OBSERVER_UNIT_COMPOSITION"
		);
		const pre = value.precondition as { scope: unknown; anchorByteLength: number; anchorWholeBytes: string },
			remainder =
				mode === "below"
					? pre.anchorByteLength - 1
					: mode === "equal"
						? pre.anchorByteLength
						: mode === "above"
							? pre.anchorByteLength + 1
							: 8193,
			dispatches = value.dispatches as { input: { scope: unknown; maxBytes: number }; chargedBytes: number }[],
			native = value.nativeResults as {
				ok: boolean;
				kind: string;
				actualByteLength?: number;
				exactCanonicalAnchorPreimageBytes?: string;
			}[];
		expect(value.ownerCount, "Parallel calculator or owner reset cannot count").toBe(1);
		expect(dispatches).toEqual([
			{ input: { scope: pre.scope, maxBytes: Math.min(8192, remainder) }, chargedBytes: 262144 - remainder },
		]);
		expect(native).toHaveLength(1);
		if (mode === "below") {
			expect(native[0]).toEqual({ ok: false, kind: "read-budget-exceeded" });
			expect(value.result).toMatchObject({ ok: false, kind: "proof-budget-exceeded" });
			expect(value.summary).toBeUndefined();
			expect(value.finalChargedBytes).toBe(262144 - remainder);
		} else {
			expect(native[0]).toMatchObject({
				ok: true,
				kind: "present",
				actualByteLength: pre.anchorByteLength,
				exactCanonicalAnchorPreimageBytes: pre.anchorWholeBytes,
			});
			expect(value.result).toMatchObject({ ok: true });
			expect(value.summary, "Unit-composition whole success still needs genuine observer custody").toBeDefined();
			expect(value.finalChargedBytes, "Unbilled anchor or unequal same-length dedup cannot pass").toBe(
				262144 - remainder + (mode === "equal-bytes" ? 0 : pre.anchorByteLength)
			);
			const charges = (value.events as { event: string; bytes?: number; before?: number; after?: number }[]).filter(
				(event) => event.event === "production-charge"
			);
			expect(charges).toContainEqual({
				event: "production-charge",
				bytes: pre.anchorByteLength,
				before: 262144 - remainder,
				after: value.finalChargedBytes,
				accepted: true,
			});
		}
	});
}
it("non-authority accounting remains private and no caller budget input enters the observer", () => {
	const manifest = readFileSync("packages/node/package.json", "utf8"),
		root = readFileSync("packages/node/src/index.ts", "utf8");
	expect(manifest + root).not.toMatch(
		/createCreatorClosedRollbackProofAccounting|CreatorClosedRollbackProofAccounting/u
	);
});
