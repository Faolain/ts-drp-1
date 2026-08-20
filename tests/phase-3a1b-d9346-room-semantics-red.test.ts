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
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: unknown;
	projectAcceptedVertices(vertices: readonly V3RoomAcceptedVertex[]): Projection;
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
	readonly logicalTime: number;
}

const probe = vi.hoisted(() => ({
	activatedSink: undefined as ((input: { readonly vertex: unknown }) => unknown) | undefined,
	closeCounts: { ahe: 0, issuance: 0, journal: 0, queue: 0, transport: 0 },
	deactivations: 0,
	ephemeralProvider: undefined as AuthorizationProvider | undefined,
	issueInputs: [] as LocalIssueInput[],
	recovered: [] as unknown[],
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
				issueLocal: (input: LocalIssueInput) => {
					probe.issueInputs.push(input);
					return Promise.resolve({ ok: true });
				},
				publishPending: () => Promise.resolve({ kind: "published", ok: true }),
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
	createBrowserDurableIssuanceStore: () =>
		Promise.resolve({
			close: (): void => {
				probe.closeCounts.issuance += 1;
			},
			readLineage: () => Promise.resolve({ next: 1 }),
		}),
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

function project(vertices: readonly V3RoomAcceptedVertex[]): Projection {
	const transportPeerAuthors = vertices.flatMap((vertex) => {
		const peerId = Reflect.get(vertex.operation, "peerId");
		return Reflect.get(vertex.operation, "action") === "join" && typeof peerId === "string"
			? [{ author: vertex.author, peerId }]
			: [];
	});
	return Object.freeze({
		acceptedDigests: Object.freeze(vertices.map(digest)),
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
			delivered: 0,
			dropped: 0,
			localSequencedKeys: 0,
			malformed: 0,
			overLimit: 0,
			published: 0,
			received: 0,
			remoteSequencedKeys: 0,
			sequencedKeys: 0,
			sequencedSenders: 0,
			stale: 0,
			subscriberFailures: 0,
			unauthorized: 0,
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
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
		publicKeyBytes: Uint8Array.of(1),
		signRegisteredVertexDigest: () => Promise.resolve(new Uint8Array(64)),
	};
}

function application(projector: ExpectedApplication["projectAcceptedVertices"] = project): ExpectedApplication {
	return {
		bootstrapOperation: Object.freeze({ action: "join", peerId: "peer-local" }),
		canonicalBlueprintPackageBytes: Uint8Array.of(1),
		catalog: {} as never,
		projectAcceptedVertices: projector,
	};
}

beforeEach(() => {
	probe.activatedSink = undefined;
	probe.closeCounts = { ahe: 0, issuance: 0, journal: 0, queue: 0, transport: 0 };
	probe.deactivations = 0;
	probe.ephemeralProvider = undefined;
	probe.issueInputs = [];
	probe.recovered = [];
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("D.93.46b real shared-room semantics", () => {
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
		const visibleApplication = application((vertices) =>
			project(vertices.filter((vertex) => Reflect.get(vertex.operation, "action") !== "projection-hidden"))
		);
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
		await first.issue(Object.freeze({ action: "after-hidden-recovery" }));
		expect(probe.issueInputs.at(-1)?.logicalTime).toBe(21);
		await first.close();

		observed.length = 0;
		probe.recovered = [recovered, projectionHidden];
		const second = await createV3RoomSession(input(visibleApplication, (value) => observed.push(value)));
		for (const vertex of [...live].reverse()) await probe.activatedSink?.({ vertex });
		expect(observed.at(-1)?.acceptedDigests).toEqual(expected);
		await second.close();
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
		const widenedProjection = application((vertices) => {
			const value = project(vertices);
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
