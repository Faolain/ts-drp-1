import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D2_AUTHORITY_KEYS,
	D108D2_BROWSER_BEHAVIORS,
	D108D2_GREEN_PATHS,
	D108D2_RED_PATHS,
	d108d2Readiness,
	d108d2SourceGovernance,
	isD108d2Authority,
} from "./fixtures/phase-6a-v3/creator-successor-product-contract.js";

const readiness = d108d2Readiness();

describe("D.108d2 creator successor room/chat product RED", () => {
	it("freezes exactly eleven RED owners, two GREEN owners and three browser behaviors", () => {
		expect(D108D2_RED_PATHS).toHaveLength(11);
		expect(new Set(D108D2_RED_PATHS).size).toBe(11);
		expect(D108D2_GREEN_PATHS).toEqual(["examples/v3-room/src/index.ts", "examples/v3-chat/src/index.ts"]);
		expect(D108D2_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108D2_BROWSER_BEHAVIORS).toHaveLength(3);
		const browser = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts"),
			"utf8"
		);
		const entry = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts"),
			"utf8"
		);
		expect(browser.match(/test\.skip\(!PRODUCT_READY,/gu)).toHaveLength(3);
		expect(browser.match(/test\.skip\(/gu)).toHaveLength(3);
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
			exactTwoGreenOwners: true,
			noForbiddenProductReturn: true,
			noNodeRootWidening: true,
			roomInputAllowsOnlyDeclarationWhenProductExists: true,
			roomIsSoleConsumerWhenProductExists: true,
		});
	});

	it("[RED readiness] requires the exact room/chat successor product contract", () => {
		expect(readiness, `missing D.108d2 product facts: ${readiness.missing.join(", ")}`).toEqual({
			missing: [],
			ready: true,
		});
	});

	it.skipIf(!readiness.ready)("uses the single composite readiness fact for product behavior", () => {
		expect(d108d2Readiness()).toEqual({ missing: [], ready: true });
		expect(D108D2_BROWSER_BEHAVIORS).toHaveLength(3);
	});
});
