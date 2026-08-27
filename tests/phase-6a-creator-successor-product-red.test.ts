import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D2_AUTHORITY_KEYS,
	D108D2_BROWSER_BEHAVIORS,
	d108d2SourceGovernance,
	D108E2B_BROWSER_BEHAVIORS,
	D108E2B_GREEN_PATHS,
	D108E2B_RED_PATHS,
	isD108d2Authority,
} from "./fixtures/phase-6a-v3/creator-successor-product-contract.js";
import { createV3RoomSession } from "../examples/v3-room/src/index.js";

describe("D.108e2b creator successor room lifetime RED", () => {
	it("freezes exactly five RED owners, one GREEN owner and seven browser behaviors", () => {
		expect(D108E2B_RED_PATHS).toHaveLength(5);
		expect(new Set(D108E2B_RED_PATHS).size).toBe(5);
		expect(D108E2B_GREEN_PATHS).toEqual(["examples/v3-room/src/index.ts"]);
		expect(D108E2B_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108D2_BROWSER_BEHAVIORS).toHaveLength(3);
		expect(D108E2B_BROWSER_BEHAVIORS).toHaveLength(4);
		const browser = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts"),
			"utf8"
		);
		const entry = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts"),
			"utf8"
		);
		expect(browser).not.toContain("PRODUCT_READY");
		expect(browser).not.toContain("test.skip(");
		expect(
			[
				'"@ts-drp/node/creator-adoption"',
				'"@ts-drp/node/creator-adoption-activate"',
				'"@ts-drp/node/creator-adoption-commit"',
			].every((alias) => browser.includes(alias))
		).toBe(true);
		expect(entry).toContain("openExistingDatabase(`${databaseName}--ahe`)");
		expect(entry).toContain("dumpDatabase(`${databaseName}--ahe`)");
	});

	it("pins the exact seven-key successor authority and rejects pre-successor or widened values", () => {
		const authority = Object.freeze({
			aclDigest: "a".repeat(64),
			anchorDigest: "b".repeat(64),
			epoch: 1,
			genesisAnchorDigest: "c".repeat(64),
			lifecycle: "active",
			objectId: "d108d2-object",
			profileId: "creator-trusted-v1",
		});
		expect(D108D2_AUTHORITY_KEYS).toEqual([
			"aclDigest",
			"anchorDigest",
			"epoch",
			"genesisAnchorDigest",
			"lifecycle",
			"objectId",
			"profileId",
		]);
		expect(isD108d2Authority(authority)).toBe(true);
		expect(isD108d2Authority({ ...authority, epoch: 0 })).toBe(false);
		expect(isD108d2Authority({ ...authority, capability: {} })).toBe(false);
		expect(isD108d2Authority(null)).toBe(false);
	});

	it("keeps node-root and chat authority closed while assigning the room as sole node consumer", () => {
		expect(d108d2SourceGovernance()).toEqual({
			chatHasNoDirectNodeAdoptionConsumer: true,
			chatInputAllowsOnlyDeclarationWhenProductExists: true,
			exactOneGreenOwner: true,
			noForbiddenProductReturn: true,
			noNodeRootWidening: true,
			roomInputAllowsOnlyDeclarationWhenProductExists: true,
			roomIsSoleConsumerWhenProductExists: true,
		});
	});

	it("runs all product behaviors without a source-pattern readiness gate", () => {
		expect(D108D2_BROWSER_BEHAVIORS).toHaveLength(3);
		expect(D108E2B_BROWSER_BEHAVIORS).toHaveLength(4);
	});

	it("rejects every unsupported cold successor composition before reading application authority", async () => {
		const observations = [];
		for (const [key, value] of [
			["createOperationAdmissionPolicy", (): Readonly<Record<string, never>> => Object.freeze({})],
			["creatorFinalitySigner", Object.freeze({ sign: () => Promise.resolve(new Uint8Array(64)) })],
			["rebaseSourceInvite", "d108e2b-source-invite"],
		] as const) {
			let applicationReads = 0;
			const input = {
				[key]: value,
				get application(): never {
					applicationReads += 1;
					throw new TypeError("D.108e2b application authority was read");
				},
				successorSnapshotDeclaration: Object.freeze({}),
			};
			let detail = "fulfilled";
			try {
				await createV3RoomSession(input as never);
			} catch (error) {
				detail = error instanceof Error ? error.message : String(error);
			}
			observations.push(Object.freeze({ applicationReads, detail, key }));
		}
		expect(observations).toEqual(
			["createOperationAdmissionPolicy", "creatorFinalitySigner", "rebaseSourceInvite"].map((key) => ({
				applicationReads: 0,
				detail: "v3 room successor authority composition is unsupported",
				key,
			}))
		);
	});
});
