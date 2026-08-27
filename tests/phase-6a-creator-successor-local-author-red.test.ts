import "fake-indexeddb/auto";

import { decodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D1B_CHILD_BEHAVIORS,
	D108D1B_GREEN_PATHS,
	D108D1B_ORACLE_BROWSER_BEHAVIORS,
	D108D1B_ORACLE_GREEN_PATHS,
	D108D1B_ORACLE_RED_PATHS,
	D108D1B_RED_PATHS,
	D108D1B_REOPEN_INPUT_KEYS,
	d108d1bChatAuthorities,
	D108E2C_GREEN_PATHS,
	D108E2C_RED_PATHS,
	D108E2C_TEST_PATHS,
	D108E2D_CHILD_BEHAVIORS,
	D108E2D_GREEN_PATHS,
	D108E2D_RED_PATHS,
	D108E2E_CHILD_BEHAVIORS,
	D108E2E_GREEN_PATHS,
	D108E2E_RED_PATHS,
	D108E4_ACTIVATION_BROWSER_BEHAVIORS,
	D108E4_CHILD_BEHAVIORS,
	D108E4_INFRASTRUCTURE_BEHAVIORS,
	D108E4_TEST_PATHS,
	D108E4_ZONE_BEHAVIORS,
	openD108d1bMultiWriterFixture,
} from "./fixtures/phase-6a-v3/creator-successor-local-author-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

describe("D.108d1b authenticated peer-local cold issuance RED", () => {
	it("freezes the exact six-RED/two-GREEN oracle corrective ownership", () => {
		expect(D108D1B_ORACLE_RED_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"tests/phase-6a-creator-successor-local-author-red.test.ts",
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
			"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
		]);
		expect(new Set(D108D1B_ORACLE_RED_PATHS).size).toBe(6);
		expect(D108D1B_ORACLE_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(
			true
		);
		expect(D108D1B_ORACLE_GREEN_PATHS).toEqual([
			"packages/node/src/creator-adoption.ts",
			"packages/node/src/v3-live.ts",
		]);
		expect(D108D1B_ORACLE_BROWSER_BEHAVIORS).toHaveLength(1);
		const browser = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts"),
			"utf8"
		);
		for (const behavior of D108D1B_ORACLE_BROWSER_BEHAVIORS) expect(browser).toContain(behavior);
	});

	it("freezes the exact D.108e2c six-RED/four-GREEN tests-only ownership", () => {
		expect(D108E2C_TEST_PATHS).toEqual([
			"tests/phase-3a1b-p3-live-transport-red.test.ts",
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"tests/phase-6a-creator-successor-local-author-red.test.ts",
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
			"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
		]);
		expect(new Set(D108E2C_TEST_PATHS).size).toBe(9);
		expect(D108E2C_TEST_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108E2C_RED_PATHS).toEqual([
			"tests/phase-3a1b-p3-live-transport-red.test.ts",
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"tests/phase-6a-creator-successor-local-author-red.test.ts",
			"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
		]);
		expect(D108E2C_GREEN_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
		]);
		const greenOwners = new Set<string>(D108E2C_GREEN_PATHS);
		expect(D108E2C_RED_PATHS.filter((path) => greenOwners.has(path))).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
		]);
	});

	it("freezes exact nine-RED/three-GREEN ownership and the closed cold input", () => {
		expect(D108D1B_RED_PATHS).toHaveLength(9);
		expect(new Set(D108D1B_RED_PATHS).size).toBe(9);
		expect(D108D1B_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108D1B_GREEN_PATHS).toEqual([
			"packages/node/src/creator-adoption-activate.ts",
			"packages/node/src/creator-adoption.ts",
			"packages/node/src/internal/creator-successor-live.ts",
		]);
		expect(D108D1B_REOPEN_INPUT_KEYS).toEqual([
			"authenticationProfile",
			"author",
			"catalog",
			"detachedSignature",
			"exactCanonicalAnchorPreimageBytes",
			"exactCanonicalParametersCarrierBytes",
			"issuanceStore",
			"liveJournalStore",
			"messageQueueManager",
			"networkNode",
			"onAdmittedVertex",
			"pinnedGenesisAnchorDigest",
			"signRegisteredVertexDigest",
			"snapshotDeclaration",
			"snapshotStore",
			"store",
		]);
	});

	it("freezes the exact D.108e2d four-RED/one-GREEN performance ownership", () => {
		expect(D108E2D_RED_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"tests/phase-6a-creator-successor-local-author-red.test.ts",
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
			"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
		]);
		expect(new Set(D108E2D_RED_PATHS).size).toBe(4);
		expect(D108E2D_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108E2D_GREEN_PATHS).toEqual(["packages/node/src/v3-live.ts"]);
		expect(D108E2D_CHILD_BEHAVIORS).toHaveLength(1);
		const childSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts"),
			"utf8"
		);
		for (const name of D108E2D_CHILD_BEHAVIORS) expect(childSource).toContain(name);
		expect((childSource.match(/it\(D108E2D_CHILD_BEHAVIORS\[0\]/gu) ?? []).length).toBe(1);
	});

	it("freezes the exact D.108e2e four-RED/one-GREEN skip-budget ownership", () => {
		expect(D108E2E_RED_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"tests/phase-6a-creator-successor-local-author-red.test.ts",
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
			"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
		]);
		expect(new Set(D108E2E_RED_PATHS).size).toBe(4);
		expect(D108E2E_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108E2E_GREEN_PATHS).toEqual(["packages/node/src/v3-live.ts"]);
		expect(D108E2E_CHILD_BEHAVIORS).toHaveLength(1);
		const childSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts"),
			"utf8"
		);
		for (const name of D108E2E_CHILD_BEHAVIORS) expect(childSource).toContain(name);
		expect((childSource.match(/it\(\s*D108E2E_CHILD_BEHAVIORS\[0\]/gu) ?? []).length).toBe(1);
	});

	it("freezes the exact D.108e4 thirteen-path tests-only ownership", () => {
		expect(D108E4_TEST_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
			"tests/phase-6a-creator-successor-local-author-red.test.ts",
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
			"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
			"tests/phase-3a1b-p3-live-transport-red.test.ts",
			"tests/fixtures/shared/workspace-package-export-file.mjs",
			"tests/phase-6a-creator-successor-infrastructure-red.test.ts",
			"tests/phase-3a1b-d9336-two-client-room.pw.ts",
			"tests/phase-3a1b-d9346-v3-zone.pw.ts",
			"tests/e5-00-zone-trade-intent.pw.ts",
			"tests/e5-02-zone-referee-outcome.pw.ts",
		]);
		expect(new Set(D108E4_TEST_PATHS).size).toBe(13);
		expect(D108E4_TEST_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(
			D108E4_TEST_PATHS.filter(
				(path) =>
					path.includes("/src/") ||
					path.endsWith("/package.json") ||
					path.endsWith(".config.ts") ||
					!(/(^|\/)tests\//u.test(path) || path.startsWith("tests/fixtures/"))
			)
		).toEqual([]);
		expect(D108E4_CHILD_BEHAVIORS).toEqual([
			"fresh Node closes the D.108e4 authenticated oracle and per-reopen budget debt",
		]);
		expect(D108E4_ACTIVATION_BROWSER_BEHAVIORS).toEqual([
			"window observes lock authority before durable store opening and possession probes use exact suffixed databases",
		]);
		expect(D108E4_INFRASTRUCTURE_BEHAVIORS).toEqual([
			"imports one explicit workspace package export only from its own fresh built file",
			"rejects every non-package-self workspace export-file target",
		]);
		expect(D108E4_ZONE_BEHAVIORS).toEqual([
			"waits for reciprocal raw unreliable links before one measured movement in each direction",
		]);
		const activationOwner = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts"),
			"utf8"
		);
		const infrastructureOwner = readFileSync(
			resolve(REPOSITORY_ROOT, "tests/phase-6a-creator-successor-infrastructure-red.test.ts"),
			"utf8"
		);
		expect(activationOwner).toContain(D108E4_ACTIVATION_BROWSER_BEHAVIORS[0]);
		for (const [index] of D108E4_INFRASTRUCTURE_BEHAVIORS.entries()) {
			expect(infrastructureOwner).toContain(`it(D108E4_INFRASTRUCTURE_BEHAVIORS[${index}]`);
		}
	});

	it("requires every root canonical consumer to use the D.108e4 export-file boundary", () => {
		for (const relativePath of [
			"tests/phase-3a1b-d9336-two-client-room.pw.ts",
			"tests/phase-3a1b-d9346-v3-zone.pw.ts",
			"tests/e5-00-zone-trade-intent.pw.ts",
			"tests/e5-02-zone-referee-outcome.pw.ts",
		]) {
			const text = readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
			expect.soft(text, relativePath).not.toMatch(/["']@ts-drp\/canonical(?:\/[^"']*)?["']/u);
			expect.soft(text, relativePath).toContain("workspace-package-export-file.mjs");
		}
	});

	it(D108E4_ZONE_BEHAVIORS[0], () => {
		const zone = readFileSync(resolve(REPOSITORY_ROOT, "tests/phase-3a1b-d9346-v3-zone.pw.ts"), "utf8");
		const helperStart = zone.indexOf("async function expectOneMeasuredRawMovement");
		const helperEnd = zone.indexOf("\nfunction expectWithinInstalledBudget", helperStart);
		expect(helperStart).toBeGreaterThanOrEqual(0);
		expect(helperEnd).toBeGreaterThan(helperStart);
		const helper = zone.slice(helperStart, helperEnd);
		expect(helper).toContain("expectReciprocalRawUnreliableLinks");
		expect(helper).toContain("rawTransport.sent");
		expect(helper).toContain("rawTransport.received");
		expect(helper).toContain("transientPositions");
		expect(helper).toContain("durableVertexCount");
		expect(helper).toContain("acceptedOperationDigest");
		expect(helper.match(/keyboard\.press\(/gu)).toHaveLength(1);
		expect(helper.indexOf("expectReciprocalRawUnreliableLinks")).toBeLessThan(helper.indexOf("keyboard.press("));
		expect(zone).toMatch(
			/function expectReciprocalRawUnreliableLinks[\s\S]*?ts-drp-ephemeral\/1[\s\S]*?maxRetransmits:\s*0[\s\S]*?ordered:\s*false[\s\S]*?fallbackCount[\s\S]*?toBe\(0\)/u
		);
		const movementCalls = [...zone.matchAll(/await expectOneMeasuredRawMovement\(\{/gu)];
		expect(movementCalls).toHaveLength(3);
		expect(zone.match(/keyboard\.press\(/gu)).toHaveLength(1);
		expect(zone).not.toMatch(/\.poll\(\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,400}?keyboard\.press\(/u);
		const config = readFileSync(resolve(REPOSITORY_ROOT, "playwright.phase-3a1b-d9346-zone.config.ts"), "utf8");
		expect(config).toContain("expect: { timeout: 20_000 }");
	});

	it("derives the shipped eight-member chat identities and exact writer split", () => {
		const authorities = d108d1bChatAuthorities();
		expect(authorities.map(({ id }) => id)).toEqual([
			"alice",
			"bob",
			"carol",
			"dave",
			"erin",
			"frank",
			"grace",
			"heidi",
		]);
		expect(authorities).toHaveLength(8);
		expect(new Set(authorities.map(({ author }) => author)).size).toBe(8);
		expect(authorities.filter(({ groups }) => groups.includes("writer"))).toHaveLength(7);
		expect(authorities.find(({ id }) => id === "dave")?.groups).toEqual(["finality"]);
		const shippedChat = readFileSync(resolve(REPOSITORY_ROOT, "examples/v3-chat/src/index.ts"), "utf8");
		for (const id of ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"]) {
			expect(shippedChat).toContain(`d933${id === "alice" || id === "bob" ? "6" : "9"}-v3-chat-${id}`);
		}
	});

	it("admits Bob's genuine epoch-zero vertex before the multi-writer successor close", async () => {
		const bob = d108d1bChatAuthorities().find(({ id }) => id === "bob");
		const fixture = await openD108d1bMultiWriterFixture();
		try {
			const established = fixture.evidence.establishedPeer;
			expect(established).toMatchObject({ author: bob?.author, authorSequence: 0 });
			const preimage = decodeCanonical(established?.canonicalPreimageBytes ?? new Uint8Array());
			expect(preimage).toMatchObject({
				author: bob?.author,
				authorSequence: 0,
				epoch: 0,
				objectId: fixture.evidence.proposed.head.objectId,
			});
			const digest =
				established === undefined
					? ""
					: Array.from(established.digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			expect(fixture.evidence.journalRows.some((row) => row.vertexDigest === digest)).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it("pins the complete zero-skip GREEN child inventory to direct execution", () => {
		expect(D108D1B_CHILD_BEHAVIORS).toHaveLength(1);
		const childSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts"),
			"utf8"
		);
		for (const name of D108D1B_CHILD_BEHAVIORS) expect(childSource).toContain(name);
		expect((childSource.match(/it\.skipIf\(/gu) ?? []).length).toBe(0);
		expect((childSource.match(/it\(D108D1B_CHILD_BEHAVIORS\[0\]/gu) ?? []).length).toBe(D108D1B_CHILD_BEHAVIORS.length);
	});
});
