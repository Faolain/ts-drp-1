import "fake-indexeddb/auto";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createD108d1PackedDurableMaterial } from "../../../tests/fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D1B_CHILD_BEHAVIORS,
	d108d1bChatAuthorities,
	openD108d1bMultiWriterFixture,
	runD108d1bLocalAuthorChild,
} from "../../../tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.js";

const childPath = new URL("./fixtures/phase-6a-creator-successor-local-author-child.mjs", import.meta.url);
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

	it(D108D1B_CHILD_BEHAVIORS[0], async () => {
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1b-local-author-"));
		directories.push(directory);
		const result = await runD108d1bLocalAuthorChild(await durableMaterial(directory));
		const proof = result.proof as
			| Readonly<{
					readonly authors?: Readonly<Record<string, string>>;
					readonly oracle?: Readonly<Record<string, unknown>>;
					readonly pid?: number;
					readonly results?: readonly Readonly<Record<string, unknown>>[];
			  }>
			| undefined;
		expect(proof?.pid).toEqual(expect.any(Number));
		expect(proof?.pid).not.toBe(process.pid);
		const expectedAcl = d108d1bChatAuthorities()
			.map(({ author, groups }) => ({ author, groups: [...groups] }))
			.sort((left, right) => left.author.localeCompare(right.author));
		const oracle = proof?.oracle as
			| Readonly<{
					readonly malformedMemberControl?: Readonly<Record<string, unknown>>;
					readonly aclMembers?: readonly Readonly<{ readonly author: string; readonly groups: readonly string[] }>[];
					readonly bobCarrier?: Readonly<Record<string, unknown>>;
			  }>
			| undefined;
		expect([...(oracle?.aclMembers ?? [])].sort((left, right) => left.author.localeCompare(right.author))).toEqual(
			expectedAcl
		);
		expect(oracle?.aclMembers?.filter(({ groups }) => groups.includes("writer"))).toHaveLength(7);
		expect(oracle?.aclMembers?.find(({ author }) => author === proof?.authors?.dave)?.groups).toEqual(["finality"]);
		expect(oracle?.bobCarrier).toMatchObject({
			exactlyOnce: true,
			preimageMatches: true,
			scopeMatches: true,
			signatureMatches: true,
			sourceKind: "received",
		});
		expect.soft(oracle?.malformedMemberControl).toEqual({
			canonical: true,
			digestMatches: true,
			result: { ok: false, reason: "snapshot-mismatch" },
		});
		const results = proof?.results ?? [];
		expect
			.soft(results.map(({ name }) => name))
			.toEqual([
				"established-bob",
				"fresh-carol",
				"forged-future-outbox",
				"malformed-future-outbox",
				"future-outbox-read-failure",
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
				"selected-exhausted-lineage",
				"foreign-exhausted-lineage",
				"malformed-exhausted-lineage",
				"missing-webcrypto",
				"ed25519-unavailable",
				"negative-lineage-next",
				"unsafe-lineage-next",
			]);
		const [established, fresh, forgedFuture, malformedFuture, backingFailure, ...rejected] = results;
		expect(established).toMatchObject({
			issued: {
				acceptedJournalAuthor: proof?.authors?.bob,
				author: proof?.authors?.bob,
				authorSequence: 1,
				issuedRowAuthor: proof?.authors?.bob,
				outboxRowAuthor: proof?.authors?.bob,
			},
			result: { lifecycle: "active", ok: true, recovery: "active-new" },
			repeat: {
				issued: {
					acceptedJournalAuthor: proof?.authors?.bob,
					author: proof?.authors?.bob,
					authorSequence: 2,
					issuedRowAuthor: proof?.authors?.bob,
					outboxRowAuthor: proof?.authors?.bob,
				},
				result: { lifecycle: "active", ok: true, recovery: "active-new" },
			},
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
		for (const [control, detail] of [
			[forgedFuture, "creator predecessor recovery failed: admission-rejected"],
			[malformedFuture, "creator predecessor recovery failed: admission-rejected"],
			[backingFailure, "creator predecessor recovery failed: issuance-rejected"],
		] as const) {
			expect(control).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					aheRecoverCount: 2,
					installEpochAnchorCount: 1,
					issuanceStoreShape: true,
					publicationCount: 0,
					snapshotOpenCount: 2,
					subscribeCount: 1,
					transactIssueCount: 1,
				},
				issued: { author: proof?.authors?.bob, authorSequence: 1 },
				repeat: { result: { detail, kind: "recovery-rejected", ok: false } },
				result: { lifecycle: "active", ok: true, recovery: "active-new" },
			});
		}
		const writerAuthors = d108d1bChatAuthorities()
			.filter(({ groups }) => groups.includes("writer"))
			.map(({ author }) => author)
			.sort();
		for (const [accepted, reopenCount] of [
			[established, 2],
			[fresh, 1],
		] as const) {
			const effects = accepted?.effects as
				| Readonly<{
						readonly aheRecoverCount?: number;
						readonly authorityEvents?: readonly Readonly<{
							readonly attempt: number;
							readonly author?: string;
							readonly kind: string;
						}>[];
						readonly issuanceStoreShape?: boolean;
						readonly lineageReads?: readonly string[];
						readonly order?: readonly string[];
						readonly snapshotOpenCount?: number;
				  }>
				| undefined;
			expect(effects?.aheRecoverCount).toBe(reopenCount);
			expect(effects?.snapshotOpenCount).toBe(reopenCount);
			expect(effects?.issuanceStoreShape).toBe(true);
			const reads = effects?.lineageReads ?? [];
			expect(reads).toHaveLength(7 * reopenCount);
			for (let offset = 0; offset < reads.length; offset += 7) {
				expect([...reads.slice(offset, offset + 7)].sort()).toEqual(writerAuthors);
			}
			const signerCalls = accepted?.signerCalls as readonly Readonly<{
				bytes: string;
				matchesDurableCarrier: boolean;
				ordinary: boolean;
				use: string;
			}>[];
			expect(signerCalls).toHaveLength(2 * reopenCount);
			expect(signerCalls.every(({ bytes, ordinary }) => ordinary && bytes.length === 64)).toBe(true);
			const possessions = signerCalls.filter(({ use }) => use === "possession");
			expect(possessions).toHaveLength(reopenCount);
			expect(possessions.every(({ matchesDurableCarrier }) => !matchesDurableCarrier)).toBe(true);
			const order = effects?.order ?? [];
			const possessionIndices = order.flatMap((entry, index) => (entry === "possession:signer" ? [index] : []));
			expect(possessionIndices).toHaveLength(reopenCount);
			for (const [positionIndex, position] of possessionIndices.entries()) {
				const end = possessionIndices[positionIndex + 1] ?? order.length;
				const selected = order.slice(position + 1, end).filter((entry) => entry.startsWith("lineage:"));
				expect(selected).toHaveLength(7);
			}
			const authorityEvents = effects?.authorityEvents ?? [];
			expect.soft(authorityEvents).toHaveLength(8 * reopenCount);
			for (let attempt = 0; attempt < reopenCount; attempt += 1) {
				const window = authorityEvents.filter((event) => event.attempt === attempt);
				expect.soft(window[0]).toEqual({ attempt, kind: "possession-signer" });
				expect
					.soft(window.slice(1).map(({ author, kind }) => ({ author, kind })))
					.toEqual(writerAuthors.map((author) => ({ author, kind: "lineage-read" })));
			}
		}
		const establishedPossessions = (
			established?.signerCalls as readonly Readonly<{ bytes: string; use: string }>[]
		).filter(({ use }) => use === "possession");
		const freshPossessions = (fresh?.signerCalls as readonly Readonly<{ bytes: string; use: string }>[]).filter(
			({ use }) => use === "possession"
		);
		expect(new Set([...establishedPossessions, ...freshPossessions].map(({ bytes }) => bytes)).size).toBe(3);
		for (const failure of rejected) {
			expect(failure).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					aheRecoverCount: 1,
					installEpochAnchorCount: 0,
					issuanceStoreShape: true,
					publicationCount: 0,
					snapshotOpenCount: 1,
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
			"missing-webcrypto",
			"ed25519-unavailable",
		]) {
			const failure = rejected.find((candidate) => candidate.name === name);
			const effects = failure?.effects as Readonly<{ readonly lineageReads?: readonly string[] }> | undefined;
			expect(effects?.lineageReads).toEqual([]);
			expect(failure?.result).toEqual({
				detail: "creator issuance possession proof failed",
				kind: "chain-invalid",
				ok: false,
			});
		}
		const nonWriter = rejected.find((candidate) => candidate.name === "non-writer");
		expect(nonWriter?.result).toEqual({
			detail: "creator issuance ACL authority is invalid",
			kind: "chain-invalid",
			ok: false,
		});
		for (const name of [
			"copied-creator-lineage",
			"two-nonzero-lineages",
			"selected-exhausted-lineage",
			"foreign-exhausted-lineage",
			"malformed-exhausted-lineage",
			"negative-lineage-next",
			"unsafe-lineage-next",
		]) {
			const failure = rejected.find((candidate) => candidate.name === name);
			expect(failure?.result).toEqual({
				detail: "creator issuance lineage is invalid",
				kind: "chain-invalid",
				ok: false,
			});
		}
		for (const candidate of results) {
			const possessionCalls = (
				candidate.signerCalls as readonly Readonly<{ readonly use?: string }>[] | undefined
			)?.filter(({ use }) => use === "possession").length;
			if (possessionCalls === undefined || possessionCalls === 0) continue;
			const events = (
				candidate.effects as
					| Readonly<{
							readonly authorityEvents?: readonly Readonly<{
								readonly attempt: number;
								readonly kind: string;
							}>[];
					  }>
					| undefined
			)?.authorityEvents;
			expect.soft(events?.filter(({ kind }) => kind === "possession-signer")).toHaveLength(possessionCalls);
			for (const lineage of events?.filter(({ kind }) => kind === "lineage-read") ?? []) {
				const signerIndex =
					events?.findIndex((event) => event.attempt === lineage.attempt && event.kind === "possession-signer") ?? -1;
				expect.soft(signerIndex).toBeGreaterThanOrEqual(0);
				expect.soft(signerIndex).toBeLessThan(events?.indexOf(lineage) ?? -1);
			}
		}
	});
});
