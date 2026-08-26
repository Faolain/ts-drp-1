import "fake-indexeddb/auto";

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openGenuineCreatorAdoptionFixture } from "../../../tests/fixtures/phase-6a-v3/creator-adoption-contract.js";
import {
	createD108d1PackedDurableMaterial,
	D108D1_CHILD_BEHAVIORS,
	d108d1Readiness,
} from "../../../tests/fixtures/phase-6a-v3/creator-successor-activation-contract.js";

const childPath = new URL("./fixtures/phase-6a-creator-successor-activation-child.mjs", import.meta.url);
const readiness = d108d1Readiness();
const directories: string[] = [];

interface ChildMessage {
	readonly kind: string;
	readonly message?: string;
	readonly proof?: Readonly<Record<string, unknown>>;
}

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

function runChild(mode: "cold" | "probe", input: unknown): Promise<ChildMessage> {
	return new Promise((resolvePromise, reject) => {
		const encoded = Buffer.from(JSON.stringify(input)).toString("base64url");
		const child = spawn(process.execPath, [childPath.pathname, mode, encoded], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let observed: ChildMessage | undefined;
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`D.108d1 child timeout: ${stderr}`));
		}, 60_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => (observed = message));
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0 || observed === undefined || observed.kind === "child-error") {
				reject(new Error(observed?.message ?? `D.108d1 child failed (${String(code)}): ${stderr}`));
			} else resolvePromise(observed);
		});
	});
}

describe("D.108d1 fresh-process successor activation RED", () => {
	it("pins both child behaviors to the genuine built-package launcher", () => {
		expect(D108D1_CHILD_BEHAVIORS).toEqual([
			"fresh Node imports the built non-root successor activation subpath",
			"cold reopen reconstructs active-new custody with no adoption CAS or displaced-row publication",
		]);
		expect(childPath.pathname.endsWith("phase-6a-creator-successor-activation-child.mjs")).toBe(true);
	});

	it.skipIf(!readiness.ready)("fresh Node imports the built non-root successor activation subpath", async () => {
		const result = await runChild("probe", {});
		expect(result.proof).toEqual({
			exports: ["activateCreatorSuccessorAdoption", "reopenCreatorSuccessorAdoption"],
			package: "@ts-drp/node/creator-adoption-activate",
		});
	});

	it.skipIf(!readiness.ready)(
		"cold reopen reconstructs active-new custody with no adoption CAS or displaced-row publication",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1-cold-"));
			directories.push(directory);
			const result = await runChild("cold", await durableMaterial(directory));
			expect(result.proof).toMatchObject({
				activation: { epoch: 1, lifecycle: "active", ok: true, recovery: "active-new" },
				adoptionSwapCount: 0,
				freshProcess: true,
				oldOutbox: { classified: "displaced", publishedAsEpochOne: false },
				snapshotImportedBeforeActivation: true,
			});
		}
	);
});
