/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal describes the observed production module. */
// Parent case ownership (each independent continuation has its own causal close):
// 1: delayedDependency; 2-3,10,13-negative,14,22,26: checkpoint-terminal progress.
// 4,15,16,19: delayedPublication; 5,11: manualReviewHold; 6-9: sameKeyReentry.
// 12,23: creatorFenceScan; 13-positive: positiveAuthenticatedPruning;
// 14,24c and the 64-writer product golden path: sixtyFourWriterGoldenPath;
// 17: nullBoundaryClose plus v1 source-shape custody; 19-21: displacedControls; 24a: staleLocalHead;
// 25: ambiguousPlanIssue. Case 24 follows signed clarification 62f71f4d:
// no committed floor regression, no Superseded-generation readoption.
// Closed nonduplicated primitives: 18 and 26-27 are exact vectors in
// d110c-0c1f5b0a-settlement-codec-red.test.ts, "puts ACL membership, genesis
// admission, adjacency, and monotonicity in the bounded advance predicate",
// "signs with successor authority and cold-opens with floor trust only, without
// predecessor bytes", and "keeps predecessor checks shape-only in the opener
// and rejects malformed predecessor fields". Interrupted adoption: retained
// phase-6b-d110c-0b0a-staged-handoff-red.test.ts, "stages without a head swap and
// publishes through one owner-bound CAS" and "recovers equivalent Complete
// retries deterministically across both AHE orderings", plus D.110c-b evidence.
// Later >=100-transition acceptance remains a retained, separately authorized
// same-room workload with bounded durable structures/custody/fresh-process
// memory checks. This fixture executes three wide transitions, not that campaign.
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, SettlementPlan } from "@ts-drp/issuance-store";
import type { DurableIssuancePruningReceipt } from "@ts-drp/issuance-store/maintenance";
import type { V3PlaneHandle } from "@ts-drp/node/v3-live";
import { type GenerationRecord, parseStorageObjectId } from "@ts-drp/storage";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { createTransientPayloadApplication } from "./fixtures/phase-6b-d110c-0c1f5b/transient-payload-application.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomHeadState,
	type V3RoomSession,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import {
	frontierFor,
	openCreatorAuthorSettlement,
	resolveCreatorAuthorSettlement,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { createBrowserAheDurableStore } from "../packages/storage-browser/src/index.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";

const observed = vi.hoisted(() => ({
	stores: new Map<string, DurableIssuanceStore>(),
	planes: new Map<string, V3PlaneHandle>(),
	commits: [] as DurableIssueCommit[],
	advances: [] as Record<string, unknown>[],
	failSuffixFor: "",
	faults: 0,
	ambiguous: undefined as
		| { database: string; kind: "fence" | "replacement"; committed: boolean; recoveryFails?: boolean }
		| undefined,
	failRecoveryReadFor: "",
	issueAttempts: [] as DurableIssueCommit[],
	commitHandles: new Map<DurableIssueCommit, V3PlaneHandle | undefined>(),
	issuePlans: new Map<DurableIssueCommit, SettlementPlan | null>(),
	timeline: [] as { database: string; kind: "plan" | "commit" | "publication"; sequence?: number; revision?: number }[],
	ambiguities: [] as {
		database: string;
		candidate: DurableIssueCommit;
		handle: V3PlaneHandle | undefined;
		plan: SettlementPlan | null;
		lineage: { next: number; exhausted: boolean };
		row: DurableIssueCommit | null;
		publicationOffset: number;
		commitOffset: number;
	}[],
	publications: [] as { database: string; sequence: number; digest: string; handle: V3PlaneHandle | undefined }[],
	planWrites: [] as { database: string; plan: SettlementPlan }[],
	prunes: [] as {
		database: string;
		input: unknown;
		stack: string;
		receipt?: DurableIssuancePruningReceipt;
		error?: unknown;
	}[],
	cleanup: [] as { input: unknown; result: unknown }[],
	closeGraphs: [] as {
		input: Parameters<typeof import("@ts-drp/compaction").deriveCloseSetHistoryCommitment>[0];
		result: Awaited<ReturnType<typeof import("@ts-drp/compaction").deriveCloseSetHistoryCommitment>>;
	}[],
}));

vi.mock("@ts-drp/compaction", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/compaction")>();
	return {
		...real,
		deriveCloseSetHistoryCommitment: async (input: Parameters<typeof real.deriveCloseSetHistoryCommitment>[0]) => {
			const result = await real.deriveCloseSetHistoryCommitment(input);
			observed.closeGraphs.push({ input, result });
			return result;
		},
	};
});

// All aliases point at the existing implementations, sharing their actual opaque
// capability custody. No replacement trust, codec, checkpoint or activation result.
vi.mock("../packages/node/dist/src/creator-adoption.js", () => import("../packages/node/src/creator-adoption.js"));
vi.mock(
	"../packages/node/dist/src/creator-adoption-stage.js",
	() => import("../packages/node/src/creator-adoption-stage.js")
);
vi.mock(
	"../packages/node/dist/src/creator-adoption-recover.js",
	() => import("../packages/node/src/creator-adoption-recover.js")
);
vi.mock("../packages/node/dist/src/creator-adoption-activate.js", async () => {
	const real = await import("../packages/node/src/creator-adoption-activate.js");
	type ActivationRealm = typeof real;
	const realms = new Map<string, Promise<ActivationRealm>>();
	// Independent physical clients have independent module-local activeOwners.
	// Query-isolate ONLY that unchanged production module; its opaque intent,
	// handle-alias and recovery dependencies retain their exact shared identities.
	// A peer keeps its realm across close/reopen: only real room.close() releases
	// its ownership. Never clear/reset a production singleton to admit a peer.
	const realmFor = async (peerId: string): Promise<ActivationRealm> => {
		let pending = realms.get(peerId);
		if (pending === undefined) {
			const source = new URL("../packages/node/src/creator-adoption-activate.ts", import.meta.url).href;
			pending = import(`${source}?f5bClient=${encodeURIComponent(peerId)}`) as Promise<ActivationRealm>;
			realms.set(peerId, pending);
		}
		const selected = await pending;
		for (const [otherId, other] of realms)
			if (otherId !== peerId)
				expect(selected.activateCreatorSuccessorAdoption, "F5B_INDEPENDENT_CLIENT_MODULE_REALM").not.toBe(
					(await other).activateCreatorSuccessorAdoption
				);
		return selected;
	};
	const capture =
		(name: "activateCreatorSuccessorAdoption" | "reopenCreatorSuccessorAdoption") => async (input: unknown) => {
			const network = Reflect.get(input as object, "networkNode") as { peerId: string };
			expect(network.peerId, "F5B_PHYSICAL_CLIENT_TRANSPORT_IDENTITY").toMatch(
				/^d110c-f5b-parent-\d+-peer-\d+(?:-fresh)?$/u
			);
			const realm = await realmFor(network.peerId);
			const result = await realm[name](input);
			if (result.ok === true) {
				observed.planes.set(network.peerId, result.handle as V3PlaneHandle);
			}
			return result;
		};
	return {
		...real,
		activateCreatorSuccessorAdoption: capture("activateCreatorSuccessorAdoption"),
		reopenCreatorSuccessorAdoption: capture("reopenCreatorSuccessorAdoption"),
	};
});

vi.mock("../packages/node/src/internal/closed-epoch-cleanup.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../packages/node/src/internal/closed-epoch-cleanup.js")>();
	return {
		...real,
		planClosedEpochCleanup: (input: unknown) => {
			const result = real.planClosedEpochCleanup(input);
			observed.cleanup.push({ input, result });
			return result;
		},
	};
});

vi.mock("../packages/node/src/internal/creator-transition-advance.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../packages/node/src/internal/creator-transition-advance.js")>();
	return {
		...real,
		inspectCreatorTransitionAdvance: (...args: Parameters<typeof real.inspectCreatorTransitionAdvance>) => {
			observed.advances.push(args[0] as unknown as Record<string, unknown>);
			return real.inspectCreatorTransitionAdvance(...args);
		},
	};
});

vi.mock("../packages/storage-browser/dist/src/issuance.js", async () => {
	const real = await import("../packages/storage-browser/src/issuance.js");
	const { browserIssuanceImplementationForTest } = await import(
		"../packages/storage-browser/src/internal/browser-issuance-store.js"
	);
	const { DurableIssuanceUnknownOutcomeError } = await import("../packages/issuance-store/src/contract.js");
	return {
		...real,
		createBrowserDurableIssuanceStore: async (input: { primaryDatabaseName: string }) => {
			const store = await real.createBrowserDurableIssuanceStore(input);
			const transactIssue = store.transactIssue;
			const readLineage = store.readLineage;
			Reflect.set(store, "readLineage", (scope: Parameters<typeof readLineage>[0]) => {
				if (observed.failRecoveryReadFor === input.primaryDatabaseName)
					return Promise.reject(new Error("F5B_RECOVERY_DURABLE_READ_UNAVAILABLE"));
				return readLineage(scope);
			});
			const ambiguousReadback = async (candidate: DurableIssueCommit) => {
				const scope = candidate.issuedRecord.scope;
				observed.ambiguities.push({
					database: input.primaryDatabaseName,
					candidate,
					handle: observed.planes.get(input.primaryDatabaseName),
					plan: await store.readSettlementPlan(scope),
					lineage: await readLineage(scope),
					row: await store.readIssued(scope, candidate.authorSequence),
					publicationOffset: observed.publications.length,
					commitOffset: observed.commits.length,
				});
			};
			// Observe methods on the EXACT backend facade. Its existing maintenance
			// WeakMap identity remains intact; no capability is minted or rebound.
			Reflect.set(store, "transactIssue", (async (scope, build) => {
				let selected: DurableIssueCommit | undefined;
				const ambiguity = observed.ambiguous?.database === input.primaryDatabaseName ? observed.ambiguous : undefined;
				const result = await transactIssue(scope, async (sequence) => {
					const candidate = await build(sequence);
					observed.issuePlans.set(candidate, structuredClone(await store.readSettlementPlan(scope)));
					observed.issueAttempts.push(candidate);
					const effect = candidate.planEffect;
					if (ambiguity !== undefined && ambiguity.kind === effect?.kind && !ambiguity.committed) {
						await ambiguousReadback(candidate);
						if (ambiguity.recoveryFails === true) observed.failRecoveryReadFor = input.primaryDatabaseName;
						observed.ambiguous = undefined;
						throw new DurableIssuanceUnknownOutcomeError(scope);
					}
					if (
						input.primaryDatabaseName === observed.failSuffixFor &&
						effect?.kind === "replacement" &&
						"fromIntent" in effect &&
						effect.fromIntent > 0
					) {
						observed.faults += 1;
						throw new Error("F5B_SIGNED_SUFFIX_NOT_COMMITTED");
					}
					selected = candidate;
					return candidate;
				});
				if (selected !== undefined) {
					observed.commits.push(selected);
					observed.timeline.push({
						database: input.primaryDatabaseName,
						kind: "commit",
						sequence: selected.authorSequence,
					});
					observed.commitHandles.set(selected, observed.planes.get(input.primaryDatabaseName));
				}
				if (ambiguity !== undefined && ambiguity.kind === selected?.planEffect?.kind && ambiguity.committed) {
					await ambiguousReadback(selected);
					if (ambiguity.recoveryFails === true) observed.failRecoveryReadFor = input.primaryDatabaseName;
					observed.ambiguous = undefined;
					throw new DurableIssuanceUnknownOutcomeError(scope);
				}
				return result;
			}) satisfies DurableIssuanceStore["transactIssue"]);
			const publish = store.compareAndMarkOutboxPublished;
			Reflect.set(store, "compareAndMarkOutboxPublished", (async (value) => {
				await publish(value);
				observed.timeline.push({
					database: input.primaryDatabaseName,
					kind: "publication",
					sequence: value.authorSequence,
				});
				observed.publications.push({
					database: input.primaryDatabaseName,
					sequence: value.authorSequence,
					digest: Buffer.from(value.digest).toString("hex"),
					handle: observed.planes.get(input.primaryDatabaseName),
				});
			}) satisfies DurableIssuanceStore["compareAndMarkOutboxPublished"]);
			const writePlan = store.transactWriteSettlementPlan;
			Reflect.set(store, "transactWriteSettlementPlan", (async (value) => {
				const plan = await writePlan(value);
				observed.planWrites.push({ database: input.primaryDatabaseName, plan: structuredClone(plan) });
				observed.timeline.push({ database: input.primaryDatabaseName, kind: "plan", revision: plan.revision });
				return plan;
			}) satisfies DurableIssuanceStore["transactWriteSettlementPlan"]);
			const implementation = browserIssuanceImplementationForTest(store);
			if (implementation === undefined) throw new Error("F5B_NATIVE_ISSUANCE_IDENTITY_LOST");
			const prune = implementation.pruneAuthenticatedSettledPrefix.bind(implementation);
			vi.spyOn(implementation, "pruneAuthenticatedSettledPrefix").mockImplementation(async (value) => {
				const event: (typeof observed.prunes)[number] = {
					database: input.primaryDatabaseName,
					input: structuredClone(value),
					stack: new Error().stack ?? "",
				};
				observed.prunes.push(event);
				try {
					return (event.receipt = await prune(value));
				} catch (error) {
					event.error = error;
					throw error;
				}
			});
			observed.stores.set(input.primaryDatabaseName, store);
			return store;
		},
	};
});

vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/node/v3-live")>();
	return {
		...real,
		activateV3LivePlane: (...args: Parameters<typeof real.activateV3LivePlane>) => {
			const result = real.activateV3LivePlane(...args);
			if (result.ok) observed.planes.set(args[0].networkNode.peerId, result.handle);
			return result;
		},
	};
});

const sessions = new Set<V3RoomSession>();
const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage");
const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const record = (value: Uint8Array) => decodeCanonical(value) as Record<string, unknown>;
const STALE_LOCAL_HEAD_FAILURE =
	"v3 room successor reopen failed: D110C_FLOOR_MISMATCH: creator successor differs from the authenticated room-head floor";
let ordinal = 0;

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new TypeError("F5B_PRODUCT_CUSTODY_MISSING");
	return value;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

function transactionDone(value: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		value.oncomplete = () => resolve();
		value.onabort = () => reject(value.error);
		value.onerror = () => reject(value.error);
	});
}

// Deferred availability transport, not hot-follow authority: only byte-for-byte
// copies of creator-published AHE/snapshot storage are delivered. The receiver's
// ordinary room reopen still checks pinned genesis, published floor, closure,
// snapshot, signatures and projection. Its issuance/journal are NEVER copied.
async function transferDatabase(sourceName: string, targetName: string): Promise<void> {
	const source = await request(indexedDB.open(sourceName));
	try {
		const names = [...source.objectStoreNames];
		const reading = source.transaction(names, "readonly");
		const rows = await Promise.all(
			names.map(async (name) => {
				const owner = reading.objectStore(name);
				const indexes = [...owner.indexNames].map((indexName) => {
					const index = owner.index(indexName);
					return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
				});
				return {
					name,
					keyPath: owner.keyPath,
					autoIncrement: owner.autoIncrement,
					indexes,
					keys: await request(owner.getAllKeys()),
					values: await request(owner.getAll()),
				};
			})
		);
		const opening = indexedDB.open(targetName, source.version);
		opening.onupgradeneeded = () => {
			for (const row of rows)
				if (!opening.result.objectStoreNames.contains(row.name)) {
					const owner = opening.result.createObjectStore(row.name, {
						keyPath: row.keyPath,
						autoIncrement: row.autoIncrement,
					});
					for (const index of row.indexes)
						owner.createIndex(index.name, index.keyPath, {
							unique: index.unique,
							multiEntry: index.multiEntry,
						});
				}
		};
		const target = await request(opening);
		try {
			const writing = target.transaction(names, "readwrite");
			const complete = transactionDone(writing);
			for (const row of rows) {
				const owner = writing.objectStore(row.name);
				owner.clear();
				row.values.forEach((value, index) => {
					if (row.keyPath === null) owner.put(structuredClone(value), row.keys[index]);
					else owner.put(structuredClone(value));
				});
			}
			await complete;
		} finally {
			target.close();
		}
	} finally {
		source.close();
	}
}

async function producedDeclaration(databaseName: string, closedEpoch: number) {
	const database = await request(indexedDB.open(`${databaseName}--drp-snapshot-quarantine-v1`));
	try {
		const reading = database.transaction(["scopes", "chunks"], "readonly");
		const [scopes, chunks] = await Promise.all([
			request(reading.objectStore("scopes").getAll()) as Promise<Record<string, unknown>[]>,
			request(reading.objectStore("chunks").getAll()) as Promise<Record<string, unknown>[]>,
		]);
		const matching = scopes.filter((row) => row.epoch === closedEpoch && row.state === "verified");
		expect(matching, "F5B_GENUINE_SNAPSHOT_DECLARATION_UNIQUE").toHaveLength(1);
		const scope = required(matching[0]);
		const selected = chunks
			.filter((row) => ["objectId", "epoch", "anchor", "manifestDigest"].every((key) => row[key] === scope[key]))
			.sort((a, b) => Number(a.index) - Number(b.index));
		expect(selected, "F5B_GENUINE_SNAPSHOT_CHUNKS_COMPLETE").toHaveLength(Number(scope.chunkCount));
		return {
			chunks: selected.map((row) => ({ byteLength: row.byteLength, digest: row.digest, index: row.index })),
			exactCanonicalManifestBytes: new Uint8Array(scope.exactCanonicalManifestBytes as Uint8Array),
			scope: {
				anchor: scope.anchor,
				epoch: scope.epoch,
				manifestDigest: scope.manifestDigest,
				objectId: scope.objectId,
			},
			totalBytes: scope.totalBytes,
		} as NonNullable<CreateV3RoomSessionInput["successorSnapshotDeclaration"]>;
	} finally {
		database.close();
	}
}

function floorOwner() {
	let state: V3RoomHeadState | null = null;
	const result = () => ({ ok: true as const, state: structuredClone(state) });
	const same = (value: unknown) => hex(encodeCanonical(value)) === hex(encodeCanonical(state));
	const authority: CreateV3RoomSessionInput["roomHeadAuthority"] = {
		initialization: { kind: "create" },
		read: () => Promise.resolve(result()),
		create: async (input) => {
			await Promise.resolve();
			if (state === null) state = { pending: null, stable: input.stable };
			return result();
		},
		migrate: () => Promise.resolve({ ok: false, reason: "conflict" }),
		begin: async (input) => {
			await Promise.resolve();
			if (!same(input.expected)) return { ok: false, reason: "conflict" };
			const previous = required(state).stable;
			state = { stable: previous, pending: { previous, next: input.next } };
			return result();
		},
		commit: async (input) => {
			await Promise.resolve();
			if (!same(input.expected)) return { ok: false, reason: "conflict" };
			state = { stable: required(required(state).pending).next, pending: null };
			return result();
		},
	};
	return {
		authority,
		read: () => structuredClone(required(state)),
		// Transport the exact floor already committed by the genuine creator.
		receive: (published: V3RoomHeadState) => {
			state = structuredClone(published);
		},
	};
}

interface Peer {
	readonly author: string;
	readonly seed: Uint8Array;
	readonly databaseName: string;
	readonly floor: ReturnType<typeof floorOwner>;
	readonly input: CreateV3RoomSessionInput;
	room: V3RoomSession;
}

async function openRoom(writerCount: number, legacy = false, secondaryAdmin = false, transientPayload = false) {
	const id = ++ordinal;
	const objectId = `creator:${(8000 + id).toString(16).padStart(32, "0")}`;
	const identities = Array.from({ length: writerCount }, (_, index) => {
		const seed = new Uint8Array(32);
		seed[0] = 121;
		seed[1] = index + 1;
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const base = transientPayload ? createTransientPayloadApplication() : createV3ChatApplication("alice");
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(base.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: encodeCanonical([]),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			objectId,
			permissionless: false,
			version: legacy ? 1 : 3,
			members: identities
				.map(({ author }, index) => ({
					author,
					finalityKey: index === 0 ? author : null,
					groups:
						index === 0
							? ["admin", "finality", "writer"]
							: secondaryAdmin && index === 1
								? ["admin", "writer"]
								: ["writer"],
				}))
				.sort((a, b) => (a.author < b.author ? -1 : 1)),
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: legacy ? "creator-trusted-v1" : "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});
	const finality = await createRecoverableFinalitySigner({ seed: creator.seed });
	const ingress = new Map<string, (message: Message) => void>();
	const received = new Set<string>();
	const held = new Set<string>();
	const publicationFailures = new Set<string>();
	const heldApplications = new Set<string>();
	const envelopes: Message[] = [];
	const peers: Peer[] = [];
	const send = async (sender: string, message: Message) => {
		envelopes.push(structuredClone(message));
		if (publicationFailures.has(sender)) return false;
		if (heldApplications.has(sender)) {
			const action = (record(V3Envelope.decode(message.data).canonicalPreimage).operation as Record<string, unknown>)
				.action;
			if (action !== "$drp.author-fence.v1" && action !== "join" && action !== "causalJoin") return true;
		}
		if (held.has(sender) || sender === `d110c-f5b-parent-${id}-peer-0`) return true;
		const target = required(peers[0]);
		const envelope = V3Envelope.decode(message.data);
		const digest = hex(hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimage));
		if (received.has(digest)) return true;
		const operation = record(envelope.canonicalPreimage).operation as Record<string, unknown>;
		required(ingress.get(target.databaseName))(message);
		// Control vertices intentionally have no application callback. A following
		// ordinary issue causally depends on them and supplies the admission ack.
		if (operation.action === "$drp.author-fence.v1" || operation.action === "join" || operation.action === "causalJoin")
			return true;
		// Bounded deterministic scheduling oracle: each real readonly IDB round
		// yields to queued ingress/storage work, with no sleep or elapsed-time test.
		// 256 is a fixture scheduling budget, never a product resource ceiling.
		for (let turn = 0; turn < 256 && !received.has(digest); turn += 1)
			await required(observed.stores.get(target.databaseName)).readLineage({ author: target.author, objectId });
		if (!received.has(digest)) throw new Error(`F5B_ROUTED_OPERATION_NOT_ADMITTED:${digest}`);
		return true;
	};
	const transportFor =
		(databaseName: string): CreateV3RoomSessionInput["openTransport"] =>
		() => {
			const networkNode = fakeNetwork(databaseName);
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			Reflect.set(networkNode, "publishMessage", (_topic: string, message: Message) => send(databaseName, message));
			return {
				networkNode,
				close: () => {
					ingress.delete(databaseName);
				},
				openEphemeral: () => {
					throw new Error("F5B_EPHEMERAL_NOT_USED");
				},
				requestRetainedHistory: () => undefined,
				setRetainedPublisher: () => undefined,
				setIngressHandler: (_topic, handler) => {
					ingress.set(databaseName, handler);
				},
			};
		};
	for (const [index, identity] of identities.entries()) {
		const databaseName = `d110c-f5b-parent-${id}-peer-${index}`;
		const floor = floorOwner();
		const application = {
			...base,
			displacementPolicies: { message: "transform" as const },
			transformDisplacedOperation: transientPayload
				? required(base.transformDisplacedOperation)
				: (operation: Readonly<Record<string, unknown>>) => ({ ...operation, text: "r".repeat(256) }),
		};
		const input: CreateV3RoomSessionInput = {
			application,
			author: identity.author,
			creatorInvite: invite,
			databaseName,
			initialLogicalTime: 3,
			issuanceDatabaseName: databaseName,
			objectId,
			publicKeyBytes: ed25519.getPublicKey(identity.seed),
			roomHeadAuthority: floor.authority,
			...(index === 0 ? { creatorFinalitySigner: finality.signer } : {}),
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				if (index === 0) {
					received.add(digest);
				}
			},
			onProjection: () => undefined,
			signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, identity.seed)),
			openTransport: transportFor(databaseName),
		};
		const room = await createV3RoomSession(input);
		sessions.add(room);
		peers.push({ ...identity, databaseName, floor, input, room });
	}
	const stop = async (peer: Peer) => {
		await peer.room.close();
		sessions.delete(peer.room);
	};
	const reopen = async (peer: Peer, closedEpoch: number, transfer = false, application = peer.input.application) => {
		await stop(peer);
		const origin = required(peers[0]);
		if (transfer) {
			await transferDatabase(`${origin.databaseName}--ahe`, `${peer.databaseName}--ahe`);
			await transferDatabase(
				`${origin.databaseName}--drp-snapshot-quarantine-v1`,
				`${peer.databaseName}--drp-snapshot-quarantine-v1`
			);
			peer.floor.receive(origin.floor.read());
		}
		const declaration = await producedDeclaration(peer.databaseName, closedEpoch);
		const { creatorFinalitySigner, ...reopenInput } = peer.input;
		peer.room = await createV3RoomSession({
			...reopenInput,
			// Legacy keeps its existing restriction. Settlement creator restart must
			// authenticate this existing input pair and rebind close authority.
			...(!legacy && creatorFinalitySigner !== undefined ? { creatorFinalitySigner } : {}),
			application,
			roomHeadAuthority: { ...peer.floor.authority, initialization: { kind: "reopen" } },
			successorSnapshotDeclaration: declaration,
		});
		sessions.add(peer.room);
	};
	const issue = (peer: Peer, clientOperationId: string) =>
		peer.room.issue({ action: "message", clientOperationId, text: clientOperationId });
	const close = async () => {
		const origin = required(peers[0]);
		try {
			return await origin.room.sealEpoch();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (detail === "creator close actor failed: CERTIFIED_VALUE_MISMATCH") {
				// The first preserved run established this earlier compatibility seam.
				// Pin all five successor/cold-checkpoint sites; do not substitute a profile,
				// checkpoint, signature, successful actor result or synthetic authority.
				const source = readFileSync(new URL("../packages/protocol-v3/src/creator-close.ts", import.meta.url), "utf8");
				const owner = (name: string) => {
					const start = source.indexOf(`export function ${name}(`);
					expect(start, `F5B_SUCCESSOR_CODEC_OWNER_${name}`).toBeGreaterThanOrEqual(0);
					const next = source.indexOf("\nexport function ", start + 1);
					return source.slice(start, next === -1 ? undefined : next);
				};
				expect(owner("prepareCreatorAnchorSigningRequest"), "F5B_SUCCESSOR_PROFILE_PREPARATION_V1_ONLY").toContain(
					'profile.profileId !== "creator-trusted-v1"'
				);
				expect(owner("completeCreatorSuccessor"), "F5B_SUCCESSOR_PROFILE_COMPLETION_V1_ONLY").toContain(
					'profileId: "creator-trusted-v1"'
				);
				expect(owner("openCreatorSuccessorTrust"), "F5B_SUCCESSOR_PROFILE_OPEN_V1_ONLY").toContain(
					'decodedRecord.profileId !== "creator-trusted-v1"'
				);
				const checkpointSource = readFileSync(
					new URL("../packages/protocol-v3/src/creator-checkpoint.ts", import.meta.url),
					"utf8"
				);
				expect(
					checkpointSource.slice(
						checkpointSource.indexOf("function trustRecord("),
						checkpointSource.indexOf("function bytesHex(")
					),
					"F5B_CHECKPOINT_CURRENT_PROFILE_V1_ONLY"
				).toContain('decoded.profileId !== "creator-trusted-v1"');
				expect(
					checkpointSource.slice(
						checkpointSource.indexOf("const genesisRecordBytes = encodeCanonical({"),
						checkpointSource.indexOf("const genesis = openCurrentAnchorTrust({")
					),
					"F5B_CHECKPOINT_RECONSTRUCTED_GENESIS_PROFILE_V1_ONLY"
				).toContain('profileId: "creator-trusted-v1"');
				throw new Error(
					"F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED: genuine settlement successor fails CERTIFIED_VALUE_MISMATCH before checkpoint production",
					{ cause: error }
				);
			}
			if (detail !== "creator trust advance failed: TRUST_CLOSURE_INVALID") throw error;
			const candidate = required(observed.advances.at(-1)).proposed as { candidates: { bytes: Uint8Array }[] };
			const kinds = candidate.candidates.map(({ bytes }) => record(bytes).kind);
			if (
				!kinds.includes("drp-creator-issuance-retirement-state") ||
				!kinds.includes("drp-creator-author-issuance-frontiers-state") ||
				kinds.includes("drp-creator-author-settlement-state")
			)
				throw error;
			throw new Error(
				"F5B_AUTHENTICATED_CHECKPOINT_COMPOSITION: genuine close emits legacy retirement/aggregate; settlement advance rejects TRUST_CLOSURE_INVALID",
				{ cause: error }
			);
		}
	};
	const checkpoint = () => {
		const advance = required(observed.advances.at(-1));
		const proposed = advance.proposed as {
			candidates: { bytes: Uint8Array; ref: { byteLength: number; digest: string } }[];
		};
		const selected = (kind: string) => required(proposed.candidates.find(({ bytes }) => record(bytes).kind === kind));
		const settled = selected("drp-creator-author-settlement-state");
		const checkpointRecord = record(settled.bytes);
		const cut = required(
			proposed.candidates.find(
				({ bytes }) =>
					record(bytes).kind === "drp-hard-epoch-cut" &&
					hex(hashDomain("ts-drp/hard-epoch-cut/v3", bytes)) === checkpointRecord.cutValueDigest
			)
		);
		const qc = proposed.candidates.find(
			({ ref }) => ref.digest === (checkpointRecord.commitQcRef as { digest: string }).digest
		);
		const opened = openCreatorAuthorSettlement({
			exactCanonicalRecordBytes: settled.bytes,
			expectedCommitQcRef: required(qc).ref,
			expectedCurrentAclDigest: checkpointRecord.currentAclDigest,
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: record(cut.bytes).snapshotManifestDigest,
			expectedSuccessorAclDigest: checkpointRecord.successorAclDigest,
			floorTrust: advance.successorTrust,
		});
		expect(opened.ok, "F5B_C26_FLOOR_ONLY_CHECKPOINT_OPEN").toBe(true);
		if (!opened.ok) throw new Error("F5B_CHECKPOINT_OPEN_FAILED");
		expect(
			proposed.candidates.filter(({ bytes }) =>
				["drp-creator-issuance-retirement-state", "drp-creator-author-issuance-frontiers-state"].includes(
					String(record(bytes).kind)
				)
			),
			"F5B_NO_LEGACY_CONTROLS"
		).toHaveLength(0);
		return {
			capability: opened.capability,
			identity: required(resolveCreatorAuthorSettlement(opened.capability)),
			bytes: settled.bytes,
			cut: record(cut.bytes),
			candidates: proposed.candidates,
		};
	};
	const deliver = (message: Message) => required(ingress.get(required(peers[0]).databaseName))(message);
	return {
		peers,
		objectId,
		issue,
		close,
		checkpoint,
		reopen,
		stop,
		transportFor,
		held,
		publicationFailures,
		heldApplications,
		envelopes,
		deliver,
		received,
	};
}

async function durable(peer: Peer) {
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: peer.databaseName });
	try {
		const scope = { author: peer.author, objectId: peer.input.objectId };
		const lineage = await store.readLineage(scope);
		const plan = await store.readSettlementPlan(scope);
		const rows: Awaited<ReturnType<typeof store.readOutboxPage>>[number][] = [];
		let afterKey: readonly [string, string, number] | null = null;
		for (;;) {
			const page = await store.readOutboxPage({ scope, limit: 128, afterKey });
			if (page.length === 0) break;
			for (const row of page) {
				expect(row.commit.outboxEntry.scope, "F5B_DURABLE_CENSUS_EXACT_SCOPE").toEqual(scope);
				expect(row.commit.authorSequence, "F5B_DURABLE_CENSUS_STRICT_CURSOR_PROGRESS").toBeGreaterThan(
					afterKey?.[2] ?? -1
				);
				rows.push(row);
				afterKey = [scope.objectId, scope.author, row.commit.authorSequence];
			}
		}
		return { lineage, plan, rows };
	} finally {
		await store.close();
	}
}

function productState(peer: Peer): Uint8Array {
	return required(peer.input.application.migration).canonicalStateBytes(peer.room.projection());
}

function messages(peer: Peer) {
	return decodeCanonical(productState(peer)) as { clientOperationId: string; text: string }[];
}

function ownCommits(peer: Peer) {
	return observed.commits.filter(
		(row) => row.issuedRecord.scope.objectId === peer.input.objectId && row.issuedRecord.scope.author === peer.author
	);
}

function applicationOperations(commit: DurableIssueCommit): Record<string, unknown>[] {
	const operation = record(commit.envelope.canonicalPreimageBytes).operation as Record<string, unknown>;
	return operation.action === "applicationBatch"
		? (operation.batch as { entries: { operation: Record<string, unknown> }[] }).entries.map((entry) => entry.operation)
		: operation.action === "message"
			? [operation]
			: [];
}

async function aheFacts(peer: Peer) {
	const store = await createBrowserAheDurableStore({ databaseName: `${peer.databaseName}--ahe` });
	try {
		const objectId = parseStorageObjectId(peer.input.objectId);
		if (!objectId.ok) throw new Error("F5B_REAL_OBJECT_ID_REQUIRED");
		const recovered = await store.recoverActiveGeneration(objectId.value);
		expect(recovered.ok, "F5B_C24C_GENUINE_ACTIVE_HEAD_RECOVERY").toBe(true);
		if (!recovered.ok || recovered.value.kind !== "active") throw new Error("F5B_ACTIVE_GENERATION_REQUIRED");
		const generations: GenerationRecord[] = [];
		let cursor: Parameters<typeof store.readGenerationPage>[0]["cursor"];
		do {
			const page = await store.readGenerationPage({
				objectId: objectId.value,
				limit: 64,
				...(cursor === undefined ? {} : { cursor }),
			});
			if (!page.ok) throw new Error(`F5B_AHE_ENUMERATION_${page.reason}`);
			generations.push(...page.value.generations);
			cursor = page.value.nextCursor ?? undefined;
		} while (cursor !== undefined);
		return { head: recovered.value.head, generations };
	} finally {
		await store.close();
	}
}

async function assertRetainedRollbackPair(peer: Peer, adoptedEpoch: number) {
	const facts = await aheFacts(peer);
	const retained = facts.generations.filter((generation) => generation.state === "Superseded");
	const expected = Math.min(adoptedEpoch, 2);
	expect(retained, "F5B_C13_C24C_PRODUCT_TRUE_BOUNDED_ROLLBACK_WINDOW").toHaveLength(expected);
	expect(facts.generations, "F5B_C13_BOUNDED_ACTIVE_AND_ROLLBACK_GENERATIONS").toHaveLength(expected + 1);
	const active = required(facts.generations.find((generation) => generation.generationId === facts.head.generationId));
	expect(active.state).toBe("Adopted");
	let base = active.baseExpectedHead;
	for (let index = 0; index < expected; index += 1) {
		if (base.kind !== "present") throw new Error("F5B_C13_ROLLBACK_LINEAGE_GAP");
		const id = base.generationId;
		const prior = required(retained.find((generation) => generation.generationId === id));
		expect(prior.closure.length, "F5B_C13_RETAINED_COMPLETE_CLOSURE").toBeGreaterThan(0);
		expect(prior.closureDigest).toBe(base.closureDigest);
		base = prior.baseExpectedHead;
	}
	return facts;
}

async function displacedFixture() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "timing-creator");
	await fixture.issue(writer, "timing-writer");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "timing-displaced");
	const source = required((await durable(writer)).rows.at(-1));
	expect(source.publishState, "F5B_C19_PUBLISHED_SOURCE_REALLY_DURABLE").toBe("published");
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	return { fixture, creator, writer, source: source.commit, checkpoint };
}

async function delayedDependency() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "dependency-creator");
	await fixture.issue(writer, "dependency-admitted-prefix");
	const prefix = required(ownCommits(writer).at(-1));
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "dependency-n");
	const delayed = required(ownCommits(writer).at(-1));
	await fixture.issue(writer, "dependency-n-plus-one");
	const dependent = required(ownCommits(writer).at(-1));
	expect(dependent.authorSequence, "F5B_C01_TWO_DISTINCT_ADJACENT_AUTHOR_SEQUENCES").toBe(delayed.authorSequence + 1);
	expect(
		record(dependent.envelope.canonicalPreimageBytes).dependencies,
		"F5B_C01_REAL_ISSUE_CAUSALLY_DEPENDS_ON_DELAYED_VERTEX"
	).toContain(hex(delayed.envelope.digest));
	const envelope = required(
		fixture.envelopes.find(
			(message) =>
				hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) ===
				hex(dependent.envelope.digest)
		)
	);
	fixture.deliver(envelope); // Deliver n+1, never n, through real signed ingress.
	await fixture.issue(creator, "dependency-before-close");
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	expect(frontierFor(checkpoint.capability, writer.author)?.[2], "F5B_C01_CLOSE_STAYS_AT_ADMITTED_PREFIX").toBe(
		prefix.authorSequence
	);
	const graph = required(observed.closeGraphs.at(-1));
	for (const row of [delayed, dependent])
		expect(
			graph.input.vertices.has(hex(row.envelope.digest)),
			"F5B_C01_DEPENDENT_NEVER_IN_REAL_CLOSE_GRAPH_WITHOUT_PREDECESSOR"
		).toBe(false);
	for (const row of [delayed, dependent])
		expect(fixture.received.has(hex(row.envelope.digest)), "F5B_C01_NEITHER_DEPENDENCY_NOR_DEPENDENT_ADMITTED").toBe(
			false
		);
	expect(messages(creator).map((row) => row.clientOperationId)).not.toContain("dependency-n-plus-one");
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "dependency-after-recovery");
	const plan = required((await durable(writer)).plan);
	for (const source of [delayed, dependent]) {
		const entry = required(plan.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(entry.sourceDigest).toEqual(source.envelope.digest);
		expect(required(entry.replacementSequence)).toBeGreaterThan(required(plan.fenceSequence));
		expect(
			ownCommits(writer).filter(
				(row) => row.planEffect?.kind === "replacement" && row.planEffect.sourceSequence === source.authorSequence
			),
			"F5B_C01_EXACT_ONE_REPLACEMENT_FOR_EACH_DISTINCT_SOURCE"
		).toHaveLength(1);
	}
	await fixture.close();
	expect(
		frontierFor(fixture.checkpoint().capability, writer.author)?.[2],
		"F5B_C01_FENCE_AND_CONTIGUOUS_REPLACEMENTS_ADVANCE"
	).toBe(required(ownCommits(writer).at(-1)).authorSequence);
	for (const id of ["dependency-n", "dependency-n-plus-one"])
		expect(messages(creator).filter((row) => row.clientOperationId === id)).toEqual([
			{ clientOperationId: id, text: "r".repeat(256) },
		]);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function nullBoundaryClose() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "null-boundary-initial");
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toBeUndefined();
	await creator.room.adoptCreatorSuccessor();
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toEqual([writer.author, 2, null]);
	await creator.room.adoptCreatorSuccessor();
	// Member is authentically re-admitted but stays offline: there is no current
	// slot 0, fence or application from it. Never manufacture a frontier or row.
	await fixture.issue(creator, "null-boundary-close-continues");
	await fixture.close();
	expect(
		frontierFor(fixture.checkpoint().capability, writer.author),
		"F5B_C17_NULL_NO_FENCE_NO_SLOT_ZERO_CLOSE_SUCCEEDS"
	).toEqual([writer.author, 2, null]);
	expect(
		ownCommits(writer).filter((row) => Number(record(row.envelope.canonicalPreimageBytes).epoch) >= 2)
	).toHaveLength(0);
	await fixture.stop(creator);
}

async function delayedPublication(mode: "unpublished-fence" | "delayed-replacement" | "delayed-fence") {
	const { fixture, creator, writer, source, checkpoint } = await displacedFixture();
	if (mode === "unpublished-fence") fixture.publicationFailures.add(writer.databaseName);
	if (mode === "delayed-replacement") fixture.heldApplications.add(writer.databaseName);
	if (mode === "delayed-fence") fixture.held.add(writer.databaseName);
	await fixture.reopen(writer, 0, true);
	if (mode === "unpublished-fence") await expect(fixture.issue(writer, "unpublished-fence-barrier")).rejects.toThrow();
	else await fixture.issue(writer, "delayed-dependent-application");
	const before = await durable(writer);
	const plan = required(before.plan);
	const fence = required(plan.fenceSequence);
	const sourceEntry = required(plan.entries.find((entry) => entry.sourceSequence === source.authorSequence));
	if (mode === "unpublished-fence") {
		expect(
			required(before.rows.find((row) => row.commit.authorSequence === fence)).publishState,
			"F5B_C04_FENCE_DURABLE_UNPUBLISHED"
		).toBe("pending");
		expect(sourceEntry.replacementSequence, "F5B_C04_NO_REPLACEMENT_BEFORE_FENCE_PUBLICATION").toBeNull();
		await fixture.stop(writer);
		fixture.publicationFailures.delete(writer.databaseName);
		await fixture.reopen(writer, 0);
		await fixture.issue(writer, "after-unpublished-fence-crash");
		expect((await durable(writer)).plan?.fenceSequence, "F5B_C04_REPUBLISH_SAME_FENCE_BEFORE_CHECKPOINT").toBe(fence);
		expect(
			ownCommits(writer).filter(
				(row) => row.planEffect?.kind === "fence" && record(row.envelope.canonicalPreimageBytes).epoch === 1
			),
			"F5B_C04_ONE_FENCE_FOR_SAME_PLAN"
		).toHaveLength(1);
	} else {
		const replacement = required(sourceEntry.replacementSequence);
		await fixture.stop(writer);
		await fixture.issue(creator, "close-while-transport-delayed");
		await fixture.close();
		const next = fixture.checkpoint();
		expect(
			frontierFor(next.capability, writer.author)?.[2],
			mode === "delayed-fence" ? "F5B_C16_DELAYED_FENCE_DEPENDENTS_NOT_ADMITTED" : "F5B_C15_ONLY_FENCE_ADMITTED"
		).toBe(mode === "delayed-fence" ? frontierFor(checkpoint.capability, writer.author)?.[2] : fence);
		await creator.room.adoptCreatorSuccessor();
		fixture.held.delete(writer.databaseName);
		fixture.heldApplications.delete(writer.databaseName);
		await fixture.reopen(writer, 1, true);
		await fixture.issue(writer, "after-delayed-close");
		const recovered = required((await durable(writer)).plan);
		expect(recovered.fenceSequence, "F5B_C16_NEXT_EPOCH_LARGER_FENCE").toBeGreaterThan(fence);
		expect(
			recovered.entries.some((entry) => entry.sourceSequence === replacement && entry.replacementSequence !== null),
			"F5B_C15_DISPLACED_REPLACEMENT_BECOMES_SOURCE"
		).toBe(true);
	}
	expect(
		messages(creator).filter((row) => row.clientOperationId === "timing-displaced"),
		"F5B_C15_C16_ONE_APPLICATION_EFFECT"
	).toEqual([{ clientOperationId: "timing-displaced", text: "r".repeat(256) }]);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function ambiguousPlanIssue(kind: "fence" | "replacement", committed: boolean, recoveryFails = false) {
	const { fixture, creator, writer, source } = await displacedFixture();
	observed.ambiguous = { database: writer.databaseName, kind, committed, recoveryFails };
	await fixture.reopen(writer, 0, true);
	// Clarification: the ambiguous owner must halt, but the existing room owner
	// may authenticate a fresh owner and retry once inside the same public call.
	// No activation result/capability is supplied by this fixture.
	const issue = fixture.issue(writer, "unknown-outcome-barrier");
	if (recoveryFails) await expect(issue, "F5B_C25_FAILED_RECOVERY_STAYS_CLOSED").rejects.toThrow();
	else await issue;
	const boundary = required(observed.ambiguities.findLast((row) => row.database === writer.databaseName));
	const entry = required(boundary.plan?.entries.find((row) => row.sourceSequence === source.authorSequence));
	const link = kind === "fence" ? boundary.plan?.fenceSequence : entry.replacementSequence;
	expect(link !== null, `F5B_C25_${kind}_${committed ? "ROW_AND_LINK" : "NEITHER"}`).toBe(committed);
	expect(boundary.row, "F5B_C25_EXACT_DURABLE_ROW_AT_AMBIGUITY").toEqual(committed ? boundary.candidate : null);
	expect(boundary.lineage.next, "F5B_C25_ATOMIC_LINEAGE_WITH_ROW_AND_LINK").toBe(
		boundary.candidate.authorSequence + (committed ? 1 : 0)
	);
	expect(required(boundary.handle).currentEphemeralAuthority(), "F5B_C25_AMBIGUOUS_OWNER_DEACTIVATED").toBeUndefined();
	if (recoveryFails) {
		const unchanged = await durable(writer);
		await expect(fixture.issue(writer, "still-halted")).rejects.toThrow();
		expect(await durable(writer), "F5B_C25_FAILED_RECOVERY_NO_MUTATION").toEqual(unchanged);
		observed.failRecoveryReadFor = "";
		await fixture.reopen(writer, 0);
		await fixture.issue(writer, "recovered-ambiguous-outcome");
	}
	expect(observed.planes.get(writer.databaseName), "F5B_C25_GENUINE_AUTHENTICATED_OWNER_IDENTITY_CHANGES").not.toBe(
		boundary.handle
	);
	for (const row of observed.commits
		.slice(boundary.commitOffset)
		.filter(
			(row) => row.issuedRecord.scope.objectId === fixture.objectId && row.issuedRecord.scope.author === writer.author
		))
		expect(observed.commitHandles.get(row), "F5B_C25_FRESH_OWNER_BEFORE_SUBSEQUENT_ISSUE").not.toBe(boundary.handle);
	for (const publication of observed.publications
		.slice(boundary.publicationOffset)
		.filter((row) => row.database === writer.databaseName))
		expect(publication.handle, "F5B_C25_FRESH_OWNER_BEFORE_SUBSEQUENT_PUBLICATION").not.toBe(boundary.handle);
	const after = required((await durable(writer)).plan);
	const recoveredLink =
		kind === "fence"
			? after.fenceSequence
			: required(after.entries.find((row) => row.sourceSequence === source.authorSequence)).replacementSequence;
	if (committed) {
		expect(recoveredLink, "F5B_C25_LINK_FROM_DURABLE_TRUTH").toBe(link);
	} else expect(recoveredLink, "F5B_C25_UNCOMMITTED_SLOT_REUSED").toBe(boundary.lineage.next);
	const surviving = required(ownCommits(writer).find((row) => row.authorSequence === recoveredLink));
	expect(
		observed.publications.filter(
			(row) => row.database === writer.databaseName && row.sequence === surviving.authorSequence
		),
		"F5B_C25_EXACT_ONE_SURVIVING_PUBLICATION_WITH_EXACT_DIGEST"
	).toEqual([
		{
			database: writer.databaseName,
			sequence: surviving.authorSequence,
			digest: hex(surviving.envelope.digest),
			handle: observed.planes.get(writer.databaseName),
		},
	]);
	expect(
		fixture.envelopes.filter(
			(message) =>
				message.sender === writer.databaseName &&
				hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) ===
					hex(surviving.envelope.digest)
		),
		"F5B_C25_EXACT_ONE_NETWORK_PUBLICATION_NOT_JUST_OUTBOX_MARK"
	).toHaveLength(1);
	expect(
		ownCommits(writer).filter(
			(row) => record(row.envelope.canonicalPreimageBytes).epoch === 1 && row.planEffect?.kind === kind
		),
		"F5B_C25_EXACT_ONE_DURABLE_FENCE_OR_REPLACEMENT"
	).toHaveLength(1);
	const attempts = observed.issueAttempts.filter(
		(row) =>
			row.issuedRecord.scope.objectId === fixture.objectId &&
			row.issuedRecord.scope.author === writer.author &&
			record(row.envelope.canonicalPreimageBytes).epoch === 1 &&
			row.planEffect?.kind === kind
	);
	expect(attempts, "F5B_C25_AT_MOST_ONE_AUTHENTICATED_SIGNED_RETRY").toHaveLength(committed ? 1 : 2);
	expect(
		after.entries.filter((row) => row.sourceSequence === source.authorSequence),
		"F5B_C25_NO_DUPLICATE_DISPOSITION"
	).toHaveLength(1);
	expect(required(after.entries.find((row) => row.sourceSequence === source.authorSequence)).disposition).toBe(
		entry.disposition
	);
	expect(
		messages(creator).filter((row) => row.clientOperationId === "timing-displaced"),
		"F5B_C25_EXACTLY_ONCE_RECOVERY_EFFECT"
	).toHaveLength(1);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function staleLocalHead() {
	const { fixture, creator, writer } = await displacedFixture();
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "linked-before-newer-floor");
	const linked = await durable(writer);
	expect(
		linked.plan?.entries.some((entry) => entry.replacementSequence !== null),
		"F5B_C24A_REAL_LINKED_PLAN_PRECONDITION"
	).toBe(true);
	await fixture.stop(writer);
	await fixture.close();
	fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	// Only the genuinely newer floor is transported. Local AHE/snapshot and
	// issuance bytes remain untouched; no old floor is restored or manufactured.
	writer.floor.receive(creator.floor.read());
	const newer = writer.floor.read();
	const mutations = observed.commits.length;
	await expect(fixture.reopen(writer, 0), "F5B_C24A_STALE_LOCAL_HEAD_FAILS_CLOSED").rejects.toThrow(
		STALE_LOCAL_HEAD_FAILURE
	);
	expect(
		encodeCanonical(await durable(writer)),
		"F5B_C24A_PLAN_REVISION_FENCE_ENTRIES_PROGRESS_LINEAGE_UNCHANGED"
	).toEqual(encodeCanonical(linked));
	expect(writer.floor.read(), "F5B_C24A_NEWER_FLOOR_NEVER_REGRESSES").toEqual(newer);
	expect(observed.commits.length, "F5B_C24A_REJECTED_REOPEN_ISSUES_NOTHING").toBe(mutations);
	const offset = ownCommits(writer).length;
	await fixture.reopen(writer, 1, true);
	await fixture.issue(writer, "after-authenticated-state-transfer");
	expect(
		ownCommits(writer)
			.slice(offset)
			.filter((row) => row.planEffect?.kind === "replacement"),
		"F5B_C24A_NO_REPLACEMENT_REISSUE"
	).toHaveLength(0);
	const remaining = required((await durable(writer)).plan).entries;
	for (const entry of required(linked.plan).entries) {
		const survived = remaining.find((row) => row.sourceSequence === entry.sourceSequence);
		// Authenticated terminal retirement may remove an entry; it may not
		// erase its link and redisposition its already-replaced source.
		if (survived !== undefined) expect(survived, "F5B_C24A_NO_REDISPOSITION").toEqual(entry);
	}
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function sixtyFourWriterGoldenPath() {
	const fixture = await openRoom(64);
	const creator = required(fixture.peers[0]);
	const expected = new Map<string, string>();
	const contributions: { peer: Peer; epoch: number; id: string; commit: DurableIssueCommit }[] = [];
	const displaced: { peer: Peer; source: DurableIssueCommit; id: string; epoch: number }[] = [];
	const adopted: { epoch: number; anchor: string; historyRoot: string; historySize: number; revision: number }[] = [];
	const expectedMembers = fixture.peers
		.map((peer, index) => ({
			author: peer.author,
			finalityKey: index === 0 ? peer.author : null,
			groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
		}))
		.sort((left, right) => (left.author < right.author ? -1 : 1));
	let priorCheckpoint: ReturnType<typeof fixture.checkpoint> | undefined;
	let sealedState: Uint8Array | undefined;
	const semanticState = (rows: { clientOperationId: string; text: string }[]) =>
		encodeCanonical([...rows].sort((left, right) => left.clientOperationId.localeCompare(right.clientOperationId)));
	const accountEpoch = (epoch: number) => {
		for (const { peer, commit } of contributions.filter((row) => row.epoch === epoch)) {
			const plan = required(observed.issuePlans.get(commit));
			const fenceSequence = required(plan.fenceSequence);
			const fences = ownCommits(peer).filter(
				(row) => row.planEffect?.kind === "fence" && record(row.envelope.canonicalPreimageBytes).epoch === epoch
			);
			expect(fences, "F5B_64_EVERY_AUTHOR_EVERY_EPOCH_EXACT_ONE_FENCE").toHaveLength(1);
			const fence = required(fences[0]);
			expect(fence.authorSequence).toBe(fenceSequence);
			expect(fenceSequence, "F5B_64_FENCE_BEFORE_FIRST_ORDINARY_ISSUE").toBeLessThan(commit.authorSequence);
			const beforeFence = required(observed.issuePlans.get(fence));
			expect(beforeFence.scope).toEqual({ author: peer.author, objectId: fixture.objectId });
			expect(beforeFence.fenceSequence).toBeNull();
			expect(beforeFence.entries.some((entry) => entry.disposition === "manual-review")).toBe(false);
			const events = observed.timeline.filter((event) => event.database === peer.databaseName);
			const planAt = events.findIndex((event) => event.kind === "plan" && event.revision === beforeFence.revision);
			const fenceAt = events.findIndex((event) => event.kind === "commit" && event.sequence === fenceSequence);
			const publishedAt = events.findIndex((event) => event.kind === "publication" && event.sequence === fenceSequence);
			const ordinaryAt = events.findIndex(
				(event) => event.kind === "commit" && event.sequence === commit.authorSequence
			);
			expect(planAt, "F5B_64_DURABLE_PLAN_WRITE_EXISTS_BEFORE_FENCE").toBeGreaterThanOrEqual(0);
			expect(planAt).toBeLessThan(fenceAt);
			expect(fenceAt).toBeLessThan(publishedAt);
			expect(publishedAt).toBeLessThan(ordinaryAt);
			const effects = ownCommits(peer).filter(
				(row) =>
					row.authorSequence >= fenceSequence &&
					row.authorSequence < commit.authorSequence &&
					row.planEffect !== undefined
			);
			expect(plan.revision, "F5B_64_EXACT_PLAN_REVISION_ADVANCES_ONLY_WITH_ATOMIC_EFFECTS").toBe(
				beforeFence.revision + effects.length
			);
			expect(
				observed.publications.filter((row) => row.database === peer.databaseName && row.sequence === fenceSequence),
				"F5B_64_EXACT_ONE_FENCE_PUBLICATION"
			).toEqual([
				{
					database: peer.databaseName,
					sequence: fenceSequence,
					digest: hex(fence.envelope.digest),
					handle: observed.commitHandles.get(fence),
				},
			]);
		}
	};
	for (let epoch = 0; epoch <= 3; epoch += 1) {
		for (const [index, peer] of fixture.peers.entries()) {
			const acl = peer.room.previewLatchedAcl().current;
			expect(acl, "F5B_64_EXACT_PRODUCT_ACL_AFTER_RECOVERY").toEqual({
				epoch,
				kind: "drp-v3-latched-acl",
				objectId: fixture.objectId,
				permissionless: false,
				version: 3,
				members: expectedMembers,
			});
			const id = `wide-${epoch}-${index}`;
			await fixture.issue(peer, id);
			const matching = ownCommits(peer).filter((commit) =>
				applicationOperations(commit).some((operation) => operation.clientOperationId === id)
			);
			expect(matching, `F5B_64_E${epoch}_AUTHOR_${index}_EXACT_ONE_ISSUED_OPERATION`).toHaveLength(1);
			const commit = required(matching[0]);
			expect(record(commit.envelope.canonicalPreimageBytes).epoch, "F5B_64_OPERATION_ISSUED_IN_CURRENT_EPOCH").toBe(
				epoch
			);
			expect(
				observed.publications.some(
					(row) =>
						row.database === peer.databaseName &&
						row.sequence === commit.authorSequence &&
						row.digest === hex(commit.envelope.digest)
				),
				"F5B_64_BACKEND_CONFIRMED_PUBLICATION"
			).toBe(true);
			expect(fixture.received.has(hex(commit.envelope.digest)), "F5B_64_CREATOR_AUTHENTICATED_ADMISSION_ACK").toBe(
				true
			);
			expect(
				messages(peer).filter((row) => row.clientOperationId === id),
				"F5B_64_AUTHOR_PRODUCT_APPLIED_OWN_OPERATION"
			).toEqual([{ clientOperationId: id, text: id }]);
			contributions.push({ peer, epoch, id, commit });
			expected.set(id, id);
			if (epoch > 0) {
				const current = required(peer.room.authority());
				expect(current.epoch, "F5B_64_REJOIN_CONTRIBUTES_BEFORE_NEXT_CLOSE").toBe(epoch);
				expect(current.anchorDigest).toBe(required(priorCheckpoint).identity.successorAnchorDigest);
				expect(current.aclDigest).toBe(required(priorCheckpoint).identity.successorAclDigest);
				expect(current.aclDigest, "F5B_64_AUTHORITY_BINDS_EXACT_RECOVERED_ACL").toBe(
					hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(acl)))
				);
				expect(current.profileId, "F5B_64_SETTLEMENT_AUTHORITY_NO_DOWNGRADE").toBe("creator-trusted-settlement-v1");
				const floor = peer.floor.read();
				expect(floor.pending).toBeNull();
				expect(floor.stable).toMatchObject({ epoch, currentAnchorDigest: current.anchorDigest });
				const ownRecovered = displaced.filter((row) => row.peer === peer && row.epoch === epoch - 1);
				const expectedLocal = [
					...(decodeCanonical(required(sealedState)) as { clientOperationId: string; text: string }[]),
					...ownRecovered.map((row) => ({ clientOperationId: row.id, text: "r".repeat(256) })),
					{ clientOperationId: id, text: id },
				];
				// Creator also receives peers' automatically drained replacements; its
				// complete shared projection is checked after all 64 admission acks.
				if (peer !== creator)
					expect(semanticState(messages(peer)), "F5B_64_EXACT_RECOVERED_PRODUCT_STATE_PER_AUTHOR").toEqual(
						semanticState(expectedLocal)
					);
				for (const source of ownRecovered) {
					const plan = required((await durable(peer)).plan);
					const entry = required(plan.entries.find((row) => row.sourceSequence === source.source.authorSequence));
					const replacement = required(entry.replacementSequence);
					expect(entry.disposition, "F5B_64_REAL_TRANSFORM_DISPOSITION").toBe("transform");
					expect(required(plan.fenceSequence), "F5B_64_PLAN_FENCE_REPLACEMENT_ORDER").toBeLessThan(replacement);
					expect(
						ownCommits(peer).filter(
							(row) =>
								row.planEffect?.kind === "replacement" && row.planEffect.sourceSequence === source.source.authorSequence
						),
						"F5B_64_EXACT_ONE_REPLACEMENT_LINK"
					).toHaveLength(1);
					expected.set(source.id, "r".repeat(256));
				}
			}
		}
		const expectedMessages = [...expected].map(([clientOperationId, text]) => ({ clientOperationId, text }));
		expect(semanticState(messages(creator)), "F5B_64_EXACT_CREATOR_APPLICATION_STATE").toEqual(
			semanticState(expectedMessages)
		);
		expect(
			hex(hashDomain("ts-drp/state/v3", semanticState(messages(creator)))),
			"F5B_64_EXACT_PRODUCT_SEMANTIC_DIGEST"
		).toBe(hex(hashDomain("ts-drp/state/v3", semanticState(expectedMessages))));
		if (epoch === 3) {
			accountEpoch(epoch);
			break;
		}
		// Rotating eight-author cohort has ALREADY issued/admitted/applied/published
		// in this epoch. It remains genuinely stopped over close/adopt and the
		// selected creator cold restart, then rejoins before the next epoch's issue.
		const cohort = fixture.peers.slice(1 + epoch * 8, 9 + epoch * 8);
		for (const [index, peer] of cohort.slice(0, 2).entries()) {
			const id = `wide-displaced-${epoch}-${index}`;
			if (index === 0) fixture.held.add(peer.databaseName);
			else fixture.publicationFailures.add(peer.databaseName);
			if (index === 0) await fixture.issue(peer, id);
			else await expect(fixture.issue(peer, id), "F5B_64_SELECTED_PENDING_PUBLICATION_FAILURE").rejects.toThrow();
			const row = required(
				(await durable(peer)).rows.find((candidate) =>
					applicationOperations(candidate.commit).some((operation) => operation.clientOperationId === id)
				)
			);
			expect(row.publishState, "F5B_64_PENDING_AND_PUBLISHED_DISPLACED_INPUTS").toBe(
				index === 0 ? "published" : "pending"
			);
			displaced.push({ peer, source: row.commit, id, epoch });
		}
		await Promise.all(cohort.map(fixture.stop));
		sealedState = productState(creator);
		await fixture.close();
		const checkpoint = fixture.checkpoint();
		accountEpoch(epoch);
		const graph = required(observed.closeGraphs.at(-1));
		const admitted = fixture.peers
			.flatMap(ownCommits)
			.filter(
				(row) =>
					record(row.envelope.canonicalPreimageBytes).epoch === epoch &&
					!displaced.some((source) => hex(source.source.envelope.digest) === hex(row.envelope.digest))
			);
		expect(
			[...graph.result.closeSetOrder].sort(),
			"F5B_64_EXACT_CLOSE_SET_COUNTS_APPLICATION_AND_CONTROL_VERTICES"
		).toEqual(admitted.map((row) => hex(row.envelope.digest)).sort());
		for (const row of admitted)
			expect(
				graph.input.authenticatedCanonicalPreimageByteLengths.get(hex(row.envelope.digest)),
				"F5B_64_EXACT_SIGNED_BYTE_CHARGES_INCLUDE_FENCES"
			).toBe(row.envelope.canonicalPreimageBytes.byteLength);
		expect(checkpoint.identity.historySize, "F5B_64_EXACT_HISTORY_SIZE_NOT_ONLY_MONOTONICITY").toBe(
			(priorCheckpoint?.identity.historySize ?? 0) + admitted.length
		);
		expect(checkpoint.identity.historyRoot, "F5B_64_HISTORY_ROOT_BINDS_COMPLETE_REAL_GRAPH").toBe(
			graph.result.historyRoot
		);
		expect(checkpoint.cut.closeSetCount).toBe(admitted.length);
		expect(checkpoint.cut.closeSetRoot).toBe(graph.result.closeSetRoot);
		expect(checkpoint.identity.frontiers, "F5B_64_AUTHENTICATED_ACL_MEMBER_VECTOR").toHaveLength(64);
		expect(checkpoint.cut.stateDigest, "F5B_64_SNAPSHOT_BINDS_EXACT_PRODUCT_STATE").toBe(
			hex(hashDomain("ts-drp/state/v3", sealedState))
		);
		for (const contribution of contributions.filter((row) => row.epoch === epoch))
			expect(
				frontierFor(checkpoint.capability, contribution.peer.author)?.[2],
				"F5B_64_CHECKPOINT_ACCOUNTS_EVERY_AUTHOR_APPLICATION"
			).toBeGreaterThanOrEqual(contribution.commit.authorSequence);
		if (priorCheckpoint !== undefined) {
			expect(checkpoint.identity.closedAnchorDigest, "F5B_64_CONTIGUOUS_ANCHOR_LINEAGE").toBe(
				priorCheckpoint.identity.successorAnchorDigest
			);
			expect(checkpoint.identity.priorCheckpointDigest, "F5B_64_ADJACENT_CHECKPOINT_LINK").toBe(
				hex(hashDomain("ts-drp/creator-author-settlement/v1", priorCheckpoint.bytes))
			);
			expect(checkpoint.identity.historySize, "F5B_64_MONOTONE_HISTORY_ACCOUNTING").toBeGreaterThan(
				priorCheckpoint.identity.historySize
			);
			expect(checkpoint.identity.historyRoot, "F5B_64_HISTORY_ROOT_ADVANCES").not.toBe(
				priorCheckpoint.identity.historyRoot
			);
		}
		await creator.room.adoptCreatorSuccessor();
		expect(productState(creator), "F5B_64_ADOPTION_EXACT_STATE_BYTES").toEqual(sealedState);
		const authority = required(creator.room.authority());
		const head = await assertRetainedRollbackPair(creator, epoch + 1);
		expect(authority.anchorDigest).toBe(checkpoint.identity.successorAnchorDigest);
		expect(authority.aclDigest).toBe(checkpoint.identity.successorAclDigest);
		expect(creator.floor.read().stable.epoch, "F5B_C24C_MONOTONE_AUTHENTICATED_FLOOR").toBe(epoch + 1);
		const previous = adopted.at(-1);
		if (previous !== undefined)
			expect(head.head.revision, "F5B_C24C_MONOTONE_ACTIVE_HEAD_REVISION").toBeGreaterThan(previous.revision);
		adopted.push({
			epoch: authority.epoch,
			anchor: authority.anchorDigest,
			historyRoot: checkpoint.identity.historyRoot,
			historySize: checkpoint.identity.historySize,
			revision: head.head.revision,
		});
		if (epoch === 1) {
			await fixture.reopen(creator, epoch);
			expect(productState(creator), "F5B_64_CREATOR_RESTART_EXACT_PRODUCT_STATE").toEqual(sealedState);
			expect(creator.room.authority(), "F5B_64_CREATOR_RESTART_AUTHORITY_IDENTICAL").toEqual(authority);
			expect((await aheFacts(creator)).head, "F5B_64_RESTART_PRESERVES_ACTIVE_HEAD").toEqual(head.head);
		}
		for (const peer of cohort) {
			fixture.held.delete(peer.databaseName);
			fixture.publicationFailures.delete(peer.databaseName);
		}
		// Reopen only: all publication remains explicitly awaited by next epoch's
		// issue. Independent stores/transport receivers can authenticate in parallel.
		await Promise.all(fixture.peers.slice(1).map((peer) => fixture.reopen(peer, epoch, true)));
		priorCheckpoint = checkpoint;
	}
	expect(contributions, "F5B_64_EXACT_256_CURRENT_EPOCH_APPLICATION_ISSUES").toHaveLength(256);
	expect(displaced, "F5B_64_SIX_BOUNDED_PENDING_PUBLISHED_RECOVERY_SOURCES").toHaveLength(6);
	expect(
		adopted.map((row) => row.epoch),
		"F5B_C24C_THREE_MONOTONE_TRANSITIONS"
	).toEqual([1, 2, 3]);
	for (const peer of fixture.peers) {
		expect(
			contributions.filter((row) => row.peer === peer).map((row) => row.epoch),
			"F5B_64_PER_AUTHOR_FOUR_EPOCH_ACCOUNTING"
		).toEqual([0, 1, 2, 3]);
		const commits = ownCommits(peer);
		const lineage = (await durable(peer)).lineage;
		expect(
			commits.map((row) => row.authorSequence),
			"F5B_64_NO_HOLE_OR_DUPLICATE_DEVICE_LINEAGE"
		).toEqual(Array.from({ length: lineage.next }, (_, sequence) => sequence));
		const publications = new Set(
			observed.publications.filter((row) => row.database === peer.databaseName).map((row) => row.sequence)
		);
		for (const commit of commits) {
			const marks = observed.publications.filter(
				(row) => row.database === peer.databaseName && row.sequence === commit.authorSequence
			);
			expect(marks, "F5B_64_NO_DUPLICATE_PUBLICATION_MARK").toHaveLength(
				publications.has(commit.authorSequence) ? 1 : 0
			);
			for (const mark of marks) expect(mark.digest).toBe(hex(commit.envelope.digest));
		}
		const intentionallyNeverPublished = displaced
			.filter((row) => row.peer === peer)
			.filter((row) => !publications.has(row.source.authorSequence));
		expect(
			publications.size + intentionallyNeverPublished.length,
			"F5B_64_PER_AUTHOR_OPERATION_PUBLICATION_CONSERVATION"
		).toBe(commits.length);
	}
	const aggregate = fixture.peers.flatMap(ownCommits);
	expect(
		aggregate
			.flatMap(applicationOperations)
			.filter((operation) => String(operation.clientOperationId).startsWith("wide-")).length,
		"F5B_64_AGGREGATE_ISSUES_INCLUDE_SOURCES_AND_REPLACEMENTS"
	).toBe(268);
	expect(messages(creator), "F5B_64_EXACT_262_UNIQUE_APPLICATION_EFFECTS").toHaveLength(262);
	const finalCanonicalState = productState(creator).slice();
	expect(
		finalCanonicalState.byteLength,
		"F5B_64_ACTUAL_FINAL_CANONICAL_STATE_WITHIN_UNCHANGED_CEILING"
	).toBeLessThanOrEqual(32_768);
	const finalAuthority = creator.room.authority();
	const finalAccounting = {
		commits: aggregate.length,
		publications: observed.publications.filter((row) =>
			fixture.peers.some((peer) => peer.databaseName === row.database)
		).length,
	};
	await fixture.reopen(creator, 2);
	expect(productState(creator), "F5B_64_FINAL_COLD_REOPEN_EXACT_CANONICAL_STATE_BYTES").toEqual(finalCanonicalState);
	expect(creator.room.authority(), "F5B_64_FINAL_COLD_REOPEN_EXACT_AUTHORITY").toEqual(finalAuthority);
	expect(
		{
			commits: fixture.peers.flatMap(ownCommits).length,
			publications: observed.publications.filter((row) =>
				fixture.peers.some((peer) => peer.databaseName === row.database)
			).length,
		},
		"F5B_64_FINAL_COLD_REOPEN_NO_DUPLICATE_ISSUE_PUBLICATION"
	).toEqual(finalAccounting);
	expect(semanticState(messages(creator)), "F5B_64_FINAL_CREATOR_COLD_REOPEN_EXACT_STATE").toEqual(
		semanticState([...expected].map(([clientOperationId, text]) => ({ clientOperationId, text })))
	);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function positiveAuthenticatedPruning() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	for (let epoch = 0; epoch < 3; epoch += 1) {
		await Promise.all(fixture.peers.map((peer, index) => fixture.issue(peer, `prune-${epoch}-${index}`)));
		const before = observed.prunes.length;
		await fixture.close();
		const checkpoint = fixture.checkpoint();
		expect(
			observed.prunes
				.slice(before)
				.some((event) => event.receipt?.deletedAuthorSequenceRange !== null && event.receipt !== undefined),
			"F5B_C13_NO_PRUNING_FROM_STAGING_ALONE"
		).toBe(false);
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(required(fixture.peers[1]), epoch, true);
		await fixture.issue(required(fixture.peers[1]), `prune-reopened-${epoch}`);
		for (const peer of fixture.peers) {
			await assertRetainedRollbackPair(peer, epoch + 1);
			const events = observed.prunes.filter(
				(event) =>
					event.database === peer.databaseName &&
					event.receipt?.deletedAuthorSequenceRange !== null &&
					event.receipt !== undefined
			);
			if (epoch < 2) {
				// First adoption has only one rollback parent; second establishes
				// the full window but has no older prefix outside that window.
				expect(events, "F5B_C13_NO_PREFIX_DELETE_BEFORE_FULL_WINDOW_AND_OLDER_PREFIX").toHaveLength(0);
				continue;
			}
			expect(events.length, "F5B_C13_PARENT_OWNER_ACTUALLY_DELETES_ISSUANCE").toBeGreaterThan(0);
			const first = required(events[0]);
			expect(
				first.receipt?.deletedAuthorSequenceRange?.from,
				"F5B_C13_PARENT_IS_FIRST_DELETING_MUTATION_NOT_RECEIPT_REPLAY"
			).toBe(0);
			expect(first.stack, "F5B_C13_PRODUCT_OWNER_CALL_CHAIN").toMatch(/packages\/node\/|examples\/v3-room\//u);
			const current = required(events.at(-1));
			const receipt = required(current.receipt);
			expect(receipt.scope).toEqual({ objectId: fixture.objectId, author: peer.author });
			expect(receipt.snapshotManifestDigest).toBe(checkpoint.identity.snapshotManifestDigest);
			expect(receipt.commitQcRef).toEqual(checkpoint.identity.commitQcRef);
			const proof = observed.cleanup.findLast((event) => {
				const input = event.input as {
					issuance?: { scope?: { author?: string } };
					close?: { closedEpoch?: number; objectId?: string };
				};
				return (
					input.issuance?.scope?.author === peer.author &&
					input.close?.closedEpoch === epoch &&
					input.close.objectId === fixture.objectId
				);
			});
			expect(required(proof).result, "F5B_C13_AUTHENTICATED_ADOPTION_ROLLBACK_AVAILABILITY_GATE_OWNER").toMatchObject({
				ok: true,
			});
			expect(required(proof).input).toMatchObject({
				adoption: { adopted: true },
				close: { verified: true, closedEpoch: epoch, commitQcRef: checkpoint.identity.commitQcRef },
				snapshot: { adopted: true, manifestDigest: checkpoint.identity.snapshotManifestDigest },
				issuance: { complete: true },
			});
			const durableState = await durable(peer);
			expect(
				durableState.rows.every((row) => row.commit.authorSequence > receipt.prunedThroughAuthorSequence),
				"F5B_C13_REAL_ISSUANCE_PREFIX_GONE"
			).toBe(true);
		}
	}
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function displacedControls() {
	const fixture = await openRoom(2, false, true);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "control-creator");
	await fixture.issue(writer, "control-writer");
	fixture.held.add(writer.databaseName);
	await writer.room.issue({ action: "join", clientId: "alice" });
	const join = required(ownCommits(writer).at(-1));
	await writer.room.issue({ action: "acl", group: "writer", kind: "revoke", target: creator.author });
	const acl = required(ownCommits(writer).at(-1));
	await fixture.close();
	fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	const decisions: { action: string; commits: number; planWrites: number }[] = [];
	const application: CreateV3RoomSessionInput["application"] = {
		...writer.input.application,
		displacedOperationIdentity: (operation) =>
			operation.action === "acl"
				? hex(encodeCanonical(operation))
				: writer.input.application.displacedOperationIdentity(operation),
		displacementPolicies: {
			...writer.input.application.displacementPolicies,
			get acl() {
				decisions.push({ action: "acl", commits: ownCommits(writer).length, planWrites: observed.planWrites.length });
				return "manual-review" as const;
			},
		},
	};
	const before = ownCommits(writer).length;
	await fixture.reopen(writer, 0, true, application);
	await expect(
		fixture.issue(writer, "acl-review-barrier"),
		"F5B_C21_DISPLACED_ACL_HOLDS_BEFORE_FENCE"
	).rejects.toThrow();
	expect(decisions.length, "F5B_C21_ACL_SURFACED_TO_REAL_APPLICATION_POLICY").toBeGreaterThan(0);
	expect(
		decisions.every((decision) => decision.commits === before),
		"F5B_C21_POLICY_PRECEDES_ANY_NEW_ISSUE"
	).toBe(true);
	const held = await durable(writer);
	expect(held.plan).toMatchObject({
		fenceSequence: null,
		entries: [{ sourceSequence: acl.authorSequence, disposition: "manual-review", replacementSequence: null }],
	});
	expect(
		held.plan?.entries.some((entry) => entry.sourceSequence === join.authorSequence),
		"F5B_C21_DISPLACED_JOIN_HAS_NO_APPLICATION_DISPOSITION"
	).toBe(false);
	expect(messages(creator), "F5B_C21_CONTROL_HAS_NO_APPLICATION_EFFECT").toHaveLength(2);
	const plane = required(observed.planes.get(writer.databaseName));
	await expect(
		plane.completeRebaseSource({ authorSequence: acl.authorSequence, digest: hex(acl.envelope.digest) }),
		"F5B_C20_REAL_SETTLEMENT_HANDLE_CANNOT_MARK_SOURCE_COMPLETE"
	).resolves.toMatchObject({
		ok: false,
		kind: "not-active",
		detail: "v3 displaced source completion is unavailable under settlement",
	});
	expect(await durable(writer), "F5B_C20_PLAN_IS_ONLY_COMPLETION_OWNER").toEqual(held);
	// No new parent behavior is duplicated for the identical structural-no-intent
	// causalJoin classifier: exact closed signed cross-anchor vector is retained in
	// phase-6b-d110c-0c1f5b0b-node-red.test.ts, "[control] classifies signed same-key
	// cross-anchor causalJoin without application intents". Its reserved local ABI
	// remains covered by phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts.
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function sameKeyReentry() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "reentry-creator-initial");
	await fixture.issue(writer, "reentry-writer-initial");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "old-incarnation-unadmitted");
	const previous = await durable(writer);
	const oldEnvelope = required(fixture.envelopes.findLast((message) => message.sender === writer.databaseName));
	const oldVertex = record(V3Envelope.decode(oldEnvelope.data).canonicalPreimage);
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	for (let epoch = 0; epoch < 3; epoch += 1) {
		await fixture.issue(creator, `removed-epoch-${epoch}`);
		await fixture.close();
		const checkpoint = fixture.checkpoint();
		expect(frontierFor(checkpoint.capability, writer.author), "F5B_C06_ABSENT_ACROSS_MULTIPLE_CLOSES").toBeUndefined();
		await creator.room.adoptCreatorSuccessor();
	}
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	const returning = required(frontierFor(checkpoint.capability, writer.author));
	// Unlike a role-only transition, complete removal and regrant creates a new
	// authenticated incarnation, with no retired-key dictionary or lineage jump.
	expect(returning, "F5B_C07_SAME_KEY_NEW_INCARNATION").toEqual([writer.author, 4, null]);
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	const offset = observed.commits.length;
	await fixture.reopen(writer, 3, true);
	await fixture.issue(writer, "same-device-reentry");
	const issued = observed.commits
		.slice(offset)
		.filter((row) => record(row.envelope.canonicalPreimageBytes).author === writer.author);
	const first = required(issued[0]);
	expect(first.authorSequence, "F5B_C07_NEVER_RESET_DEVICE_SEQUENCE").toBe(previous.lineage.next);
	expect(record(first.envelope.canonicalPreimageBytes).operation, "F5B_C07_EMPTY_PLAN_STILL_FENCES").toMatchObject({
		action: "$drp.author-fence.v1",
	});
	expect((await durable(writer)).plan?.entries, "F5B_C07_OLD_INCARNATION_NOT_REBASED").toHaveLength(0);
	expect(oldVertex.epoch, "F5B_C09_OLD_VERTEX_REMAINS_ON_ITS_DEAD_ANCHOR").toBeLessThan(returning[1]);
	expect(oldVertex.anchor, "F5B_C09_CROSS_ANCHOR_PAIR_IS_NOT_EQUIVOCATION").not.toBe(
		creator.room.authority()?.anchorDigest
	);
	fixture.deliver(oldEnvelope);
	await fixture.issue(writer, "after-rejected-stale-envelope");
	const accepted = Reflect.get(creator.room.projection(), "accepted") as { clientOperationId: string }[];
	expect(
		accepted.map((row) => row.clientOperationId),
		"F5B_C09_STALE_INCARNATION_REJECTED_AT_REAL_INGRESS"
	).not.toContain("old-incarnation-unadmitted");
	await fixture.stop(writer);
	// A fresh installation receives the very same published authenticated bytes;
	// no issued/outbox/plan row from the returning device is copied to it.
	const fresh = {
		...writer,
		databaseName: `${writer.databaseName}-fresh`,
		floor: floorOwner(),
		input: {
			...writer.input,
			databaseName: `${writer.databaseName}-fresh`,
			issuanceDatabaseName: `${writer.databaseName}-fresh`,
			openTransport: fixture.transportFor(`${writer.databaseName}-fresh`),
		},
	};
	await fixture.reopen(fresh, 3, true);
	await fixture.issue(fresh, "fresh-device-reentry");
	expect((await durable(fresh)).lineage.next, "F5B_C08_FRESH_DEVICE_STARTS_AT_ZERO").toBeGreaterThanOrEqual(2);
	const freshStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: fresh.databaseName });
	try {
		const zero = required(await freshStore.readIssued({ author: fresh.author, objectId: fixture.objectId }, 0));
		expect(record(zero.envelope.canonicalPreimageBytes).operation, "F5B_C08_FRESH_DEVICE_FENCE_ZERO").toMatchObject({
			action: "$drp.author-fence.v1",
			fenceSequence: 0,
		});
	} finally {
		await freshStore.close();
	}
	await fixture.stop(fresh);
	await fixture.stop(creator);
}

async function manualReviewHold() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "manual-creator-before");
	await fixture.issue(writer, "manual-writer-before");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "manual-displaced");
	await fixture.close();
	const first = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	const before = await durable(writer);
	await fixture.reopen(writer, 0, true, {
		...writer.input.application,
		displacementPolicies: { message: "manual-review" },
	});
	await expect(fixture.issue(writer, "must-stay-held"), "F5B_C11_MANUAL_REVIEW_BARRIER").rejects.toThrow();
	const held = await durable(writer);
	expect(held.lineage, "F5B_C05_C11_NO_FENCE_OR_REPLACEMENT_WHILE_HELD").toEqual(before.lineage);
	expect(held.plan?.fenceSequence, "F5B_C11_DURABLE_UNFENCED_PLAN").toBeNull();
	expect(
		held.plan?.entries.some((entry) => entry.disposition === "manual-review"),
		"F5B_C11_PLAN_HOLD_DURABLE"
	).toBe(true);
	await fixture.issue(creator, "manual-other-author-progress");
	await fixture.close();
	const second = fixture.checkpoint();
	expect(frontierFor(second.capability, creator.author)?.[2], "F5B_C11_ONLY_HELD_AUTHOR_STALLS").toBeGreaterThan(
		required(frontierFor(first.capability, creator.author)?.[2])
	);
	expect(frontierFor(second.capability, writer.author)?.[2], "F5B_C11_HELD_BOUNDARY_UNCHANGED").toBe(
		frontierFor(first.capability, writer.author)?.[2]
	);
	await creator.room.adoptCreatorSuccessor();
	// The original source must still exist while unlinked; backend primitive
	// conformance additionally tests direct prune refusal under the same gate.
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: writer.databaseName });
	try {
		for (const entry of required(held.plan).entries)
			expect(
				await store.readIssued({ author: writer.author, objectId: fixture.objectId }, entry.sourceSequence),
				"F5B_C13_UNLINKED_SOURCE_RETAINED_ACROSS_CLOSE"
			).not.toBeNull();
	} finally {
		await store.close();
	}
	// Hold survives an authenticated transition and cold reopen byte-for-byte.
	const heldPolicy = Object.freeze({
		...writer.input.application,
		displacementPolicies: Object.freeze({ message: "manual-review" as const }),
	});
	await fixture.reopen(writer, 1, true, heldPolicy);
	await expect(fixture.issue(writer, "held-after-cold-reopen")).rejects.toThrow(
		"v3 room settlement plan requires manual review"
	);
	expect(encodeCanonical((await durable(writer)).plan), "F5B_C11_CROSS_CLOSE_COLD_REOPEN_PRESERVES_HELD_PLAN").toEqual(
		encodeCanonical(held.plan)
	);
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toBeUndefined();
	await creator.room.adoptCreatorSuccessor();
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toEqual([writer.author, 4, null]);
	await creator.room.adoptCreatorSuccessor();
	await fixture.reopen(writer, 3, true, heldPolicy);
	await fixture.issue(writer, "readmitted-after-hold");
	expect(
		(await durable(writer)).plan?.entries,
		"F5B_C11_AUTHENTICATED_READMISSION_RETIRES_OLD_HOLD_NO_RESOLVER"
	).toEqual([]);
	expect(
		messages(creator).map((row) => row.clientOperationId),
		"F5B_C11_AUTHOR_WIDE_READMISSION_DISCARDS_OLD_CONTENT_NOT_MODERATOR_APPROVAL"
	).not.toContain("manual-displaced");
	await fixture.stop(writer);
	await fixture.stop(creator);
}

async function creatorFenceScan(duplicate = false, stale = false) {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "scan-creator-before");
	await fixture.issue(writer, "scan-writer-before");
	await fixture.close();
	const first = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "scan-writer-current");
	const authority = required(creator.room.authority());
	const makeFence = (sequence: number, fenceSequence: number, dependency = authority.anchorDigest) => {
		const canonicalPreimage = encodeCanonical({
			anchor: authority.anchorDigest,
			author: writer.author,
			authorSequence: sequence,
			dependencies: [dependency],
			epoch: authority.epoch,
			kind: "drp-vertex",
			logicalTime: 10_000 + sequence,
			objectId: fixture.objectId,
			operation: { action: "$drp.author-fence.v1", fenceSequence, version: 1 },
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimage);
		return {
			digest: hex(digest),
			message: Message.create({
				objectId: required(observed.planes.get(creator.databaseName)).topic,
				data: V3Envelope.encode({ canonicalPreimage, signature: ed25519.sign(digest, writer.seed) }).finish(),
				sender: writer.databaseName,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			}),
		};
	};
	// Adversarial author signs its own operations. Only operation bytes are
	// adversarial; creator graph, signature checking, close and checkpoint are real.
	const lower = makeFence(10_000, 10_000);
	const largest = makeFence(10_001, 10_001, lower.digest);
	if (stale) {
		fixture.deliver(makeFence(10_000, required(frontierFor(first.capability, writer.author)?.[2])).message);
	} else {
		fixture.deliver(lower.message);
		if (duplicate) fixture.deliver(makeFence(10_000, 9999).message);
		fixture.deliver(largest.message);
	}
	fixture.deliver(makeFence(10_002, 10_003).message); // m > f: malformed control
	await fixture.issue(writer, "scan-after-fences"); // FIFO ingress acknowledgement
	await fixture.issue(creator, "scan-independent-creator");
	await fixture.close();
	const second = fixture.checkpoint();
	expect(
		frontierFor(second.capability, writer.author)?.[2],
		duplicate
			? "F5B_C23_SAME_SLOT_DUPLICATE_BELOW_FENCE_FREEZES_PRIOR_BOUNDARY"
			: "F5B_C12_LARGEST_VALID_FENCE_THEN_CONTIGUOUS_SCAN"
	).toBe(
		duplicate
			? frontierFor(first.capability, writer.author)?.[2]
			: stale
				? required(ownCommits(writer).at(-1)).authorSequence
				: 10_001
	);
	if (stale)
		expect(
			frontierFor(second.capability, writer.author)?.[2],
			"F5B_C12_M_AT_OR_BELOW_TERMINAL_CANNOT_BRIDGE_UNKNOWN_SLOTS"
		).toBeLessThan(10_000);
	expect(
		frontierFor(second.capability, creator.author)?.[2],
		duplicate ? "F5B_C23_OTHER_AUTHOR_ADVANCES_DESPITE_DUPLICATE" : "F5B_C12_BYZANTINE_JUMP_ONLY_BURNS_OWN_SPACE"
	).toBeGreaterThan(required(frontierFor(first.capability, creator.author)?.[2]));
	await creator.room.adoptCreatorSuccessor();
	await fixture.stop(writer);
	await fixture.stop(creator);
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: {
			estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }),
		},
	});
	observed.stores.clear();
	observed.planes.clear();
	observed.commits = [];
	observed.advances = [];
	observed.failSuffixFor = "";
	observed.faults = 0;
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	observed.issueAttempts = [];
	observed.commitHandles.clear();
	observed.issuePlans.clear();
	observed.timeline = [];
	observed.ambiguities = [];
	observed.publications = [];
	observed.planWrites = [];
	observed.prunes = [];
	observed.cleanup = [];
	observed.closeGraphs = [];
});
afterEach(async () => {
	observed.failSuffixFor = "";
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	await Promise.all([...sessions].map((room) => room.close().catch(() => undefined)));
	sessions.clear();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});

describe("D.110c-0c1f5b parent genuine settlement composition", () => {
	it("retains checkpoint-terminal open progress through cold recovery across three transitions", async () => {
		const fixture = await openRoom(2, false, false, true);
		const creator = required(fixture.peers[0]);
		const writer = required(fixture.peers[1]);
		const application = creator.input.application;
		const blueprintDigest = required(application.catalog.blueprintDigests[0]);
		const artifact = application.catalog.resolve(blueprintDigest);
		expect(artifact.canonicalBlueprintPackageBytes, "F5B_C03_CATALOG_PACKAGE_MATCHES_REAL_APPLICATION").toEqual(
			application.canonicalBlueprintPackageBytes
		);
		expect(blueprintDigest, "F5B_C03_REAL_LOCAL_PACKAGE_DIGEST").toBe(
			hex(hashDomain("ts-drp/blueprint-admission/v3", application.canonicalBlueprintPackageBytes))
		);
		expect(
			record(application.canonicalBlueprintPackageBytes).implementation,
			"F5B_C03_LOCAL_ARTIFACT_ID_AND_DIGEST_COUPLED"
		).toEqual({
			artifactId: "f5b-transient-payload.v1",
			artifactDigest: hex(hashDomain("ts-drp/blueprint-artifact/v3", artifact.exactArtifactBytes)),
			runtimeProfile: "ecmascript-2024-sync-v1",
		});
		const invite = creator.input.creatorInvite;
		if (typeof invite === "string") throw new TypeError("F5B_C03_EXACT_CREATOR_INVITE_MATERIAL_REQUIRED");
		expect(
			record(invite.exactCanonicalGenesisAnchorPreimageBytes).blueprintDigest,
			"F5B_C03_GENUINE_INVITE_BINDS_LOCAL_BLUEPRINT"
		).toBe(blueprintDigest);
		await fixture.issue(creator, "creator-before-close");
		await fixture.issue(writer, "writer-before-close");
		fixture.held.add(writer.databaseName);
		await Promise.all([fixture.issue(writer, "displaced-0"), fixture.issue(writer, "displaced-1")]);
		const scope = { author: writer.author, objectId: fixture.objectId };
		const sourceStore = required(observed.stores.get(writer.databaseName));
		const before = await sourceStore.readLineage(scope);
		const source = required(await sourceStore.readIssued(scope, before.next - 1));
		expect(record(source.envelope.canonicalPreimageBytes).operation, "F5B_REAL_BATCH_SOURCE").toMatchObject({
			action: "applicationBatch",
		});
		const sourceOperation = record(source.envelope.canonicalPreimageBytes).operation as {
			action: string;
			batch: { entries: { logicalTime: number; operation: Record<string, unknown> }[]; version: number };
		};
		expect(
			sourceOperation.batch.entries.map((entry) => entry.operation),
			"F5B_C03_REAL_TWO_INTENT_SOURCE_BYTES"
		).toEqual([
			{ action: "message", clientOperationId: "displaced-0", text: "displaced-0" },
			{ action: "message", clientOperationId: "displaced-1", text: "displaced-1" },
		]);
		const transformed = sourceOperation.batch.entries.map((entry) => ({
			...entry,
			operation: required(application.transformDisplacedOperation)(entry.operation),
		}));
		for (const entry of transformed) {
			expect(entry.operation).toEqual({
				action: "message",
				clientOperationId: entry.operation.clientOperationId,
				text: "r".repeat(33_000),
			});
			expect(
				encodeCanonical(entry.operation).byteLength,
				"F5B_C03_SINGLE_TRANSIENT_OPERATION_WITHIN_UNCHANGED_LIMIT"
			).toBeLessThan(65_536);
		}
		expect(
			encodeCanonical({ action: "applicationBatch", batch: { entries: transformed, version: 1 } }).byteLength,
			"F5B_C03_PAIR_REQUIRES_REAL_MULTIPLE_REPLACEMENT_CHUNKS"
		).toBeGreaterThan(65_536);
		expect(productState(creator).byteLength, "F5B_C03_INITIAL_REAL_STATE_WITHIN_UNCHANGED_CEILING").toBeLessThan(
			32_768
		);
		// The only intended RED terminus: genuine production close, before any
		// frontier fixture or capability can exist. All subsequent code is GREEN
		// continuation, not a claim that RED physically entered openProgressSources.
		await fixture.close();
		const first = fixture.checkpoint();
		expect(frontierFor(first.capability, writer.author)?.[2], "F5B_C03_BATCH_SOURCE_NOT_ADMITTED").toBeLessThan(
			source.authorSequence
		);
		for (const peer of fixture.peers)
			expect(frontierFor(first.capability, peer.author)?.[1], "F5B_C22_GENESIS_INCARNATION").toBe(0);
		const creatorZero = required(ownCommits(creator).find((row) => row.authorSequence === 0));
		expect(
			required(observed.closeGraphs.at(-1)).result.closeSetOrder,
			"F5B_C22_REAL_CLOSE_SET_INCLUDES_CREATOR_SLOT_ZERO"
		).toContain(hex(creatorZero.envelope.digest));
		expect(
			record(creatorZero.envelope.canonicalPreimageBytes).epoch,
			"F5B_C22_REAL_CREATOR_SLOT_ZERO_GENESIS_ROW"
		).toBe(0);
		expect(
			record(creatorZero.envelope.canonicalPreimageBytes).operation,
			"F5B_C22_SLOT_ZERO_ACCOUNTED_WITHOUT_BEING_A_FENCE"
		).not.toMatchObject({ action: "$drp.author-fence.v1" });
		expect(
			frontierFor(first.capability, creator.author)?.[2],
			"F5B_C22_EXACT_CREATOR_GENESIS_FRONTIER_INCLUDES_SLOT_ZERO"
		).toBe(required(ownCommits(creator).at(-1)).authorSequence);
		await creator.room.adoptCreatorSuccessor();
		fixture.held.delete(writer.databaseName);
		observed.failSuffixFor = writer.databaseName;
		await fixture.reopen(writer, 0, true);
		await expect(fixture.issue(writer, "blocked-suffix"), "F5B_C03_CRASH_AFTER_COMMITTED_PREFIX").rejects.toThrow();
		const partial = required((await durable(writer)).plan);
		const entry = required(partial.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(entry.replacementSequence, "F5B_C10_PARTIAL_LINK_UNFULFILLED").toBeNull();
		expect(required(entry.replacementProgress).chunks, "F5B_REAL_ROOM_CREATED_PARTIAL_PROGRESS").toHaveLength(1);
		expect(partial.fenceSequence, "F5B_C02_FENCE_PRECEDES_REPLACEMENT").toBeLessThan(
			required(required(entry.replacementProgress).chunks[0]).replacementSequence
		);
		const prefixSequence = required(required(entry.replacementProgress).chunks[0]).replacementSequence;
		const prefix = required(ownCommits(writer).find((row) => row.authorSequence === prefixSequence));
		expect(applicationOperations(prefix), "F5B_C03_COMMITTED_PREFIX_RETAINS_REAL_TRANSIENT_BYTES").toEqual([
			required(transformed[0]).operation,
		]);
		const beforeRestartState = productState(writer).slice();
		await fixture.reopen(writer, 0);
		await expect(
			fixture.issue(writer, "same-epoch-blocked-suffix"),
			"F5B_C03_SAME_EPOCH_RESTART_RETRIES_ONLY_UNCOMMITTED_SUFFIX"
		).rejects.toThrow();
		expect((await durable(writer)).plan, "F5B_C03_SAME_EPOCH_RESTART_PRESERVES_EXACT_PARTIAL_PLAN").toEqual(partial);
		expect(productState(writer), "F5B_C03_SAME_EPOCH_RESTART_PRESERVES_EXACT_BOUNDED_STATE").toEqual(
			beforeRestartState
		);
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === prefixSequence),
			"F5B_C03_SAME_EPOCH_RESTART_NO_PREFIX_REISSUE"
		).toEqual([prefix]);
		expect(
			observed.publications.filter((row) => row.database === writer.databaseName && row.sequence === prefixSequence),
			"F5B_C03_SAME_EPOCH_RESTART_NO_PREFIX_REPUBLICATION"
		).toHaveLength(1);
		await fixture.issue(creator, "creator-during-writer-crash");
		expect(productState(creator).byteLength, "F5B_C03_PREFIX_FOLD_STATE_WITHIN_UNCHANGED_CEILING").toBeLessThan(32_768);
		await fixture.close();
		const second = fixture.checkpoint();
		expect(
			frontierFor(second.capability, writer.author)?.[2],
			"F5B_AUTHENTICATED_SOURCE_IS_TERMINAL"
		).toBeGreaterThanOrEqual(source.authorSequence);
		await creator.room.adoptCreatorSuccessor();
		const incompleteSource = await durable(writer);
		expect(
			incompleteSource.rows.some((row) => row.commit.authorSequence === source.authorSequence),
			"F5B_C13_INCOMPLETE_PLAN_SOURCE_RETAINED_AFTER_AUTHENTICATED_ADOPTION"
		).toBe(true);
		expect(
			observed.prunes
				.filter((event) => event.database === writer.databaseName)
				.every((event) => event.receipt?.deletedAuthorSequenceRange === null || event.receipt === undefined),
			"F5B_C13_PARENT_REFUSES_DELETE_WHILE_PLAN_UNLINKED"
		).toBe(true);
		observed.failSuffixFor = "";
		await fixture.reopen(writer, 1, true);
		await fixture.issue(writer, "after-cold-reopen");
		const recoverySource = readFileSync(new URL("../packages/node/src/v3-live.ts", import.meta.url), "utf8");
		// Together with the real terminal checkpoint + partial-progress completion
		// below, forbid the current unconditional undefined-frontier bypass. This
		// does not inject the context: only production checkpoint custody may do so.
		expect(recoverySource, "F5B_OPEN_PROGRESS_NO_UNAUTHENTICATED_UNDEFINED_FRONTIER_CALL").not.toMatch(
			/readSettlementSources\(registration\)/u
		);
		const complete = required(await required(observed.stores.get(writer.databaseName)).readSettlementPlan(scope));
		const completed = required(complete.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(
			completed.replacementSequence,
			"F5B_OPEN_PROGRESS_SOURCES_AUTHENTICATED_FRONTIER_REACHABILITY"
		).not.toBeNull();
		expect(required(completed.replacementProgress).chunks[0], "F5B_C10_LINKED_PREFIX_NEVER_REISSUED").toEqual(
			required(entry.replacementProgress).chunks[0]
		);
		expect(required(completed.replacementProgress).chunks.at(-1)?.throughIntent, "F5B_C03_UNLINKED_SUFFIX_ONCE").toBe(
			2
		);
		const chunks = required(completed.replacementProgress).chunks;
		expect(chunks, "F5B_C03_EXACT_TWO_GENUINE_COMMITTED_REPLACEMENT_CHUNKS").toHaveLength(2);
		const chunkCommits = chunks.map((chunk) =>
			required(ownCommits(writer).find((row) => row.authorSequence === chunk.replacementSequence))
		);
		expect(
			chunkCommits.flatMap(applicationOperations),
			"F5B_C03_EXACT_TRANSIENT_INTENTS_NO_PREFIX_REISSUE_SUFFIX_ONCE"
		).toEqual(transformed.map((entry) => entry.operation));
		for (const chunk of chunkCommits) {
			expect(ownCommits(writer).filter((row) => row.authorSequence === chunk.authorSequence)).toHaveLength(1);
			expect(
				observed.publications.filter(
					(row) =>
						row.database === writer.databaseName &&
						row.sequence === chunk.authorSequence &&
						row.digest === hex(chunk.envelope.digest)
				)
			).toHaveLength(1);
			expect(encodeCanonical(record(chunk.envelope.canonicalPreimageBytes).operation).byteLength).toBeLessThan(65_536);
		}
		for (const id of ["displaced-0", "displaced-1"])
			expect(
				messages(creator).filter((row) => row.clientOperationId === id),
				"F5B_C03_TRANSIENT_BYTES_NOT_RETAINED_ONE_STATE_EFFECT_PER_INTENT"
			).toEqual([{ clientOperationId: id, text: id }]);
		expect(productState(creator).byteLength, "F5B_C03_COMPLETE_REAL_STATE_WITHIN_UNCHANGED_CEILING").toBeLessThan(
			32_768
		);
		await fixture.close();
		fixture.checkpoint();
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(creator, 2);
		await fixture.issue(creator, "creator-cold-reopen");
		await fixture.reopen(writer, 2, true);
		await fixture.issue(writer, "writer-third-reopen");
		for (const peer of fixture.peers)
			expect(peer.room.authority()?.epoch, "F5B_C14_THREE_TRANSITIONS_AND_COLD_REOPEN").toBe(3);
		for (const peer of fixture.peers)
			expect(
				productState(peer).byteLength,
				"F5B_C03_THIRD_TRANSITION_REAL_STATE_WITHIN_UNCHANGED_CEILING"
			).toBeLessThan(32_768);
		await Promise.all(fixture.peers.map(fixture.stop));
	});

	// Independently attributable continuations replace the old aggregate timeout.
	// The unchanged 60s runner watchdog belongs only to the fixed 64-writer
	// functional fixture; it is NOT a product latency/performance acceptance gate.
	// No complete GREEN duration is claimed by this pre-codec RED.
	it(
		"composes 64 active writers with universal plan fence and exact state accounting across three transitions",
		sixtyFourWriterGoldenPath,
		60_000
	);
	it(
		"case 1 withholds a distinct dependent author sequence until its delayed predecessor is settled",
		delayedDependency
	);
	it("cases 6-9 authenticate same-key removal and same-device and fresh-device readmission", sameKeyReentry);
	it(
		"case 11 retains the hold across close and cold reopen until authenticated author-wide readmission",
		manualReviewHold
	);
	it("case 12 scans the largest valid fence without burning another author space", () => creatorFenceScan());
	it("case 12 ignores a stale fence at or below the authenticated terminal boundary", () =>
		creatorFenceScan(false, true));
	it("case 23 freezes only the equivocating author below a fence", () => creatorFenceScan(true));
	it.each(["unpublished-fence", "delayed-replacement", "delayed-fence"] as const)(
		"cases 4 15 16 preserve %s custody",
		delayedPublication
	);
	it("case 17 closes an authenticated null-boundary member without a fence or slot zero", nullBoundaryClose);
	it("cases 19-21 retain displaced control and sole plan completion ownership", displacedControls);
	it("case 24a rejects a stale local head without regressing the authenticated floor", staleLocalHead);
	it.each([
		["fence", false],
		["fence", true],
		["replacement", false],
		["replacement", true],
	] as const)("case 25 accounts exact surviving %s publication with committed=%s", ambiguousPlanIssue);
	it("case 25 retains custody when bounded authenticated recovery cannot read durable truth", () =>
		ambiguousPlanIssue("fence", false, true));
	it("case 13 prunes only beyond the fully retained authenticated rollback window", positiveAuthenticatedPruning);
	it("case 17 retains the exact legacy v1 reentry guard source custody", () => {
		const source = readFileSync(new URL("../packages/node/src/creator-close.ts", import.meta.url), "utf8");
		expect(source).toContain('"D110C_0C1F1_AUTHOR_REENTRY_PROOF_REQUIRED"');
		expect(source.replace(/\s+/gu, " "), "F5B_C17_V1_PRIORLESS_REENTRY_GUARD_UNCHANGED").toContain(
			"if (priorBoundary === undefined) { const observedNext = author === input.issuanceScope.author ? localNext : undefined; if ((sequences[0] ?? observedNext ?? 0) > 1) { throw new TypeError( priorIdentity === undefined ? LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED : AUTHOR_REENTRY_PROOF_REQUIRED ); }"
		);
	});

	it("keeps the genuine v1 room issue, close, adoption and cold reopen control unchanged", async () => {
		const fixture = await openRoom(1, true);
		const creator = required(fixture.peers[0]);
		await fixture.issue(creator, "v1-control");
		const closed = await fixture.close();
		expect(closed.successorEpoch, "F5B_C17_CV1_COMPATIBILITY_CLOSE").toBe(1);
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(creator, 0);
		await fixture.issue(creator, "v1-after-reopen");
		expect(creator.room.authority()?.epoch, "F5B_V1_COLD_REOPEN_CONTROL").toBe(1);
		await fixture.stop(creator);
		// Observe the exact pre-existing floor rejection independently of the
		// settlement carrier RED. Case 24a uses this same error with a linked plan.
		const floorControl = await openRoom(2, true);
		const floorCreator = required(floorControl.peers[0]);
		const floorWriter = required(floorControl.peers[1]);
		await floorControl.issue(floorCreator, "v1-floor-creator");
		await floorControl.issue(floorWriter, "v1-floor-writer");
		await floorControl.close();
		await floorCreator.room.adoptCreatorSuccessor();
		await floorControl.reopen(floorWriter, 0, true);
		await floorControl.issue(floorWriter, "v1-floor-writer-next");
		await floorControl.stop(floorWriter);
		const untouched = await durable(floorWriter);
		await floorControl.close();
		await floorCreator.room.adoptCreatorSuccessor();
		floorWriter.floor.receive(floorCreator.floor.read());
		const currentFloor = floorWriter.floor.read();
		// No live owner competes with this stale durable-copy probe. The newer
		// creator floor stays committed; stopping a session never rewinds it.
		await floorControl.stop(floorCreator);
		await expect(
			floorControl.reopen(floorWriter, 0),
			"F5B_C24A_EXACT_REACHABLE_FLOOR_REJECTION_CONTROL"
		).rejects.toThrow(STALE_LOCAL_HEAD_FAILURE);
		expect(await durable(floorWriter)).toEqual(untouched);
		expect(floorWriter.floor.read()).toEqual(currentFloor);
	});
});
