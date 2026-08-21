/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vitest mock factories infer their closed controlled shapes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { V3RoomAcceptedVertex, V3RoomCreatorInviteMaterial } from "../examples/v3-room/src/index.js";
import type { EphemeralChannel, EphemeralChannelOptions } from "../packages/ephemeral/src/index.js";

interface Projection {
	readonly acceptedDigests: readonly string[];
	readonly transportPeerAuthors: readonly Readonly<{ author: string; peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

interface AuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority():
		| Readonly<{
				aclDigest: string;
				anchorDigest: string;
				epoch: 0;
				objectId: string;
		  }>
		| undefined;
	isCurrentWriter(author: string): boolean;
}

interface ExpectedApplication {
	readonly batchableOperationActions: readonly string[];
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: unknown;
	projectAcceptedOperations(operations: readonly AcceptedOperation[]): Projection;
}

interface AcceptedOperation {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

interface ExpectedInput {
	readonly application: ExpectedApplication;
	readonly author: string;
	readonly creatorInvite: V3RoomCreatorInviteMaterial;
	readonly databaseName: string;
	readonly initialLogicalTime: number;
	readonly objectId: string;
	onAcceptedVertex(vertex: V3RoomAcceptedVertex): void;
	onProjection(projection: Projection): void;
	openTransport(): Readonly<Record<string, unknown>>;
	readonly publicKeyBytes: Uint8Array;
	signRegisteredVertexDigest(): Promise<Uint8Array>;
}

interface ExpectedSession {
	close(): Promise<void>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	openEphemeral(options: EphemeralChannelOptions): EphemeralChannel;
}

interface LocalIssueInput {
	readonly operations: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[];
	signRegisteredVertexDigest(digest: Uint8Array): Promise<Uint8Array>;
}

const probe = vi.hoisted(() => ({
	activatedSink: undefined as ((input: { readonly vertex: unknown }) => unknown) | undefined,
	closeCounts: { ahe: 0, issuance: 0, journal: 0, queue: 0, transport: 0 },
	deactivations: 0,
	ephemeralProvider: undefined as AuthorizationProvider | undefined,
	issueInputs: [] as LocalIssueInput[],
	issueBarrier: undefined as Promise<void> | undefined,
	issueBatchFailure: false,
	issueRejectedActions: new Set<string>(),
	issueRejectedTexts: new Set<string>(),
	issueRowsPerRequest: 1,
	issueSinkVertex: undefined as V3RoomAcceptedVertex | undefined,
	issuanceNames: [] as string[],
	onSign: undefined as (() => void) | undefined,
	pendingPublications: 0,
	publishCalls: 0,
	publishFailureAtCall: undefined as number | undefined,
	recovered: [] as unknown[],
	retainedIngressHandler: undefined as ((message: unknown) => void) | undefined,
	retainedVertex: undefined as V3RoomAcceptedVertex | undefined,
	splitPrefixLength: undefined as number | undefined,
}));

vi.mock("@ts-drp/control-plane", async (importOriginal) => ({
	...(await importOriginal()),
	createCurrentAnchorTrustStore: () => ({
		install: () => Promise.resolve({ ok: true, trust: { profileId: "creator-trusted-v1" } }),
		open: () => Promise.resolve({ ok: true, trust: { profileId: "creator-trusted-v1" } }),
	}),
}));

vi.mock("../packages/message-queue/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	MessageQueueManager: class {
		closeAll(): void {
			probe.closeCounts.queue += 1;
		}
	},
}));

vi.mock("../packages/node/dist/src/v3-live.js", async (importOriginal) => ({
	...(await importOriginal()),
	activateV3LivePlane: (input: { onAdmittedVertex(value: { readonly vertex: unknown }): unknown }) => {
		probe.activatedSink = input.onAdmittedVertex;
		return {
			handle: {
				currentEphemeralAuthority: () =>
					Object.freeze({
						aclDigest: "c".repeat(64),
						anchorDigest: "a".repeat(64),
						epoch: 0,
						isCurrentWriter: (author: string): boolean => author === "author-writer",
						objectId: "controlled-v3-room",
					}),
				deactivate: (): void => {
					probe.deactivations += 1;
				},
				issueLocal: async (input: LocalIssueInput) => {
					probe.issueInputs.push(input);
					await probe.issueBarrier;
					const entries = input.operations;
					if (entries.length > 16) {
						return { detail: "controlled split", kind: "split-required", ok: false, prefixLength: 16 };
					}
					if (probe.splitPrefixLength !== undefined && entries.length > probe.splitPrefixLength) {
						return {
							detail: "controlled byte split",
							kind: "split-required",
							ok: false,
							prefixLength: probe.splitPrefixLength,
						};
					}
					if (probe.issueBatchFailure && entries.length > 1) {
						return { detail: "controlled batch-owned failure", kind: "issuance-rejected", ok: false };
					}
					if (
						entries.some(
							({ operation }) =>
								probe.issueRejectedActions.has(String(Reflect.get(operation, "action"))) ||
								probe.issueRejectedTexts.has(String(Reflect.get(operation, "text")))
						)
					) {
						return { detail: "controlled malformed singleton", kind: "malformed-input", ok: false };
					}
					probe.onSign?.();
					await input.signRegisteredVertexDigest(new Uint8Array(32));
					probe.pendingPublications += probe.issueRowsPerRequest;
					if (probe.issueSinkVertex !== undefined) {
						try {
							await probe.activatedSink?.({ vertex: probe.issueSinkVertex });
						} catch {
							// The shipped node logs post-commit sink failure and returns its durable result.
						}
					}
					return { ok: true };
				},
				publishPending: () => {
					probe.publishCalls += 1;
					if (probe.publishFailureAtCall === probe.publishCalls) {
						return Promise.resolve({ kind: "publish-failed", ok: false });
					}
					if (probe.pendingPublications === 0) return Promise.resolve({ kind: "empty", ok: true });
					probe.pendingPublications -= 1;
					return Promise.resolve({ kind: "published", ok: true });
				},
				previewLatchedAcl: () => ({}),
				republishRetained: () => Promise.resolve({ kind: "published", ok: true }),
			},
			ok: true,
		};
	},
	prepareV3LiveGeneration: () =>
		Promise.resolve({
			capability: {},
			descriptor: { anchorDigest: "a".repeat(64), blueprintDigest: "b".repeat(64) },
			ok: true,
		}),
	recoverV3LiveReplica: () =>
		Promise.resolve({
			capability: {},
			descriptor: { recoveredVertices: [...probe.recovered] },
			ok: true,
		}),
	routeV3Ingress: () => undefined,
	routeV3RetainedIngress: () => {
		if (probe.retainedVertex !== undefined) void probe.activatedSink?.({ vertex: probe.retainedVertex });
	},
}));

vi.mock("../packages/protocol-v3/dist/src/public.js", async (importOriginal) => ({
	...(await importOriginal()),
	createAdmissionBoundTransactionalVertexIssuer: () => {
		throw new Error("D9346_UNEXPECTED_BOOTSTRAP_ISSUER");
	},
	prepareBlueprintAdmission: () => ({}),
}));

vi.mock("../packages/storage/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	parseStorageObjectId: () => ({ ok: true, value: "controlled-v3-room" }),
}));

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserAheDurableStore: () =>
		Promise.resolve({
			close: (): void => {
				probe.closeCounts.ahe += 1;
			},
		}),
}));

vi.mock("../packages/storage-browser/dist/src/issuance.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableIssuanceStore: ({ primaryDatabaseName }: { primaryDatabaseName: string }) => {
		probe.issuanceNames.push(primaryDatabaseName);
		return Promise.resolve({
			close: (): void => {
				probe.closeCounts.issuance += 1;
			},
			readLineage: () => Promise.resolve({ next: 1 }),
		});
	},
}));

vi.mock("../packages/storage-browser/dist/src/live-journal.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableLiveJournalStore: () =>
		Promise.resolve({
			close: (): void => {
				probe.closeCounts.journal += 1;
			},
		}),
}));

const roomModule = import("../examples/v3-room/src/index.js");

function accepted(
	digestBytes: number | Uint8Array,
	input: Readonly<{
		author: string;
		authorSequence: number;
		epoch: number;
		logicalTime: number;
		operation?: Readonly<Record<string, unknown>>;
	}>
): V3RoomAcceptedVertex {
	return {
		...input,
		digest: typeof digestBytes === "number" ? Uint8Array.of(digestBytes) : new Uint8Array(digestBytes),
		operation: input.operation ?? Object.freeze({ action: "message" }),
	} as unknown as V3RoomAcceptedVertex;
}

function digest(vertex: V3RoomAcceptedVertex): string {
	return Array.from(vertex.digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function project(operations: readonly AcceptedOperation[]): Projection {
	const transportPeerAuthors = operations.flatMap((acceptedOperation) => {
		const peerId = Reflect.get(acceptedOperation.operation, "peerId");
		return Reflect.get(acceptedOperation.operation, "action") === "join" && typeof peerId === "string"
			? [{ author: acceptedOperation.author, peerId }]
			: [];
	});
	return Object.freeze({
		acceptedDigests: Object.freeze(
			operations
				.filter(({ operation }) => Reflect.get(operation, "action") !== "projection-hidden")
				.map(({ vertexDigest }) => vertexDigest)
		),
		transportPeerAuthors: Object.freeze(transportPeerAuthors),
		writerAuthors: Object.freeze(transportPeerAuthors.map(({ author }) => author)),
	});
}

function creatorInvite(): V3RoomCreatorInviteMaterial {
	return Object.freeze({
		detachedGenesisSignature: new Uint8Array(64).fill(1),
		exactCanonicalGenesisAnchorPreimageBytes: Uint8Array.of(1),
		exactCanonicalLatchedAclBytes: Uint8Array.of(2),
		exactCanonicalParametersCarrierBytes: Uint8Array.of(3),
		exactCanonicalProfileBytes: Uint8Array.of(4),
		exactCanonicalSignerSetBytes: Uint8Array.of(5),
		pinnedGenesisAnchorDigest: "a".repeat(64),
	});
}

function channel(): EphemeralChannel {
	return Object.freeze({
		authorizedPeers: () => [],
		close: () => undefined,
		publish: () => Promise.resolve(true),
		stats: () => ({
			authorityMismatch: 0,
			delivered: 0,
			dropped: 0,
			localSequencedKeys: 0,
			malformed: 0,
			overLimit: 0,
			published: 0,
			received: 0,
			rateLimited: 0,
			remoteSequencedKeys: 0,
			sequencedKeys: 0,
			sequencedSenders: 0,
			stale: 0,
			subscriberFailures: 0,
			unauthorized: 0,
			writerBuckets: 0,
		}),
		subscribe: () => () => undefined,
	});
}

function input(application: ExpectedApplication, onProjection: (projection: Projection) => void): ExpectedInput {
	return {
		application,
		author: "author-local",
		creatorInvite: creatorInvite(),
		databaseName: "controlled-room",
		initialLogicalTime: 3,
		objectId: "controlled-v3-room",
		onAcceptedVertex: () => undefined,
		onProjection,
		openTransport: () => ({
			close: (): void => {
				probe.closeCounts.transport += 1;
			},
			networkNode: {} as never,
			openEphemeral: (provider: AuthorizationProvider, _options: EphemeralChannelOptions): EphemeralChannel => {
				probe.ephemeralProvider = provider;
				return channel();
			},
			requestRetainedHistory: () => undefined,
			setIngressHandler: (
				_ingressId: string,
				_live: (message: unknown) => void,
				retained: (message: unknown) => void
			) => {
				probe.retainedIngressHandler = retained;
			},
			setRetainedPublisher: () => undefined,
		}),
		publicKeyBytes: Uint8Array.of(1),
		signRegisteredVertexDigest: () => Promise.resolve(new Uint8Array(64)),
	};
}

function application(projector: ExpectedApplication["projectAcceptedOperations"] = project): ExpectedApplication {
	return {
		batchableOperationActions: Object.freeze(["message"]),
		bootstrapOperation: Object.freeze({ action: "join", peerId: "peer-local" }),
		canonicalBlueprintPackageBytes: Uint8Array.of(1),
		catalog: {} as never,
		projectAcceptedOperations: projector,
	};
}

beforeEach(() => {
	probe.activatedSink = undefined;
	probe.closeCounts = { ahe: 0, issuance: 0, journal: 0, queue: 0, transport: 0 };
	probe.deactivations = 0;
	probe.ephemeralProvider = undefined;
	probe.issueInputs = [];
	probe.issueBarrier = undefined;
	probe.issueBatchFailure = false;
	probe.issueRejectedActions = new Set<string>();
	probe.issueRejectedTexts = new Set<string>();
	probe.issueRowsPerRequest = 1;
	probe.issueSinkVertex = undefined;
	probe.issuanceNames = [];
	probe.onSign = undefined;
	probe.pendingPublications = 0;
	probe.publishCalls = 0;
	probe.publishFailureAtCall = undefined;
	probe.recovered = [];
	probe.retainedIngressHandler = undefined;
	probe.retainedVertex = undefined;
	probe.splitPrefixLength = undefined;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("D.93.46b real shared-room semantics", () => {
	it("accepts the exact Phase 3g application policy and split durable database input", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const candidateApplication = Object.freeze({
			...application(),
			displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>) =>
				String(Reflect.get(operation, "clientOperationId")),
			displacementPolicies: Object.freeze({ message: "rebase" as const }),
			transformDisplacedOperation: undefined,
		});
		const candidateInput = Object.freeze({
			...input(candidateApplication, () => undefined),
			issuanceDatabaseName: "controlled-room-shared-issuance",
		});
		const session = await Reflect.apply(currentCreateV3RoomSession, undefined, [candidateInput]);
		expect(session.roomId).toBe("a".repeat(64));
		expect(probe.issuanceNames).toEqual(["controlled-room-shared-issuance"]);
		await session.close();
	});

	it("coalesces two same-turn eligible requests into one node-owned operations input", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(application(), () => undefined));
		probe.issueInputs.length = 0;
		const firstOperation = { action: "message", text: "first" };
		const firstIssue = session.issue(firstOperation);
		firstOperation.text = "mutated-after-capture";
		await Promise.all([firstIssue, session.issue(Object.freeze({ action: "message", text: "second" }))]);
		expect(probe.issueInputs).toEqual([
			{
				operations: [
					{ logicalTime: 3, operation: { action: "message", text: "first" } },
					{ logicalTime: 5, operation: { action: "message", text: "second" } },
				],
				signRegisteredVertexDigest: expect.any(Function),
			},
		]);
		await session.close();
	});

	it("splits seventeen requests and never batches across a control barrier", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(application(), () => undefined));
		probe.issueInputs.length = 0;
		await Promise.all(
			Array.from({ length: 17 }, (_, index) =>
				session.issue(Object.freeze({ action: "message", text: `message-${index}` }))
			)
		);
		expect(probe.issueInputs.map(({ operations }) => operations?.length)).toEqual([16, 1]);

		probe.issueInputs.length = 0;
		await Promise.all([
			session.issue({ action: "message", text: "before-a" }),
			session.issue({ action: "message", text: "before-b" }),
			session.issue({ action: "acl", group: "writer", kind: "grant", target: "a".repeat(64) }),
			session.issue({ action: "message", text: "after" }),
		]);
		expect(
			probe.issueInputs.map((entry) =>
				(entry.operations ?? []).map(({ operation }) => String(Reflect.get(operation, "action")))
			)
		).toEqual([["message", "message"], ["acl"], ["message"]]);
		await session.close();
	});

	it("rejects one over-budget eligible head without dropping or coalescing the untouched suffix", async () => {
		const invalidApplication = application();
		probe.issueRejectedTexts.add("oversized");
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(invalidApplication, () => undefined));
		probe.issueInputs.length = 0;
		const outcomes = await Promise.allSettled([
			session.issue({ action: "message", text: "oversized" }),
			session.issue({ action: "message", text: "survives-a" }),
			session.issue({ action: "message", text: "survives-b" }),
		]);
		expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
		expect(
			probe.issueInputs.map(({ operations }) => operations.map(({ operation }) => Reflect.get(operation, "text")))
		).toEqual([
			["oversized", "survives-a", "survives-b"],
			["survives-a", "survives-b"],
		]);
		await session.close();
	});

	it("retries the exact node-selected prefix and suffix after a byte-budget split", async () => {
		probe.splitPrefixLength = 1;
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(application(), () => undefined));
		probe.issueInputs.length = 0;
		await Promise.all([
			session.issue({ action: "message", text: "large-prefix" }),
			session.issue({ action: "message", text: "suffix" }),
		]);
		expect(probe.issueInputs.map(({ operations }) => operations.map(({ operation }) => operation))).toEqual([
			[
				{ action: "message", text: "large-prefix" },
				{ action: "message", text: "suffix" },
			],
			[{ action: "message", text: "large-prefix" }],
			[{ action: "message", text: "suffix" }],
		]);
		await session.close();
	});

	it("expands one genuine batch once for recovery and live projection without publishing a malformed prefix", async () => {
		const validBatch = accepted(0x61, {
			author: "author-batch",
			authorSequence: 7,
			epoch: 0,
			logicalTime: 9,
			operation: Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						Object.freeze({ logicalTime: 7, operation: Object.freeze({ action: "message", text: "first" }) }),
						Object.freeze({ logicalTime: 9, operation: Object.freeze({ action: "message", text: "second" }) }),
					]),
					version: 1,
				}),
			}),
		});
		const malformedBatch = accepted(0x62, {
			author: "author-hostile",
			authorSequence: 8,
			epoch: 0,
			logicalTime: 11,
			operation: Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						Object.freeze({ logicalTime: 10, operation: Object.freeze({ action: "message", text: "prefix" }) }),
						Object.freeze({
							logicalTime: 11,
							operation: Object.freeze({ action: "applicationBatch", batch: { entries: [], version: 1 } }),
						}),
					]),
					version: 1,
				}),
			}),
		});
		const productInvalidBatch = accepted(0x64, {
			author: "author-product-invalid",
			authorSequence: 9,
			epoch: 0,
			logicalTime: 11,
			operation: Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						Object.freeze({ logicalTime: 10, operation: Object.freeze({ action: "message", text: "prefix" }) }),
						Object.freeze({ logicalTime: 11, operation: Object.freeze({ action: "message", text: 7 }) }),
					]),
					version: 1,
				}),
			}),
		});
		const projected: readonly AcceptedOperation[][] = [];
		const snapshots = projected as AcceptedOperation[][];
		probe.recovered = [malformedBatch, productInvalidBatch, validBatch];
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(
			input(
				application((operations) => {
					if (
						operations.some(
							({ operation }) =>
								Reflect.get(operation, "action") === "message" && typeof Reflect.get(operation, "text") !== "string"
						)
					) {
						throw new TypeError("D93515_PRODUCT_INVALID_BATCH");
					}
					snapshots.push([...operations]);
					return project(operations);
				}),
				() => undefined
			)
		);
		const validDigest = digest(validBatch);
		expect(snapshots.at(-1)).toEqual([
			{
				author: "author-batch",
				authorSequence: 7,
				logicalTime: 7,
				operation: { action: "message", text: "first" },
				operationCount: 2,
				operationIndex: 0,
				vertexDigest: validDigest,
			},
			{
				author: "author-batch",
				authorSequence: 7,
				logicalTime: 9,
				operation: { action: "message", text: "second" },
				operationCount: 2,
				operationIndex: 1,
				vertexDigest: validDigest,
			},
		]);
		expect(snapshots.flat().some(({ vertexDigest }) => vertexDigest === digest(malformedBatch))).toBe(false);
		expect(snapshots.flat().some(({ vertexDigest }) => vertexDigest === digest(productInvalidBatch))).toBe(false);
		probe.issueInputs.length = 0;
		await session.issue({ action: "message", text: "after-quarantine" });
		expect(probe.issueInputs[0]?.operations[0]?.logicalTime).toBe(13);
		const later = accepted(0x63, {
			author: "author-later",
			authorSequence: 1,
			epoch: 0,
			logicalTime: 13,
			operation: Object.freeze({ action: "message", text: "later" }),
		});
		await probe.activatedSink?.({ vertex: later });
		expect(snapshots.at(-1)?.map(({ operation }) => operation)).toEqual([
			{ action: "message", text: "first" },
			{ action: "message", text: "second" },
			{ action: "message", text: "later" },
		]);
		await session.close();

		probe.recovered = [];
		const liveSnapshots: AcceptedOperation[][] = [];
		const liveSession = await createV3RoomSession(
			input(
				application((operations) => {
					liveSnapshots.push([...operations]);
					return project(operations);
				}),
				() => undefined
			)
		);
		await probe.activatedSink?.({ vertex: validBatch });
		expect(liveSnapshots.at(-1)).toEqual(snapshots[0]);
		await liveSession.close();

		const retainedSnapshots: AcceptedOperation[][] = [];
		const retainedSession = await createV3RoomSession(
			input(
				application((operations) => {
					retainedSnapshots.push([...operations]);
					return project(operations);
				}),
				() => undefined
			)
		);
		probe.retainedVertex = validBatch;
		probe.retainedIngressHandler?.(Object.freeze({}));
		await Promise.resolve();
		await Promise.resolve();
		expect(retainedSnapshots.at(-1)).toEqual(snapshots[0]);
		await retainedSession.close();
	});

	it("rejects every promise owned by one failed batch while leaving the next snapshot independent", async () => {
		probe.issueBatchFailure = true;
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(application(), () => undefined));
		probe.issueInputs.length = 0;
		const failed = await Promise.allSettled([
			session.issue({ action: "message", text: "first" }),
			session.issue({ action: "message", text: "second" }),
		]);
		expect(failed.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
		expect(probe.issueInputs).toHaveLength(1);
		probe.issueBatchFailure = false;
		await expect(session.issue({ action: "message", text: "later" })).resolves.toBeUndefined();
		expect(probe.issueInputs).toHaveLength(2);
		await session.close();
	});

	it("puts signer reentry into the next room drain snapshot", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(application(), () => undefined));
		probe.issueInputs.length = 0;
		let reentered: Promise<void> | undefined;
		probe.onSign = () => {
			probe.onSign = undefined;
			reentered = session.issue({ action: "message", text: "reentrant" });
		};
		await Promise.all([
			session.issue({ action: "message", text: "first" }),
			session.issue({ action: "message", text: "second" }),
		]);
		await reentered;
		expect(probe.issueInputs.map(({ operations }) => operations.map(({ operation }) => operation))).toEqual([
			[
				{ action: "message", text: "first" },
				{ action: "message", text: "second" },
			],
			[{ action: "message", text: "reentrant" }],
		]);
		await session.close();
	});

	it("puts admitted-sink reentry into the next room drain snapshot", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const sessionHolder: { current?: ExpectedSession } = {};
		let reentered: Promise<void> | undefined;
		const selectedApplication = application((operations) => {
			if (operations.length > 0 && sessionHolder.current !== undefined && reentered === undefined) {
				reentered = sessionHolder.current.issue({ action: "message", text: "sink-reentrant" });
			}
			return project(operations);
		});
		const session = await createV3RoomSession(input(selectedApplication, () => undefined));
		sessionHolder.current = session;
		probe.issueInputs.length = 0;
		probe.issueSinkVertex = accepted(0x45, {
			author: "author-local",
			authorSequence: 4,
			epoch: 0,
			logicalTime: 4,
			operation: Object.freeze({ action: "message", text: "durable" }),
		});
		await Promise.all([
			session.issue({ action: "message", text: "first" }),
			session.issue({ action: "message", text: "second" }),
		]);
		await reentered;
		expect(probe.issueInputs.map(({ operations }) => operations.map(({ operation }) => operation))).toEqual([
			[
				{ action: "message", text: "first" },
				{ action: "message", text: "second" },
			],
			[{ action: "message", text: "sink-reentrant" }],
		]);
		await session.close();
	});

	it("settles captured work and rejects new capture when close begins during the active node issue", async () => {
		let release = (): void => undefined;
		probe.issueBarrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(application(), () => undefined));
		const owned = Promise.allSettled([
			session.issue({ action: "message", text: "first" }),
			session.issue({ action: "message", text: "second" }),
		]);
		await Promise.resolve();
		const closing = session.close();
		await expect(session.issue({ action: "message", text: "too-late" })).rejects.toThrow();
		release();
		expect((await owned).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
		await closing;
	});

	it("refolds one digest-keyed set identically across recovery order, replay, and opposite live order", async () => {
		const recovered = accepted(0x10, {
			author: "author-base",
			authorSequence: 1,
			epoch: 0,
			logicalTime: 0,
		});
		const earlierDigest = new Uint8Array(32).fill(0x7a);
		earlierDigest[31] = 0x23;
		const laterDigest = new Uint8Array(earlierDigest);
		laterDigest[31] = 0x24;
		const digestEarlier = accepted(earlierDigest, {
			author: "author-a",
			authorSequence: 1,
			epoch: 0,
			logicalTime: 1,
		});
		const digestLater = accepted(laterDigest, {
			author: "author-a",
			authorSequence: 1,
			epoch: 0,
			logicalTime: 1,
		});
		const sequenceLater = accepted(0x22, {
			author: "author-a",
			authorSequence: 2,
			epoch: 0,
			logicalTime: 1,
		});
		const authorLater = accepted(0x21, {
			author: "author-b",
			authorSequence: 1,
			epoch: 0,
			logicalTime: 1,
		});
		const epochLater = accepted(0x25, {
			author: "author-a",
			authorSequence: 1,
			epoch: 1,
			logicalTime: 0,
		});
		const projectionHidden = accepted(0x30, {
			author: "author-hidden",
			authorSequence: 1,
			epoch: 0,
			logicalTime: 19,
			operation: Object.freeze({ action: "projection-hidden" }),
		});
		const live = [epochLater, authorLater, sequenceLater, digestLater, digestEarlier];
		const expected = [recovered, digestEarlier, digestLater, sequenceLater, authorLater, epochLater].map(digest);
		const visibleApplication = application(project);
		const observed: Projection[] = [];
		probe.recovered = [projectionHidden, recovered];
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const first = await createV3RoomSession(input(visibleApplication, (value) => observed.push(value)));
		expect(observed.at(-1)?.acceptedDigests).toEqual([digest(recovered)]);
		for (const vertex of live) await probe.activatedSink?.({ vertex });
		expect(observed.at(-1)?.acceptedDigests).toEqual(expected);
		const projectionCount = observed.length;
		await probe.activatedSink?.({ vertex: digestEarlier });
		expect(observed).toHaveLength(projectionCount);
		probe.issueRowsPerRequest = 3;
		await first.issue(Object.freeze({ action: "after-hidden-recovery" }));
		expect(probe.issueInputs.at(-1)?.operations.at(-1)?.logicalTime).toBe(21);
		expect(probe.publishCalls).toBe(4);
		await first.close();

		observed.length = 0;
		probe.recovered = [recovered, projectionHidden];
		const second = await createV3RoomSession(input(visibleApplication, (value) => observed.push(value)));
		for (const vertex of [...live].reverse()) await probe.activatedSink?.({ vertex });
		expect(observed.at(-1)?.acceptedDigests).toEqual(expected);
		await second.close();
	});

	it("rejects both batch promises when publication fails after durable acceptance", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		probe.issueRowsPerRequest = 3;
		probe.publishFailureAtCall = 3;
		const durableBatch = accepted(0x43, {
			author: "author-local",
			authorSequence: 3,
			epoch: 0,
			logicalTime: 3,
			operation: Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "message", text: "first" }) }),
						Object.freeze({ logicalTime: 5, operation: Object.freeze({ action: "message", text: "second" }) }),
					]),
					version: 1,
				}),
			}),
		});
		probe.issueSinkVertex = durableBatch;
		const session = await createV3RoomSession(input(application(), () => undefined));
		const outcomes = await Promise.allSettled([
			session.issue(Object.freeze({ action: "message", text: "first" })),
			session.issue(Object.freeze({ action: "message", text: "second" })),
		]);
		expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
		expect(probe.publishCalls).toBe(3);
		expect(probe.pendingPublications).toBe(1);
		await session.close();

		probe.issueSinkVertex = undefined;
		probe.publishFailureAtCall = undefined;
		probe.recovered = [durableBatch];
		const recovered: Projection[] = [];
		const reopened = await createV3RoomSession(input(application(), (projection) => recovered.push(projection)));
		expect(recovered.at(-1)?.acceptedDigests).toEqual([digest(durableBatch), digest(durableBatch)]);
		expect(probe.issueInputs).toHaveLength(1);
		await reopened.close();
	});

	it("surfaces a post-commit admitted-sink failure through terminalFailure", async () => {
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		probe.issueSinkVertex = accepted(0x44, {
			author: "author-local",
			authorSequence: 4,
			epoch: 0,
			logicalTime: 4,
			operation: Object.freeze({ action: "sink-failure" }),
		});
		const session = await createV3RoomSession(
			input(
				application((operations) => {
					if (operations.length > 0) throw new Error("D9351_SINK_FAILURE");
					return project(operations);
				}),
				() => undefined
			)
		);
		const outcomes = await Promise.allSettled([
			session.issue(Object.freeze({ action: "message", text: "committed-before-sink-a" })),
			session.issue(Object.freeze({ action: "message", text: "committed-before-sink-b" })),
		]);
		expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
		await expect(session.issue(Object.freeze({ action: "must-remain-terminal" }))).rejects.toThrow(
			"D9351_SINK_FAILURE"
		);
		expect(probe.issueInputs).toHaveLength(1);
		expect(probe.deactivations).toBe(1);
		await session.close();
	});

	it("keeps projector failure recoverable and releases every opened owner exactly once", async () => {
		probe.recovered = [accepted(1, { author: "author-a", authorSequence: 1, epoch: 0, logicalTime: 1 })];
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		await expect(
			createV3RoomSession(
				input(
					application(() => {
						throw new Error("D9346_PROJECTOR_FAILURE");
					}),
					() => undefined
				)
			)
		).rejects.toThrow("D9346_PROJECTOR_FAILURE");
		expect(probe.closeCounts).toEqual({ ahe: 1, issuance: 1, journal: 1, queue: 0, transport: 0 });

		const recovered: Projection[] = [];
		const session = await createV3RoomSession(input(application(), (value) => recovered.push(value)));
		expect(recovered).toHaveLength(1);
		await session.close();
		await session.close();
		expect(probe.closeCounts).toEqual({ ahe: 2, issuance: 2, journal: 2, queue: 1, transport: 1 });
		expect(probe.deactivations).toBe(1);
	});

	it("opens E1 only from the signed accepted roster and current writer projection", async () => {
		probe.recovered = [
			accepted(1, {
				author: "author-writer",
				authorSequence: 1,
				epoch: 0,
				logicalTime: 1,
				operation: Object.freeze({ action: "join", peerId: "peer-writer" }),
			}),
			accepted(2, {
				author: "author-reader",
				authorSequence: 1,
				epoch: 0,
				logicalTime: 2,
				operation: Object.freeze({ action: "join", peerId: "peer-reader" }),
			}),
		];
		const widenedProjection = application((operations) => {
			const value = project(operations);
			return { ...value, writerAuthors: ["author-writer", "author-reader"] };
		});
		const { createV3RoomSession: currentCreateV3RoomSession } = await roomModule;
		const createV3RoomSession = currentCreateV3RoomSession as unknown as (
			input: ExpectedInput
		) => Promise<ExpectedSession>;
		const session = await createV3RoomSession(input(widenedProjection, () => undefined));
		session.openEphemeral({ maxMessageBytes: 65_536, maxSequencedKeys: 1, maxSequencedSenders: 2 });
		const provider = probe.ephemeralProvider;
		expect(provider).toBeDefined();
		expect(provider?.authorForPeer("peer-writer")).toBe("author-writer");
		expect(provider?.currentAuthority()).toEqual({
			aclDigest: "c".repeat(64),
			anchorDigest: "a".repeat(64),
			epoch: 0,
			isCurrentWriter: expect.any(Function),
			objectId: "controlled-v3-room",
		});
		expect(provider?.isCurrentWriter("author-writer")).toBe(true);
		expect(provider?.isCurrentWriter(provider.authorForPeer("peer-reader") ?? "")).toBe(false);
		expect(provider?.authorForPeer("peer-unknown")).toBeUndefined();
		await session.close();
		expect(() =>
			session.openEphemeral({ maxMessageBytes: 65_536, maxSequencedKeys: 1, maxSequencedSenders: 2 })
		).toThrow();
	});
});
