import "fake-indexeddb/auto";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createD108d1PackedDurableMaterial } from "../../../tests/fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D1B_CHILD_BEHAVIORS,
	d108d1bChatAuthorities,
	d108d1bReadiness,
	openD108d1bMultiWriterFixture,
	runD108d1bLocalAuthorChild,
} from "../../../tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.js";

const childPath = new URL("./fixtures/phase-6a-creator-successor-local-author-child.mjs", import.meta.url);
const readiness = d108d1bReadiness();
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
	const fixture = await openD108d1bMultiWriterFixture();
	try {
		return await createD108d1PackedDurableMaterial(fixture, directory);
	} finally {
		await fixture.close();
	}
}

describe("D.108d1b authenticated peer-local fresh-process issuance RED", () => {
	it("pins the complete child inventory to the genuine built-package launcher", () => {
		expect(D108D1B_CHILD_BEHAVIORS).toEqual([
			"fresh Node binds established and fresh chat peers while every ambiguous or unauthenticated cold reopen fails before live effects",
		]);
		expect(childPath.pathname.endsWith("phase-6a-creator-successor-local-author-child.mjs")).toBe(true);
	});

	it.skipIf(!readiness.ready)(D108D1B_CHILD_BEHAVIORS[0], async () => {
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1b-local-author-"));
		directories.push(directory);
		const result = await runD108d1bLocalAuthorChild(await durableMaterial(directory));
		const proof = result.proof as
			| Readonly<{
					readonly authors?: Readonly<Record<string, string>>;
					readonly pid?: number;
					readonly results?: readonly Readonly<Record<string, unknown>>[];
			  }>
			| undefined;
		expect(proof?.pid).toEqual(expect.any(Number));
		expect(proof?.pid).not.toBe(process.pid);
		const results = proof?.results ?? [];
		expect(results.map(({ name }) => name)).toEqual([
			"established-bob",
			"fresh-carol",
			"copied-creator-lineage",
			"wrong-author-right-signer",
			"right-author-wrong-signer",
			"two-nonzero-lineages",
			"anchor-replay",
			"signer-mutation",
			"signature-alias",
			"signer-throw",
			"signer-reject",
			"non-writer",
		]);
		const [established, fresh, ...rejected] = results;
		expect(established).toMatchObject({
			issued: {
				acceptedJournalAuthor: proof?.authors?.bob,
				author: proof?.authors?.bob,
				authorSequence: 1,
				issuedRowAuthor: proof?.authors?.bob,
				outboxRowAuthor: proof?.authors?.bob,
			},
			result: { lifecycle: "active", ok: true, recovery: "active-new" },
		});
		expect(fresh).toMatchObject({
			issued: {
				acceptedJournalAuthor: proof?.authors?.carol,
				author: proof?.authors?.carol,
				authorSequence: 0,
				issuedRowAuthor: proof?.authors?.carol,
				outboxRowAuthor: proof?.authors?.carol,
			},
			result: { lifecycle: "active", ok: true, recovery: "active-new" },
		});
		const writerAuthors = d108d1bChatAuthorities()
			.filter(({ groups }) => groups.includes("writer"))
			.map(({ author }) => author)
			.sort();
		for (const accepted of [established, fresh]) {
			const effects = accepted?.effects as Readonly<{ readonly lineageReads?: readonly string[] }> | undefined;
			expect([...(effects?.lineageReads ?? [])].sort()).toEqual(writerAuthors);
			const signerCalls = accepted?.signerCalls as readonly Readonly<{ bytes: string; ordinary: boolean }>[];
			expect(signerCalls).toHaveLength(2);
			expect(signerCalls.every(({ bytes, ordinary }) => ordinary && bytes.length === 64)).toBe(true);
		}
		const establishedCalls = established?.signerCalls as readonly Readonly<{ bytes: string }>[];
		const freshCalls = fresh?.signerCalls as readonly Readonly<{ bytes: string }>[];
		expect(establishedCalls[0]?.bytes).not.toBe(freshCalls[0]?.bytes);
		for (const failure of rejected) {
			expect(failure).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					installEpochAnchorCount: 0,
					publicationCount: 0,
					subscribeCount: 0,
					transactIssueCount: 0,
				},
				result: { kind: "chain-invalid", ok: false },
			});
		}
		for (const name of [
			"wrong-author-right-signer",
			"right-author-wrong-signer",
			"anchor-replay",
			"signer-mutation",
			"signature-alias",
			"signer-throw",
			"signer-reject",
			"non-writer",
		]) {
			const failure = rejected.find((candidate) => candidate.name === name);
			const effects = failure?.effects as Readonly<{ readonly lineageReads?: readonly string[] }> | undefined;
			expect(effects?.lineageReads).toEqual([]);
		}
	});
});
