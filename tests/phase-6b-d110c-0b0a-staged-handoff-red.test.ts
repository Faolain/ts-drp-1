import "fake-indexeddb/auto";

import type { PresentHead } from "@ts-drp/storage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	openGenuineCreatorAdoptionFixture,
	REPOSITORY_ROOT,
} from "./fixtures/phase-6a-v3/creator-adoption-contract.js";

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

describe("D.110c-0b0a staged adoption and pending recovery causal RED", () => {
	it("requires a durable-complete/no-head-swap stage and a non-activating recovery owner", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const objectId = fixture.evidence.proposed.head.objectId;
			const before = await fixture.evidence.aheBackend.readHead(objectId);
			expect(before.ok).toBe(true);
			if (!before.ok || before.value.kind !== "present") {
				throw new TypeError("D.110c-0b0a genuine predecessor head is unavailable");
			}

			const verified = await fixture.modules.verifyCreatorSuccessorAdoption({
				catalog: fixture.catalog,
				handle: fixture.handle,
			});
			expect(verified.ok).toBe(true);
			if (verified.ok !== true) throw new TypeError(`D.110c-0b0a verification failed: ${String(verified.kind)}`);

			fixture.controls.aheOperationCounts.clear();
			const committed = await fixture.modules.commitCreatorSuccessorAdoption({
				handle: fixture.handle,
				intent: verified.intent,
			});
			expect(committed).toMatchObject({ ok: true, recovery: "active-new" });
			const after = await fixture.evidence.aheBackend.readHead(objectId);
			expect(after.ok).toBe(true);
			if (!after.ok || after.value.kind !== "present") {
				throw new TypeError("D.110c-0b0a committed successor head is unavailable");
			}
			expect(sameHead(before.value, after.value)).toBe(false);
			expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);

			const packageJson = JSON.parse(
				readFileSync(resolve(REPOSITORY_ROOT, "packages/node/package.json"), "utf8")
			) as Readonly<{ readonly exports?: Readonly<Record<string, unknown>> }>;
			expect(packageJson.exports?.["./creator-adoption-stage"]).toBeUndefined();
			expect(packageJson.exports?.["./creator-adoption-recover"]).toBeUndefined();

			throw new TypeError("D110C_0B0A_STAGED_HANDOFF_SEAM_MISSING");
		} finally {
			await fixture.close();
		}
	});
});
