/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture factories preserve the genuine inferred native/protocol port signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator } from "@ts-drp/compaction";
import type * as CompactionModule from "@ts-drp/compaction";
import type { DurableIssueCommit, SettlementPlan } from "@ts-drp/issuance-store";
import {
	journalRetirementCanonicalRow,
	journalRetirementRowCharge,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
	type LiveJournalRetirementImageReader,
} from "@ts-drp/live-journal";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import type * as AdoptionActivationModule from "@ts-drp/node/creator-adoption-activate";
import type * as V3LiveModule from "@ts-drp/node/v3-live";
import type { V3RoomStorageHost } from "@ts-drp/node/v3-room-host";
import {
	createOutcomeCommitAdmissionOperation,
	createOutcomeCommitAdmissionPolicy,
	createOutcomeCommitOperation,
	prepareOutcomeIntent,
} from "@ts-drp/outcome-commit";
import type * as ProtocolV3Module from "@ts-drp/protocol-v3";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { expectedTargetObjectId } from "./fixtures/phase-3h/migration-rehearsal-fixture.js";
import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import { Keychain } from "../packages/keychain/src/keychain.js";
import { P5_KEYCHAIN_VECTORS } from "../packages/keychain/tests/phase-3a1b-p5-keychain-contract.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../packages/node/src/creator-adoption.js";
import { openCreatorCloseHistory } from "../packages/node/src/internal/creator-close-history.js";
import type * as AdvanceModule from "../packages/node/src/internal/creator-transition-advance.js";
import {
	readV3ApplicationProjectionOrder,
	readV3RuntimeOwnerCensus,
	type V3PlaneHandle,
} from "../packages/node/src/v3-live.js";
import { authenticateV3RoomCreatorInvite } from "../packages/node/src/v3-room.js";
import type { V3RoomTransport } from "../packages/node/src/v3-room.js";
import {
	frontierFor,
	openCreatorAuthorSettlement,
	resolveCreatorAuthorSettlement,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { openSealAuthority, verifySealQC } from "../packages/protocol-v3/src/seal.js";
import type * as SnapshotModule from "../packages/protocol-v3/src/snapshot-transfer.js";
import {
	AHE_BOUNDED_READ_LIMITS,
	digestBlob,
	digestClosure,
	parseStorageObjectId,
} from "../packages/storage/src/index.js";
import { createSqliteAheDurableStore } from "../packages/storage-node/src/index.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/src/live-journal.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { openNodeSealEvidenceStore } from "../packages/storage-node/src/seal-evidence.js";
import { openNodeSealVoteStore } from "../packages/storage-node/src/seal-vote.js";
import { createNodeSnapshotQuarantineStore } from "../packages/storage-node/src/snapshot-transfer.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

const nativeEnduranceObserved = vi.hoisted(() => ({
	planes: new Map<string, V3PlaneHandle>(),
	failures: [] as unknown[],
	readCommittedPlan: undefined as
		| ((
				author: string,
				objectId: string,
				sequence: number
		  ) => Promise<{ name: string; plan: SettlementPlan | null; commit: DurableIssueCommit }>)
		| undefined,
	commits: [] as { name: string; commit: DurableIssueCommit; plan: SettlementPlan | null }[],
	publications: [] as { name: string; sequence: number; digest: string }[],
	graphs: [] as {
		input: Parameters<typeof CompactionModule.deriveCloseSetHistoryCommitment>[0];
		result: Awaited<ReturnType<typeof CompactionModule.deriveCloseSetHistoryCommitment>>;
	}[],
	advances: [] as Parameters<typeof AdvanceModule.inspectCreatorTransitionAdvance>[0][],
	snapshots: [] as {
		input: Parameters<typeof SnapshotModule.encodeSnapshotTransfer>[0];
		result: ReturnType<typeof SnapshotModule.encodeSnapshotTransfer>;
	}[],
}));
vi.mock("@ts-drp/compaction", async (importOriginal) => {
	const real = await importOriginal<typeof CompactionModule>();
	return {
		...real,
		deriveCloseSetHistoryCommitment: async (input: Parameters<typeof real.deriveCloseSetHistoryCommitment>[0]) => {
			const result = await real.deriveCloseSetHistoryCommitment(input);
			if (process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1") nativeEnduranceObserved.graphs.push({ input, result });
			return result;
		},
	};
});
vi.mock("../packages/node/src/internal/creator-transition-advance.js", async (importOriginal) => {
	const real = await importOriginal<typeof AdvanceModule>();
	return {
		...real,
		inspectCreatorTransitionAdvance: (...args: Parameters<typeof real.inspectCreatorTransitionAdvance>) => {
			if (process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1") nativeEnduranceObserved.advances.push(args[0]);
			return real.inspectCreatorTransitionAdvance(...args);
		},
	};
});
vi.mock("@ts-drp/protocol-v3/snapshot-transfer", async (importOriginal) => {
	const real = await importOriginal<typeof SnapshotModule>();
	return {
		...real,
		encodeSnapshotTransfer: (input: Parameters<typeof real.encodeSnapshotTransfer>[0]) => {
			const result = real.encodeSnapshotTransfer(input);
			if (process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1") nativeEnduranceObserved.snapshots.push({ input, result });
			return result;
		},
	};
});
vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const real = await importOriginal<typeof V3LiveModule>();
	return {
		...real,
		activateV3LivePlane: (...args: Parameters<typeof real.activateV3LivePlane>) => {
			const result = real.activateV3LivePlane(...args);
			if (process.env.TS_DRP_R10_NATIVE_SHALLOW === "1" && result.ok)
				nativeEnduranceObserved.planes.set(args[0].networkNode.peerId, result.handle);
			return result;
		},
	};
});
vi.mock("@ts-drp/node/creator-adoption-activate", async (importOriginal) => {
	const real = await importOriginal<typeof AdoptionActivationModule>();
	const observe = async (owner: typeof real.activateCreatorSuccessorAdoption, input: unknown) => {
		const result = await Reflect.apply(owner, undefined, [input]);
		if (process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1" && result.ok === true) {
			// Successor activation is an internal live-module call, so the
			// exported genesis activation observer cannot see its genuine handle.
			const networkNode = Reflect.get(input as object, "networkNode") as { peerId: string };
			nativeEnduranceObserved.planes.set(networkNode.peerId, result.handle as V3PlaneHandle);
		}
		return result;
	};
	return {
		...real,
		activateCreatorSuccessorAdoption: (input: unknown) => observe(real.activateCreatorSuccessorAdoption, input),
		reopenCreatorSuccessorAdoption: (input: unknown) => observe(real.reopenCreatorSuccessorAdoption, input),
	};
});
vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const real = await importOriginal<typeof ProtocolV3Module>();
	return {
		...real,
		createAdmissionBoundTransactionalVertexIssuer: (
			input: Parameters<typeof real.createAdmissionBoundTransactionalVertexIssuer>[0]
		) => {
			const issuer = real.createAdmissionBoundTransactionalVertexIssuer(input);
			if (process.env.TS_DRP_R10_NATIVE_SHALLOW !== "1") return issuer;
			return {
				...issuer,
				issue: async (...args: Parameters<typeof issuer.issue>) => {
					try {
						const commit = await issuer.issue(...args);
						if (process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1") {
							const observed = await required(nativeEnduranceObserved.readCommittedPlan)(
								input.author,
								commit.issuedRecord.scope.objectId,
								commit.authorSequence
							);
							expect(observed.commit.envelope).toEqual(commit.envelope);
							nativeEnduranceObserved.commits.push(observed);
						}
						return commit;
					} catch (error) {
						const captured = {
							author: input.author,
							request: args,
							error:
								error instanceof Error
									? {
											name: error.name,
											message: error.message,
											...Object.fromEntries(
												Object.getOwnPropertyNames(error).map((key) => [key, Reflect.get(error, key)])
											),
										}
									: error,
						};
						nativeEnduranceObserved.failures.push(captured);
						writeSync(1, `R10_NATIVE_ISSUANCE_FAILURE ${JSON.stringify(captured)}\n`);
						throw error;
					}
				},
			};
		},
	};
});

// Actual SQLite files and genuine protocol/crypto owners; transport is a local
// fixture route, not libp2p, a device result, or an independent freshness oracle.
const directories = new Set<string>();
const openRooms = new Set<V3RoomSession>();
const floors = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const protocolPorts = new Set<SnapshotChunkProtocolPort>();
const keychains = new Set<Keychain>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("R9_REQUIRED_FIXTURE_VALUE");
	return value;
}
const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

function nativeReadPort<Store extends { acquireNativeReadReservation: unknown }>(store: Store): Store {
	if (
		store === null ||
		typeof store !== "object" ||
		typeof Reflect.get(store, "acquireNativeReadReservation") !== "function"
	)
		throw new TypeError("R9_NATIVE_READ_PORT_REQUIRED");
	return store;
}

function nativeFilename(directory: string, name: string): string {
	return join(directory, `${hex(hashDomain("r9-test-file/v1", new TextEncoder().encode(name)))}.sqlite`);
}
function nativeHost(directory: string, reopenSigning = false): V3RoomStorageHost {
	const filename = (name: string): string => nativeFilename(directory, name);
	const signing = (name: string) => {
		const file = filename(`${name}--signing`);
		return {
			filename: file,
			initialization: (reopenSigning || existsSync(file) ? "reopen" : "create") as "reopen" | "create",
		};
	};
	return Object.freeze({
		openAhe: (name) =>
			Promise.resolve(nativeReadPort(createSqliteAheDurableStore({ filename: filename(`${name}--ahe`) }))),
		openIssuance: (name) =>
			Promise.resolve(
				nativeReadPort(createNodeDurableIssuanceStore({ primaryFilename: filename(`${name}--issuance`) }))
			),
		openJournal: (name) =>
			Promise.resolve(
				nativeReadPort(createNodeDurableLiveJournalStore({ primaryFilename: filename(`${name}--journal`) }))
			),
		openSnapshots: (name) =>
			Promise.resolve(createNodeSnapshotQuarantineStore({ primaryFilename: filename(`${name}--snapshots`) })),
		openSealVote: (name) => openNodeSealVoteStore(signing(name)),
		openSealEvidence: (name) => openNodeSealEvidenceStore(signing(name)),
		openRoomHead: (name, initialization) =>
			Promise.resolve(createNodeRoomHeadAuthority({ filename: filename(`${name}--floor`), initialization })),
	});
}

interface NativeCensusReplayFault {
	readonly mutation: "signature" | "provenance";
	enabled: boolean;
	sealedReads: number;
	mutatedReads: number;
	readonly issuance: Map<string, Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>>>;
	readonly journals: Map<string, Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>>;
}

async function gridFixture(
	blueprintDigest?: string,
	shippedProfile = false,
	publicNativeHost = false,
	configuredAuthor = false,
	recipientLocalBootstrap = false,
	recipientHealthAdminOnly = false,
	endurance?: Readonly<{ writers: 64 | 128 }>,
	replayFault?: NativeCensusReplayFault
) {
	const directory = mkdtempSync(join(tmpdir(), "r9-grid-outcome-"));
	directories.add(directory);
	const identities = (
		endurance === undefined ? [0x51, 0x61] : Array.from({ length: endurance.writers }, (_, i) => i + 1)
	).map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const keychain = configuredAuthor ? new Keychain({ private_key_seed: P5_KEYCHAIN_VECTORS.alphaSeed }) : undefined;
	if (keychain !== undefined) {
		keychains.add(keychain);
		await keychain.start();
		// Literal independent crypto oracle, not an application key acquisition.
		identities[0] = {
			seed: Uint8Array.from(Buffer.from(P5_KEYCHAIN_VECTORS.alphaLocalSeedHex, "hex")),
			author: keychain.localAuthorId,
		};
	}
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `r9-grid-peer-${order}` }));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author, blueprintDigest);
	let nativeStage = "startup";
	const authorizedSigningNamespaces = new Map<string, number>();
	const initializedSigningNamespaces = new Set<string>();
	const publicHost = (reopening: boolean): V3RoomStorageHost => {
		const owner = createNodeV3RoomStorageHost({
			directory,
			initialization: ({ name, family }) => {
				if (endurance === undefined || family !== "signing") return reopening ? "reopen" : "create";
				const index = authorizedSigningNamespaces.get(name);
				if (index === undefined) throw new TypeError("R10_NATIVE_SIGNING_NAMESPACE_NOT_ENROLLED");
				// The explicit local acquisition owner authorizes the first family
				// once; missing files never refresh previously acquired custody.
				const knownInitialized = initializedSigningNamespaces.has(name);
				const initialization = knownInitialized ? "reopen" : "create";
				if (process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1") {
					const filename = join(
						directory,
						`${createHash("sha256")
							.update(JSON.stringify([family, name]))
							.digest("hex")}.sqlite`
					);
					writeSync(
						1,
						`R10_NATIVE_SIGNING_ACQUISITION ${JSON.stringify({ stage: nativeStage, name, index, family, knownInitialized, initialization, filename, existsBefore: existsSync(filename) })}\n`
					);
				}
				return initialization;
			},
		});
		if (endurance === undefined) return owner;
		return Object.freeze({
			...owner,
			openSealVote: async (name: string) => {
				const result = await owner.openSealVote(name);
				initializedSigningNamespaces.add(name);
				return result;
			},
			openSealEvidence: async (name: string) => {
				const result = await owner.openSealEvidence(name);
				initializedSigningNamespaces.add(name);
				return result;
			},
		});
	};
	const originalHost = publicNativeHost ? publicHost(false) : nativeHost(directory);
	const observeJournalHost = (owner: V3RoomStorageHost): V3RoomStorageHost =>
		endurance === undefined && replayFault === undefined
			? owner
			: Object.freeze({
					...owner,
					...(replayFault === undefined ? {} : { openIssuance: async (name: string) => {
						const store = await owner.openIssuance(name);
						replayFault.issuance.set(name, store);
						return store;
					} }),
					openJournal: async (name: string) => {
						const journal = await owner.openJournal(name);
						replayFault?.journals.set(name, journal);
						const observe =
							(method: "readRetirementImage" | "readSignedAnchorEnvelope" | "readAnchorPreimage") => {
							const producer = required(Reflect.get(journal, method));
							const authenticObservations = new WeakSet<object>();
							const observed = async (input: unknown) => {
								try {
									const stack = new Error().stack ?? "";
									const original = await Reflect.apply(required(Reflect.get(journal, method)), journal, [input]);
									let result = original;
									// Supported ordinary replay now consumes this SAME full
									// native capture, not a second semantic page. Alter only
									// the actual acquisition read while the fault is enabled;
									// keep the original seal/census page injector below.
									if (method === "readRetirementImage" && original.ok && replayFault?.enabled &&
										stack.includes("acquireCreatorOrdinaryIssuanceMaintenanceProof")) {
										const frames: [string, [string, number, string, number?], Record<string, unknown>][] = original.value.canonicalRows.map((bytes: Uint8Array) => decodeCanonical(bytes) as
											[string, [string, number, string, number?], Record<string, unknown>]);
										// These original two fault cases run in their genuine
										// single current scope before seal/adopt. Do not choose
										// a historical row by an action or an epoch heuristic.
										const headers = frames.filter(([table]) => table === "scopes");
										if (headers.length !== 1) throw Error("R10_NATIVE_CURRENT_FAULT_SCOPE_REQUIRED");
										const scope = headers[0]![1], kind = replayFault.mutation === "signature" ? "received" : "local-issued";
										const selected = frames.findIndex(([table, key, row]) => table !== "scopes" &&
											key[0] === scope[0] && key[1] === scope[1] && key[2] === scope[2] &&
											(row.sourceKind ?? row.source_kind) === kind);
										if (selected < 0) throw Error("R10_NATIVE_CENSUS_FAULT_SOURCE_REQUIRED");
										const [table, key, row] = frames[selected]!, sql = table === "accepted_entries";
										let altered: Record<string, unknown>;
										if (kind === "received") {
											const detachedSignature = Uint8Array.from((row.detachedSignature ?? row.received_signature) as Uint8Array);
											detachedSignature[0] ^= 1;
											altered = {...row, [sql ? "received_signature" : "detachedSignature"]: detachedSignature};
										} else {
											const issued = await required(replayFault.issuance.get(name)).readIssued(
												{author: String(row.localAuthor ?? row.local_author), objectId: key[0]},
												Number(row.localAuthorSequence ?? row.local_author_sequence));
											if (issued === null) throw Error("R10_NATIVE_CENSUS_GENUINE_ISSUED_REQUIRED");
											const preimage = Uint8Array.from(issued.envelope.canonicalPreimageBytes), signature = Uint8Array.from(issued.envelope.signature);
											if (sql) altered = {...row, source_kind: "received", local_author: null, local_author_sequence: null,
												received_preimage: preimage, received_signature: signature};
											else {
												const {localAuthor: _author, localAuthorSequence: _sequence, ...base} = row;
												altered = {...base, sourceKind: "received", exactCanonicalPreimageBytes: preimage, detachedSignature: signature};
											}
										}
										const changed = journalRetirementCanonicalRow(table, key, altered);
										result = {...original, value: {...original.value, canonicalRows: Object.freeze(original.value.canonicalRows.map(
											(bytes: Uint8Array, index: number) => index === selected ? changed : bytes))}};
										replayFault.mutatedReads += 1;
									}
									if (method === "readRetirementImage" && result === original && result.ok)
										authenticObservations.add(result.value);
									const value = result.value;
									const bytes =
										result.exactCanonicalAnchorPreimageBytes ?? result.envelope?.exactCanonicalAnchorPreimageBytes;
									const scope = result.scope;
									const requested = (input as { scope?: unknown }).scope;
									const observation = {
										stage: nativeStage,
										name,
										method,
										input,
										ok: result.ok,
										kind: result.kind,
										scope,
										scopeMatches:
											scope === undefined || requested === undefined
												? undefined
												: hex(encodeCanonical(scope)) === hex(encodeCanonical(requested)),
										bytes: bytes instanceof Uint8Array ? bytes.byteLength : undefined,
										byteDigest:
											bytes instanceof Uint8Array
												? hex(hashDomain("r10-native-journal-observation/v1", bytes))
												: undefined,
										maxBytes: Reflect.get(input as object, "maxBytes"),
										image: value?.image,
										control: value?.control,
										drainSourcePresent: value?.drainSource !== undefined,
										canonicalRowBytes: value?.canonicalRows?.map((row: Uint8Array) => row.byteLength),
										failure: result.ok ? undefined : result,
										stack: new Error().stack,
									};
									if (endurance !== undefined) writeSync(1, `R10_NATIVE_JOURNAL_OBSERVATION ${JSON.stringify(observation)}\n`);
									return result;
								} catch (error) {
									writeSync(
										1,
										`R10_NATIVE_JOURNAL_THROW ${JSON.stringify({ stage: nativeStage, name, method, input, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error })}\n`
									);
									throw error;
								}
							};
							// Transparent telemetry must not hide an existing genuine
							// producer's same-held-image currency port. The producer
							// still enrolls only its exact observation and checks native
							// lifetime/currency itself; copied data grants nothing.
							const probe = method === "readRetirementImage" && Object.isFrozen(producer)
								? Object.getOwnPropertyDescriptor(producer, "captureCurrentProbe") : undefined;
							if (probe !== undefined && "value" in probe && typeof probe.value === "function") {
								Object.defineProperty(observed, "captureCurrentProbe", {value: function (
									this: LiveJournalRetirementImageReader,
									observation: Parameters<NonNullable<LiveJournalRetirementImageReader["captureCurrentProbe"]>>[0]
								) {
									if (this !== observed || Reflect.get(journal, method) !== producer || !authenticObservations.has(observation)) return undefined;
									return Reflect.apply(probe.value, producer, [observation]);
								}});
								return Object.freeze(observed);
							}
							return observed;
							};
						return Object.freeze({
							...journal,
							...(endurance === undefined && replayFault === undefined ? {} : {
								readRetirementImage: observe("readRetirementImage"),
							}),
							...(endurance === undefined ? {} : {
								readSignedAnchorEnvelope: observe("readSignedAnchorEnvelope"),
								readAnchorPreimage: observe("readAnchorPreimage"),
							}),
							...(replayFault === undefined ? {} : { readPage: async (input: Parameters<typeof journal.readPage>[0]) => {
								const stack = new Error().stack ?? "";
								const page = await journal.readPage(input);
								if (!page.ok || page.rows.length === 0) return page;
								if (!replayFault.enabled) {
									if (stack.includes("sealCreatorDurableReplay") && page.nextSequence === null) replayFault.sealedReads += 1;
									return page;
								}
								// Keep the original post-capture census verification seam,
								// and the current ordinary owner's fresh native replay read.
								// Do not force the obsolete full-census admission path just
								// to inject the same signature/provenance fault.
								const censusVerification = stack.includes("readCreatorRecoveryDependencyCensus") && stack.includes("verify");
								const ordinaryVerification = stack.includes("readCreatorReplayRows") && !stack.includes("sealCreatorDurableReplay");
								if (!censusVerification && !ordinaryVerification) return page;
								const selected = page.rows.findIndex(row => row.sourceKind ===
									(replayFault.mutation === "signature" ? "received" : "local-issued"));
								if (selected < 0) throw new Error("R10_NATIVE_CENSUS_FAULT_SOURCE_REQUIRED");
								const row = page.rows[selected]!;
								let altered: typeof row;
								if (row.sourceKind === "received") {
									const detachedSignature = Uint8Array.from(row.detachedSignature);
									detachedSignature[0] ^= 1;
									altered = { ...row, detachedSignature };
								} else {
									const issued = await required(replayFault.issuance.get(name)).readIssued(
										{ author: row.author, objectId: row.scope.objectId }, row.authorSequence);
									if (issued === null) throw new Error("R10_NATIVE_CENSUS_GENUINE_ISSUED_REQUIRED");
									altered = { scope: row.scope, journalSequence: row.journalSequence, vertexDigest: row.vertexDigest,
										sourceKind: "received", exactCanonicalPreimageBytes: Uint8Array.from(issued.envelope.canonicalPreimageBytes),
										detachedSignature: Uint8Array.from(issued.envelope.signature) };
								}
								replayFault.mutatedReads += 1;
								return { ...page, rows: page.rows.map((value, index) => index === selected ? altered : value) };
							} }),
						}) as typeof journal;
					},
				});
	const host = observeJournalHost(originalHost);
	const signing = { calls: 0, failAt: 0, failures: 0, digests: [] as Uint8Array[] };
	const objectId = `creator:${hex(hashDomain("r9-grid-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const material = async (targetObjectId: string) => {
		const signers = [{ publicKey: creator.author, signerId: "creator" }];
		return createV3RoomCreatorInviteMaterial({
			blueprintDigest: required(application.catalog.blueprintDigests[0]),
			exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
				application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
			),
			exactCanonicalLatchedAclBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: identities
					.map(({ author }, index) => ({
						author,
						finalityKey: index === 0 ? author : null,
						groups: index === 0 ? ["admin", "finality", "writer"] : recipientHealthAdminOnly ? ["admin"] : ["writer"],
					}))
					.sort((left, right) => left.author.localeCompare(right.author)),
				objectId: targetObjectId,
				permissionless: false,
				version: shippedProfile ? 1 : 3,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId: shippedProfile ? "creator-trusted-v1" : "creator-trusted-settlement-v1",
				quorum: 1,
				signers,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			objectId: targetObjectId,
			signGenesisAnchorDigest: (digest) =>
				keychain?.signWithLocalAuthor(digest) ?? Promise.resolve(ed25519.sign(digest, creator.seed)),
		});
	};
	const invite = await material(objectId);
	let sourceAuthorizer: Parameters<NonNullable<V3RoomTransport["setSettlementSourceAuthorizer"]>>[0] | undefined;
	const approvals: Readonly<Record<string, unknown>>[] = [];
	const publicationRefusals = new Set<number>();
	const creatorRooms = new Set<V3RoomSession>();
	const lastCreatorStatements = new Map<string, NonNullable<ReturnType<NonNullable<V3RoomSession["currencyStatement"]>>>>();
	const open = async (
		kind: "create" | "reopen",
		name = "source",
		selectedInvite = invite,
		selectedObjectId = objectId,
		options: {
			index?: number;
			protocol?: SnapshotChunkProtocolPort;
			issuanceName?: string;
			failAcceptedAction?: string;
			acceptedFailures?: { count: number };
			healthPeers?: readonly string[];
			// Test-only scheduling of the original wire delivery and observation wake.
			// Native owners, signatures, admission and timeout values remain unchanged.
			fenceReadbackScheduling?: {
				now(): number;
				deferIngress(deliver: () => void): void;
				wakeAfterMiss(): Promise<void>;
			};
		} = {}
	) => {
		const index = options.index ?? 0;
		const identity = required(identities[index]);
		if (endurance !== undefined) {
			const enrolled = authorizedSigningNamespaces.get(name);
			if (enrolled !== undefined && enrolled !== index) throw new TypeError("R10_NATIVE_NAMESPACE_IDENTITY_CONFLICT");
			authorizedSigningNamespaces.set(name, index);
		}
		let ingress: ((message: Message) => void) | undefined;
		let ingressTopic: string | undefined;
		let healthObservation:
			| Parameters<NonNullable<V3RoomTransport["setControlPlaneObservationProvider"]>>[0]
			| undefined;
		const accepted = new Set<string>();
		const acknowledgements = new Map<string, () => void>();
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind },
		});
		floors.add(floor);
		const signer =
			keychain !== undefined
				? await keychain.acquireLocalAuthorFinalitySigner()
				: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer;
		const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
			storageHost:
				kind === "reopen"
					? observeJournalHost(publicNativeHost ? publicHost(true) : nativeHost(directory, true))
					: host,
			application:
				recipientLocalBootstrap && index !== 0
					? createV3ZoneApplication(
							[endurance === undefined ? required(roster[index]) : { ...required(roster[index]), order: 1 }],
							required(roster[0]).peerId,
							creator.author,
							blueprintDigest
						)
					: application,
			author: identity.author,
			...(index === 0 ? { creatorFinalitySigner: signer } : {}),
			creatorInvite: selectedInvite,
			...(endurance === undefined || index !== 0
				? {}
				: {
						approveSettlementSourceSelection: (request) => {
							approvals.push(Object.freeze({ ...request.preview }));
							request.cancellationSignal.throwIfAborted();
							return Promise.resolve(true);
						},
					}),
			createOperationAdmissionPolicy: (context) =>
				createOutcomeCommitAdmissionPolicy({
					aclDigest: context.aclDigest,
					anchorDigest: context.anchorDigest,
					epoch: context.epoch,
					objectId: context.objectId,
					maxEntries: 1024,
					...(context.authenticatedApplicationStateBytes === undefined
						? {}
						: {
								authenticatedApplicationStateBytes: context.authenticatedApplicationStateBytes,
							}),
				}),
			databaseName: name,
			issuanceDatabaseName: options.issuanceName ?? name,
			migrationDatabaseNamespace: name,
			objectId: selectedObjectId,
			initialLogicalTime: 3,
			publicKeyBytes: ed25519.getPublicKey(identity.seed),
			roomHeadAuthority: floor,
			openTransport: () => {
				const networkNode = fakeNetwork(required(roster[index]).peerId, false);
				if (options.healthPeers !== undefined)
					Reflect.set(networkNode, "getGroupPeers", () => [...required(options.healthPeers)]);
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
				if (endurance !== undefined)
					Reflect.set(networkNode, "publishMessage", (_topic: string, message: Message) => {
						const published = !publicationRefusals.has(index);
						if (published && process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1") {
							const envelope = V3Envelope.decode(message.data),
								vertex = decodeCanonical(envelope.canonicalPreimage) as Record<string, unknown>;
							nativeEnduranceObserved.publications.push({
								name,
								sequence: Number(vertex.authorSequence),
								digest: hex(hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimage)),
							});
						}
						return Promise.resolve(published);
					});
				if (options.protocol !== undefined)
					Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => options.protocol);
				return {
					networkNode,
					close: () => undefined,
					openEphemeral: () => {
						throw new Error("R9_EPHEMERAL_UNUSED");
					},
					requestRetainedHistory: () => undefined,
					setIngressHandler: (topic, handler) => {
						ingress = handler;
						ingressTopic = topic;
					},
					setRetainedPublisher: () => undefined,
					...(endurance === undefined
						? {}
						: {
								setSettlementSourceAuthorizer: (
									authorizer: Parameters<NonNullable<V3RoomTransport["setSettlementSourceAuthorizer"]>>[0]
								) => {
									if (index === 0) sourceAuthorizer = authorizer;
								},
								requestSettlementSourceAuthorization: (
									request: Parameters<NonNullable<V3RoomTransport["requestSettlementSourceAuthorization"]>>[0],
									control?: Readonly<{ signal?: AbortSignal }>
								) =>
									required(sourceAuthorizer)({
										...request,
										authenticatedRequesterPeerId: required(roster[index]).peerId,
										signal: control?.signal ?? new AbortController().signal,
									}),
							}),
					setControlPlaneObservationProvider: (provider) => {
						healthObservation = provider;
					},
				};
			},
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				accepted.add(digest);
				acknowledgements.get(digest)?.();
				if (vertex.operation.action === options.failAcceptedAction && options.acceptedFailures?.count === 0) {
					options.acceptedFailures.count += 1;
					throw new TypeError("R9_CONTROLLED_AUTHENTICATED_REPLAY_INTERRUPTION");
				}
			},
			onProjection: () => undefined,
			signRegisteredVertexDigest: (digest) => {
				signing.calls += 1;
				signing.digests.push(new Uint8Array(digest));
				if (signing.calls === signing.failAt) {
					signing.failAt = 0;
					signing.failures += 1;
					return Promise.reject(new TypeError("R9_CONTROLLED_RECORD_SIGNING_INTERRUPTION"));
				}
				return index === 0 && keychain !== undefined
					? keychain.signWithLocalAuthor(digest)
					: Promise.resolve(ed25519.sign(digest, identity.seed));
			},
		};
		const room = await createV3RoomSession(input);
		openRooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		if (index === 0) creatorRooms.add(room);
		else if (kind === "reopen") {
			// Decision B (sync before sending): a reopened Writer signs nothing until it is current. This
			// harness has no successor delivery, so it hands over the statement of the room's open
			// creator (following a migration redirect), as the delivery does on bind.
			const creatorRoom = [...creatorRooms].find(
				(candidate) => openRooms.has(candidate) && candidate.objectId === selectedObjectId
			);
			const statement = creatorRoom?.currencyStatement?.() ?? lastCreatorStatements.get(selectedObjectId);
			if (statement !== undefined) await room.confirmCurrent?.(statement);
		}
		const receiveSignedRows = async (
			rows: readonly { commit: { envelope: { canonicalPreimageBytes: Uint8Array; signature: Uint8Array } } }[],
			finalDigest: string,
			senderIndex = 0
		) => {
			if (accepted.has(finalDigest)) return;
			const reservedFence = endurance !== undefined && Reflect.get(
				Reflect.get(decodeCanonical(required(rows.at(-1)).commit.envelope.canonicalPreimageBytes) as object,
					"operation") as object, "action") === "$drp.author-fence.v1";
			const scheduling = reservedFence ? options.fenceReadbackScheduling : undefined;
			const observationNow = scheduling?.now ?? (() => performance.now());
			const started = performance.now();
			let readbackPolls = 0;
			let lastReadback: Readonly<Record<string, unknown>> | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledgements.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("R9_REMOTE_RECORD_ADMISSION_ACK_TIMEOUT")), 30_000);
			});
			try {
				const deliver = () => {
					for (const row of rows)
						required(ingress)(
							Message.create({
								data: V3Envelope.encode({
									canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
									signature: row.commit.envelope.signature,
								}).finish(),
								objectId: required(ingressTopic),
								sender: required(roster[senderIndex]).peerId,
								type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
							})
						);
				};
				if (scheduling === undefined) deliver();
				else scheduling.deferIngress(deliver);
				if (reservedFence) {
					// Reserved fences deliberately have no application callback. Native
					// journal readback supplies their acknowledgement, not a fake ACK.
					const journal = await fixtureJournal();
					try {
						const deadline = observationNow() + 29_000;
						while (!accepted.has(finalDigest)) {
							const vertex = decodeCanonical(required(rows.at(-1)).commit.envelope.canonicalPreimageBytes) as Record<
								string,
								unknown
							>;
							const scope = {
								objectId: String(vertex.objectId),
								epoch: Number(vertex.epoch),
								anchorDigest: String(vertex.anchor),
							};
							const ready = await journal.readiness({ scope });
							readbackPolls += 1;
							lastReadback = { elapsedMs: performance.now() - started, scope, readiness: ready };
							if (ready.ok && ready.ready) {
								let afterSequence: number | null = null;
								do {
									const page = await journal.readPage({ scope, snapshot: ready.snapshot, afterSequence, limit: 128 });
									lastReadback = { elapsedMs: performance.now() - started, scope, readiness: ready,
										page: page.ok ? { ok: true, rows: page.rows.length, nextSequence: page.nextSequence,
											found: page.rows.some(row => row.vertexDigest === finalDigest) } : page };
									if (!page.ok) break;
									if (page.rows.some((row) => row.vertexDigest === finalDigest)) {
										accepted.add(finalDigest);
										acknowledgements.get(finalDigest)?.();
										break;
									}
									afterSequence = page.nextSequence;
								} while (afterSequence !== null);
							}
							// A native append may finish while synchronous work delays this
							// wake-up past the polling deadline. Observe it before deciding
							// to stop; neither the deadline nor the ACK timer is extended.
							if (!accepted.has(finalDigest) && observationNow() >= deadline) break;
							if (!accepted.has(finalDigest)) {
								if (scheduling === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 20));
								else await scheduling.wakeAfterMiss();
							}
						}
					} finally {
						await journal.close();
					}
				}
				await joined;
				// Application notification acknowledges acceptance, not the enclosing
				// ingress custody join. This existing FIFO read observes completion
				// without publication retries, writer recovery, or early release.
				await room.queryRetainedHashes({ limit: 1 });
			} catch (error) {
				writeSync(1, `R10_NATIVE_DELIVERY_OBSERVATION ${JSON.stringify({ senderIndex, finalDigest,
					elapsedMs: performance.now() - started, readbackPolls, lastReadback,
					failure: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error })}\n`);
				throw error;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledgements.delete(finalDigest);
			}
		};
		const fixtureJournal = () => host.openJournal(name);
		return {
			room,
			floor,
			input,
			receiveSignedRows,
			healthObservation: () => healthObservation?.(),
			releaseAcceptedEvidence: () => accepted.clear(),
		};
	};
	const outcome = (room: V3RoomSession, id: string, quantity = 3) => {
		const context = {
			aclDigest: hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(room.previewLatchedAcl().current))),
			anchorDigest: room.roomId,
			epoch: Reflect.get(room.previewLatchedAcl().current as object, "epoch") as number,
			objectId: room.objectId,
		};
		const prepared = prepareOutcomeIntent({
			...context,
			clientOperationId: id,
			counterparties: identities.map(({ author }) => author),
			exactCanonicalPayloadBytes: encodeCanonical({ asset: "crystal", quantity }),
			outcomeKind: "same-zone-trade-v1",
		});
		return createOutcomeCommitAdmissionOperation(
			createOutcomeCommitOperation({
				prepared,
				approvals: identities.map(({ author, seed }) => ({
					signer: author,
					signature: ed25519.sign(prepared.registeredDigest, seed),
				})),
			})
		);
	};
	const stop = async (opened: Awaited<ReturnType<typeof open>>) => {
		// The creator's last statement, for a Writer that reopens after the creator handed off.
		if (creatorRooms.has(opened.room)) {
			try {
				const statement = opened.room.currencyStatement?.();
				if (statement !== undefined) lastCreatorStatements.set(statement.objectId, statement);
			} catch {
				// A creator that cannot state its epoch (failed or closed) leaves none.
			}
		}
		await opened.room.close();
		openRooms.delete(opened.room);
		await opened.floor.close();
		floors.delete(opened.floor);
	};
	return {
		directory,
		identities,
		application,
		host,
		signing,
		objectId,
		invite,
		material,
		open,
		outcome,
		stop,
		keychain,
		approvals,
		publicationRefusals,
		setNativeStage: (stage: string) => {
			nativeStage = stage;
		},
	};
}

for (const mutation of ["signature", "provenance"] as const) {
	it(`native Grid final-census ${mutation} tamper refuses before effects and exact work continues`, async () => {
		const fault: NativeCensusReplayFault = { mutation, enabled: false, sealedReads: 0, mutatedReads: 0,
			issuance: new Map(), journals: new Map() };
		const fixture = await gridFixture(undefined, false, true, false, false, false, undefined, fault);
		const source = await fixture.open("create", "census-source");
		const recipient = await fixture.open("create", "census-recipient", fixture.invite, fixture.objectId, { index: 1 });
		await source.room.issue({ action: "placeBlock", id: "census-local", kind: "stone", x: 1, y: 1 });
		await recipient.room.issue({ action: "placeBlock", id: "census-remote", kind: "stone", x: 2, y: 1 });
		const remoteRows = await required(fault.issuance.get("census-recipient")).readOutboxPage({
			scope: { author: required(fixture.identities[1]).author, objectId: fixture.objectId }, limit: 128 });
		await source.receiveSignedRows(remoteRows, hex(required(remoteRows.at(-1)).commit.envelope.digest), 1);
		const journal = required(fault.journals.get("census-source"));
		const issuance = required(fault.issuance.get("census-source"));
		const scope = { author: required(fixture.identities[0]).author, objectId: fixture.objectId };
		const beforeHead = await source.room.inspectDurableHead();
		const beforeJournal = encodeCanonical(await required(journal.readRetirementImage)({ objectId: fixture.objectId }));
		const beforeLineage = await issuance.readLineage(scope);
		const beforeOutbox = encodeCanonical(await issuance.readOutboxPage({ scope, limit: 128 }));
		const beforeProjection = encodeCanonical(source.room.projection());
		const beforeSignatures = fixture.signing.calls;
		const operation = { action: "placeBlock", id: "census-exact-continuation", kind: "stone", x: 3, y: 1 };
		fault.enabled = true;
		await expect(source.room.issue(operation)).rejects.toThrow();
		expect(fault.sealedReads, "initial authentic native replay was captured before the fault").toBeGreaterThan(0);
		expect(fault.mutatedReads, "final census verification read was actually altered").toBeGreaterThan(0);
		expect(fixture.signing.calls, "refusal precedes operation signing").toBe(beforeSignatures);
		expect(await source.room.inspectDurableHead()).toEqual(beforeHead);
		expect(encodeCanonical(await required(journal.readRetirementImage)({ objectId: fixture.objectId }))).toEqual(beforeJournal);
		expect(await issuance.readLineage(scope)).toEqual(beforeLineage);
		expect(encodeCanonical(await issuance.readOutboxPage({ scope, limit: 128 }))).toEqual(beforeOutbox);
		expect(encodeCanonical(source.room.projection())).toEqual(beforeProjection);
		fault.enabled = false;
		await source.room.issue(operation);
		expect(source.room.projection()).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ id: operation.id,
			kind: operation.kind, x: operation.x, y: operation.y })]) });
		expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
		await source.room.adoptCreatorSuccessor();
		expect(source.room.authority()).toMatchObject({ epoch: 1 });
	}, 120_000);
}

it("native Grid delivery completion joins received custody before durable-head inspection", async () => {
	const fixture = await gridFixture(undefined, false, false, false, true);
	const source = await fixture.open("create", "head-source");
	const recipient = await fixture.open("create", "head-recipient", fixture.invite, fixture.objectId, { index: 1 });
	await recipient.room.issue({ action: "placeBlock", id: "joined-received-head", kind: "stone", x: 1, y: 1 });
	const issuance = await fixture.host.openIssuance("head-recipient");
	let rows;
	try {
		rows = await issuance.readOutboxPage({ scope: { objectId: fixture.objectId,
			author: required(fixture.identities[1]).author }, limit: 128 });
	} finally { await issuance.close(); }
	const published = rows.filter(row => row.publishState === "published");
	expect(published.length).toBeGreaterThan(0);
	await source.receiveSignedRows(published, hex(required(published.at(-1)).commit.envelope.digest), 1);
	const inspected = await source.room.inspectDurableHead();
	expect(inspected.head.objectId).toBe(fixture.objectId);
	expect(Reflect.get(source.room.projection(), "blocks")).toEqual([
		{ id: "joined-received-head", kind: "stone", x: 1, y: 1 },
	]);
});

it("native Grid reserved-fence readback checks committed bytes after an expired observation wake", async () => {
	const fixture = await gridFixture(undefined, false, true, false, true, false, { writers: 64 });
	let observationTime = 0;
	let deliver: (() => void) | undefined;
	let wakes = 0;
	let exactFence: DurableIssueCommit | undefined;
	const exactNativeFence = async () => {
		const commit = required(exactFence);
		const vertex = decodeCanonical(commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;
		const scope = { objectId: String(vertex.objectId), epoch: Number(vertex.epoch), anchorDigest: String(vertex.anchor) };
		const journal = await fixture.host.openJournal("wake-source");
		try {
			const ready = await journal.readiness({ scope });
			expect(ready.ok, "R10_FENCE_WAKE_NATIVE_READINESS").toBe(true);
			if (!ready.ok || !ready.ready) return undefined;
			const page = await journal.readPage({ scope, snapshot: ready.snapshot, afterSequence: null, limit: 128 });
			expect(page.ok, "R10_FENCE_WAKE_NATIVE_PAGE").toBe(true);
			return page.ok ? page.rows.find(row => row.vertexDigest === hex(commit.envelope.digest)) : undefined;
		} finally { await journal.close(); }
	};
	const source = await fixture.open("create", "wake-source", fixture.invite, fixture.objectId, {
		fenceReadbackScheduling: {
			now: () => observationTime,
			deferIngress: originalDelivery => { expect(deliver).toBeUndefined(); deliver = originalDelivery; },
			wakeAfterMiss: async () => {
				wakes += 1;
				expect(wakes, "R10_FENCE_WAKE_FIRST_ACTUAL_NATIVE_MISS").toBe(1);
				expect(await exactNativeFence()).toBeUndefined();
				required(deliver)();
				const deadline = performance.now() + 15_000;
				while (await exactNativeFence() === undefined) {
					if (performance.now() >= deadline) throw new TypeError("R10_FENCE_WAKE_GENUINE_APPEND_TIMEOUT");
					await new Promise<void>(resolve => setTimeout(resolve, 20));
				}
				// Simulate only a delayed observation wake, not authentication, rows,
				// acknowledgement, native accounting or the original 30-second timer.
				observationTime = 127_647;
				writeSync(1, `R10_NATIVE_FENCE_WAKE ${JSON.stringify({ wakes, observationTime, exactNativeAppend: true })}\n`);
			},
		},
	});
	const recipient = await fixture.open("create", "wake-recipient", fixture.invite, fixture.objectId, { index: 1 });
	// Startup does not issue the reserved fence until this Writer first works.
	await recipient.room.issue({ action: "placeBlock", id: "wake-fence-source", kind: "stone", x: 1, y: 1 });
	const issuance = await fixture.host.openIssuance("wake-recipient");
	let outbox;
	try {
		outbox = await issuance.readOutboxPage({ scope: { objectId: fixture.objectId,
			author: required(fixture.identities[1]).author }, limit: 128 });
	} finally { await issuance.close(); }
	const fence = required(outbox.find(row => Reflect.get(
		Reflect.get(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as object, "operation") as object,
		"action") === "$drp.author-fence.v1"));
	expect(fence.publishState).toBe("published");
	exactFence = fence.commit;
	// Establish the genuine signed source prefix before observing its fence.
	const prefix = outbox.filter(row => row.commit.authorSequence < fence.commit.authorSequence);
	if (prefix.length > 0) {
		expect(prefix.every(row => row.publishState === "published")).toBe(true);
		await source.receiveSignedRows(prefix, hex(required(prefix.at(-1)).commit.envelope.digest), 1);
	}
	expect(ed25519.verify(fence.commit.envelope.signature, fence.commit.envelope.digest,
		ed25519.getPublicKey(required(fixture.identities[1]).seed))).toBe(true);
	let deliveryFailure: unknown;
	try { await source.receiveSignedRows([fence], hex(fence.commit.envelope.digest), 1); }
	catch (error) { deliveryFailure = error; }
	const native = required(await exactNativeFence());
	expect(native.sourceKind).toBe("received");
	if (native.sourceKind !== "received") throw new TypeError("R10_FENCE_WAKE_RECEIVED_BYTES_REQUIRED");
	expect(native.exactCanonicalPreimageBytes).toEqual(fence.commit.envelope.canonicalPreimageBytes);
	expect(native.detachedSignature).toEqual(fence.commit.envelope.signature);
	expect(wakes).toBe(1);
	expect(observationTime).toBe(127_647);
	if (deliveryFailure !== undefined) throw deliveryFailure;
	// This public native inspection follows the helper's existing FIFO join.
	expect((await source.room.inspectDurableHead()).head.objectId).toBe(fixture.objectId);
}, 60_000);

// A finite, opt-in capacity workload, not a 128-worker benchmark or endurance
// replacement. All 128 authenticated Writers use real native issuance, but only
// creator + one recipient are live concurrently. Default signed epoch limits and
// production admission/resource enforcement are unchanged.
it.runIf(process.env.TS_DRP_R10_NATIVE_CAPACITY_128 === "1")(
	"R10 native capacity: 128 authenticated Writers settle prune reopen and continue",
	async () => {
		const fixture = await gridFixture(undefined, false, false, false, true, false, { writers: 128 });
		const source = await fixture.open("create", "capacity-peer-0");
		const expected = new Map<string, Readonly<Record<string, unknown>>>();
		const state = (opened: Awaited<ReturnType<typeof fixture.open>>) =>
			required(fixture.application.migration).canonicalStateBytes(opened.room.projection());
		const checkWorld = (opened: Awaited<ReturnType<typeof fixture.open>>) => {
			const blocks = Reflect.get(opened.room.projection(), "blocks") as readonly Readonly<Record<string, unknown>>[];
			expect([...blocks].sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
				[...expected.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
			);
		};
		const rows = async (index: number) => {
			const issuance = await fixture.host.openIssuance(`capacity-peer-${index}`);
			try {
				return await issuance.readOutboxPage({
					scope: { objectId: fixture.objectId, author: required(fixture.identities[index]).author }, limit: 128,
				});
			} finally { await issuance.close(); }
		};
		const flush = async (index: number, epoch: number) => {
			const published = (await rows(index)).filter(row => row.publishState === "published" &&
				Reflect.get(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as object, "epoch") === epoch);
			for (const row of published) {
				expect(hex(hashDomain("ts-drp/vertex/v3", row.commit.envelope.canonicalPreimageBytes))).toBe(hex(row.commit.envelope.digest));
				expect(ed25519.verify(row.commit.envelope.signature, row.commit.envelope.digest,
					ed25519.getPublicKey(required(fixture.identities[index]).seed))).toBe(true);
			}
			if (published.length !== 0)
				await source.receiveSignedRows(published, hex(required(published.at(-1)).commit.envelope.digest), index);
		};
		const add = async (opened: Awaited<ReturnType<typeof fixture.open>>, id: string, ordinal: number) => {
			const block = { id, kind: "stone", x: ordinal % 32, y: Math.floor(ordinal / 32) };
			await opened.room.issue({ action: "placeBlock", ...block });
			expected.set(id, block);
		};
		const image = async () => {
			const journal = await fixture.host.openJournal("capacity-peer-0");
			try {
				const result = await required(journal.readRetirementImage)({ objectId: fixture.objectId });
				if (!result.ok) throw new TypeError(`R10_CAPACITY_NATIVE_IMAGE_${result.kind}`);
				return result.value;
			} finally { await journal.close(); }
		};
		let delivery: Awaited<ReturnType<typeof recipientSource>> | undefined;
		const proxy: SnapshotChunkProtocolPort = {
			localPeerId: "r9-grid-peer-127", connectedPeers: () => ["r9-grid-peer-0"],
			open: peer => required(delivery).port.open(peer), serve: () => () => undefined,
			close: () => delivery?.port.close(),
		};
		let recipient: Awaited<ReturnType<typeof fixture.open>> | undefined;
		expect(Reflect.get(fixture.invite.exactCanonicalLatchedAclBytes === undefined ? {} :
			decodeCanonical(fixture.invite.exactCanonicalLatchedAclBytes) as object, "members")).toHaveLength(128);
		await add(source, "capacity-w0", 0);
		for (let index = 1; index < 128; index++) {
			const opened = await fixture.open("create", `capacity-peer-${index}`, fixture.invite, fixture.objectId,
				{ index, ...(index === 127 ? { protocol: proxy } : {}) });
			await add(opened, `capacity-w${index}`, index);
			await flush(index, 0);
			if (index === 127) recipient = opened;
			else await fixture.stop(opened);
			if (index % 16 === 15) writeSync(1, `R10_CAPACITY_NATIVE_WRITERS ${index + 1}\n`);
		}
		checkWorld(source);
		const before = await image();
		const originalEpochZeroRows = before.canonicalRows.filter(bytes => {
			const [table, , row] = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
			return table !== "scopes" && row.epoch === 0;
		}).length;
		expect(originalEpochZeroRows).toBeGreaterThanOrEqual(256);
		for (let epoch = 0; epoch < 5; epoch++) {
			if (epoch !== 0) await add(source, `capacity-creator-e${epoch}`, 128 + epoch);
			fixture.setNativeStage(`capacity-seal-${epoch}`);
			const sealed = await source.room.sealEpoch();
			expect(sealed).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
			await source.room.adoptCreatorSuccessor();
			delivery = await recipientSource(fixture, "capacity-peer-0", fixture.objectId, fixture.invite, false, 127);
			await required(recipient).room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
			await flush(127, epoch + 1);
			checkWorld(source);
			checkWorld(required(recipient));
			expect(state(required(recipient))).toEqual(state(source));
			writeSync(1, `R10_CAPACITY_NATIVE_ROLLOVER ${epoch + 1}\n`);
		}
		const after = await image();
		const remainingEpochZeroRows = after.canonicalRows.filter(bytes => {
			const [table, , row] = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
			return table !== "scopes" && row.epoch === 0;
		}).length;
		expect(remainingEpochZeroRows, "old accepted bytes physically retired, not only omitted from a quote").toBe(0);
		const expectedState = state(source);
		await fixture.stop(required(recipient));
		recipient = await fixture.open("reopen", "capacity-peer-127", fixture.invite, fixture.objectId,
			{ index: 127, protocol: proxy });
		expect(recipient.room.authority()).toMatchObject({ epoch: 5 });
		expect(state(recipient)).toEqual(expectedState);
		await add(recipient, "capacity-recipient-reopened", 133);
		await flush(127, 5);
		checkWorld(source);
		await fixture.stop(source);
		const reopened = await fixture.open("reopen", "capacity-peer-0");
		expect(reopened.room.authority()).toMatchObject({ epoch: 5 });
		checkWorld(reopened);
		await add(reopened, "capacity-creator-reopened", 134);
		checkWorld(reopened);
		writeSync(1, `R10_CAPACITY_NATIVE_RESULT ${JSON.stringify({ writers: 128, maxConcurrentClients: 2,
			operations: expected.size, healthyTransitions: 5, originalEpochZeroRows, remainingEpochZeroRows,
			beforeJournalEncodedCharge: before.image.byteCharge, afterJournalEncodedCharge: after.image.byteCharge,
			signedEpochParameters: parameters, localSimulatorOnly: true, frozenMemoryAcceptance: false })}\n`);
	},
	10_800_000
);

function migrationName(sourceObjectId: string, targetObjectId: string, rehearsalNonce: Uint8Array): string {
	const scratchDigest = hex(
		hashDomain(
			"ts-drp/v3-room-migration-scratch/v1",
			encodeCanonical({ rehearsalNonce, sourceObjectId, targetObjectId })
		)
	);
	return `ts-drp-v3-room-migration--${hex(hashDomain("ts-drp/v3-room-migration-local-store/v1", encodeCanonical({ localNamespace: "source", scratchDigest })))}`;
}

// Opt-in native preparation/controller. No execution result or separately
// frozen fresh-process memory acceptance is implied by this fixture alone.
// All authority/storage/signing owners are production; transport is serialized
// local byte delivery. Creator policy is configured but unused for same-author
// current-Writer recovery. This is not a device claim.
async function runNativeGridComposition(transitions: number, exactComposition = false, longHorizon = false) {
	if (
		!Number.isSafeInteger(transitions) ||
		transitions < 2 ||
		!Number.isSafeInteger(192 + 132 * transitions) ||
		(longHorizon && (!exactComposition || transitions < 100))
	)
		throw new TypeError("R10_NATIVE_TRANSITION_DOMAIN_REQUIRED");
	const fixture = await gridFixture(undefined, false, true, false, true, false, { writers: 64 });
	type Opened = Awaited<ReturnType<typeof fixture.open>>;
	const peers: Opened[] = [];
	const deliveries = new Map<number, Awaited<ReturnType<typeof recipientSource>>>();
	const expected = new Map<string, Readonly<{ id: string; kind: string; x: number; y: number }>>();
	const state = (peer: Opened) => required(fixture.application.migration).canonicalStateBytes(peer.room.projection());
	const record = (bytes: Uint8Array) => decodeCanonical(bytes) as Record<string, unknown>;
	if (exactComposition)
		nativeEnduranceObserved.readCommittedPlan = async (author, objectId, sequence) => {
			const index = fixture.identities.findIndex((identity) => identity.author === author);
			if (index < 0) throw new TypeError("R10_OBSERVER_EXACT_CURRENT_AUTHOR_REQUIRED");
			const name = `r10-peer-${index}`,
				store = await fixture.host.openIssuance(name);
			try {
				return {
					name,
					plan: await store.readSettlementPlan({ author, objectId }),
					commit: required((await store.readIssued({ author, objectId }, sequence)) ?? undefined),
				};
			} finally {
				await store.close();
			}
		};
	const operation = (commit: DurableIssueCommit) =>
		record(commit.envelope.canonicalPreimageBytes).operation as Record<string, unknown>;
	const totals = {
		ordinary: 0,
		sources: 0,
		recovered: 0,
		transitions: 0,
		publication: 0,
		commits: 0,
		orderlyReopens: 0,
		initialPublicationFailures: 0,
		expectedJoins: 0,
		joins: 0,
		closedJoins: 0,
	};
	const expectedJoinsByAuthor = new Map<string, number>();
	const nextSequences = new Map(fixture.identities.map(({ author }) => [author, 0]));
	const pendingExpected = new Map<
		number,
		{
			block: Readonly<{ id: string; kind: string; x: number; y: number }>;
			source: DurableIssueCommit;
			originallyPending: boolean;
			publishedAfterReopen: boolean;
		}
	>();
	let priorCheckpoint: { digest: string; successor: string; historyRoot: string; historySize: number } | undefined;
	// Long mode independently carries compact history from genesis. It never
	// restores its oracle from a production checkpoint or retains history leaves.
	const independentHistory = longHorizon ? new CompactMerkleAccumulator() : undefined;
	const assertNativeRollbackBytes = async () => {
		const object = parseStorageObjectId(fixture.objectId);
		if (!object.ok) throw new TypeError("R10_NATIVE_OBJECT_ID_REQUIRED");
		const store = await fixture.host.openAhe("r10-peer-0--ahe");
		try {
			const acquired = await store.acquireBoundedActiveRead({
				objectId: object.value,
				ancestorCount: 2,
				limits: AHE_BOUNDED_READ_LIMITS,
			});
			expect(acquired.ok, "R10_CURRENT_AND_TWO_NATIVE_COMPLETE_READABLE_ROLLBACKS").toBe(true);
			if (!acquired.ok || acquired.value.kind !== "present")
				throw new TypeError(`R10_NATIVE_ROLLBACK_READ_${JSON.stringify(acquired)}`);
			const reader = acquired.value.reader;
			try {
				expect(reader.generations).toHaveLength(3);
				let current = required(reader.generations.find((row) => row.generationId === reader.head.generationId));
				expect(current.state).toBe("Adopted");
				for (let depth = 0; depth < 3; depth += 1) {
					const closure = digestClosure(current.closure);
					expect(closure).toEqual({ ok: true, value: current.closureDigest });
					for (const ref of current.closure) {
						const blob = required(
							reader.blobs.find((row) => row.ref.digest === ref.digest && row.ref.byteLength === ref.byteLength)
						);
						expect(blob.bytes.byteLength, "R10_PHYSICAL_ROLLBACK_COMPLETE_LENGTH").toBe(ref.byteLength);
						expect(digestBlob(blob.bytes), "R10_PHYSICAL_ROLLBACK_HASH_BOUND_BYTES").toEqual({
							ok: true,
							value: ref.digest,
						});
					}
					if (depth < 2) {
						if (current.baseExpectedHead.kind !== "present") throw new TypeError("R10_NATIVE_ROLLBACK_LINEAGE_GAP");
						const base = current.baseExpectedHead;
						current = required(reader.generations.find((row) => row.generationId === base.generationId));
						expect(current.closureDigest).toBe(base.closureDigest);
						expect(current.state).toBe("Superseded");
					}
				}
				const advance = required(nativeEnduranceObserved.advances.at(-1));
				const physical = (closure: AdvanceModule.CreatorTransitionClosure): AdvanceModule.CreatorTransitionClosure => ({
					...closure,
					candidates: closure.candidates.map((candidate) => {
						const blob = required(
							reader.blobs.find(
								(row) => row.ref.digest === candidate.ref.digest && row.ref.byteLength === candidate.ref.byteLength
							)
						);
						expect(blob.bytes).toEqual(candidate.bytes);
						return { ref: candidate.ref, bytes: blob.bytes };
					}),
				});
				// Original opaque trusts; only candidate bytes are re-read from the
				// physical current/rollback closure. No floor/state-flag substitute.
				const { inspectCreatorTransitionAdvance } = await import(
					"../packages/node/src/internal/creator-transition-advance.js"
				);
				expect(
					inspectCreatorTransitionAdvance({
						...advance,
						current: physical(advance.current),
						proposed: physical(advance.proposed),
					}).ok,
					"R10_PHYSICAL_ROLLBACK_TRANSITION_REVERIFIES"
				).toBe(true);
				expect(await reader.checkCurrent(), "R10_NATIVE_ROLLBACK_CURRENCY_BEFORE_DELIVERY").toEqual({
					ok: true,
					value: { kind: "current" },
				});
				return {
					generationId: reader.head.generationId,
					revision: reader.head.revision,
					closureDigest: reader.head.closureDigest,
					completeUsableGenerations: 3,
					referencedBlobs: reader.blobs.length,
				};
			} finally {
				await reader.release();
			}
		} finally {
			await store.close();
		}
	};
	const persistedCheckpoint = async (index: number, phase: string) => {
		const peer = required(peers[index]);
		const nativeHead = async (opened: Opened) => {
			if (index === 0) return opened.room.inspectDurableHead();
			const object = parseStorageObjectId(fixture.objectId);
			if (!object.ok) throw new TypeError("R10_NATIVE_RECIPIENT_OBJECT_REQUIRED");
			const store = await fixture.host.openAhe(`${opened.input.databaseName}--ahe`);
			try {
				const read = await store.acquireBoundedActiveRead({
					objectId: object.value,
					ancestorCount: 0,
					limits: AHE_BOUNDED_READ_LIMITS,
				});
				expect(read.ok, "R10_RECIPIENT_OWN_COMPLETE_NATIVE_HEAD").toBe(true);
				if (!read.ok) throw new TypeError(`R10_RECIPIENT_HEAD_REFUSED_${read.reason}`);
				if (read.value.kind === "empty") return { head: read.value.head, references: [] };
				const reader = read.value.reader;
				try {
					const generation = required(reader.generations.find((row) => row.generationId === reader.head.generationId));
					expect(digestClosure(generation.closure)).toEqual({ ok: true, value: reader.head.closureDigest });
					for (const ref of generation.closure) {
						const blob = required(
							reader.blobs.find((row) => row.ref.digest === ref.digest && row.ref.byteLength === ref.byteLength)
						);
						expect(blob.bytes.byteLength).toBe(ref.byteLength);
						expect(digestBlob(blob.bytes)).toEqual({ ok: true, value: ref.digest });
					}
					expect(await reader.checkCurrent()).toEqual({ ok: true, value: { kind: "current" } });
					return { head: reader.head, references: generation.closure };
				} finally {
					await reader.release();
				}
			} finally {
				await store.close();
			}
		};
		const scope = { objectId: fixture.objectId, pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest };
		const exact = state(peer),
			authority = peer.room.authority(),
			head = await nativeHead(peer),
			floor = await peer.floor.read({ scope });
		const issuance = await fixture.host.openIssuance(`r10-peer-${index}`);
		let before;
		try {
			const authorScope = { objectId: fixture.objectId, author: peer.input.author };
			before = encodeCanonical({
				lineage: await issuance.readLineage(authorScope),
				plan: await issuance.readSettlementPlan(authorScope),
				rows: await rows(index),
			});
		} finally {
			await issuance.close();
		}
		const publicationOffset = nativeEnduranceObserved.publications.length;
		await fixture.stop(peer);
		peers[index] = await fixture.open("reopen", `r10-peer-${index}`, fixture.invite, fixture.objectId, {
			index,
			...(index === 0
				? {}
				: {
						protocol: {
							localPeerId: `r9-grid-peer-${index}`,
							connectedPeers: () => ["r9-grid-peer-0"],
							open: (remote) => required(deliveries.get(index)).port.open(remote),
							serve: () => () => undefined,
							close: () => deliveries.get(index)?.port.close(),
						},
					}),
		});
		const reopened = required(peers[index]);
		expect(state(reopened), `R10_${phase}_EXACT_PERSISTED_WORLD`).toEqual(exact);
		expect(reopened.room.authority(), `R10_${phase}_EXACT_AUTHORITY`).toEqual(authority);
		expect(await nativeHead(reopened), `R10_${phase}_EXACT_HEAD`).toEqual(head);
		expect(await reopened.floor.read({ scope }), `R10_${phase}_EXACT_SAFETY_FLOOR`).toEqual(floor);
		const reopenedIssuance = await fixture.host.openIssuance(`r10-peer-${index}`);
		try {
			const authorScope = { objectId: fixture.objectId, author: reopened.input.author };
			expect(
				encodeCanonical({
					lineage: await reopenedIssuance.readLineage(authorScope),
					plan: await reopenedIssuance.readSettlementPlan(authorScope),
					rows: await rows(index),
				}),
				`R10_${phase}_EXACT_ISSUANCE_DEBT`
			).toEqual(before);
		} finally {
			await reopenedIssuance.close();
		}
		expect(
			nativeEnduranceObserved.publications.slice(publicationOffset).filter((row) => row.name === `r10-peer-${index}`),
			`R10_${phase}_NO_DUPLICATE_FIRST_PUBLICATION`
		).toHaveLength(0);
		totals.orderlyReopens += 1;
		writeSync(
			1,
			`R10_NATIVE_ORDERLY_CHECKPOINT ${JSON.stringify({ phase, index, epoch: authority?.epoch ?? 0, stateDigest: hex(hashDomain("ts-drp/state/v3", exact)), processDeath: false })}\n`
		);
	};
	const rows = async (index: number) => {
		const issuance = await fixture.host.openIssuance(`r10-peer-${index}`);
		try {
			return await issuance.readOutboxPage({
				scope: { author: required(fixture.identities[index]).author, objectId: fixture.objectId },
				limit: 128,
			});
		} finally {
			await issuance.close();
		}
	};
	const captureNativeControlSuffix = async (index: number, epoch: number) => {
		const name = `r10-peer-${index}`;
		for (const row of await rows(index)) {
			const commit = row.commit,
				vertex = record(commit.envelope.canonicalPreimageBytes),
				action = operation(commit).action;
			if (
				Number(vertex.epoch) < epoch ||
				Number(vertex.epoch) > epoch + 1 ||
				nativeEnduranceObserved.commits.some(
					(entry) => entry.name === name && entry.commit.authorSequence === commit.authorSequence
				)
			)
				continue;
			if (action === "$drp.author-fence.v1") {
				expect(operation(commit)).toEqual({
					action: "$drp.author-fence.v1",
					fenceSequence: commit.authorSequence,
					version: 1,
				});
				const owned = await required(nativeEnduranceObserved.readCommittedPlan)(
					required(fixture.identities[index]).author,
					fixture.objectId,
					commit.authorSequence
				);
				expect(owned.commit.envelope).toEqual(commit.envelope);
				if (vertex.epoch === (required(peers[index]).room.authority()?.epoch ?? 0))
					expect(owned.plan?.fenceSequence, "R10_CURRENT_FENCE_BINDS_NATIVE_SETTLEMENT_PLAN").toBe(
						commit.authorSequence
					);
			} else {
				expect(action, "R10_ONLY_ORIGINAL_BOOTSTRAP_OR_RESERVED_FENCE_BYPASSES_ISSUER_OBSERVER").toBe("installRoster");
				expect(operation(commit)).toEqual(required(peers[index]).input.application.bootstrapOperation);
				expect(vertex.epoch).toBe(0);
				expect(vertex.dependencies).toEqual([fixture.invite.pinnedGenesisAnchorDigest]);
			}
			expect(vertex).toMatchObject({
				objectId: fixture.objectId,
				author: required(fixture.identities[index]).author,
				authorSequence: commit.authorSequence,
			});
			expect(hex(hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes))).toBe(
				hex(commit.envelope.digest)
			);
			expect(
				ed25519.verify(
					commit.envelope.signature,
					commit.envelope.digest,
					ed25519.getPublicKey(required(fixture.identities[index]).seed)
				)
			).toBe(true);
			expect(row.publishState).toBe("published");
			nativeEnduranceObserved.commits.push({ name, commit, plan: null });
		}
		// Combine the separate original native issuance arms by their immutable
		// author ordinal, not by the time at which an observer read completes.
		nativeEnduranceObserved.commits.sort(
			(left, right) => left.name.localeCompare(right.name) || left.commit.authorSequence - right.commit.authorSequence
		);
	};
	const flush = async (index: number) => {
		const published = (await rows(index)).filter(
			(row) =>
				row.publishState === "published" &&
				(!exactComposition ||
					record(row.commit.envelope.canonicalPreimageBytes).epoch ===
						(required(peers[index]).room.authority()?.epoch ?? 0))
		);
		if (published.length !== 0) {
			try {
				await required(peers[0]).receiveSignedRows(
					published,
					hex(required(published.at(-1)).commit.envelope.digest),
					index
				);
			} catch (cause) {
				throw new TypeError(
					`R10_NATIVE_DELIVERY_FAILED writer=${index} rows=${JSON.stringify(published.map((row) => ({ sequence: row.commit.authorSequence, vertex: decodeCanonical(row.commit.envelope.canonicalPreimageBytes) })))}`,
					{ cause }
				);
			}
		}
	};
	// Reconstruct the actual physical frontier from the public authenticated order
	// and original signed dependencies, not the expanded application projection.
	// The signed genesis carrier supplies the same bound used by the live issuer.
	const prepareJoinAccounting = async (index: number) => {
		if (!exactComposition) return () => undefined;
		const order = readV3ApplicationProjectionOrder({
			plane: required(nativeEnduranceObserved.planes.get(`r9-grid-peer-${index}`)),
		});
		if (!order.ok) throw new TypeError(order.detail);
		await captureNativeControlSuffix(index, order.order.epoch);
		const canonicalParameters = fixture.invite.exactCanonicalParametersCarrierBytes;
		expect(record(fixture.invite.exactCanonicalGenesisAnchorPreimageBytes).parametersDigest).toBe(
			hex(hashDomain("ts-drp/parameters/v3", canonicalParameters))
		);
		const maxDependencies = record(canonicalParameters).maxDependencies;
		if (typeof maxDependencies !== "number" || !Number.isSafeInteger(maxDependencies) || maxDependencies < 2)
			throw new TypeError("R10_SIGNED_DEPENDENCY_BOUND_REQUIRED");
		const currentDigests = [...order.order.digests, ...order.order.controlDigests];
		expect(new Set(currentDigests).size, "R10_EXACT_CURRENT_VERTEX_IDENTITIES").toBe(currentDigests.length);
		const tips = new Set([order.order.anchorDigest, ...currentDigests]);
		for (const digest of currentDigests) {
			const matches = nativeEnduranceObserved.commits.filter(({ commit }) => hex(commit.envelope.digest) === digest);
			expect(matches, "R10_PRE_ISSUE_CURRENT_VERTEX_HAS_EXACT_NATIVE_SIGNED_BYTES").toHaveLength(1);
			const commit = required(matches[0]).commit,
				vertex = record(commit.envelope.canonicalPreimageBytes);
			expect(vertex).toMatchObject({ objectId: fixture.objectId, epoch: order.order.epoch });
			expect(hex(hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes))).toBe(digest);
			expect(
				ed25519.verify(commit.envelope.signature, commit.envelope.digest, Buffer.from(String(vertex.author), "hex"))
			).toBe(true);
			for (const dependency of vertex.dependencies as string[]) tips.delete(dependency);
		}
		const expectedJoins =
			tips.size <= maxDependencies ? 0 : Math.ceil((tips.size - maxDependencies) / (maxDependencies - 1));
		const name = `r10-peer-${index}`,
			key = `${order.order.epoch}:${name}`,
			offset = nativeEnduranceObserved.commits.length;
		totals.expectedJoins += expectedJoins;
		expectedJoinsByAuthor.set(key, (expectedJoinsByAuthor.get(key) ?? 0) + expectedJoins);
		return () => {
			const issued = nativeEnduranceObserved.commits
				.slice(offset)
				.filter(
					({ name: owner, commit }) =>
						owner === name && record(commit.envelope.canonicalPreimageBytes).epoch === order.order.epoch
				);
			const joins = issued.filter(({ commit }) => operation(commit).action === "causalJoin");
			expect(joins, "R10_ACTUAL_SIGNED_JOINS_MATCH_INDEPENDENT_PRE_ISSUE_FRONTIER_BOUND").toHaveLength(expectedJoins);
			for (const { commit } of joins) {
				const vertex = record(commit.envelope.canonicalPreimageBytes);
				expect(operation(commit)).toEqual({ action: "causalJoin" });
				expect(vertex.dependencies, "R10_JOIN_CONSUMES_EXACT_SORTED_CURRENT_TIPS").toEqual(
					[...tips].sort().slice(0, maxDependencies)
				);
				expect(hex(hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes))).toBe(
					hex(commit.envelope.digest)
				);
				expect(
					ed25519.verify(
						commit.envelope.signature,
						commit.envelope.digest,
						Buffer.from(required(fixture.identities[index]).author, "hex")
					)
				).toBe(true);
				for (const dependency of vertex.dependencies as string[]) tips.delete(dependency);
				tips.add(hex(commit.envelope.digest));
			}
			expect(tips.size).toBeLessThanOrEqual(maxDependencies);
			const terminal = issued.filter(({ commit }) => operation(commit).action !== "causalJoin");
			expect(terminal, "R10_ONE_TERMINAL_APP_ISSUE_AFTER_BOUNDED_JOINS").toHaveLength(1);
			expect(record(required(terminal[0]).commit.envelope.canonicalPreimageBytes).dependencies).toEqual(
				[...tips].sort()
			);
			totals.joins += joins.length;
		};
	};
	let finalSealDiagnosticAttempted = false;
	const measureFinalSealDiagnostic = async () => {
		if (
			process.env.TS_DRP_R10_NATIVE_SEAL_DIAGNOSTIC !== "1" ||
			!exactComposition ||
			finalSealDiagnosticAttempted ||
			required(peers[0]).room.authority()?.epoch !== transitions
		) return;
		finalSealDiagnosticAttempted = true;
		fixture.setNativeStage(`epoch-${transitions}-diagnostic-genuine-seal`);
		writeSync(1, "R10_NONACCEPTANCE_GENUINE_SEAL_START\n");
		try {
			const result = await required(peers[0]).room.sealEpoch();
			writeSync(1, `R10_NONACCEPTANCE_GENUINE_SEAL_RESULT ${JSON.stringify(result)}\n`);
			if (result.ok) {
				fixture.setNativeStage(`epoch-${transitions}-diagnostic-genuine-adopt`);
				await required(peers[0]).room.adoptCreatorSuccessor();
				writeSync(1, `R10_NONACCEPTANCE_GENUINE_ADOPT_RESULT ${JSON.stringify(required(peers[0]).room.authority())}\n`);
				fixture.setNativeStage(`epoch-${transitions + 1}-diagnostic-genuine-seal`);
				const next = await required(peers[0]).room.sealEpoch();
				writeSync(1, `R10_NONACCEPTANCE_NEXT_GENUINE_SEAL_RESULT ${JSON.stringify(next)}\n`);
			}
		} catch (cause) {
			writeSync(1, `R10_NONACCEPTANCE_GENUINE_SEAL_FAILURE ${JSON.stringify({
				name: cause instanceof Error ? cause.name : typeof cause,
				message: cause instanceof Error ? cause.message : String(cause),
				stack: cause instanceof Error ? cause.stack : undefined,
			})}\n`);
		}
	};
	const add = async (index: number, id: string, ordinal: number) => {
		const block = Object.freeze({
			id,
			kind: "stone",
			x: exactComposition ? Math.floor(ordinal / 64) : ordinal % 32,
			y: exactComposition ? index : Math.floor(ordinal / 32),
		});
		const checkJoins = await prepareJoinAccounting(index);
		try {
			await required(peers[index]).room.issue({ action: "placeBlock", ...block });
		} catch (cause) {
			const peer = required(peers[index]),
				issuance = await fixture.host.openIssuance(`r10-peer-${index}`);
			try {
				const scope = { author: peer.input.author, objectId: fixture.objectId };
				const context = {
					index,
					authority: peer.room.authority(),
					names: {
						databaseName: peer.input.databaseName,
						issuance: peer.input.issuanceDatabaseName,
						floor: `r10-peer-${index}-external-floor.sqlite`,
					},
					scope,
					lineage: await issuance.readLineage(scope),
					plan: await issuance.readSettlementPlan(scope),
					rows: await rows(index),
					signatures: fixture.signing.calls,
					floor: await peer.floor.read({
						scope: {
							objectId: fixture.objectId,
							pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
						},
					}),
					nativeFailures: nativeEnduranceObserved.failures,
				};
				writeSync(1, `R10_NATIVE_CONTINUATION_FAILURE ${JSON.stringify(context)}\n`);
				throw new TypeError(
					`R10 native continued issue failed writer=${index} epoch=${peer.room.authority()?.epoch ?? 0}`,
					{ cause }
				);
			} finally {
				await issuance.close();
				if (index === 0) await measureFinalSealDiagnostic();
			}
		}
		checkJoins();
		expected.set(id, block);
		return block;
	};
	const checkWorld = (peer: Opened) => {
		const actual = Reflect.get(peer.room.projection(), "blocks") as readonly Readonly<Record<string, unknown>>[];
		expect([...actual].sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
			[...expected.values()].sort((a, b) => a.id.localeCompare(b.id))
		);
		expect(state(peer).byteLength).toBeLessThanOrEqual(32_768);
		if (exactComposition)
			expect(
				hex(
					hashDomain(
						"r10-grid-independent-world/v1",
						encodeCanonical([...actual].sort((a, b) => String(a.id).localeCompare(String(b.id))))
					)
				),
				"R10_INDEPENDENT_SEMANTIC_DIGEST"
			).toBe(
				hex(
					hashDomain(
						"r10-grid-independent-world/v1",
						encodeCanonical([...expected.values()].sort((a, b) => a.id.localeCompare(b.id)))
					)
				)
			);
	};
	const samples: Readonly<Record<string, unknown>>[] = [];
	let sampleCount = 0;
	const collectSample = async (phase: string) => {
		const perAuthor = [];
		const issuedPreimages = new Map<string, Uint8Array>();
		for (let index = 0; index < 64; index += 1) {
			const issuance = await fixture.host.openIssuance(`r10-peer-${index}`);
			try {
				const scope = { author: required(fixture.identities[index]).author, objectId: fixture.objectId };
				const outbox = await issuance.readOutboxPage({ scope, limit: 128 });
				for (const row of outbox)
					issuedPreimages.set(hex(row.commit.envelope.digest), row.commit.envelope.canonicalPreimageBytes);
				perAuthor.push({
					index,
					lineage: await issuance.readLineage(scope),
					plan: await issuance.readSettlementPlan(scope),
					outbox: outbox.map((row) => ({
						sequence: row.commit.authorSequence,
						digest: hex(row.commit.envelope.digest),
						publishState: row.publishState,
						bytes: row.commit.envelope.canonicalPreimageBytes.byteLength,
					})),
				});
			} finally {
				await issuance.close();
			}
		}
		const census = [];
		const journalBytes = [];
		const creatorJournal = `${createHash("sha256")
			.update(JSON.stringify(["journal", "r10-peer-0"]))
			.digest("hex")}.sqlite.drp-live-journal-v1.sqlite`;
		let physicalBytes = 0;
		const files = (directory: string): string[] =>
			readdirSync(directory).flatMap((entry) => {
				const filename = join(directory, entry);
				return statSync(filename).isDirectory() ? files(filename) : [filename];
			});
		for (const filename of files(fixture.directory)) {
			physicalBytes += statSync(filename).size;
			if (!filename.endsWith(".sqlite")) continue;
			const database = new DatabaseSync(filename, { readOnly: true });
			try {
				if (filename === join(fixture.directory, creatorJournal)) {
					// Read-only forensic cap, never passed to a native owner or used for admission.
					const diagnosticMaxRows = 1024,
						diagnosticMaxBytes = 8_388_608;
					database.exec("BEGIN");
					try {
						const tables = ["scopes", "accepted_entries"] as const;
						for (const table of tables) {
							const count = database
								.prepare(`SELECT count(*) AS n FROM ${table} WHERE object_id=?`)
								.get(fixture.objectId);
							expect(Number(count?.n), "finite native journal diagnostic row cap").toBeLessThanOrEqual(
								diagnosticMaxRows
							);
							const blobFields =
								table === "scopes"
									? ["exact_anchor_preimage", "detached_anchor_signature", "exact_parameters_carrier"]
									: ["received_preimage", "received_signature"];
							const bytes = database
								.prepare(
									`SELECT coalesce(sum(${blobFields.map((field) => `coalesce(length(${field}),0)`).join("+")}),0) AS n FROM ${table} WHERE object_id=?`
								)
								.get(fixture.objectId);
							expect(Number(bytes?.n), "finite native journal diagnostic extraction cap").toBeLessThanOrEqual(
								diagnosticMaxBytes
							);
						}
						const scopes = database
							.prepare(
								"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes WHERE object_id=? ORDER BY epoch,anchor_digest"
							)
							.all(fixture.objectId)
							.map((row) => ({ ...row }));
						const entries = database
							.prepare(
								"SELECT object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence FROM accepted_entries WHERE object_id=? ORDER BY epoch,anchor_digest,journal_sequence"
							)
							.all(fixture.objectId)
							.map((row) => ({ ...row }));
						const histogram = new Map<
							string,
							{
								rows: number;
								rowCharges: number;
								canonicalFrames: number;
								preimageBytes: number;
								signatureBytes: number;
							}
						>();
						let rowCharges = 0,
							canonicalFrames = 0;
						const crossings: unknown[] = [];
						for (const [table, rows] of [
							["scopes", scopes],
							["accepted_entries", entries],
						] as const) {
							for (const row of rows) {
								const key = [row.object_id, row.epoch, row.anchor_digest];
								if (table === "accepted_entries") key.push(row.journal_sequence);
								const charge = journalRetirementRowCharge(row);
								const frame = journalRetirementCanonicalRow(table, key, row).byteLength;
								const preimage =
									row.received_preimage instanceof Uint8Array
										? row.received_preimage
										: issuedPreimages.get(String(row.vertex_digest));
								const vertex =
									preimage === undefined
										? undefined
										: (decodeCanonical(preimage, { maxBytes: diagnosticMaxBytes }) as Record<string, unknown>);
								const operation = vertex?.operation as Record<string, unknown> | undefined;
								const action =
									table === "scopes" ? "anchor" : String(operation?.action ?? "unknown-full-charge-retained");
								const category =
									vertex?.settlementSource !== undefined
										? "replacement"
										: action === "$drp.author-fence.v1"
											? "fence"
											: action === "installRoster"
												? "bootstrap"
												: "ordinary";
								const group = `${table}/epoch-${String(row.epoch)}/${String(row.source_kind ?? "scope")}/${category}/${action}`;
								const value = histogram.get(group) ?? {
									rows: 0,
									rowCharges: 0,
									canonicalFrames: 0,
									preimageBytes: 0,
									signatureBytes: 0,
								};
								value.rows++;
								value.rowCharges += charge;
								value.canonicalFrames += frame;
								value.preimageBytes +=
									row.received_preimage instanceof Uint8Array
										? row.received_preimage.byteLength
										: row.exact_anchor_preimage instanceof Uint8Array
											? row.exact_anchor_preimage.byteLength
											: 0;
								value.signatureBytes +=
									row.received_signature instanceof Uint8Array
										? row.received_signature.byteLength
										: row.detached_anchor_signature instanceof Uint8Array
											? row.detached_anchor_signature.byteLength
											: 0;
								histogram.set(group, value);
								for (const [kind, before, increment] of [
									["rowCharges", rowCharges, charge],
									["canonicalFrames", canonicalFrames, frame],
								] as const)
									if (
										before <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes &&
										before + increment > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
									)
										crossings.push({ kind, key, group, before, increment, after: before + increment });
								rowCharges += charge;
								canonicalFrames += frame;
							}
						}
						const fullImageBytes = encodeCanonical(
							{ scopes, rows: entries },
							{ maxBytes: diagnosticMaxBytes, maxItems: 1 + (scopes.length + entries.length) * 128, maxDepth: 16 }
						).byteLength;
						journalBytes.push({
							diagnosticOnly: true,
							file: creatorJournal,
							nativeLimit: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
							diagnosticMaxRows,
							diagnosticMaxBytes,
							scopeCount: scopes.length,
							rowCount: entries.length,
							rowCharges,
							canonicalFrames,
							frameOverhead: canonicalFrames - rowCharges,
							fullImageBytes,
							imageEnvelopeOverhead: fullImageBytes - rowCharges,
							crossings,
							histogram: Object.fromEntries(histogram),
						});
					} finally {
						database.exec("ROLLBACK");
					}
				}
				for (const table of database
					.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
					.all()) {
					const name = String(table.name);
					const content = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
					census.push({
						file: filename.slice(fixture.directory.length + 1),
						table: name,
						rows: content.length,
						encodedBytes: encodeCanonical(content).byteLength,
					});
				}
			} finally {
				database.close();
			}
		}
		const head = await required(peers[0]).room.inspectDurableHead();
		const beforeGc = process.memoryUsage();
		// These are bounded per-sample scalar observations, not retained frames or
		// new resource thresholds. acceptedDigests belongs to the live projection;
		// canonical durable state carries blocks, roster and outcomes separately.
		const applicationFields = longHorizon
			? peers.map((peer, index) => {
					const projection = peer.room.projection();
					const field = (name: string) => {
						const values = Reflect.get(projection, name) as readonly unknown[];
						return { count: values.length, encodedBytes: encodeCanonical(values).byteLength };
					};
					return {
						index,
						canonicalStateBytes: state(peer).byteLength,
						blocks: field("blocks"),
						acceptedDigests: field("acceptedDigests"),
						roster: field("roster"),
						outcomes: field("outcomes"),
					};
				})
			: undefined;
		const runtime = [...nativeEnduranceObserved.planes].map(([peerId, plane]) => ({
			peerId,
			census: readV3RuntimeOwnerCensus(plane),
		}));
		if (longHorizon) {
			// Existing signed epoch/pending bounds and approved local admission
			// pools, not new physical-memory targets or per-epoch fitted limits.
			const limits = {
				authorVertexCounts: 64,
				closeAuthors: parameters.maxEpochVertices,
				closeCharges: parameters.maxEpochVertices,
				closeVertices: parameters.maxEpochVertices,
				controlVertices: parameters.maxEpochVertices,
				latchedOperations: parameters.maxEpochVertices,
				causalityIndex: parameters.maxEpochVertices,
				pendingIngress: parameters.maxPendingEntries,
				pendingIngressBytes: parameters.maxPendingBytes,
				admittedInputJobs: 32,
				admittedInputBytes: parameters.maxPendingBytes,
				admittedReadControlJobs: 32,
				admittedPendingPublicationJobs: 32,
				admittedEgressControlJobs: 32,
				admittedGossipQueueJobs: 32,
				admittedGossipQueueBytes: parameters.maxPendingBytes,
			};
			expect(runtime, "R10_LONG_EXACT_ACTIVE_RUNTIME_CENSUS").toHaveLength(64);
			for (const { peerId, census: observed } of runtime) {
				const census = required(observed);
				expect(census.networkRegistrations, `R10_LONG_ONE_CURRENT_REGISTRATION:${peerId}`).toBe(1);
				expect(census.active, `R10_LONG_CURRENT_RUNTIME_ACTIVE:${peerId}`).toBe(1);
				expect(census.terminal, `R10_LONG_CURRENT_RUNTIME_NONTERMINAL:${peerId}`).toBe(0);
				for (const [field, limit] of Object.entries(limits)) {
					const value = required(census[field]);
					expect(Number.isSafeInteger(value), `R10_LONG_CENSUS_INTEGER:${peerId}:${field}`).toBe(true);
					expect(value, `R10_LONG_CENSUS_NONNEGATIVE:${peerId}:${field}`).toBeGreaterThanOrEqual(0);
					expect(value, `R10_LONG_CENSUS_EXISTING_LIMIT:${peerId}:${field}`).toBeLessThanOrEqual(limit);
				}
			}
		}
		if (!longHorizon) required(globalThis.gc)();
		const observation = {
			phase,
			...(applicationFields === undefined ? {} : { applicationFields }),
			bootstrapConfiguration: {
				creatorRosterMembers: 64,
				recipientRosterMembers: 1,
				recipientOrder: 1,
				signedAclWriters: 64,
			},
			active: peers.length,
			epoch: required(peers[0]).room.authority()?.epoch ?? 0,
			expectedBlocks: expected.size,
			stateBytes: state(required(peers[0])).byteLength,
			semanticDigest: hex(
				hashDomain(
					"r10-grid-independent-world/v1",
					encodeCanonical([...expected.values()].sort((a, b) => a.id.localeCompare(b.id)))
				)
			),
			head,
			...(exactComposition
				? {
						issuanceRows: perAuthor.reduce((sum, author) => sum + author.outbox.length, 0),
						pendingRows: perAuthor.reduce(
							(sum, author) => sum + author.outbox.filter((row) => row.publishState === "pending").length,
							0
						),
						sqlRows: census.reduce((sum, row) => sum + row.rows, 0),
						logicalEncodedBytes: census.reduce((sum, row) => sum + row.encodedBytes, 0),
						deliveryPorts: protocolPorts.size,
						totals: { ...totals },
					}
				: { perAuthor, census }),
			journalBytes,
			physicalBytes,
			beforeGc,
			memoryAcceptance: false,
		};
		// Full decoded observation frames are released before GC. The retained
		// sample contains scalar census values, never SQL rows or author plans.
		if (exactComposition) {
			perAuthor.length = 0;
			census.length = 0;
			issuedPreimages.clear();
		}
		// Long-mode GC runs only after this collector frame has returned, so
		// decoded SQL rows and signed readback frames are no longer stack roots.
		if (longHorizon) return { ...observation, runtime };
		required(globalThis.gc)();
		return { ...observation, postGc: process.memoryUsage(), runtime };
	};
	const sample = async (phase: string) => {
		const collectionStarted = performance.now();
		const collected = await collectSample(phase);
		const collectionAndAssertionsMs = performance.now() - collectionStarted;
		const sampleRecord = await (async () => {
			if (!longHorizon) return collected;
			const beforeGc = process.memoryUsage();
			const gcStarted = performance.now();
			// Same existing GC/event-loop sequence as the Grid workload; no
			// distinct-room slope or absolute threshold is imported here.
			for (let turn = 0; turn < 3; turn += 1) {
				required(globalThis.gc)();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			return {
				...collected,
				beforeGc,
				postGc: process.memoryUsage(),
				testOnly: {
					collectionAndAssertionsMs,
					gcAndEventLoopMs: performance.now() - gcStarted,
					gcTurns: 3,
					eventLoopTurns: 3,
				},
				samplingBoundary: phase === "startup" ? "startup" : "joined-after-epoch-accounting",
			};
		})();
		sampleCount += 1;
		// The existing short controller keeps its original samples. Long mode
		// streams each record and retains only a count, never an epoch-sized array.
		if (!longHorizon) samples.push(sampleRecord);
		writeSync(1, `R10_NATIVE_SHALLOW_SAMPLE ${JSON.stringify(sampleRecord)}\n`);
	};
	const accountEpoch = async (epoch: number) => {
		for (let index = 0; index < 64; index += 1) await captureNativeControlSuffix(index, epoch);
		for (let index = 0; index < 64; index += 1) {
			const author = required(fixture.identities[index]).author,
				name = `r10-peer-${index}`;
			const commits = nativeEnduranceObserved.commits.filter((row) => row.name === name);
			const current = commits.filter(({ commit }) => record(commit.envelope.canonicalPreimageBytes).epoch === epoch);
			expect(
				current.filter(({ commit }) => operation(commit).action === "causalJoin"),
				"R10_NO_UNACCOUNTED_NATIVE_CAUSAL_JOINS"
			).toHaveLength(expectedJoinsByAuthor.get(`${epoch}:${name}`) ?? 0);
			expectedJoinsByAuthor.delete(`${epoch}:${name}`);
			const suffix = commits.filter(({ commit }) => record(commit.envelope.canonicalPreimageBytes).epoch === epoch + 1);
			const issuance = await fixture.host.openIssuance(name);
			try {
				const lineage = await issuance.readLineage({ author, objectId: fixture.objectId });
				const through = lineage.next - suffix.length,
					start = required(nextSequences.get(author));
				expect(
					current.map(({ commit }) => commit.authorSequence),
					"R10_PER_AUTHOR_NO_HOLE_DUPLICATE_OR_SKIPPED_ORDINAL"
				).toEqual(Array.from({ length: through - start }, (_, offset) => start + offset));
				expect(
					suffix.map(({ commit }) => commit.authorSequence),
					"R10_SUCCESSOR_EXACT_SUFFIX"
				).toEqual(Array.from({ length: suffix.length }, (_, offset) => through + offset));
				expect(current.length + suffix.length, "R10_OBSERVER_ONLY_CURRENT_NEXT_SUFFIX").toBe(commits.length);
				expect(
					current.filter(({ commit }) => operation(commit).action === "$drp.author-fence.v1"),
					"R10_ONE_GENUINE_FENCE_PER_WRITER_EPOCH"
				).toHaveLength(1);
				for (const { commit } of current) {
					const initiallyFailed = [...pendingExpected.values()].find(
						(source) =>
							source.originallyPending &&
							source.source.issuedRecord.scope.author === author &&
							source.source.authorSequence === commit.authorSequence
					);
					if (initiallyFailed !== undefined)
						expect(initiallyFailed.publishedAfterReopen, "R10_INITIAL_PUBLICATION_DEBT_TRUTHFULLY_DRAINED").toBe(true);
					const publications = nativeEnduranceObserved.publications.filter(
						(row) => row.name === name && row.sequence === commit.authorSequence
					);
					expect(publications, "R10_EXACT_FIRST_SUCCESSFUL_PUBLICATION_CONSERVATION").toHaveLength(1);
					if (publications.length) expect(required(publications[0]).digest).toBe(hex(commit.envelope.digest));
					totals.publication += publications.length;
					totals.commits += 1;
				}
				nextSequences.set(author, through);
			} finally {
				await issuance.close();
			}
		}
		const carry = nativeEnduranceObserved.commits.filter(
			({ commit }) => record(commit.envelope.canonicalPreimageBytes).epoch === epoch + 1
		);
		const digests = new Set(carry.map(({ commit }) => hex(commit.envelope.digest)));
		nativeEnduranceObserved.commits.splice(0, nativeEnduranceObserved.commits.length, ...carry);
		nativeEnduranceObserved.publications.splice(
			0,
			nativeEnduranceObserved.publications.length,
			...nativeEnduranceObserved.publications.filter((row) => digests.has(row.digest))
		);
		nativeEnduranceObserved.graphs.length = 0;
		nativeEnduranceObserved.advances.length = 0;
		nativeEnduranceObserved.snapshots.length = 0;
		fixture.signing.digests.length = 0;
		for (const peer of peers) peer.releaseAcceptedEvidence();
		vi.clearAllMocks();
	};
	const assertClosedEpoch = async (epoch: number, sealedState: Uint8Array) => {
		for (let index = 0; index < 64; index += 1) await captureNativeControlSuffix(index, epoch);
		const graph = required(nativeEnduranceObserved.graphs.at(-1));
		const excluded = new Set([...pendingExpected.values()].map((source) => hex(source.source.envelope.digest)));
		const admitted = nativeEnduranceObserved.commits.filter(
			({ commit }) =>
				record(commit.envelope.canonicalPreimageBytes).epoch === epoch && !excluded.has(hex(commit.envelope.digest))
		);
		expect([...graph.result.closeSetOrder].sort(), "R10_EXACT_AUTHENTICATED_SIGNED_CLOSE_SET").toEqual(
			admitted.map(({ commit }) => hex(commit.envelope.digest)).sort()
		);
		totals.closedJoins += admitted.filter(({ commit }) => operation(commit).action === "causalJoin").length;
		for (const { commit } of admitted) {
			const digest = hex(commit.envelope.digest);
			expect(hex(hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes))).toBe(digest);
			expect(
				ed25519.verify(
					commit.envelope.signature,
					commit.envelope.digest,
					Buffer.from(commit.issuedRecord.scope.author, "hex")
				),
				"R10_EACH_CLOSE_MEMBER_ACTUAL_SIGNATURE"
			).toBe(true);
			expect(required(graph.input.vertices.get(digest)).operation).toEqual(operation(commit));
			expect(required(graph.input.vertices.get(digest)).dependencies).toEqual(
				record(commit.envelope.canonicalPreimageBytes).dependencies
			);
			expect(graph.input.authenticatedCanonicalPreimageByteLengths.get(digest)).toBe(
				commit.envelope.canonicalPreimageBytes.byteLength
			);
		}
		const advance = required(nativeEnduranceObserved.advances.at(-1));
		const candidates = advance.proposed.candidates;
		expect(advance.currentTrust.currentEpoch).toBe(epoch);
		expect(advance.successorTrust.currentEpoch).toBe(epoch + 1);
		const selected = (kind: string, matches: (value: Record<string, unknown>, bytes: Uint8Array) => boolean) => {
			const rows = candidates.filter(({ bytes }) => {
				const value = record(bytes);
				return value.kind === kind && matches(value, bytes);
			});
			expect(rows, `R10_UNIQUE_CURRENT_CLOSE_${kind}`).toHaveLength(1);
			return required(rows[0]);
		};
		const settlement = selected(
			"drp-creator-author-settlement-state",
			(value) =>
				value.closedEpoch === epoch &&
				value.successorEpoch === epoch + 1 &&
				value.successorAnchorDigest === advance.successorTrust.currentAnchorDigest
		);
		const settlementRecord = record(settlement.bytes);
		const cutCandidate = selected(
			"drp-hard-epoch-cut",
			(value, bytes) =>
				value.epoch === epoch && hex(hashDomain("ts-drp/hard-epoch-cut/v3", bytes)) === settlementRecord.cutValueDigest
		);
		const cut = record(cutCandidate.bytes);
		const qc = required(
			candidates.find(({ ref }) => ref.digest === (settlementRecord.commitQcRef as { digest: string }).digest)
		);
		const opened = openCreatorAuthorSettlement({
			exactCanonicalRecordBytes: settlement.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCurrentAclDigest: settlementRecord.currentAclDigest,
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cutCandidate.bytes)),
			expectedSnapshotManifestDigest: cut.snapshotManifestDigest,
			expectedSuccessorAclDigest: settlementRecord.successorAclDigest,
			floorTrust: advance.successorTrust,
		});
		expect(opened.ok, `R10_ORIGINAL_FLOOR_BOUND_SETTLEMENT_AUTHENTICATION_${opened.ok ? "OK" : opened.reason}`).toBe(
			true
		);
		if (!opened.ok) throw new TypeError(`R10_NATIVE_SETTLEMENT_OPEN_FAILED_${opened.reason}`);
		const identity = required(resolveCreatorAuthorSettlement(opened.capability));
		const sealAuthority = openSealAuthority({
			trust: advance.currentTrust,
			signerPublicKey: ed25519.getPublicKey(required(fixture.identities[0]).seed),
		});
		expect(sealAuthority.ok).toBe(true);
		if (!sealAuthority.ok) throw new TypeError("R10_NATIVE_QC_AUTHORITY_REQUIRED");
		expect(verifySealQC({ authority: sealAuthority.authority, exactCanonicalQcBytes: qc.bytes })).toMatchObject({
			ok: true,
			phase: "commit",
			valueDigest: identity.cutValueDigest,
		});
		expect(cut).toMatchObject({
			objectId: fixture.objectId,
			epoch,
			stateDigest: hex(hashDomain("ts-drp/state/v3", sealedState)),
			closeSetCount: admitted.length,
			historyRoot: graph.result.historyRoot,
			historySize: graph.result.historySize,
			closeSetRoot: graph.result.closeSetRoot,
		});
		const history = CompactMerkleAccumulator.fromSnapshot(graph.input.previousHistorySnapshot);
		if (independentHistory !== undefined)
			expect(graph.input.previousHistorySnapshot, "R10_LONG_INDEPENDENT_PRIOR_COMPACT_HISTORY").toEqual(
				independentHistory.snapshot()
			);
		expect(history.size).toBe(priorCheckpoint?.historySize ?? 0);
		await history.appendMany(
			graph.result.closeSetOrder.map((vertexHash, offset) =>
				encodeCanonical({
					epoch,
					kind: "drp-history-leaf",
					objectId: fixture.objectId,
					ordinal: history.size + offset,
					protocolMajor: 3,
					vertexHash,
				})
			)
		);
		expect(history.size).toBe((priorCheckpoint?.historySize ?? 0) + admitted.length);
		expect(hex(history.root()), "R10_EXACT_ORDERED_HISTORY_EXTENSION").toBe(identity.historyRoot);
		expect(identity.historySize).toBe(history.size);
		if (independentHistory !== undefined) {
			const priorSize = independentHistory.size;
			await independentHistory.appendMany(
				graph.result.closeSetOrder.map((vertexHash, offset) =>
					encodeCanonical({
						epoch,
						kind: "drp-history-leaf",
						objectId: fixture.objectId,
						ordinal: priorSize + offset,
						protocolMajor: 3,
						vertexHash,
					})
				)
			);
			expect(independentHistory.snapshot(), "R10_LONG_INDEPENDENT_ORDERED_HISTORY_EXTENSION").toEqual(
				history.snapshot()
			);
			expect(hex(independentHistory.root())).toBe(identity.historyRoot);
		}
		expect(identity.frontiers).toHaveLength(64);
		for (let index = 0; index < 64; index += 1) {
			const author = required(fixture.identities[index]).author;
			const ordinary = required(
				admitted.find(
					({ commit }) =>
						commit.issuedRecord.scope.author === author &&
						operation(commit).id === `writer-${index.toString().padStart(2, "0")}` &&
						operation(commit).x === epoch
				)
			);
			expect(frontierFor(opened.capability, author)?.[2]).toBe(ordinary.commit.authorSequence);
		}
		if (priorCheckpoint !== undefined) {
			expect(identity.closedAnchorDigest).toBe(priorCheckpoint.successor);
			expect(identity.priorCheckpointDigest).toBe(priorCheckpoint.digest);
			expect(cut.previousHistoryRoot).toBe(priorCheckpoint.historyRoot);
		}
		const snapshot = required(
			nativeEnduranceObserved.snapshots.findLast((row) => row.result.manifestDigest === identity.snapshotManifestDigest)
		);
		const payload = new Uint8Array(Buffer.concat(snapshot.result.chunks));
		expect(payload).toEqual(snapshot.input.exactCanonicalPayloadBytes);
		expect(encodeCanonical(record(payload).application), "R10_AUTHENTICATED_SNAPSHOT_EXACT_INDEPENDENT_WORLD").toEqual(
			sealedState
		);
		const historyCandidate = selected(
			"creator-close-history-1",
			(value) => value.cutValueDigest === identity.cutValueDigest
		);
		expect(
			openCreatorCloseHistory({
				bytes: historyCandidate.bytes,
				exactCanonicalCutValueBytes: cutCandidate.bytes,
				historyRoot: identity.historyRoot,
				historySize: identity.historySize,
			})
		).toEqual(history.snapshot());
		priorCheckpoint = {
			digest: settlement.ref.digest,
			successor: identity.successorAnchorDigest,
			historyRoot: identity.historyRoot,
			historySize: identity.historySize,
		};
	};
	for (let index = 0; index < 64; index += 1) {
		const proxy: SnapshotChunkProtocolPort = {
			localPeerId: `r9-grid-peer-${index}`,
			connectedPeers: () => ["r9-grid-peer-0"],
			open: (peer) => required(deliveries.get(index)).port.open(peer),
			serve: () => () => undefined,
			close: () => deliveries.get(index)?.port.close(),
		};
		peers.push(
			await fixture.open("create", `r10-peer-${index}`, fixture.invite, fixture.objectId, {
				index,
				...(index === 0 ? {} : { protocol: proxy }),
			})
		);
		if (exactComposition) await captureNativeControlSuffix(index, 0);
		if (index % 8 === 7) writeSync(1, `R10_NATIVE_STARTUP ${index + 1} ${JSON.stringify(process.memoryUsage())}\n`);
	}
	expect(peers).toHaveLength(64);
	await sample("startup");
	for (let epoch = 0; epoch <= transitions; epoch += 1) {
		fixture.setNativeStage(`epoch-${epoch}-ordinary-contribution`);
		for (let index = 0; index < 64; index += 1) {
			const before = nativeEnduranceObserved.commits.length;
			await add(
				index,
				exactComposition ? `writer-${index.toString().padStart(2, "0")}` : `r10-e${epoch}-w${index}`,
				epoch * 64 + index
			);
			if (index !== 0) await flush(index);
			if (exactComposition) {
				const issued = nativeEnduranceObserved.commits
					.slice(before)
					.filter(
						({ commit }) =>
							operation(commit).action === "placeBlock" &&
							operation(commit).id === `writer-${index.toString().padStart(2, "0")}` &&
							operation(commit).x === epoch
					);
				expect(issued, "R10_ONE_REAL_ORDINARY_CONTRIBUTION_PER_WRITER_EPOCH").toHaveLength(1);
				const { commit, plan } = required(issued[0]);
				expect(record(commit.envelope.canonicalPreimageBytes).epoch).toBe(epoch);
				expect(commit.issuedRecord.scope).toEqual({
					author: required(fixture.identities[index]).author,
					objectId: fixture.objectId,
				});
				expect(required(plan?.fenceSequence ?? undefined)).toBeLessThan(commit.authorSequence);
				const order = readV3ApplicationProjectionOrder({
					plane: required(nativeEnduranceObserved.planes.get("r9-grid-peer-0")),
				});
				expect(order.ok, "R10_GENUINE_CREATOR_AUTHENTICATED_APPLIED_CONTRIBUTION").toBe(true);
				if (!order.ok) throw new TypeError(order.detail);
				expect(order.order.digests).toContain(hex(commit.envelope.digest));
				totals.ordinary += 1;
			}
		}
		checkWorld(required(peers[0]));
		if (exactComposition) expect(expected.size).toBe(64);
		if (epoch === transitions) {
			if (exactComposition) await accountEpoch(epoch);
			break;
		}
		if (exactComposition && epoch === 0) await persistedCheckpoint(0, "PRE_CLOSE");
		const sealedState = state(required(peers[0])).slice();
		const cohort = Array.from({ length: 8 }, (_, offset) => 1 + ((epoch * 8 + offset) % 63));
		for (const index of cohort) {
			if (index === cohort[1]) fixture.publicationRefusals.add(index);
			if (index === cohort[0] || index === cohort[1]) {
				const id = exactComposition ? `writer-${index.toString().padStart(2, "0")}` : `r10-offline-e${epoch}-w${index}`;
				const ordinal = 192 + epoch * 2 + (index === cohort[0] ? 0 : 1);
				const block = Object.freeze({
					id,
					kind: "stone",
					x: exactComposition ? -epoch - 1 : ordinal % 32,
					y: exactComposition ? -index - 1 : Math.floor(ordinal / 32),
				});
				const checkJoins = await prepareJoinAccounting(index);
				if (fixture.publicationRefusals.has(index))
					await expect(required(peers[index]).room.issue({ action: "placeBlock", ...block })).rejects.toThrow(
						"publication failed"
					);
				else await required(peers[index]).room.issue({ action: "placeBlock", ...block });
				checkJoins();
				if (exactComposition) {
					const source = required((await rows(index)).at(-1));
					expect(source.publishState).toBe(index === cohort[1] ? "pending" : "published");
					const order = readV3ApplicationProjectionOrder({
						plane: required(nativeEnduranceObserved.planes.get("r9-grid-peer-0")),
					});
					if (!order.ok) throw new TypeError(order.detail);
					expect(order.order.digests).not.toContain(hex(source.commit.envelope.digest));
					const originallyPending = index === cohort[1];
					expect(
						nativeEnduranceObserved.publications.filter(
							(row) => row.name === `r10-peer-${index}` && row.sequence === source.commit.authorSequence
						),
						"R10_ORIGINAL_SOURCE_PUBLICATION_BEFORE_CLOSE"
					).toHaveLength(originallyPending ? 0 : 1);
					pendingExpected.set(index, { block, source: source.commit, originallyPending, publishedAfterReopen: false });
					if (originallyPending) totals.initialPublicationFailures += 1;
					totals.sources += 1;
				} else expected.set(id, block);
			}
			await fixture.stop(required(peers[index]));
		}
		fixture.setNativeStage(`epoch-${epoch}-creator-seal`);
		const sealed = await required(peers[0]).room.sealEpoch();
		expect(sealed).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		if (exactComposition) {
			await assertClosedEpoch(epoch, sealedState);
			if (epoch === 0) await persistedCheckpoint(63, "POST_CLOSE_PRE_ADOPTION");
			if (epoch === 1) await persistedCheckpoint(62, "PRE_ADOPTION");
		}
		fixture.setNativeStage(`epoch-${epoch}-creator-adopt`);
		await required(peers[0]).room.adoptCreatorSuccessor();
		if (exactComposition) {
			expect(state(required(peers[0]))).toEqual(sealedState);
			expect(required(peers[0]).room.authority()).toMatchObject({
				epoch: epoch + 1,
				anchorDigest: required(priorCheckpoint).successor,
			});
			await assertNativeRollbackBytes();
			totals.transitions += 1;
			if (epoch === 0) await persistedCheckpoint(0, "POST_ADOPTION_POST_PRUNE");
		}
		fixture.publicationRefusals.clear();
		for (let index = 1; index < 64; index += 1) {
			fixture.setNativeStage(`epoch-${epoch}-recipient-${index}-install`);
			const delivery = await recipientSource(fixture, "r10-peer-0", fixture.objectId, fixture.invite, false, index);
			const priorDelivery = deliveries.get(index);
			deliveries.set(index, delivery);
			const publicationOffset = nativeEnduranceObserved.publications.length;
			if (cohort.includes(index))
				peers[index] = await fixture.open("reopen", `r10-peer-${index}`, fixture.invite, fixture.objectId, {
					index,
					protocol: {
						localPeerId: `r9-grid-peer-${index}`,
						connectedPeers: () => ["r9-grid-peer-0"],
						open: (peer) => required(deliveries.get(index)).port.open(peer),
						serve: () => () => undefined,
						close: () => deliveries.get(index)?.port.close(),
					},
				});
			if (exactComposition) {
				const source = pendingExpected.get(index);
				if (source !== undefined) {
					// This real native cold reopen still owns the old head. Unlike the
					// historical copied-target fixture, startup truthfully publishes its
					// pending original before public target installation/rebase.
					const reopenedOrder = readV3ApplicationProjectionOrder({
						plane: required(nativeEnduranceObserved.planes.get(`r9-grid-peer-${index}`)),
					});
					expect(reopenedOrder.ok, "R10_NATIVE_OLD_HEAD_REOPEN_CURRENT_AUTHENTICATED_SCOPE").toBe(true);
					if (!reopenedOrder.ok) throw new TypeError(reopenedOrder.detail);
					expect(reopenedOrder.order.epoch).toBe(epoch);
					const original = required(
						(await rows(index)).find((row) => row.commit.authorSequence === source.source.authorSequence)
					);
					expect(original.commit).toEqual(source.source);
					expect(original.publishState).toBe("published");
					const matches = (row: { name: string; sequence: number }) =>
						row.name === `r10-peer-${index}` && row.sequence === source.source.authorSequence;
					const publications = nativeEnduranceObserved.publications.filter(matches);
					expect(publications, "R10_EXACT_ORIGINAL_SOURCE_FIRST_PUBLICATION").toHaveLength(1);
					expect(required(publications[0]).digest).toBe(hex(source.source.envelope.digest));
					expect(
						nativeEnduranceObserved.publications.slice(publicationOffset).filter(matches),
						"R10_OLD_HEAD_REOPEN_PUBLICATION_CONTINUITY"
					).toHaveLength(source.originallyPending ? 1 : 0);
					source.publishedAfterReopen = source.originallyPending;
				}
			}
			await required(peers[index]).room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
			await flush(index);
			if (exactComposition) {
				// install and byte reads are joined before replacing their fixture
				// delivery owner; the original product joined close is untouched.
				if (priorDelivery !== undefined) {
					await priorDelivery.port.close();
					protocolPorts.delete(priorDelivery.port);
				}
				const source = pendingExpected.get(index);
				if (source !== undefined) {
					const issuance = await fixture.host.openIssuance(`r10-peer-${index}`);
					try {
						const plan = required(
							await issuance.readSettlementPlan({
								author: required(fixture.identities[index]).author,
								objectId: fixture.objectId,
							})
						);
						const entry = required(plan.entries.find((row) => row.sourceSequence === source.source.authorSequence));
						expect(entry.disposition).toBe("rebase");
						expect(entry.sourceDigest).toEqual(source.source.envelope.digest);
						const fence = required(plan.fenceSequence ?? undefined),
							replacementSequence = required(entry.replacementSequence ?? undefined);
						const replacement = required(
							await issuance.readIssued(
								{ author: required(fixture.identities[index]).author, objectId: fixture.objectId },
								replacementSequence
							)
						);
						expect(replacement.authorSequence, "R10_NATIVE_PLAN_EXACT_SOURCE_TO_REPLACEMENT_LINK").toBe(
							replacementSequence
						);
						if (entry.replacementProgress !== undefined) {
							expect(entry.replacementProgress.intentCount).toBe(1);
							expect(entry.replacementProgress.chunks).toHaveLength(1);
							expect(required(entry.replacementProgress.chunks[0])).toMatchObject({
								replacementSequence,
								throughIntent: 1,
								lastLogicalTime: record(replacement.envelope.canonicalPreimageBytes).logicalTime,
							});
						}
						expect(operation(replacement)).toEqual({ action: "placeBlock", ...source.block });
						expect(fence).toBeGreaterThan(source.source.authorSequence);
						expect(replacementSequence).toBeGreaterThan(fence);
						const creatorOrder = readV3ApplicationProjectionOrder({
							plane: required(nativeEnduranceObserved.planes.get("r9-grid-peer-0")),
						});
						if (!creatorOrder.ok) throw new TypeError(creatorOrder.detail);
						expect(creatorOrder.order.digests).toContain(hex(replacement.envelope.digest));
						expect(creatorOrder.order.digests).not.toContain(hex(source.source.envelope.digest));
						expect(
							nativeEnduranceObserved.publications.filter(
								(row) => row.name === `r10-peer-${index}` && row.sequence === replacementSequence
							)
						).toHaveLength(1);
						expected.set(source.block.id, source.block);
						totals.recovered += 1;
					} finally {
						await issuance.close();
					}
				}
				expect(protocolPorts.size).toBeLessThanOrEqual(64);
			}
		}
		checkWorld(required(peers[0]));
		for (const index of cohort.slice(0, 2)) {
			const issuance = await fixture.host.openIssuance(`r10-peer-${index}`);
			try {
				const plan = required(
					await issuance.readSettlementPlan({
						author: required(fixture.identities[index]).author,
						objectId: fixture.objectId,
					})
				);
				expect(plan.fenceSequence).not.toBeNull();
				expect(plan.entries.some((entry) => entry.disposition === "rebase" && entry.replacementSequence !== null)).toBe(
					true
				);
			} finally {
				await issuance.close();
			}
		}
		if (!longHorizon) await sample(`adopted-${epoch + 1}`);
		// Orderly joined persisted reopen, explicitly not process-death evidence.
		if (epoch === 0 && !exactComposition) {
			fixture.setNativeStage("epoch-1-orderly-creator-reopen");
			const exact = state(required(peers[0]));
			await fixture.stop(required(peers[0]));
			peers[0] = await fixture.open("reopen", "r10-peer-0");
			expect(state(required(peers[0]))).toEqual(exact);
		}
		if (exactComposition) {
			await accountEpoch(epoch);
			pendingExpected.clear();
			if (epoch === 2) await persistedCheckpoint(0, "POST_PRUNE");
		}
		// All original conservation assertions execute before releasing their
		// captured payloads. Only long mode samples after that joined release.
		if (longHorizon) await sample(`adopted-${epoch + 1}`);
	}
	// The four native plan/fence/replacement checks above cover same-author
	// current-Writer recovery, not creator-selected portable settlement.
	expect(fixture.approvals.length).toBe(0);
	await sample(`continued-epoch-${transitions}`);
	if (longHorizon) {
		expect(sampleCount).toBe(transitions + 2);
		expect(samples, "R10_LONG_NO_RETAINED_PER_EPOCH_SAMPLE_RECORDS").toHaveLength(0);
	} else expect(samples).toHaveLength(transitions + 2);
	if (exactComposition) {
		if (longHorizon) {
			expect(totals).toMatchObject({
				ordinary: 64 * (transitions + 1),
				sources: 2 * transitions,
				recovered: 2 * transitions,
				transitions,
				orderlyReopens: 5,
				initialPublicationFailures: transitions,
			});
			// Bootstrap 64; each of T+1 epochs has 64 ordinary commits and
			// 64 fences; each close adds two offline sources and two replacements.
			const nonJoinCommits = 64 + 128 * (transitions + 1) + 4 * transitions;
			expect(totals.commits, "R10_LONG_EXACT_TOTAL_COMMITS").toBe(nonJoinCommits + totals.expectedJoins);
			expect(totals.publication, "R10_LONG_EXACT_FIRST_SUCCESSFUL_PUBLICATIONS").toBe(
				nonJoinCommits + totals.expectedJoins
			);
			expect(totals.commits - 64, "R10_LONG_SEPARATE_NON_BOOTSTRAP_COMMITS").toBe(
				nonJoinCommits - 64 + totals.expectedJoins
			);
			expect(totals.publication - 64, "R10_LONG_SEPARATE_NON_BOOTSTRAP_PUBLICATIONS").toBe(
				nonJoinCommits - 64 + totals.expectedJoins
			);
			// First close: 64 bootstrap +64 fences +64 ordinary. Later closes:
			// 64 fences +64 ordinary +two prior-epoch recovery replacements.
			const nonJoinClosedHistory = 192 + 130 * (transitions - 1);
			expect(required(priorCheckpoint).historySize, "R10_LONG_EXACT_AUTHENTICATED_HISTORY_SIZE").toBe(
				nonJoinClosedHistory + totals.closedJoins
			);
		} else {
			expect(totals).toMatchObject({
				ordinary: 256,
				sources: 6,
				recovered: 6,
				transitions: 3,
				orderlyReopens: 5,
				initialPublicationFailures: 3,
			});
			expect(totals.joins, "R10_COMPLETE_INDEPENDENT_JOIN_CONSERVATION").toBe(totals.expectedJoins);
			expect(expectedJoinsByAuthor.size, "R10_NO_UNACCOUNTED_PRE_ISSUE_JOIN_FORECAST").toBe(0);
			expect(totals.commits, "R10_EXACT_TOTAL_COMMITS_INCLUDING_64_GENUINE_BOOTSTRAPS_AND_JOINS").toBe(
				588 + totals.expectedJoins
			);
			expect(totals.publication, "R10_EXACT_TOTAL_FIRST_SUCCESSFUL_PUBLICATIONS").toBe(588 + totals.expectedJoins);
			expect(totals.commits - 64, "R10_SEPARATE_NON_BOOTSTRAP_COMMIT_ACCOUNTING").toBe(524 + totals.expectedJoins);
			expect(totals.publication - 64, "R10_SEPARATE_NON_BOOTSTRAP_PUBLICATION_ACCOUNTING").toBe(
				524 + totals.expectedJoins
			);
			expect(required(priorCheckpoint).historySize, "R10_EXACT_THREE_CLOSE_AUTHENTICATED_HISTORY_SIZE").toBe(
				452 + totals.closedJoins
			);
		}
		if (longHorizon) {
			expect(totals.joins, "R10_COMPLETE_INDEPENDENT_JOIN_CONSERVATION").toBe(totals.expectedJoins);
			expect(expectedJoinsByAuthor.size, "R10_NO_UNACCOUNTED_PRE_ISSUE_JOIN_FORECAST").toBe(0);
		}
		expect(nativeEnduranceObserved.commits).toHaveLength(0);
		expect(nativeEnduranceObserved.publications).toHaveLength(0);
		await persistedCheckpoint(0, "FINAL_CONTINUED_WORLD");
		checkWorld(required(peers[0]));
		await measureFinalSealDiagnostic();
	}
}
it.runIf(process.env.TS_DRP_R10_NATIVE_SHALLOW === "1")(
	"R10 native preparation: 64 active Writers and two authenticated same-room transitions",
	() => runNativeGridComposition(2),
	1_800_000
);
it.runIf(process.env.TS_DRP_R10_NATIVE_COMPOSITION === "1")(
	"R10 native composition: 64 active Writers fixed world and three authenticated same-room transitions",
	() => runNativeGridComposition(3, true),
	10_800_000
);
it.runIf(process.env.TS_DRP_R10_NATIVE_LONG_HORIZON === "1")(
	"R10 native continuous long horizon: 64 active Writers fixed world and at least 100 authenticated same-room transitions",
	async () => {
		if (process.env.TS_DRP_R10_NATIVE_COMPOSITION !== "1" || process.env.TS_DRP_R10_NATIVE_SHALLOW !== "1")
			throw new TypeError("R10_NATIVE_LONG_EXISTING_ACCOUNTING_OBSERVERS_REQUIRED");
		if (process.env.TS_DRP_R10_FORECAST_DIAGNOSTIC === "1" || process.env.TS_DRP_R10_NATIVE_SEAL_DIAGNOSTIC === "1")
			throw new TypeError("R10_NATIVE_LONG_ENFORCED_NONDIAGNOSTIC_WORKLOAD_REQUIRED");
		const selected = process.env.TS_DRP_R10_NATIVE_TRANSITIONS ?? "100";
		if (!/^[1-9][0-9]*$/.test(selected)) throw new TypeError("R10_NATIVE_TRANSITION_DOMAIN_REQUIRED");
		await runNativeGridComposition(Number(selected), true, true);
	},
	// Preparation default only. The original fresh-process resource workload,
	// memory window/watchdog/epsilon/absolute ceiling still need their own freeze.
	10_800_000
);

async function exactSourceEffects(
	fixture: Awaited<ReturnType<typeof gridFixture>>,
	opened: Awaited<ReturnType<Awaited<ReturnType<typeof gridFixture>>["open"]>>
) {
	const issuance = await fixture.host.openIssuance("source");
	try {
		const scope = { author: opened.input.author, objectId: fixture.objectId };
		return encodeCanonical({
			lineage: await issuance.readLineage(scope),
			outbox: await issuance.readOutboxPage({ scope, limit: 128 }),
			state: required(fixture.application.migration).canonicalStateBytes(opened.room.projection()),
			floor: await opened.floor.read({
				scope: { objectId: fixture.objectId, pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest },
			}),
		});
	} finally {
		await issuance.close();
	}
}

// Original scripted byte transport answers the original signed material server;
// it grants no authority and receives only bytes read from genuine SQLite.
async function recipientSource(
	fixture: Awaited<ReturnType<typeof gridFixture>>,
	name: string,
	objectId: string,
	invite: Awaited<ReturnType<Awaited<ReturnType<typeof gridFixture>>["material"]>>,
	nullSettlementCompanion = false,
	receiverIndex = 1
) {
	const object = parseStorageObjectId(objectId);
	if (!object.ok) throw new TypeError("R9_TEST_OBJECT_INVALID");
	const store = await fixture.host.openAhe(`${name}--ahe`),
		snapshotStore = await fixture.host.openSnapshots(name);
	try {
		const exported = await readCreatorSuccessorExport({
			store,
			snapshotStore,
			catalog: fixture.application.catalog,
			objectId: object.value,
			pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: invite.detachedGenesisSignature,
		});
		const scope = await snapshotStore.openScope(exported.declaration);
		const read = scope.verificationQuarantine.open(new AbortController().signal);
		const chunks: Uint8Array[] = [];
		try {
			for (const descriptor of exported.declaration.chunks) {
				const chunk = await read.read(descriptor);
				if (chunk === undefined) throw new TypeError("R9_NATIVE_SOURCE_SNAPSHOT_MISSING");
				chunks.push(chunk);
			}
		} finally {
			await read.discard();
			await scope.release();
		}
		const sender = "r9-grid-peer-0",
			receiver = `r9-grid-peer-${receiverIndex}`,
			creator = required(fixture.identities[0]);
		let material = exported.material;
		if (nullSettlementCompanion) {
			const originalSettlement = exported.material.exactCanonicalSettlementBytes;
			if (!(originalSettlement instanceof Uint8Array) || originalSettlement.byteLength > 8192)
				throw new TypeError("R9_BOUNDED_ORIGINAL_V1_SETTLEMENT_REQUIRED");
			// Explicit adversarial WRONG-KIND distractors, not valid none-profile
			// proofs. Genuine original v1 bytes only satisfy the transport shape so
			// independent authenticated profile checking sees the missing proof.
			material = {
				...exported.material,
				exactCanonicalSettlementBytes: null,
				exactCanonicalRetirementBytes: new Uint8Array(originalSettlement),
				exactCanonicalAggregateBytes: new Uint8Array(originalSettlement),
			};
		}
		const scripted = new ScriptedSnapshotChunkPort(
			{ declaration: exported.declaration, chunks } as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
			new Map([[sender, "honest"]]),
			receiver
		);
		const server = createCreatorSuccessorMaterialServer({
			identity: {
				author: creator.author,
				sign: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
				isAuthorizedAuthor: (author) => fixture.identities.some((identity) => identity.author === author),
			},
			localPeerId: sender,
			manifestDigest: exported.declaration.scope.manifestDigest,
			material,
			connectedPeers: () => [receiver],
		});
		const requestDigests: Uint8Array[] = [];
		const port: SnapshotChunkProtocolPort = {
			localPeerId: receiver,
			connectedPeers: () => [sender],
			close: () => scripted.close(),
			serve: (handler) => scripted.serve(handler),
			open: async (peer) => {
				const stream = await scripted.open(peer),
					frames: Uint8Array[] = [];
				let materialRequest = false;
				return {
					peerId: peer,
					abort: (reason) => stream.abort(reason),
					close: () => stream.close(),
					read: async (maximum, options) => {
						if (!materialRequest) return stream.read(maximum, options);
						options.signal.throwIfAborted();
						const frame = frames.shift();
						if (frame === undefined || frame.byteLength > maximum) throw new TypeError("R9_MATERIAL_FRAME_INVALID");
						return frame;
					},
					write: async (bytes, options) => {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind !== "creator-successor-material-request") return stream.write(bytes, options);
						materialRequest = true;
						const proof = { ...request };
						delete proof.signature;
						requestDigests.push(hashDomain("ts-drp/creator-successor-transport/v1", encodeCanonical(proof)));
						const inbound: SnapshotChunkProtocolStream = {
							peerId: receiver,
							abort: () => undefined,
							close: () => Promise.resolve(),
							read: () => Promise.reject(new TypeError("R9_MATERIAL_REREAD")),
							write: (frame) => {
								frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("R9_SIGNED_MATERIAL_REFUSED");
					},
				};
			},
		};
		protocolPorts.add(port);
		return { offer: exported.offer, port, peers: [sender], requestDigests };
	} finally {
		await snapshotStore.close();
		await store.close();
	}
}

afterEach(async () => {
	const joined = await Promise.allSettled([...openRooms].map((room) => room.close()));
	openRooms.clear();
	const headJoined = await Promise.allSettled([...floors].map((floor) => floor.close()));
	floors.clear();
	const protocolJoined = await Promise.allSettled([...protocolPorts].map((port) => port.close()));
	protocolPorts.clear();
	const signingJoined = await Promise.allSettled([...keychains].map((keychain) => keychain.stop()));
	keychains.clear();
	if (process.env.TS_DRP_R10_NATIVE_ACCOUNTING_DIAGNOSTIC === "1") {
		const describe = (value: unknown, depth = 0): unknown => {
			if (depth >= 6) return "bounded-cause-depth";
			if (!(value instanceof Error))
				return typeof value === "string" ? value.slice(0, 4096) : String(value).slice(0, 4096);
			return {
				name: value.name,
				message: value.message.slice(0, 4096),
				stack: value.stack?.slice(0, 8192),
				cause: value.cause === undefined ? undefined : describe(value.cause, depth + 1),
				errors:
					value instanceof AggregateError
						? Array.from(value.errors as unknown[])
								.slice(0, 32)
								.map((error) => describe(error, depth + 1))
						: undefined,
			};
		};
		for (const [family, outcomes] of [
			["rooms", joined],
			["heads", headJoined],
			["protocol", protocolJoined],
			["signing", signingJoined],
		] as const)
			for (const [index, outcome] of outcomes.entries())
				if (outcome.status === "rejected")
					writeSync(
						1,
						`R10_NATIVE_JOIN_FAILURE ${JSON.stringify({ family, index, reason: describe(outcome.reason) })}\n`
					);
	}
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	expect(
		[...joined, ...headJoined, ...protocolJoined, ...signingJoined].filter((result) => result.status === "rejected"),
		"R9_NATIVE_OWNERS_JOIN"
	).toEqual([]);
});

it.each(["signature", "foreign-object", "acl", "parameters"] as const)(
	"native Grid refuses invalid %s invite before durable floor or application acquisition",
	async (invalid) => {
		const fixture = await gridFixture();
		const name = `invalid-invite-${invalid}`;
		const original =
			invalid === "foreign-object" ? await fixture.material(`creator:${"f".repeat(32)}`) : fixture.invite;
		const selected = {
			...original,
			detachedGenesisSignature: new Uint8Array(original.detachedGenesisSignature),
		};
		if (invalid === "signature") selected.detachedGenesisSignature[0] ^= 1;
		if (invalid === "acl") {
			selected.exactCanonicalLatchedAclBytes = encodeCanonical({
				...(decodeCanonical(original.exactCanonicalLatchedAclBytes) as Record<string, unknown>),
				permissionless: true,
			});
		}
		if (invalid === "parameters") {
			selected.exactCanonicalParametersCarrierBytes = encodeCanonical({
				...(decodeCanonical(original.exactCanonicalParametersCarrierBytes) as Record<string, unknown>),
				maxGraphVertices: 1,
			});
		}
		await expect(fixture.open("create", name, selected)).rejects.toThrow();
		const floor = required([...floors].at(-1));
		expect(
			await floor.read({
				scope: {
					objectId: fixture.objectId,
					pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
				},
			})
		).toEqual({ ok: true, state: null });
		expect(existsSync(nativeFilename(fixture.directory, `${name}--ahe--ahe`))).toBe(false);
	},
	120_000
);

it("shared invite authentication binds bounded wire material to the registered application without granting native authority", async () => {
	const fixture = await gridFixture();
	const creatorInvite = hex(
		encodeCanonical({
			...fixture.invite,
			kind: "ts-drp-example-v3-room-creator-invite",
			version: 1,
		})
	);
	const result = authenticateV3RoomCreatorInvite({ creatorInvite, application: fixture.application });
	expect(result).toEqual({
		objectId: fixture.objectId,
		blueprintDigest: required(fixture.application.catalog.blueprintDigests[0]),
		creatorInvite,
		pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
	});
	expect(Object.isFrozen(result)).toBe(true);
	expect(() =>
		authenticateV3RoomCreatorInvite({
			creatorInvite: "0".repeat(131_074),
			application: fixture.application,
		})
	).toThrow("size is invalid");
	const alteredPackage = new Uint8Array(fixture.application.canonicalBlueprintPackageBytes);
	alteredPackage[0] ^= 1;
	expect(() =>
		authenticateV3RoomCreatorInvite({
			creatorInvite,
			application: {
				...fixture.application,
				canonicalBlueprintPackageBytes: alteredPackage,
			},
		})
	).toThrow("application is invalid");
	const opened = await fixture.open("create", "valid-after-refusal");
	await opened.room.issue({ action: "placeBlock", id: "valid-invite-continuation", kind: "stone", x: 1, y: 2 });
	expect(opened.room.projection()).toMatchObject({ blocks: [{ id: "valid-invite-continuation" }] });
}, 120_000);

it("R10 header custody joins genuine same-room close install and persisted continuation", async () => {
	const fixture = await gridFixture();
	const opened = await fixture.open("create");
	for (let epoch = 0; epoch < 3; epoch++) {
		await opened.room.issue(fixture.outcome(opened.room, `header-custody-${epoch}`));
		expect(await opened.room.sealEpoch()).toMatchObject({ ok: true });
		await opened.room.adoptCreatorSuccessor();
		expect(opened.room.authority()).toMatchObject({ epoch: epoch + 1 });
	}
	const expected = encodeCanonical(opened.room.projection());
	await fixture.stop(opened);
	const reopened = await fixture.open("reopen");
		expect(reopened.room.authority()).toMatchObject({ epoch: 3 });
		expect(encodeCanonical(reopened.room.projection())).toEqual(expected);
	await reopened.room.issue(fixture.outcome(reopened.room, "header-custody-reopened"));
}, 120_000);

it("prepares genuine Grid current outcome on native SQLite without portable authority shortcuts", async () => {
	const fixture = await gridFixture();
	const { room } = await fixture.open("create");
	const operation = fixture.outcome(room, "native-source-current");
	await room.issue(operation);
	expect(room.projection()).toMatchObject({ outcomes: [operation] });
}, 120_000);

it.each([false, true])(
	"native Grid transfers current outcomes with inherited snapshot=%s through signed record and persisted redirect",
	async (inherited) => {
		const fixture = await gridFixture();
		const opened = await fixture.open("create");
		const { room } = opened;
		if (inherited) {
			await room.issue(fixture.outcome(room, "source-inherited"));
			expect(await room.sealEpoch()).toMatchObject({ ok: true });
			await room.adoptCreatorSuccessor();
			expect(room.authority()).toMatchObject({ epoch: 1 });
		}
		const oldContextOperation = fixture.outcome(room, "source-current");
		await room.issue(oldContextOperation);
		const expectedOutcomes = encodeCanonical(Reflect.get(room.projection(), "outcomes"));
		const sourceState = required(fixture.application.migration).canonicalStateBytes(room.projection());
		const nonce = new Uint8Array(32).fill(inherited ? 0x73 : 0x72);
		const targetObjectId = expectedTargetObjectId(fixture.objectId, nonce);
		const targetInvite = await fixture.material(targetObjectId);
		const rehearsal = await room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
		expect(rehearsal).toMatchObject({ activated: false, targetAnchorDigest: targetInvite.pinnedGenesisAnchorDigest });
		// Rehearsal leaves the source live and untouched. The target record, rather
		// than ordinary admission of historical approvals, inherits the exact state.
		expect(required(fixture.application.migration).canonicalStateBytes(room.projection())).toEqual(sourceState);
		expect(
			await room.activateMigration({
				exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
				recordVertexDigest: rehearsal.recordVertexDigest,
				targetCreatorInvite: targetInvite,
			})
		).toMatchObject({ activated: true });
		expect(room.objectId).toBe(targetObjectId);
		expect(encodeCanonical(Reflect.get(room.projection(), "outcomes"))).toEqual(expectedOutcomes);
		const targetState = required(fixture.application.migration).canonicalStateBytes(room.projection());
		await expect(room.issue(oldContextOperation)).rejects.toThrow();
		expect(required(fixture.application.migration).canonicalStateBytes(room.projection())).toEqual(targetState);
		if (inherited) {
			// A genuine handoff releases the creator's native/topic owner before the
			// recipient takes it. No database copying or recreated follower path.
			expect(await room.sealEpoch()).toMatchObject({ ok: true });
			await room.adoptCreatorSuccessor();
			const delivery = await recipientSource(
				fixture,
				migrationName(fixture.objectId, targetObjectId, nonce),
				targetObjectId,
				targetInvite
			);
			await fixture.stop(opened);
			const recipient = await fixture.open("create", "recipient", targetInvite, targetObjectId, {
				index: 1,
				protocol: delivery.port,
			});
			await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
			expect(recipient.room.authority()).toMatchObject({ objectId: targetObjectId, epoch: 1 });
			expect(encodeCanonical(Reflect.get(recipient.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
			await expect(recipient.room.issue(oldContextOperation)).rejects.toThrow();
			await fixture.stop(recipient);
			const recipientReopen = await fixture.open("reopen", "recipient", targetInvite, targetObjectId, { index: 1 });
			expect(encodeCanonical(Reflect.get(recipientReopen.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
			await expect(recipientReopen.room.issue(oldContextOperation)).rejects.toThrow();
			const validTargetOperation = fixture.outcome(recipientReopen.room, "recipient-target-continued");
			await recipientReopen.room.issue(validTargetOperation);
			expect(Reflect.get(recipientReopen.room.projection(), "outcomes")).toEqual(
				expect.arrayContaining([validTargetOperation])
			);
			return;
		}
		await fixture.stop(opened);
		const reopened = await fixture.open("reopen");
		expect(reopened.room.objectId).toBe(targetObjectId);
		expect(encodeCanonical(Reflect.get(reopened.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
		await expect(reopened.room.issue(oldContextOperation)).rejects.toThrow();
		const validTargetOperation = fixture.outcome(reopened.room, "target-continued");
		await reopened.room.issue(validTargetOperation);
		expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(expect.arrayContaining([validTargetOperation]));
	},
	180_000
);

it("native Grid refuses forged transfer context, changed proofs/state and duplicate identities before durable effects", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "negative-source"));
	const nonce = new Uint8Array(32).fill(0x74),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	const record = decodeCanonical(rehearsal.exactCanonicalRecordBytes) as Record<string, unknown>;
	expect(record.version).toBe(2);
	const target = await fixture.open("create", "negative-target", targetInvite, targetObjectId);
	const effects = async (opened: typeof target, name: string) => {
		const issuance = await fixture.host.openIssuance(name);
		try {
			const scope = { author: opened.input.author, objectId: targetObjectId };
			return encodeCanonical({
				lineage: await issuance.readLineage(scope),
				outbox: await issuance.readOutboxPage({ scope, limit: 128 }),
				state: required(fixture.application.migration).canonicalStateBytes(opened.room.projection()),
				floor: await opened.floor.read({
					scope: { objectId: targetObjectId, pinnedGenesisAnchorDigest: targetInvite.pinnedGenesisAnchorDigest },
				}),
			});
		} finally {
			await issuance.close();
		}
	};
	const preimage = await effects(target, "negative-target");
	const rewritten = (edit: (value: Record<string, unknown>) => void, recalculateState = false) => {
		const value = structuredClone(record);
		edit(value);
		if (recalculateState)
			value.applicationStateDigest = hex(
				hashDomain("ts-drp/v3-room-migration-state/v1", encodeCanonical(value.applicationState))
			);
		return { action: "migrationRecord", record: value };
	};
	const variants = [
		[
			"foreign source",
			rewritten((value) => {
				value.sourceObjectId = `creator:${"e".repeat(32)}`;
			}),
		],
		[
			"foreign target",
			rewritten((value) => {
				value.targetObjectId = `creator:${"f".repeat(32)}`;
			}),
		],
		[
			"foreign target anchor",
			rewritten((value) => {
				value.targetAnchorDigest = "f".repeat(64);
			}),
		],
		[
			"foreign target ACL",
			rewritten((value) => {
				value.targetAclDigest = "f".repeat(64);
			}),
		],
		[
			"foreign target epoch",
			rewritten((value) => {
				value.targetEpoch = 1;
			}),
		],
		[
			"changed state",
			rewritten((value) => {
				(value.applicationState as { blocks: unknown[] }).blocks.push({ id: "injected", kind: "stone", x: 9, y: 9 });
			}),
		],
		[
			"changed approval",
			rewritten((value) => {
				const outcomes = (
					value.applicationState as { outcomes: { proof: { approvals: { signature: Uint8Array }[] } }[] }
				).outcomes;
				const signature = required(required(outcomes[0]).proof.approvals[0]).signature;
				signature[0] = required(signature[0]) ^ 0xff;
			}, true),
		],
		[
			"duplicate identity",
			rewritten((value) => {
				const outcomes = (value.applicationState as { outcomes: unknown[] }).outcomes;
				outcomes.push(structuredClone(outcomes[0]));
			}, true),
		],
		[
			"conflicting identity",
			rewritten((value) => {
				(value.applicationState as { outcomes: unknown[] }).outcomes.push(
					fixture.outcome(source.room, "negative-source", 4)
				);
			}, true),
		],
	] as const;
	for (const [reason, operation] of variants) {
		await expect(target.room.issue(operation), reason).rejects.toThrow();
		expect(await effects(target, "negative-target"), `${reason}: exact native preimage`).toEqual(preimage);
	}
	const writer = await fixture.open("create", "negative-writer", targetInvite, targetObjectId, { index: 1 });
	const writerPreimage = await effects(writer, "negative-writer");
	await expect(writer.room.issue({ action: "migrationRecord", record })).rejects.toThrow();
	expect(await effects(writer, "negative-writer")).toEqual(writerPreimage);
	await target.room.issue({ action: "migrationRecord", record });
	expect(Reflect.get(target.room.projection(), "outcomes")).toEqual(Reflect.get(source.room.projection(), "outcomes"));
	const accepted = await effects(target, "negative-target");
	await expect(target.room.issue({ action: "migrationRecord", record })).rejects.toThrow();
	expect(await effects(target, "negative-target")).toEqual(accepted);
}, 180_000);

it.each([3, 4])(
	"native Grid resumes interrupted signing cut=%s with the exact existing authenticated prefix",
	async (cut) => {
		const fixture = await gridFixture(),
			source = await fixture.open("create");
		await source.room.issue(fixture.outcome(source.room, "interrupted-current"));
		await source.room.issue({ action: "placeBlock", id: "import-a", kind: "stone", x: 1, y: 1 });
		await source.room.issue({ action: "placeBlock", id: "import-b", kind: "wood", x: 2, y: 2 });
		const sourceState = required(fixture.application.migration).canonicalStateBytes(source.room.projection());
		const nonce = new Uint8Array(32).fill(0x75),
			targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
			targetInvite = await fixture.material(targetObjectId);
		const targetName = migrationName(fixture.objectId, targetObjectId, nonce);
		// Cut 3 follows the genuine bootstrap/fence; cut 4 additionally follows the
		// durable block batch and refuses the final record signature. Neither cut
		// overrides a storage result or substitutes a fabricated protocol capability.
		fixture.signing.failAt = fixture.signing.calls + cut;
		await expect(
			source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite })
		).rejects.toThrow();
		expect(fixture.signing.failures).toBe(1);
		expect(required(fixture.application.migration).canonicalStateBytes(source.room.projection())).toEqual(sourceState);
		const targetIssuance = await fixture.host.openIssuance(`${targetName}--issuance`);
		try {
			const scope = { author: required(fixture.identities[0]).author, objectId: targetObjectId };
			const before = {
				lineage: await targetIssuance.readLineage(scope),
				rows: await targetIssuance.readOutboxPage({ scope, limit: 128 }),
			};
			expect(before.lineage.next).toBe(cut - 1);
			expect(before.rows).toHaveLength(cut - 1);
			expect(
				before.rows.map(
					(row) =>
						(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action: string } }).operation
							.action
				)
			).toEqual(["installRoster", "$drp.author-fence.v1", "applicationBatch"].slice(0, cut - 1));
			const calls = fixture.signing.calls;
			const resumed = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
			expect(resumed).toMatchObject({ activated: false, importedOperationCount: 2 });
			expect(fixture.signing.calls - calls, "only missing operations are signed on exact native recovery").toBe(
				5 - cut
			);
			const after = {
				lineage: await targetIssuance.readLineage(scope),
				rows: await targetIssuance.readOutboxPage({ scope, limit: 128 }),
			};
			expect(after.lineage.next).toBe(4);
			expect(after.rows.slice(0, cut - 1)).toEqual(before.rows);
			expect(after.rows).toHaveLength(4);
			expect(
				(
					decodeCanonical(required(after.rows[3]).commit.envelope.canonicalPreimageBytes) as {
						operation: { action: string };
					}
				).operation.action
			).toBe("migrationRecord");
			const repeated = await source.room.rehearseMigration({
				rehearsalNonce: nonce,
				targetCreatorInvite: targetInvite,
			});
			expect(repeated).toEqual(resumed);
			expect(fixture.signing.calls - calls).toBe(5 - cut);
			expect(await targetIssuance.readLineage(scope)).toEqual(after.lineage);
			expect(await targetIssuance.readOutboxPage({ scope, limit: 128 })).toEqual(after.rows);
		} finally {
			await targetIssuance.close();
		}
	},
	180_000
);

it("native Grid preserves exact signed migration-record custody when authenticated replay notification is interrupted", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "replay-source-current"));
	const nonce = new Uint8Array(32).fill(0x76),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	const name = migrationName(fixture.objectId, targetObjectId, nonce),
		issuance = await fixture.host.openIssuance(`${name}--issuance`);
	try {
		const primed = await fixture.open("create", name, targetInvite, targetObjectId, {
			issuanceName: `${name}--issuance`,
		});
		await fixture.stop(primed);
		const scope = { author: required(fixture.identities[0]).author, objectId: targetObjectId };
		const before = {
			lineage: await issuance.readLineage(scope),
			rows: await issuance.readOutboxPage({ scope, limit: 128 }),
		};
		expect(
			before.rows.some(
				(row) =>
					(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action: string } }).operation
						.action === "migrationRecord"
			)
		).toBe(true);
		const fault = { count: 0 };
		await expect(
			fixture.open("reopen", name, targetInvite, targetObjectId, {
				issuanceName: `${name}--issuance`,
				failAcceptedAction: "migrationRecord",
				acceptedFailures: fault,
			})
		).rejects.toThrow();
		expect(fault.count).toBe(1);
		expect(await issuance.readLineage(scope)).toEqual(before.lineage);
		expect(await issuance.readOutboxPage({ scope, limit: 128 })).toEqual(before.rows);
		const recovered = await fixture.open("reopen", name, targetInvite, targetObjectId, {
			issuanceName: `${name}--issuance`,
		});
		expect(Reflect.get(recovered.room.projection(), "outcomes")).toEqual(
			Reflect.get(source.room.projection(), "outcomes")
		);
		expect(await issuance.readLineage(scope)).toEqual(before.lineage);
		expect(await issuance.readOutboxPage({ scope, limit: 128 })).toEqual(before.rows);
		const continued = fixture.outcome(recovered.room, "replay-target-continued");
		await recovered.room.issue(continued);
		expect(Reflect.get(recovered.room.projection(), "outcomes")).toEqual(expect.arrayContaining([continued]));
	} finally {
		await issuance.close();
	}
}, 180_000);

it("native Grid persisted source refuses an absent protected dependency without repairs and continues after exact restoration", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "unavailable-source-current"));
	const nonce = new Uint8Array(32).fill(0x77),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const before = await exactSourceEffects(fixture, source),
		signatures = fixture.signing.calls;
	await fixture.stop(source);
	// Existing native corruption-fixture idiom: retain the exact genuine selected
	// bytes, remove only that protected blob in this test-owned database, and
	// restore only those original bytes. This is damage, not lawful retirement.
	const raw = new DatabaseSync(nativeFilename(fixture.directory, "source--ahe--ahe"));
	const selected = required(
		raw
			.prepare(
				"SELECT b.digest,b.bytes FROM blobs b JOIN promotions p ON p.digest=b.digest WHERE p.object_id=? ORDER BY b.digest LIMIT 1"
			)
			.get(fixture.objectId)
	);
	if (typeof selected.digest !== "string" || !(selected.bytes instanceof Uint8Array))
		throw new TypeError("R9_ORIGINAL_PROTECTED_BLOB_REQUIRED");
	const originalBytes = new Uint8Array(selected.bytes),
		selectedDigest = selected.digest;
	const image = () =>
		encodeCanonical({
			objects: raw.prepare("SELECT * FROM objects ORDER BY object_id").all(),
			generations: raw.prepare("SELECT * FROM generations ORDER BY object_id,generation_id").all(),
			promotions: raw.prepare("SELECT * FROM promotions ORDER BY object_id,generation_id,digest").all(),
			blobs: raw.prepare("SELECT * FROM blobs ORDER BY digest").all(),
			controls: raw.prepare("SELECT * FROM retirement_controls ORDER BY object_id").all(),
		});
	raw.exec("PRAGMA foreign_keys = OFF");
	expect(raw.prepare("DELETE FROM blobs WHERE digest=?").run(selectedDigest).changes).toBe(1);
	const damaged = image();
	try {
		await expect(fixture.open("reopen")).rejects.toThrow();
		expect(image(), "failed recovery must not repair, prune or rewrite the damaged native image").toEqual(damaged);
		expect(fixture.signing.calls).toBe(signatures);
	} finally {
		raw.prepare("INSERT INTO blobs(digest,bytes) VALUES(?,?)").run(selectedDigest, originalBytes);
		raw.close();
	}
	const restored = await fixture.open("reopen");
	expect(await exactSourceEffects(fixture, restored)).toEqual(before);
	expect(
		await restored.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite })
	).toMatchObject({ activated: false });
}, 180_000);

it("native Grid refuses stale source floor activation before irreversible source effects and permits fresh rehearsal", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "stale-floor-current"));
	const nonce = new Uint8Array(32).fill(0x78),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	const before = await exactSourceEffects(fixture, source),
		signatures = fixture.signing.calls;
	await expect(
		source.room.activateMigration({
			exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
			recordVertexDigest: rehearsal.recordVertexDigest,
			targetCreatorInvite: targetInvite,
		})
	).rejects.toThrow();
	expect(await exactSourceEffects(fixture, source)).toEqual(before);
	expect(fixture.signing.calls).toBe(signatures);
	const freshNonce = new Uint8Array(32).fill(0x79),
		freshTarget = expectedTargetObjectId(fixture.objectId, freshNonce),
		freshInvite = await fixture.material(freshTarget);
	expect(
		await source.room.rehearseMigration({ rehearsalNonce: freshNonce, targetCreatorInvite: freshInvite })
	).toMatchObject({ activated: false });
}, 180_000);

it.each([false, true])(
	"native Grid recipient independently admits original creator-signed transfer envelopes then reopens and continues (recipient-local bootstrap=%s)",
	async (recipientLocalBootstrap) => {
		const fixture = await gridFixture(undefined, false, false, false, recipientLocalBootstrap),
			source = await fixture.open("create");
		const oldContext = fixture.outcome(source.room, "remote-source-current");
		await source.room.issue(oldContext);
		const nonce = new Uint8Array(32).fill(0x7a),
			targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
			targetInvite = await fixture.material(targetObjectId);
		const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
		const issuance = await fixture.host.openIssuance(
			`${migrationName(fixture.objectId, targetObjectId, nonce)}--issuance`
		);
		try {
			const rows = await issuance.readOutboxPage({
				scope: { author: required(fixture.identities[0]).author, objectId: targetObjectId },
				limit: 128,
			});
			const recipient = await fixture.open("create", "remote-recipient", targetInvite, targetObjectId, { index: 1 });
			await recipient.receiveSignedRows(rows, rehearsal.recordVertexDigest);
			expect(Reflect.get(recipient.room.projection(), "outcomes")).toEqual(
				Reflect.get(source.room.projection(), "outcomes")
			);
			const state = required(fixture.application.migration).canonicalStateBytes(recipient.room.projection());
			await expect(recipient.room.issue(oldContext)).rejects.toThrow();
			expect(required(fixture.application.migration).canonicalStateBytes(recipient.room.projection())).toEqual(state);
			await fixture.stop(recipient);
			// Decision B (sync before sending): the reopened recipient signs nothing until it confirms the
			// target creator's statement, so the target's creator comes online (its rehearsed replica);
			// the fixture hands its statement to the reopened Writer.
			const name = migrationName(fixture.objectId, targetObjectId, nonce);
			const targetCreator = await fixture.open("create", name, targetInvite, targetObjectId, {
				issuanceName: `${name}--issuance`,
			});
			const reopened = await fixture.open("reopen", "remote-recipient", targetInvite, targetObjectId, { index: 1 });
			expect(reopened.room.localIssueCurrency?.()).toBe("current");
			expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(
				Reflect.get(source.room.projection(), "outcomes")
			);
			await expect(reopened.room.issue(oldContext)).rejects.toThrow();
			const continued = fixture.outcome(reopened.room, "remote-target-continued");
			await reopened.room.issue(continued);
			expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(expect.arrayContaining([continued]));
			await fixture.stop(targetCreator);
		} finally {
			await issuance.close();
		}
	},
	180_000
);

it("native Grid repeated bootstrap cannot authorize a migration record and ordinary work remains possible", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "bootstrap-boundary-source"));
	const nonce = new Uint8Array(32).fill(0x7e),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId),
		rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite }),
		target = await fixture.open("create", "bootstrap-boundary-target", targetInvite, targetObjectId),
		issuance = await fixture.host.openIssuance("bootstrap-boundary-target");
	try {
		// Ordinary creator controls remain supported, but a repeated bootstrap is
		// not a second first-prefix authorization for authenticated inheritance.
		await target.room.issue(target.input.application.bootstrapOperation);
		const scope = { author: target.input.author, objectId: targetObjectId };
		const image = async () =>
			encodeCanonical({
				lineage: await issuance.readLineage(scope),
				outbox: await issuance.readOutboxPage({ scope, limit: 128 }),
				state: required(fixture.application.migration).canonicalStateBytes(target.room.projection()),
				floor: await target.floor.read({
					scope: { objectId: targetObjectId, pinnedGenesisAnchorDigest: targetInvite.pinnedGenesisAnchorDigest },
				}),
				signatures: fixture.signing.calls,
			});
		const before = await image();
		await expect(
			target.room.issue({ action: "migrationRecord", record: decodeCanonical(rehearsal.exactCanonicalRecordBytes) })
		).rejects.toThrow();
		expect(await image()).toEqual(before);
		await target.room.issue({ action: "placeBlock", id: "ordinary-after-record-refusal", kind: "stone", x: 1, y: 2 });
		expect(Reflect.get(target.room.projection(), "blocks")).toContainEqual({
			id: "ordinary-after-record-refusal",
			kind: "stone",
			x: 1,
			y: 2,
		});
	} finally {
		await issuance.close();
	}
}, 180_000);

it("native Grid retained predecessor digest preserves outcome snapshot reopen and valid continuation without pretending to migrate outcomes", async () => {
	const predecessor = "f9bfacb0c2a26815aff3d36122e0ddfdb5459b45ed6fa76e75712b762787c557";
	const fixture = await gridFixture(predecessor),
		source = await fixture.open("create");
	expect(fixture.application.catalog.blueprintDigests).toContain(predecessor);
	const historical = fixture.outcome(source.room, "predecessor-historical");
	await source.room.issue(historical);
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	expect(source.room.authority()).toMatchObject({ epoch: 1 });
	await fixture.stop(source);
	const reopened = await fixture.open("reopen");
	expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual([historical]);
	await reopened.room.issue({ action: "placeBlock", id: "predecessor-continued-block", kind: "stone", x: 3, y: 3 });
	const continued = fixture.outcome(reopened.room, "predecessor-continued-outcome");
	await reopened.room.issue(continued);
	expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(expect.arrayContaining([historical, continued]));
	const nonce = new Uint8Array(32).fill(0x7b),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const before = await exactSourceEffects(fixture, reopened),
		signatures = fixture.signing.calls;
	await expect(
		reopened.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite })
	).rejects.toThrow();
	expect(await exactSourceEffects(fixture, reopened)).toEqual(before);
	expect(fixture.signing.calls).toBe(signatures);
}, 180_000);

it("native Grid refuses digest-consistent transfer state differing from the authenticated target prefix before effects", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "prefix-source-current"));
	const nonce = new Uint8Array(32).fill(0x7c),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	const original = decodeCanonical(rehearsal.exactCanonicalRecordBytes) as Record<string, unknown>;
	const target = await fixture.open("create", "prefix-negative-target", targetInvite, targetObjectId),
		issuance = await fixture.host.openIssuance("prefix-negative-target");
	try {
		const scope = { author: target.input.author, objectId: targetObjectId };
		const image = async () =>
			encodeCanonical({
				lineage: await issuance.readLineage(scope),
				outbox: await issuance.readOutboxPage({ scope, limit: 128 }),
				state: required(fixture.application.migration).canonicalStateBytes(target.room.projection()),
				floor: await target.floor.read({
					scope: { objectId: targetObjectId, pinnedGenesisAnchorDigest: targetInvite.pinnedGenesisAnchorDigest },
				}),
			});
		const before = await image();
		for (const member of ["blocks", "roster"] as const) {
			const record = structuredClone(original),
				state = record.applicationState as { blocks: unknown[]; roster: { peerId: string }[] };
			if (member === "blocks") state.blocks.push({ id: "absent-authenticated-import", kind: "stone", x: 9, y: 9 });
			else required(state.roster[0]).peerId = "altered-authenticated-roster";
			record.applicationStateDigest = hex(hashDomain("ts-drp/v3-room-migration-state/v1", encodeCanonical(state)));
			await expect(target.room.issue({ action: "migrationRecord", record }), member).rejects.toThrow();
			expect(await image(), `${member}: exact before-effects native image`).toEqual(before);
		}
		await target.room.issue({ action: "migrationRecord", record: original });
		expect(Reflect.get(target.room.projection(), "outcomes")).toEqual(
			Reflect.get(source.room.projection(), "outcomes")
		);
	} finally {
		await issuance.close();
	}
}, 180_000);

it("native Grid shipped none-settlement profile completes inherited and current outcome transfer with recipient adoption and reopen", async () => {
	const fixture = await gridFixture(undefined, true),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "shipped-source-inherited"));
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	const oldContext = fixture.outcome(source.room, "shipped-source-current");
	await source.room.issue(oldContext);
	await source.room.issue({ action: "placeBlock", id: "shipped-source-block", kind: "stone", x: 4, y: 4 });
	const expectedOutcomes = encodeCanonical(Reflect.get(source.room.projection(), "outcomes"));
	const nonce = new Uint8Array(32).fill(0x7d),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	expect(
		await source.room.activateMigration({
			exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
			recordVertexDigest: rehearsal.recordVertexDigest,
			targetCreatorInvite: targetInvite,
		})
	).toMatchObject({ activated: true });
	expect(encodeCanonical(Reflect.get(source.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
	await expect(source.room.issue(oldContext)).rejects.toThrow();
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	const delivery = await recipientSource(
		fixture,
		migrationName(fixture.objectId, targetObjectId, nonce),
		targetObjectId,
		targetInvite
	);
	await fixture.stop(source);
	const recipient = await fixture.open("create", "shipped-recipient", targetInvite, targetObjectId, {
		index: 1,
		protocol: delivery.port,
	});
	await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
	expect(recipient.room.authority()).toMatchObject({ objectId: targetObjectId, epoch: 1 });
	expect(encodeCanonical(Reflect.get(recipient.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
	await fixture.stop(recipient);
	const reopened = await fixture.open("reopen", "shipped-recipient", targetInvite, targetObjectId, { index: 1 });
	expect(encodeCanonical(Reflect.get(reopened.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
	await expect(reopened.room.issue(oldContext)).rejects.toThrow();
	const continued = fixture.outcome(reopened.room, "shipped-target-continued");
	await reopened.room.issue(continued);
	expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(expect.arrayContaining([continued]));
}, 180_000);

it("native Grid health counts an authenticated enrolled non-Writer across rollover, never strangers or closed custody", async () => {
	const fixture = await gridFixture(undefined, true, true, false, false, true);
	// Routing presence is a local fixture premise; membership below comes from
	// actual signed genesis/state, native ACL operations and successor adoption.
	const source = await fixture.open("create", "source", fixture.invite, fixture.objectId, {
		healthPeers: ["r9-grid-peer-1", "unmapped-transport-stranger"],
	});
	expect(source.healthObservation()).toMatchObject({
		objectId: fixture.objectId,
		epoch: 0,
		authenticatedPeerIds: ["r9-grid-peer-1"],
		localState: "installed",
	});
	await source.room.issue({ action: "placeBlock", id: "health-native-block", kind: "stone", x: 4, y: 4 });
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	expect(source.healthObservation()).toMatchObject({
		epoch: 1,
		authenticatedPeerIds: ["r9-grid-peer-1"],
		localState: "installed",
	});
	await source.room.close();
	openRooms.delete(source.room);
	expect(source.healthObservation()).toBeUndefined();
}, 180_000);

it("public native SQLite host preserves healthy Grid rollover, noncreating reopen and continued target-context outcomes", async () => {
	const fixture = await gridFixture(undefined, true, true);
	const source = await fixture.open("create");
	expect(source.room.status().closeAuthority, "new creator close binding").toBe("available");
	const first = fixture.outcome(source.room, "public-host-first");
	await source.room.issue(first);
	await source.room.issue({ action: "placeBlock", id: "public-host-block", kind: "stone", x: 4, y: 4 });
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	expect(source.room.status().closeAuthority, "warm creator close binding").toBe("available");
	const expectedOutcomes = encodeCanonical(Reflect.get(source.room.projection(), "outcomes"));
	await fixture.stop(source);
	const reopened = await fixture.open("reopen");
	expect(reopened.room.status().closeAuthority, "reopened creator close binding").toBe("available");
	expect(Reflect.get(reopened.room.previewLatchedAcl().current as object, "epoch")).toBe(1);
	expect(encodeCanonical(Reflect.get(reopened.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
	await expect(reopened.room.issue(first)).rejects.toThrow();
	expect(reopened.room.status().closeAuthority, "old-context refusal preserves creator close binding").toBe(
		"available"
	);
	const continued = fixture.outcome(reopened.room, "public-host-continued");
	await reopened.room.issue(continued);
	expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(expect.arrayContaining([continued]));
	expect(await reopened.room.sealEpoch()).toMatchObject({ ok: true });
	await reopened.room.adoptCreatorSuccessor();
	expect(Reflect.get(reopened.room.previewLatchedAcl().current as object, "epoch")).toBe(2);
}, 180_000);

it("Keychain-owned creator signer closes native Grid epochs before and after joined identity shutdown and strict reopen", async () => {
	const fixture = await gridFixture(undefined, true, true, true);
	const keychain = required(fixture.keychain);
	const originalSigner = await keychain.acquireLocalAuthorFinalitySigner();
	const source = await fixture.open("create");
	expect(source.room.status().closeAuthority).toBe("available");
	await source.room.issue({ action: "placeBlock", id: "owned-key-first", kind: "stone", x: 4, y: 4 });
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	const state = required(fixture.application.migration).canonicalStateBytes(source.room.projection());
	await fixture.stop(source);
	await keychain.stop();
	await expect(keychain.acquireLocalAuthorFinalitySigner()).rejects.toThrow("local author identity is unavailable");
	await keychain.start();
	expect(await keychain.acquireLocalAuthorFinalitySigner()).not.toBe(originalSigner);
	const reopened = await fixture.open("reopen");
	expect(reopened.room.status().closeAuthority).toBe("available");
	expect(required(fixture.application.migration).canonicalStateBytes(reopened.room.projection())).toEqual(state);
	await reopened.room.issue({ action: "placeBlock", id: "owned-key-continued", kind: "stone", x: 5, y: 5 });
	expect(await reopened.room.sealEpoch()).toMatchObject({ ok: true });
	await reopened.room.adoptCreatorSuccessor();
	expect(reopened.room.authority()).toMatchObject({ epoch: 2 });
}, 180_000);

it("native Grid legacy source ID reopens the migrated target after healthy successor adoption and continues with preserved outcomes", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	const oldContext = fixture.outcome(source.room, "legacy-redirect-source-current");
	await source.room.issue(oldContext);
	const expectedOutcomes = encodeCanonical(Reflect.get(source.room.projection(), "outcomes"));
	const nonce = new Uint8Array(32).fill(0x7e),
		targetObjectId = expectedTargetObjectId(fixture.objectId, nonce),
		targetInvite = await fixture.material(targetObjectId);
	const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	expect(
		await source.room.activateMigration({
			exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
			recordVertexDigest: rehearsal.recordVertexDigest,
			targetCreatorInvite: targetInvite,
		})
	).toMatchObject({ activated: true });
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	expect(source.room.authority()).toMatchObject({ objectId: targetObjectId, epoch: 1 });
	expect(encodeCanonical(Reflect.get(source.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
	await fixture.stop(source);
	// With every owner stopped, damage only the actual target floor row and
	// retain its original encoded image for exact restoration. Reopen must not
	// synthesize a target genesis floor from the persisted source redirect.
	const targetFloorName = `${migrationName(fixture.objectId, targetObjectId, nonce)}--room-head--floor`,
		rawFloor = new DatabaseSync(nativeFilename(fixture.directory, targetFloorName));
	const originalFloor = required(rawFloor.prepare("SELECT image FROM room_head WHERE id=1").get());
	if (!(originalFloor.image instanceof Uint8Array)) throw new TypeError("R9_ORIGINAL_TARGET_FLOOR_REQUIRED");
	const originalFloorBytes = new Uint8Array(originalFloor.image),
		signatures = fixture.signing.calls;
	expect(rawFloor.prepare("DELETE FROM room_head WHERE id=1").run().changes).toBe(1);
	const damagedFloor = encodeCanonical(rawFloor.prepare("SELECT * FROM room_head ORDER BY id").all());
	try {
		await expect(fixture.open("reopen")).rejects.toThrow();
		expect(encodeCanonical(rawFloor.prepare("SELECT * FROM room_head ORDER BY id").all())).toEqual(damagedFloor);
		expect(fixture.signing.calls).toBe(signatures);
	} finally {
		rawFloor.prepare("INSERT INTO room_head(id,image) VALUES(1,?)").run(originalFloorBytes);
		rawFloor.close();
	}
	// Strict reopen uses the original source ID, original invite and original
	// native names. It must follow the persisted redirect into the already
	// adopted target owner, not replay the displaced target-genesis owner.
	const reopened = await fixture.open("reopen");
	expect(reopened.room.authority()).toMatchObject({ objectId: targetObjectId, epoch: 1 });
	expect(encodeCanonical(Reflect.get(reopened.room.projection(), "outcomes"))).toEqual(expectedOutcomes);
	const before = required(fixture.application.migration).canonicalStateBytes(reopened.room.projection());
	await expect(reopened.room.issue(oldContext)).rejects.toThrow();
	expect(required(fixture.application.migration).canonicalStateBytes(reopened.room.projection())).toEqual(before);
	const continued = fixture.outcome(reopened.room, "legacy-redirect-target-continued");
	await reopened.room.issue(continued);
	expect(Reflect.get(reopened.room.projection(), "outcomes")).toEqual(expect.arrayContaining([oldContext, continued]));
}, 180_000);

it("native Grid settlement-v1 recipient refuses genuinely creator-signed null companion before native effects", async () => {
	const fixture = await gridFixture(),
		source = await fixture.open("create");
	await source.room.issue(fixture.outcome(source.room, "null-companion-source"));
	expect(await source.room.sealEpoch()).toMatchObject({ ok: true });
	await source.room.adoptCreatorSuccessor();
	const delivery = await recipientSource(fixture, "source", fixture.objectId, fixture.invite, true);
	await fixture.stop(source);
	const name = "null-companion-recipient",
		recipient = await fixture.open("create", name, fixture.invite, fixture.objectId, {
			index: 1,
			protocol: delivery.port,
		}),
		issuance = await fixture.host.openIssuance(name),
		raw = new DatabaseSync(nativeFilename(fixture.directory, `${name}--ahe--ahe`)),
		snapshot = new DatabaseSync(
			`${nativeFilename(fixture.directory, `${name}--snapshots`)}.drp-snapshot-quarantine-v1.sqlite`
		);
	try {
		const scope = { author: recipient.input.author, objectId: fixture.objectId };
		const image = async () =>
			encodeCanonical({
				state: required(fixture.application.migration).canonicalStateBytes(recipient.room.projection()),
				floor: await recipient.floor.read({
					scope: { objectId: fixture.objectId, pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest },
				}),
				lineage: await issuance.readLineage(scope),
				outbox: await issuance.readOutboxPage({ scope, limit: 128 }),
				objects: raw.prepare("SELECT * FROM objects ORDER BY object_id").all(),
				generations: raw.prepare("SELECT * FROM generations ORDER BY object_id,generation_id").all(),
				promotions: raw.prepare("SELECT * FROM promotions ORDER BY object_id,generation_id,digest").all(),
				blobs: raw.prepare("SELECT * FROM blobs ORDER BY digest").all(),
				controls: raw.prepare("SELECT * FROM retirement_controls ORDER BY object_id").all(),
				snapshotScopes: snapshot
					.prepare("SELECT * FROM snapshot_scopes_v2 ORDER BY object_id,epoch,anchor,manifest_digest")
					.all(),
				snapshotChunks: snapshot
					.prepare("SELECT * FROM snapshot_chunks_v2 ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index")
					.all(),
				snapshotAccounting: snapshot.prepare("SELECT * FROM snapshot_owner_v2 ORDER BY id").all(),
				snapshotControls: snapshot.prepare("SELECT * FROM snapshot_retirement_controls ORDER BY object_id").all(),
			});
		const before = await image(),
			signatures = fixture.signing.calls;
		await expect(
			recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers })
		).rejects.toThrow("creator settlement companion differs from authenticated profile");
		expect(await image()).toEqual(before);
		// The recipient necessarily signs its bounded material request before it
		// receives the adversarial signed response. No native issuance is signed.
		expect(delivery.requestDigests).toHaveLength(1);
		expect(fixture.signing.calls - signatures).toBe(1);
		expect(fixture.signing.digests.slice(signatures)).toEqual(delivery.requestDigests);
	} finally {
		snapshot.close();
		raw.close();
		await issuance.close();
	}
}, 180_000);
