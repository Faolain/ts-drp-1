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
	D108D1B_ORACLE_CHILD_BEHAVIORS,
	D108D1B_ORACLE_GREEN_PATHS,
	D108D1B_ORACLE_RED_PATHS,
	D108D1B_RED_PATHS,
	D108D1B_REOPEN_INPUT_KEYS,
	d108d1bChatAuthorities,
	d108d1bOracleReadiness,
	d108d1bReadiness,
	openD108d1bMultiWriterFixture,
} from "./fixtures/phase-6a-v3/creator-successor-local-author-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});

	it("freezes the exact six-RED/one-GREEN oracle corrective ownership", () => {
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
		expect(D108D1B_ORACLE_CHILD_BEHAVIORS).toHaveLength(1);
		expect(D108D1B_ORACLE_BROWSER_BEHAVIORS).toHaveLength(1);
		const browser = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts"),
			"utf8"
		);
		for (const behavior of D108D1B_ORACLE_BROWSER_BEHAVIORS) expect(browser).toContain(behavior);
	});
});

describe("D.108d1b authenticated peer-local cold issuance RED", () => {
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

	it("pins the complete zero-skip GREEN child inventory to the one readiness fact", () => {
		expect(D108D1B_CHILD_BEHAVIORS).toHaveLength(1);
		const childSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts"),
			"utf8"
		);
		for (const name of D108D1B_CHILD_BEHAVIORS) expect(childSource).toContain(name);
		expect((childSource.match(/it\.skipIf\(!readiness\.ready\)/gu) ?? []).length).toBe(D108D1B_CHILD_BEHAVIORS.length);
	});

	it("[RED readiness] requires authenticated local-author selection", () => {
		expect(d108d1bReadiness()).toEqual({ missing: [], ready: true });
	});

	it("[RED oracle readiness] requires canonical ACL, strict lineage and bounded diagnostic ownership", () => {
		expect(d108d1bOracleReadiness()).toEqual({ missing: [], ready: true });
	});
});
