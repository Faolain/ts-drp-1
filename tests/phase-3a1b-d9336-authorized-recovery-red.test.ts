import { hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import { describe, expect, it } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";

interface RecoverySuccess {
	readonly ok: true;
	readonly descriptor: Readonly<{
		readonly objectId: string;
		readonly recoveredVertexCount: 2;
		readonly transcript: readonly ["authorized", "issued-record-authenticated", "journaled", "indexed", "ready"];
	}>;
}

type Recover = (input: Readonly<Record<string, unknown>>) => Promise<RecoverySuccess | Readonly<{ ok: false }>>;

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

describe("D.93.36 authorized durable recovery RED", () => {
	it("recovers one genuine local commit before any live effect", async () => {
		const candidate = (await import("../packages/node/src/v3-live.js")) as unknown as Record<string, unknown>;
		expect(typeof candidate.recoverV3LiveReplica).toBe("function");
		const recover = candidate.recoverV3LiveReplica as Recover;
		const fixture = await createGenuinePreparedV3Fixture();
		const trace: string[] = [];
		try {
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const commit = commitFor(scope, 0, fixture.recoveryCanonicalPreimageBytes, fixture.recoverySignature);
			const outboxRecord: DurableIssuanceOutboxRecord = Object.freeze({ commit, publishState: "published" });
			const issuanceStore: DurableIssuanceStore = Object.freeze({
				transactIssue: () => Promise.reject(new Error("recovery must not issue")),
				compareAndMarkOutboxPublished: () => Promise.reject(new Error("recovery must not publish")),
				readIssued(selectedScope, authorSequence) {
					trace.push("read-issued");
					return Promise.resolve(
						selectedScope.objectId === scope.objectId && selectedScope.author === scope.author && authorSequence === 0
							? commit
							: null
					);
				},
				readOutboxPage(input = {}) {
					trace.push("read-outbox");
					return Promise.resolve(input.afterKey == null ? Object.freeze([outboxRecord]) : Object.freeze([]));
				},
				readLineage() {
					return Promise.resolve(Object.freeze({ exhausted: false, next: 1 }));
				},
				close: () => Promise.resolve(),
			});
			const journalStore: DurableLiveJournalStore = Object.freeze({
				installGenesis() {
					trace.push("install-genesis");
					return Promise.resolve(
						Object.freeze({
							ok: true as const,
							scope: Object.freeze({
								objectId: fixture.descriptor.objectId,
								epoch: 0 as const,
								anchorDigest: fixture.descriptor.anchorDigest,
							}),
							parametersDigest: fixture.descriptor.parametersDigest,
							idempotent: false,
						})
					);
				},
				readiness() {
					trace.push("journal-readiness");
					return Promise.resolve(
						Object.freeze({
							ok: true as const,
							ready: true as const,
							scope: Object.freeze({
								objectId: fixture.descriptor.objectId,
								epoch: 0 as const,
								anchorDigest: fixture.descriptor.anchorDigest,
							}),
							snapshot: Object.freeze({
								kind: "v3-live-journal-snapshot-token-1" as const,
								scope: Object.freeze({
									objectId: fixture.descriptor.objectId,
									epoch: 0 as const,
									anchorDigest: fixture.descriptor.anchorDigest,
								}),
								highWatermark: 0,
								genesisDigest: "1".repeat(64),
								parametersDigest: fixture.descriptor.parametersDigest,
								orderedRowDigest: "2".repeat(64),
								snapshotDigest: "3".repeat(64),
							}),
							rowCount: 0,
						})
					);
				},
				readPage() {
					trace.push("read-journal");
					return Promise.resolve(
						Object.freeze({
							ok: true as const,
							scope: Object.freeze({
								objectId: fixture.descriptor.objectId,
								epoch: 0 as const,
								anchorDigest: fixture.descriptor.anchorDigest,
							}),
							snapshot: Object.freeze({
								kind: "v3-live-journal-snapshot-token-1" as const,
								scope: Object.freeze({
									objectId: fixture.descriptor.objectId,
									epoch: 0 as const,
									anchorDigest: fixture.descriptor.anchorDigest,
								}),
								highWatermark: 0,
								genesisDigest: "1".repeat(64),
								parametersDigest: fixture.descriptor.parametersDigest,
								orderedRowDigest: "2".repeat(64),
								snapshotDigest: "3".repeat(64),
							}),
							rows: Object.freeze([]),
							nextSequence: null,
						})
					);
				},
				appendAccepted(input) {
					trace.push("append-journal");
					return Promise.resolve(
						Object.freeze({
							ok: true as const,
							scope: input.scope,
							journalSequence: 1,
							vertexDigest: input.vertexDigest,
							sourceKind: input.sourceKind,
							idempotent: false,
						})
					);
				},
				close: () => Promise.resolve(),
			});

			const result = await recover({
				capability: fixture.capability,
				exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
				issuanceScope: scope,
				issuanceStore,
				liveJournalStore: journalStore,
			});
			expect(result).toMatchObject({
				ok: true,
				descriptor: {
					objectId: fixture.descriptor.objectId,
					recoveredVertexCount: 2,
					transcript: ["authorized", "issued-record-authenticated", "journaled", "indexed", "ready"],
				},
			});
			expect(trace).toEqual([
				"install-genesis",
				"journal-readiness",
				"read-journal",
				"read-outbox",
				"read-issued",
				"append-journal",
				"read-outbox",
			]);
		} finally {
			await fixture.close();
		}
	});
});
