import "fake-indexeddb/auto";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openGenuineCreatorAdoptionFixture } from "../../../tests/fixtures/phase-6a-v3/creator-adoption-contract.js";
import {
	createD108d1PackedDurableMaterial,
	D108D1_CHILD_BEHAVIORS,
	runD108d1ActivationChild,
} from "../../../tests/fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import { D108D1A_COLD_BEHAVIOR } from "../../../tests/fixtures/phase-6a-v3/creator-successor-handle-identity-contract.js";
import {
	d108e1ExpectedSnapshotReads,
	isD108e1DirectSnapshotTelemetry,
} from "../../../tests/fixtures/phase-6a-v3/creator-successor-infrastructure-contract.js";

const childPath = new URL("./fixtures/phase-6a-creator-successor-activation-child.mjs", import.meta.url);
const directories: string[] = [];

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

afterAll(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

async function durableMaterial(directory: string): Promise<unknown> {
	const fixture = await openGenuineCreatorAdoptionFixture();
	try {
		return await createD108d1PackedDurableMaterial(fixture, directory);
	} finally {
		await fixture.close();
	}
}

describe("D.108d1 fresh-process successor activation RED", () => {
	it("pins both child behaviors to the genuine built-package launcher", () => {
		expect(D108D1_CHILD_BEHAVIORS).toEqual([
			"fresh Node imports the built non-root successor activation subpath",
			"cold reopen reconstructs active-new custody with no adoption CAS or displaced-row publication",
		]);
		expect(childPath.pathname.endsWith("phase-6a-creator-successor-activation-child.mjs")).toBe(true);
	});

	it("fresh Node imports the built non-root successor activation subpath", async () => {
		const result = await runD108d1ActivationChild("probe", {});
		expect(result.proof).toEqual({
			exports: ["activateCreatorSuccessorAdoption", "reopenCreatorSuccessorAdoption"],
			package: "@ts-drp/node/creator-adoption-activate",
		});
	});

	it("cold reopen reconstructs active-new custody with no adoption CAS or displaced-row publication", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1-cold-"));
		directories.push(directory);
		const material = await durableMaterial(directory);
		const expectedReads = d108e1ExpectedSnapshotReads(material);
		const result = await runD108d1ActivationChild("cold", material);
		expect(result.proof).toMatchObject({
			activation: { epoch: 1, lifecycle: "active", ok: true, recovery: "active-new" },
			adoptionSwapCount: 0,
			oldOutbox: { classified: "displaced", publishedAsEpochOne: false },
			pid: expect.any(Number),
			snapshotImportedBeforeActivation: true,
		});
		expect(isD108e1DirectSnapshotTelemetry(result.proof?.snapshotReadTelemetry, expectedReads)).toBe(true);
		expect(result.proof?.pid).not.toBe(process.pid);
	});

	it("kills declaration-loop telemetry even when it copies the direct-read labels", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108e1-mutant-"));
		directories.push(directory);
		const material = await durableMaterial(directory);
		const result = await runD108d1ActivationChild("declaration-loop-mutant" as never, material);
		expect(result.proof).toMatchObject({ telemetryMutant: "declaration-loop" });
		expect(
			isD108e1DirectSnapshotTelemetry(result.proof?.snapshotReadTelemetry, d108e1ExpectedSnapshotReads(material))
		).toBe(false);
	});

	it(D108D1A_COLD_BEHAVIOR, async () => {
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1a-cold-"));
		directories.push(directory);
		const material = await durableMaterial(directory);
		if (material === null || typeof material !== "object" || Array.isArray(material)) {
			throw new TypeError("D.108d1a packed material is invalid");
		}
		const result = await runD108d1ActivationChild("cold", {
			...material,
			d108d1aIdentity: true,
		});
		expect(result.proof).toMatchObject({
			adoptionSwapCount: 0,
			identityReopens: {
				first: "published",
				second: "published",
				sentCount: expect.any(Number),
				targetPeerId: expect.stringMatching(/^d108d1a-cold-target-/u),
			},
			pid: expect.any(Number),
		});
		const identity = result.proof?.identityReopens as Readonly<{ readonly sentCount?: unknown }> | undefined;
		expect(Number(identity?.sentCount)).toBe(2);
		expect(result.proof?.pid).not.toBe(process.pid);
	});
});
