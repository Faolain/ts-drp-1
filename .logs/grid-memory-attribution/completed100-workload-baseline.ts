/* eslint-disable @typescript-eslint/explicit-function-return-type -- Real-room fixture retains inferred production signatures. */
import "fake-indexeddb/auto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import { writeSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Install observers before the room/node consumers below.
import {
	aheFacts,
	assertRetainedRollbackPair,
	durable,
	hex,
	observed,
	openRoom,
	originalStorage,
	type Peer,
	productState,
	record,
	required,
	sessions,
} from "./fixtures/grid-room-workload.js";
import { createV3ZoneApplication, type ZoneBlock } from "../examples/grid/src/v3-zone.js";
import { readV3ApplicationProjectionOrder } from "../packages/node/src/v3-live.js";
import { frontierFor } from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";

const WRITERS = 64;
const TRANSITIONS = 100;
const HEAP_CEILING = 512_000_000;
const SLOPE_REFERENCE = 165_161;
const STATE_CEILING = 32_768;

function releaseEvidence(nextEpoch?: number): number {
	// Adoption can already issue the next epoch's fence. Keep those exact observer
	// records until that epoch's lineage, publication and close-set checks consume them.
	const carried =
		nextEpoch === undefined
			? []
			: observed.commits.filter((commit) => record(commit.envelope.canonicalPreimageBytes).epoch === nextEpoch);
	const carriedDigests = new Set(carried.map((commit) => hex(commit.envelope.digest)));
	const carriedHandles = carried.map((commit) => [commit, observed.commitHandles.get(commit)] as const);
	const carriedPlans = carried.map((commit) => [commit, required(observed.issuePlans.get(commit))] as const);
	const carriedPublications = observed.publications.filter((row) => carriedDigests.has(row.digest));
	observed.commits.length = 0;
	observed.advances.length = 0;
	observed.issueAttempts.length = 0;
	observed.commitHandles.clear();
	observed.issuePlans.clear();
	observed.timeline.length = 0;
	observed.ambiguities.length = 0;
	observed.publications.length = 0;
	observed.planWrites.length = 0;
	observed.prunes.length = 0;
	observed.cleanup.length = 0;
	observed.closeGraphs.length = 0;
	observed.snapshots.length = 0;
	// Release vi.fn/spy call arguments as well as the explicit observer arrays.
	vi.clearAllMocks();
	observed.commits.push(...carried);
	for (const [commit, handle] of carriedHandles) observed.commitHandles.set(commit, handle);
	for (const [commit, plan] of carriedPlans) observed.issuePlans.set(commit, plan);
	observed.publications.push(...carriedPublications);
	return carried.length;
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
	releaseEvidence();
	observed.stores.clear();
	observed.planes.clear();
});

afterEach(async () => {
	const cleanup = await Promise.allSettled([...sessions].map((room) => room.close()));
	sessions.clear();
	releaseEvidence();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
	const failures = cleanup.filter((row) => row.status === "rejected");
	expect(failures, "GRID100_ROOM_CLEANUP_FAILURES_ARE_NOT_SUPPRESSED").toEqual([]);
});

function emit(value: Readonly<Record<string, unknown>>): void {
	writeSync(1, `${JSON.stringify({ kind: "GRID100_DIAGNOSTIC", ...value })}\n`);
}

function operation(commit: DurableIssueCommit): Record<string, unknown> {
	const value = record(commit.envelope.canonicalPreimageBytes).operation;
	if (value === null || typeof value !== "object") throw new TypeError("GRID100_OPERATION_MISSING");
	return value as Record<string, unknown>;
}

function block(index: number, epoch: number): ZoneBlock {
	return { id: `writer-${index.toString().padStart(2, "0")}`, kind: "stone", x: epoch, y: index };
}

function world(peer: Peer): { blocks: ZoneBlock[]; roster: { author: string; peerId: string; order: number }[] } {
	const state = decodeCanonical(productState(peer));
	if (state === null || typeof state !== "object" || Array.isArray(state)) throw new TypeError("GRID100_WORLD_MISSING");
	const blocks = Reflect.get(state, "blocks");
	const roster = Reflect.get(state, "roster");
	if (!Array.isArray(blocks) || !Array.isArray(roster)) throw new TypeError("GRID100_WORLD_SHAPE");
	return { blocks, roster };
}

async function memorySample() {
	const gc = globalThis.gc;
	if (gc !== undefined) {
		for (let turn = 0; turn < 3; turn += 1) {
			gc();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	const memory = process.memoryUsage();
	return { ...memory, ownedBytes: memory.heapUsed + memory.arrayBuffers, postGc: gc !== undefined };
}

function slope(values: readonly number[]): number {
	const midpoint = (values.length - 1) / 2;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return (
		values.reduce((sum, value, index) => sum + (index - midpoint) * (value - mean), 0) /
		values.reduce((sum, _value, index) => sum + (index - midpoint) ** 2, 0)
	);
}

it.runIf(process.env.TS_DRP_GRID100_DIAGNOSTIC === "1")(
	"diagnostic: 64 active grid writers across 100 genuine same-room transitions",
	async () => {
		const started = performance.now();
		let transitions = 0;
		let contributions = 0;
		let recoveredSources = 0;
		let creatorRestarts = 0;
		let completed = false;
		let roster: { author: string; peerId: string; order: number }[] = [];
		const samples: Awaited<ReturnType<typeof memorySample>>[] = [];
		const fixture = await openRoom(WRITERS, false, false, false, ({ identities, creatorPeerId }) => {
			const prefix = creatorPeerId.slice(0, -1);
			roster = identities.map(({ author }, order) => ({ author, order, peerId: `${prefix}${order}` }));
			return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
		});
		const creator = required(fixture.peers[0]);
		const objectId = fixture.objectId;
		const nextSequences = new Map(fixture.peers.map((peer) => [peer.author, 0]));
		let previousCheckpoint: { digest: string; successor: string; historySize: number; historyRoot: string } | undefined;
		let previousHeadRevision = -1;
		let displaced: { peer: Peer; commit: DurableIssueCommit; block: ZoneBlock; pending: boolean }[] = [];
		emit({
			phase: "start",
			objectId,
			writers: WRITERS,
			targetTransitions: TRANSITIONS,
			memoryScope: "whole-process-including-fake-indexeddb-vitest-and-observer-overhead",
			acceptance: false,
			runtimeCeilingMs: 3_500_000,
		});
		try {
			for (let epoch = 0; epoch <= TRANSITIONS; epoch += 1) {
				const epochStarted = performance.now();
				const current: { peer: Peer; commit: DurableIssueCommit }[] = [];
				for (const [index, peer] of fixture.peers.entries()) {
					const desired = block(index, epoch);
					const before = observed.commits.length;
					await peer.room.issue({ action: "placeBlock", ...desired });
					const matches = observed.commits.slice(before).filter((commit) => {
						const value = operation(commit);
						return value.action === "placeBlock" && value.id === desired.id && value.x === epoch && value.y === index;
					});
					expect(matches, "GRID100_EXACT_ONE_ORDINARY_COMMIT_PER_WRITER_EPOCH").toHaveLength(1);
					const commit = required(matches[0]);
					expect(record(commit.envelope.canonicalPreimageBytes).epoch).toBe(epoch);
					expect(commit.issuedRecord.scope).toEqual({ author: peer.author, objectId });
					expect(
						observed.publications.filter(
							(row) => row.database === peer.databaseName && row.sequence === commit.authorSequence
						),
						"GRID100_BACKEND_CONFIRMED_PUBLICATION_ONCE"
					).toHaveLength(1);
					expect(fixture.received.has(hex(commit.envelope.digest)), "GRID100_CREATOR_AUTHENTICATED_ADMISSION").toBe(
						true
					);
					expect(
						world(peer).blocks.find((row) => row.id === desired.id),
						"GRID100_WRITER_APPLIED_OWN_CONTRIBUTION"
					).toEqual(desired);
					const plan = required(observed.issuePlans.get(commit));
					const fence = required(plan.fenceSequence);
					expect(fence, "GRID100_UNIVERSAL_FENCE_PRECEDES_ORDINARY_ISSUE").toBeLessThan(commit.authorSequence);
					const fences = observed.commits.filter(
						(row) =>
							row.issuedRecord.scope.author === peer.author &&
							row.planEffect?.kind === "fence" &&
							record(row.envelope.canonicalPreimageBytes).epoch === epoch
					);
					expect(fences, "GRID100_ONE_FENCE_PER_CURRENT_WRITER_EPOCH").toHaveLength(1);
					expect(required(fences[0]).authorSequence).toBe(fence);
					if (epoch > 0) {
						const authority = required(peer.room.authority());
						expect(authority.epoch).toBe(epoch);
						expect(authority.profileId).toBe("creator-trusted-settlement-v1");
						expect(authority.anchorDigest).toBe(required(previousCheckpoint).successor);
						expect(world(peer).roster, "GRID100_AUTHENTICATED_ROSTER_SURVIVES_REOPEN").toEqual(roster);
						expect(peer.floor.read()).toMatchObject({
							pending: null,
							stable: { epoch, currentAnchorDigest: authority.anchorDigest },
						});
					} else {
						expect(peer.room.authority(), "GRID100_GENESIS_HAS_NO_SUCCESSOR_AUTHORITY").toBeNull();
						const invite = peer.input.creatorInvite;
						if (typeof invite === "string") throw new TypeError("GRID100_EXACT_GENESIS_INVITE_REQUIRED");
						const anchorBytes = hashDomain("ts-drp/epoch-anchor/v3", invite.exactCanonicalGenesisAnchorPreimageBytes);
						const anchorDigest = hex(anchorBytes);
						const profileDigest = hex(hashDomain("ts-drp/profile/v3", invite.exactCanonicalProfileBytes));
						expect(anchorDigest).toBe(invite.pinnedGenesisAnchorDigest);
						expect(ed25519.verify(invite.detachedGenesisSignature, anchorBytes, creator.input.publicKeyBytes)).toBe(
							true
						);
						expect(record(invite.exactCanonicalGenesisAnchorPreimageBytes)).toMatchObject({
							objectId,
							epoch: 0,
							profileDigest,
						});
						expect(record(invite.exactCanonicalProfileBytes).profileId).toBe("creator-trusted-settlement-v1");
						const selected = readV3ApplicationProjectionOrder({
							plane: required(observed.planes.get(peer.databaseName)),
						});
						expect(selected.ok, "GRID100_AUTHENTICATED_GENESIS_NODE_ORDER").toBe(true);
						if (!selected.ok) throw new TypeError(selected.detail);
						expect(selected.order).toMatchObject({ objectId, epoch: 0, anchorDigest });
						expect(peer.floor.read()).toMatchObject({
							pending: null,
							stable: { objectId, epoch: 0, currentAnchorDigest: anchorDigest },
						});
						const bootstraps = observed.commits.filter(
							(row) => row.issuedRecord.scope.author === peer.author && operation(row).action === "installRoster"
						);
						expect(bootstraps, "GRID100_ONE_GENUINE_GENESIS_ROSTER_BOOTSTRAP").toHaveLength(1);
						const bootstrap = required(bootstraps[0]);
						expect(hex(hashDomain("ts-drp/vertex/v3", bootstrap.envelope.canonicalPreimageBytes))).toBe(
							hex(bootstrap.envelope.digest)
						);
						expect(operation(bootstrap)).toEqual(peer.input.application.bootstrapOperation);
						expect(record(bootstrap.envelope.canonicalPreimageBytes)).toMatchObject({
							objectId,
							epoch: 0,
							author: peer.author,
							anchor: anchorDigest,
							dependencies: [anchorDigest],
						});
						expect(
							ed25519.verify(bootstrap.envelope.signature, bootstrap.envelope.digest, peer.input.publicKeyBytes)
						).toBe(true);
						expect(selected.order.digests).toContain(hex(bootstrap.envelope.digest));
						expect(selected.order.digests).toContain(hex(commit.envelope.digest));
					}
					for (const source of displaced.filter((row) => row.peer === peer)) {
						const entry = required(plan.entries.find((row) => row.sourceSequence === source.commit.authorSequence));
						expect(entry.disposition).toBe("rebase");
						const replacement = required(
							observed.commits.find(
								(row) =>
									row.issuedRecord.scope.author === peer.author && row.authorSequence === entry.replacementSequence
							)
						);
						expect(operation(replacement), "GRID100_REAL_REBASE_PRESERVES_DISPLACED_OPERATION").toEqual({
							action: "placeBlock",
							...source.block,
						});
						expect(replacement.authorSequence).toBeGreaterThan(fence);
						expect(replacement.authorSequence).toBeLessThan(commit.authorSequence);
						expect(fixture.received.has(hex(replacement.envelope.digest))).toBe(true);
						expect(
							observed.publications.filter(
								(row) => row.database === peer.databaseName && row.sequence === replacement.authorSequence
							)
						).toHaveLength(1);
						recoveredSources += 1;
					}
					current.push({ peer, commit });
					contributions += 1;
				}
				displaced = [];
				const expectedBlocks = Array.from({ length: WRITERS }, (_unused, index) => block(index, epoch));
				expect(world(creator), "GRID100_EXACT_SHARED_WORLD_AND_ROSTER").toEqual({ blocks: expectedBlocks, roster });
				const sealed = productState(creator).slice();
				expect(sealed.byteLength, "GRID100_UNCHANGED_CANONICAL_STATE_CEILING").toBeLessThanOrEqual(STATE_CEILING);
				const worldDigest = hex(hashDomain("ts-drp/state/v3", sealed));
				const cohort = Array.from({ length: 8 }, (_unused, offset) =>
					required(fixture.peers[1 + ((epoch * 8 + offset) % (WRITERS - 1))])
				);
				if (epoch < TRANSITIONS) {
					for (const [offset, peer] of cohort.slice(0, 2).entries()) {
						const index = fixture.peers.indexOf(peer);
						const pending = offset === 1;
						const displacedBlock = { ...block(index, epoch), x: -epoch - 1, y: -index - 1 };
						if (pending) fixture.publicationFailures.add(peer.databaseName);
						else fixture.held.add(peer.databaseName);
						const issue = peer.room.issue({ action: "placeBlock", ...displacedBlock });
						if (pending) await expect(issue, "GRID100_REAL_PENDING_PUBLICATION_FAILURE").rejects.toThrow();
						else await issue;
						const source = required((await durable(peer)).rows.at(-1));
						expect(source.publishState).toBe(pending ? "pending" : "published");
						expect(fixture.received.has(hex(source.commit.envelope.digest))).toBe(false);
						displaced.push({ peer, commit: source.commit, block: displacedBlock, pending });
					}
					await Promise.all(cohort.map(fixture.stop));
					await fixture.close();
					const checkpoint = fixture.checkpoint();
					const graph = required(observed.closeGraphs.at(-1));
					const excluded = new Set(displaced.map((row) => hex(row.commit.envelope.digest)));
					const admitted = observed.commits.filter(
						(row) =>
							record(row.envelope.canonicalPreimageBytes).epoch === epoch && !excluded.has(hex(row.envelope.digest))
					);
					expect([...graph.result.closeSetOrder].sort(), "GRID100_EXACT_SIGNED_CLOSE_SET").toEqual(
						admitted.map((row) => hex(row.envelope.digest)).sort()
					);
					for (const commit of admitted) {
						const digest = hex(commit.envelope.digest);
						expect(hex(hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes))).toBe(digest);
						expect(
							ed25519.verify(
								commit.envelope.signature,
								commit.envelope.digest,
								Buffer.from(commit.issuedRecord.scope.author, "hex")
							)
						).toBe(true);
						const vertex = required(graph.input.vertices.get(digest));
						expect(vertex.operation).toEqual(operation(commit));
						expect(vertex.dependencies).toEqual(record(commit.envelope.canonicalPreimageBytes).dependencies);
						expect(graph.input.authenticatedCanonicalPreimageByteLengths.get(digest)).toBe(
							commit.envelope.canonicalPreimageBytes.byteLength
						);
					}
					expect(checkpoint.cut.stateDigest).toBe(worldDigest);
					expect(checkpoint.cut.closeSetCount).toBe(admitted.length);
					expect(checkpoint.identity.historySize).toBe((previousCheckpoint?.historySize ?? 0) + admitted.length);
					expect(checkpoint.identity.frontiers).toHaveLength(WRITERS);
					for (const { peer, commit } of current)
						expect(frontierFor(checkpoint.capability, peer.author)?.[2]).toBeGreaterThanOrEqual(commit.authorSequence);
					if (previousCheckpoint !== undefined) {
						expect(checkpoint.identity.closedAnchorDigest).toBe(previousCheckpoint.successor);
						expect(checkpoint.identity.priorCheckpointDigest).toBe(previousCheckpoint.digest);
						expect(checkpoint.identity.historyRoot).not.toBe(previousCheckpoint.historyRoot);
					}
					const snapshot = required(
						observed.snapshots.findLast(
							(row) => row.result.manifestDigest === checkpoint.identity.snapshotManifestDigest
						)
					);
					const payload = new Uint8Array(Buffer.concat(snapshot.result.chunks));
					expect(payload).toEqual(snapshot.input.exactCanonicalPayloadBytes);
					expect(encodeCanonical(record(payload).application), "GRID100_PRODUCED_SNAPSHOT_EXACT_WORLD").toEqual(sealed);
					await creator.room.adoptCreatorSuccessor();
					const head = await assertRetainedRollbackPair(creator);
					expect(head.head.revision).toBeGreaterThan(previousHeadRevision);
					previousHeadRevision = head.head.revision;
					expect(productState(creator)).toEqual(sealed);
					expect(creator.room.authority()).toMatchObject({
						epoch: epoch + 1,
						anchorDigest: checkpoint.identity.successorAnchorDigest,
					});
					previousCheckpoint = {
						digest: hex(hashDomain("ts-drp-storage/blob/v1", checkpoint.bytes)),
						successor: checkpoint.identity.successorAnchorDigest,
						historySize: checkpoint.identity.historySize,
						historyRoot: checkpoint.identity.historyRoot,
					};
					transitions += 1;
					if (epoch % 10 === 1) {
						const authority = creator.room.authority();
						await fixture.reopen(creator, epoch);
						expect(productState(creator)).toEqual(sealed);
						expect(creator.room.authority()).toEqual(authority);
						expect((await aheFacts(creator)).head).toEqual(head.head);
						creatorRestarts += 1;
					}
				}
				let durableRows = 0;
				let maxDurableRows = 0;
				for (const peer of fixture.peers) {
					const retained = await durable(peer);
					durableRows += retained.rows.length;
					maxDurableRows = Math.max(maxDurableRows, retained.rows.length);
					const commits = observed.commits.filter((row) => row.issuedRecord.scope.author === peer.author);
					const successorCommits = commits.filter(
						(row) => record(row.envelope.canonicalPreimageBytes).epoch === epoch + 1
					);
					if (epoch === TRANSITIONS) {
						expect(successorCommits, "GRID100_FINAL_EPOCH_LEAVES_NO_UNACCOUNTED_SUCCESSOR_SUFFIX").toHaveLength(0);
					}
					const accountedThrough = retained.lineage.next - successorCommits.length;
					expect(
						successorCommits.map((row) => row.authorSequence),
						"GRID100_SUCCESSOR_EVIDENCE_IS_EXACT_LINEAGE_SUFFIX"
					).toEqual(Array.from({ length: successorCommits.length }, (_unused, offset) => accountedThrough + offset));
					const currentCommits = commits.filter((row) => record(row.envelope.canonicalPreimageBytes).epoch === epoch);
					expect(currentCommits.length + successorCommits.length, "GRID100_NO_OUT_OF_SCOPE_OBSERVER_COMMIT").toBe(
						commits.length
					);
					const start = required(nextSequences.get(peer.author));
					expect(
						currentCommits.map((row) => row.authorSequence),
						"GRID100_NO_LINEAGE_HOLE_OR_DUPLICATE"
					).toEqual(Array.from({ length: accountedThrough - start }, (_unused, offset) => start + offset));
					nextSequences.set(peer.author, accountedThrough);
					for (const commit of commits) {
						const unpublished = displaced.some(
							(row) => row.pending && row.peer === peer && row.commit.authorSequence === commit.authorSequence
						);
						expect(
							observed.publications.filter(
								(row) => row.database === peer.databaseName && row.sequence === commit.authorSequence
							),
							"GRID100_PUBLICATION_CONSERVATION"
						).toHaveLength(unpublished ? 0 : 1);
					}
				}
				const evidenceRecords =
					observed.commits.length + observed.snapshots.length + observed.closeGraphs.length + fixture.envelopes.length;
				const pruningReceipts = observed.prunes.filter((row) => row.receipt !== undefined).length;
				const pruningFailures = observed.prunes.filter((row) => row.error !== undefined).length;
				expect(pruningFailures, "GRID100_PRUNING_FAILURES_NOT_SUPPRESSED").toBe(0);
				const carriedEvidenceRecords = releaseEvidence(epoch < TRANSITIONS ? epoch + 1 : undefined);
				fixture.envelopes.length = 0;
				const carriedReceived = observed.commits
					.map((commit) => hex(commit.envelope.digest))
					.filter((digest) => fixture.received.has(digest));
				fixture.received.clear();
				for (const digest of carriedReceived) fixture.received.add(digest);
				if (epoch < TRANSITIONS) {
					for (const peer of cohort) {
						fixture.held.delete(peer.databaseName);
						fixture.publicationFailures.delete(peer.databaseName);
					}
					await Promise.all(fixture.peers.slice(1).map((peer) => fixture.reopen(peer, epoch, true)));
				}
				const memory = await memorySample();
				samples.push(memory);
				emit({
					phase: "epoch-complete",
					epoch,
					transitions,
					contributions,
					recoveredSources,
					creatorRestarts,
					objectId,
					worldDigest,
					worldBytes: sealed.byteLength,
					durableRows,
					maxDurableRows,
					pruningReceipts,
					evidenceRecordsReleased: evidenceRecords - carriedEvidenceRecords,
					retainedRecoverySources: displaced.length,
					retainedObserverCommits: observed.commits.length,
					activeRoomOwners: sessions.size,
					elapsedMs: performance.now() - started,
					epochElapsedMs: performance.now() - epochStarted,
					memory,
					referenceHeapCeilingExceeded: memory.heapUsed >= HEAP_CEILING || memory.ownedBytes >= HEAP_CEILING,
				});
			}
			expect(transitions).toBe(TRANSITIONS);
			expect(contributions).toBe(WRITERS * (TRANSITIONS + 1));
			expect(recoveredSources).toBe(2 * TRANSITIONS);
			expect(creatorRestarts).toBe(10);
			const finalState = productState(creator).slice();
			const finalAuthority = creator.room.authority();
			await fixture.reopen(creator, TRANSITIONS - 1);
			expect(productState(creator), "GRID100_FINAL_COLD_REOPEN_EXACT_WORLD").toEqual(finalState);
			expect(creator.room.authority()).toEqual(finalAuthority);
			expect(observed.commits, "GRID100_FINAL_COLD_REOPEN_NO_DUPLICATE_ISSUE").toHaveLength(0);
			expect(observed.publications, "GRID100_FINAL_COLD_REOPEN_NO_DUPLICATE_PUBLICATION").toHaveLength(0);
			const tail = samples.slice(-32);
			emit({
				phase: "memory-diagnostic",
				scope: "aggregate-process-not-product-retained-memory-acceptance",
				postGc: samples.every((sample) => sample.postGc),
				referenceSlopeLimit: SLOPE_REFERENCE,
				heapUsedSlope: slope(tail.map((sample) => sample.heapUsed)),
				arrayBuffersSlope: slope(tail.map((sample) => sample.arrayBuffers)),
				ownedBytesSlope: slope(tail.map((sample) => sample.ownedBytes)),
				referenceCeiling: HEAP_CEILING,
				referenceCeilingExceeded: samples.some(
					(sample) => sample.heapUsed >= HEAP_CEILING || sample.ownedBytes >= HEAP_CEILING
				),
				acceptance: false,
			});
			completed = true;
		} finally {
			emit({
				phase: "settled",
				completed,
				transitions,
				contributions,
				recoveredSources,
				elapsedMs: performance.now() - started,
				acceptance: false,
			});
		}
	},
	3_500_000
);
