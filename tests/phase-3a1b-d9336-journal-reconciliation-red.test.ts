import { hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/src/live-journal.js";

type Recover = (input: Readonly<Record<string, unknown>>) => Promise<
	| Readonly<{
			readonly ok: true;
			readonly descriptor: Readonly<{ readonly recoveredVertexCount: number }>;
	  }>
	| Readonly<{ readonly ok: false }>
>;

function commitFor(
	scope: DurableIssueScope,
	authorSequence: number,
	canonicalPreimageBytes: Uint8Array,
	signature: Uint8Array
): DurableIssueCommit {
	const envelope = Object.freeze({
		canonicalPreimageBytes: new Uint8Array(canonicalPreimageBytes),
		digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
		signature: new Uint8Array(signature),
	});
	return Object.freeze({
		authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
	});
}

describe("D.93.36 retained journal reconciliation RED", () => {
	it("re-authenticates the immutable journal before reconciling the full local outbox", async () => {
		const candidate = (await import("../packages/node/src/v3-live.js")) as unknown as Record<string, unknown>;
		const recover = candidate.recoverV3LiveReplica as Recover;
		const fixture = await createGenuinePreparedV3Fixture();
		const directory = mkdtempSync(path.join(tmpdir(), "drp-d9336-journal-replay-"));
		const journal = createNodeDurableLiveJournalStore({ primaryFilename: path.join(directory, "journal.sqlite") });
		try {
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const journalScope = Object.freeze({
				anchorDigest: fixture.descriptor.anchorDigest,
				epoch: 0 as const,
				objectId: fixture.descriptor.objectId,
			});
			const installed = await journal.installGenesis({
				detachedAnchorSignature: fixture.detachedAnchorSignature,
				exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalAnchorPreimageBytes,
				exactCanonicalParametersCarrierBytes: fixture.exactCanonicalParametersCarrierBytes,
				objectId: fixture.descriptor.objectId,
			});
			expect(installed.ok).toBe(true);

			const firstCarrier = fixture.createRecoveryVertex(0, [fixture.descriptor.anchorDigest]);
			const firstDigest = Array.from(firstCarrier.digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			const secondCarrier = fixture.createRecoveryVertex(1, [firstDigest]);
			const received = await journal.appendAccepted({
				detachedSignature: firstCarrier.signature,
				exactCanonicalPreimageBytes: firstCarrier.canonicalPreimageBytes,
				scope: journalScope,
				sourceKind: "received",
				vertexDigest: firstDigest,
			});
			expect(received).toMatchObject({ idempotent: false, journalSequence: 0, ok: true });

			const commits = [
				commitFor(scope, 0, firstCarrier.canonicalPreimageBytes, firstCarrier.signature),
				commitFor(scope, 1, secondCarrier.canonicalPreimageBytes, secondCarrier.signature),
			] as const;
			const outbox = commits.map(
				(commit, index): DurableIssuanceOutboxRecord =>
					Object.freeze({ commit, publishState: index === 0 ? "published" : "pending" })
			);
			const issuanceStore: DurableIssuanceStore = Object.freeze({
				transactIssue: () => Promise.reject(new Error("recovery must not issue")),
				compareAndMarkOutboxPublished: () => Promise.reject(new Error("recovery must not publish")),
				readIssued(_selectedScope, authorSequence) {
					return Promise.resolve(commits[authorSequence] ?? null);
				},
				readOutboxPage(input = {}) {
					const next = input.afterKey == null ? 0 : input.afterKey[2] + 1;
					return Promise.resolve(outbox[next] === undefined ? Object.freeze([]) : Object.freeze([outbox[next]]));
				},
				readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: 2 })),
				close: () => Promise.resolve(),
			});

			const result = await recover({
				capability: fixture.capability,
				exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
				issuanceScope: scope,
				issuanceStore,
				liveJournalStore: journal,
			});
			expect(result).toMatchObject({ ok: true, descriptor: { recoveredVertexCount: 3 } });

			const ready = await journal.readiness({ scope: journalScope });
			expect(ready).toMatchObject({ ok: true, ready: true, rowCount: 2 });
			if (!ready.ok || !ready.ready) throw new TypeError("journal did not reopen");
			const page = await journal.readPage({ scope: journalScope, snapshot: ready.snapshot });
			expect(page).toMatchObject({
				ok: true,
				rows: [
					{ journalSequence: 0, sourceKind: "received", vertexDigest: firstDigest },
					{ journalSequence: 1, sourceKind: "local-issued", authorSequence: 1 },
				],
			});
		} finally {
			await journal.close();
			await fixture.close();
			rmSync(directory, { force: true, recursive: true });
		}
	});
});
