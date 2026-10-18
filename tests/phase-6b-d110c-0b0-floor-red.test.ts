import "fake-indexeddb/auto";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import {
	createD108d1PackedDurableMaterial,
	type D108d1ChildMessage,
	REPOSITORY_ROOT,
	runD108d1ActivationChild,
} from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";

describe("D.110c-0b0 authenticated room-head floor causal RED", () => {
	it("refuses a genuine advanced cold reopen when no independent room-head authority is supplied", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const run = async (mode: "cold" | "d110c-no-floor" | "d110c-wrong-floor"): Promise<D108d1ChildMessage> => {
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-d110c-0b0-red-"));
			const fixture = await openGenuineCreatorAdoptionFixture();
			try {
				const material = await createD108d1PackedDurableMaterial(fixture, directory);
				return await runD108d1ActivationChild(mode, material);
			} finally {
				await fixture.close();
				rmSync(directory, { force: true, recursive: true });
			}
		};
		const result = await run("d110c-no-floor");
		const proof = result.proof as
			| Readonly<{
					readonly activation?: Readonly<{ readonly ok?: unknown }>;
					readonly failure?: Readonly<{ readonly kind?: unknown; readonly ok?: unknown }>;
			  }>
			| undefined;
		if (proof?.failure?.kind !== "D110C_FLOOR_MIGRATION_REQUIRED" || proof.failure.ok !== false) {
			throw new TypeError("D110C_0B0_FRESHNESS_FLOOR_MISSING");
		}
		expect(proof.activation).toBeUndefined();
		const wrong = (await run("d110c-wrong-floor")).proof as
			| Readonly<{ readonly failure?: Readonly<{ readonly kind?: unknown; readonly ok?: unknown }> }>
			| undefined;
		expect(wrong?.failure).toMatchObject({ kind: "D110C_FLOOR_MISMATCH", ok: false });
		const correct = (await run("cold")).proof as
			| Readonly<{ readonly activation?: Readonly<{ readonly epoch?: unknown; readonly ok?: unknown }> }>
			| undefined;
		expect(correct?.activation).toMatchObject({ epoch: 1, ok: true });

		const roomSource = readFileSync(resolve(REPOSITORY_ROOT, "examples/v3-room/src/index.ts"), "utf8");
		const activationSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-activate.ts"),
			"utf8"
		);
		expect(roomSource).toContain("export interface V3RoomHeadAuthority");
		expect(roomSource).toContain("readonly roomHeadAuthority: V3RoomHeadAuthority");
		expect(activationSource).toContain('"expectedRoomHead"');
	});
});
