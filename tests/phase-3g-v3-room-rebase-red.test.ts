/* eslint-disable @typescript-eslint/explicit-function-return-type -- controlled module factories expose exact probes. */
import { encodeCanonical } from "@ts-drp/canonical";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { V3RoomCreatorInviteMaterial } from "../examples/v3-room/src/index.js";

const probe = vi.hoisted(() => ({
	bootstrapIssues: 0,
	completionOutcomes: [] as unknown[],
	completedSources: [] as unknown[],
	events: [] as string[],
	issuanceNames: [] as string[],
	issueInputs: [] as Readonly<Record<string, unknown>>[],
	issueOutcomes: [] as Readonly<Record<string, unknown>>[],
	journalInstalled: false,
	journalNames: [] as string[],
	nextCapabilityId: 0,
	readinessOutcome: undefined as unknown,
	prepareAnchors: [] as string[],
	publicationOutcomes: [] as Readonly<Record<string, unknown>>[],
	publishCalls: 0,
	rebaseGate: undefined as Promise<void> | undefined,
	rebasePages: [] as unknown[],
	rebaseReads: 0,
	recoveredVertices: [] as Readonly<Record<string, unknown>>[],
	recoveryOutcomes: [] as unknown[],
	recoveryInputs: [] as Readonly<Record<string, unknown>>[],
	consumedCapabilityIds: [] as number[],
	signerCalls: 0,
	targetBootstrapCommitted: false,
	trustNames: [] as string[],
	trustStores: [] as Readonly<{ readonly anchor: string; readonly store: object }>[],
}));

vi.mock("@ts-drp/control-plane", async (importOriginal) => ({
	...(await importOriginal()),
	createCurrentAnchorTrustStore: (input: { pinnedGenesisAnchorDigest: string; store: object }) => {
		probe.prepareAnchors.push(input.pinnedGenesisAnchorDigest);
		probe.trustStores.push(Object.freeze({ anchor: input.pinnedGenesisAnchorDigest, store: input.store }));
		return {
			install: () => Promise.resolve({ ok: true, trust: { profileId: "creator-trusted-v1" } }),
			open: () => Promise.resolve({ ok: true, trust: { profileId: "creator-trusted-v1" } }),
		};
	},
}));

vi.mock("../packages/storage/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	parseStorageObjectId: (value: string) => ({ ok: true, value }),
}));

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserAheDurableStore: ({ databaseName }: { databaseName: string }) => {
		probe.trustNames.push(databaseName);
		return Promise.resolve({ close: () => Promise.resolve(), databaseName });
	},
}));

vi.mock("../packages/storage-browser/dist/src/issuance.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableIssuanceStore: ({ primaryDatabaseName }: { primaryDatabaseName: string }) => {
		probe.issuanceNames.push(primaryDatabaseName);
		return Promise.resolve({
			close: () => Promise.resolve(),
			compareAndMarkOutboxPublished: () => Promise.resolve(),
			readIssued: () => Promise.resolve(null),
			readLineage: () => Promise.resolve({ exhausted: false, next: probe.targetBootstrapCommitted ? 1 : 0 }),
			readOutboxPage: () => Promise.resolve([]),
			transactIssue: () => Promise.reject(new Error("controlled issuer owns bootstrap transaction")),
		});
	},
}));

vi.mock("../packages/storage-browser/dist/src/live-journal.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableLiveJournalStore: ({ primaryDatabaseName }: { primaryDatabaseName: string }) => {
		probe.journalNames.push(primaryDatabaseName);
		return Promise.resolve({
			appendAccepted: () => Promise.reject(new Error("controlled recovery owns journal append")),
			close: () => Promise.resolve(),
			installGenesis: () => {
				const idempotent = probe.journalInstalled;
				probe.journalInstalled = true;
				return Promise.resolve({ idempotent, ok: true });
			},
			readPage: () => Promise.resolve({ nextSequence: null, ok: true, rows: [] }),
			readiness: () =>
				Promise.resolve(
					probe.readinessOutcome ??
						(probe.journalInstalled
							? {
									ok: true,
									ready: true,
									rowCount: 1,
									scope: {
										anchorDigest: "b".repeat(64),
										epoch: 0,
										objectId: `creator:${"d".repeat(32)}`,
									},
									snapshot: {
										genesisDigest: "1".repeat(64),
										highWatermark: 0,
										kind: "v3-live-journal-snapshot-token-1",
										orderedRowDigest: "2".repeat(64),
										parametersDigest: "3".repeat(64),
										scope: {
											anchorDigest: "b".repeat(64),
											epoch: 0,
											objectId: `creator:${"d".repeat(32)}`,
										},
										snapshotDigest: "4".repeat(64),
									},
								}
							: { kind: "not-installed", ok: true, ready: false })
				),
		});
	},
}));

vi.mock("../packages/protocol-v3/dist/src/public.js", async (importOriginal) => ({
	...(await importOriginal()),
	createAdmissionBoundTransactionalVertexIssuer: () => ({
		issue: () => {
			probe.bootstrapIssues += 1;
			probe.targetBootstrapCommitted = true;
			return Promise.resolve({});
		},
	}),
	prepareBlueprintAdmission: () => ({}),
}));

vi.mock("../packages/node/dist/src/v3-live.js", async (importOriginal) => ({
	...(await importOriginal()),
	prepareV3LiveGeneration: (input: { pinnedGenesisAnchorDigest: string }) => {
		probe.nextCapabilityId += 1;
		return Promise.resolve({
			capability: Object.freeze({ anchor: input.pinnedGenesisAnchorDigest, id: probe.nextCapabilityId }),
			descriptor: { anchorDigest: input.pinnedGenesisAnchorDigest, blueprintDigest: "b".repeat(64) },
			ok: true,
		});
	},
	recoverV3LiveReplica: (input: Readonly<Record<string, unknown>>) => {
		probe.recoveryInputs.push(input);
		const targetCapability = Reflect.get(input, "capability");
		const displacedSource = Reflect.get(input, "displacedSource");
		const sourceCapability =
			typeof displacedSource === "object" && displacedSource !== null
				? Reflect.get(displacedSource, "capability")
				: undefined;
		for (const capability of [targetCapability, sourceCapability]) {
			const id = typeof capability === "object" && capability !== null ? Reflect.get(capability, "id") : undefined;
			if (!Number.isSafeInteger(id) || probe.consumedCapabilityIds.includes(id as number)) {
				return Promise.resolve({
					detail: "v3 recovery capability is unavailable",
					kind: "capability-consumed",
					ok: false,
				});
			}
			probe.consumedCapabilityIds.push(id as number);
		}
		probe.journalInstalled = true;
		const selected = probe.recoveryOutcomes.shift();
		if (selected !== undefined) return Promise.resolve(selected);
		if (!probe.targetBootstrapCommitted) {
			return Promise.resolve({
				detail: "v3 recovery issued record chain is empty",
				kind: "issuance-rejected",
				ok: false,
			});
		}
		return Promise.resolve({ capability: {}, descriptor: { recoveredVertices: probe.recoveredVertices }, ok: true });
	},
	activateV3LivePlane: () => ({
		handle: {
			completeRebaseSource: (input: unknown) => {
				probe.completedSources.push(input);
				probe.events.push(`complete:${String(Reflect.get(input as object, "authorSequence"))}`);
				const outcome = probe.completionOutcomes.shift() ?? { kind: "published", ok: true };
				return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
			},
			currentEphemeralAuthority: () => undefined,
			deactivate: () => undefined,
			issueLocal: async (input: Readonly<Record<string, unknown>>) => {
				probe.issueInputs.push(input);
				probe.events.push("issue");
				const signer = Reflect.get(input, "signRegisteredVertexDigest");
				if (typeof signer === "function") {
					probe.signerCalls += 1;
					await Reflect.apply(signer, undefined, [new Uint8Array(32)]);
				}
				return (
					probe.issueOutcomes.shift() ?? {
						authorSequence: 6 + probe.issueInputs.length,
						digest: "d".repeat(64),
						kind: "accepted",
						ok: true,
					}
				);
			},
			publishPending: () => {
				probe.publishCalls += 1;
				return Promise.resolve(probe.publicationOutcomes.shift() ?? { kind: "empty", ok: true });
			},
			readRebaseOutbox: async () => {
				probe.rebaseReads += 1;
				await probe.rebaseGate;
				return probe.rebasePages.shift() ?? { kind: "empty", ok: true };
			},
			republishRetained: () => Promise.resolve({ kind: "empty", ok: true }),
		},
		ok: true,
	}),
	routeV3Ingress: () => false,
	routeV3RetainedIngress: () => false,
}));

const roomModule = import("../examples/v3-room/src/index.js");

function invite(anchor: string): V3RoomCreatorInviteMaterial {
	return Object.freeze({
		detachedGenesisSignature: new Uint8Array(64).fill(anchor === "a".repeat(64) ? 1 : 2),
		exactCanonicalGenesisAnchorPreimageBytes: Uint8Array.of(anchor === "a".repeat(64) ? 1 : 2),
		exactCanonicalLatchedAclBytes: Uint8Array.of(3),
		exactCanonicalParametersCarrierBytes: Uint8Array.of(4),
		exactCanonicalProfileBytes: Uint8Array.of(5),
		exactCanonicalSignerSetBytes: Uint8Array.of(6),
		pinnedGenesisAnchorDigest: anchor,
	});
}

function application(): Readonly<Record<string, unknown>> {
	const canonicalBlueprintPackageBytes = encodeCanonical({
		manifest: {
			operations: ["expire-me", "message", "rebase-me", "review-me", "transform-me"].map((name) => ({
				argumentSchema: {
					fields: [
						{ name: "clientOperationId", required: true, type: "string" },
						...(name === "message" ? [] : [{ name: "value", required: false, type: "integer" }]),
						...(name === "message" ? [{ name: "text", required: false, type: "string" }] : []),
					],
					kind: "closed-record",
				},
				maxCanonicalOperationBytes: 65_536,
				name,
			})),
		},
	});
	const blueprintDigest = "b".repeat(64);
	return Object.freeze({
		batchableOperationActions: Object.freeze(["expire-me", "message", "rebase-me", "review-me", "transform-me"]),
		bootstrapOperation: Object.freeze({ action: "join", peerId: "peer:local" }),
		canonicalBlueprintPackageBytes,
		catalog: Object.freeze({
			blueprintDigests: Object.freeze([blueprintDigest]),
			catalogDigest: "c".repeat(64),
			resolve(requested: string) {
				if (requested !== blueprintDigest) throw new TypeError("unknown controlled Phase 3g blueprint");
				return Object.freeze({ blueprintDigest, canonicalBlueprintPackageBytes });
			},
		}),
		displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>) =>
			String(Reflect.get(operation, "clientOperationId")),
		displacementPolicies: Object.freeze({
			"expire-me": "expire",
			"message": "rebase",
			"rebase-me": "rebase",
			"review-me": "manual-review",
			"transform-me": "transform",
		}),
		projectAcceptedOperations: () =>
			Object.freeze({ acceptedDigests: [], transportPeerAuthors: [], writerAuthors: [] }),
	});
}

function acceptedVertex(
	operation: Readonly<Record<string, unknown>>,
	logicalTime = 5,
	authorSequence = 3,
	digestByte = 0xaa
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		anchor: "b".repeat(64),
		author: "author-local",
		authorSequence,
		dependencies: Object.freeze(["b".repeat(64)]),
		digest: new Uint8Array(32).fill(digestByte),
		epoch: 0,
		kind: "drp-vertex",
		logicalTime,
		objectId: `creator:${"d".repeat(32)}`,
		operation,
		protocolMajor: 3,
	});
}

function roomInput(selectedApplication = application()): Readonly<Record<string, unknown>> {
	return Object.freeze({
		application: selectedApplication,
		author: "author-local",
		creatorInvite: invite("b".repeat(64)),
		databaseName: "target-plane",
		initialLogicalTime: 9,
		issuanceDatabaseName: "shared-lineage",
		objectId: `creator:${"d".repeat(32)}`,
		onAcceptedVertex: () => undefined,
		onProjection: () => undefined,
		openTransport: () => ({
			close: () => undefined,
			networkNode: {},
			openEphemeral: () => ({ close: () => undefined }),
			requestRetainedHistory: () => undefined,
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
		publicKeyBytes: Uint8Array.of(1),
		rebaseSourceInvite: invite("a".repeat(64)),
		signRegisteredVertexDigest: () => Promise.resolve(new Uint8Array(64)),
	});
}

function displaced(
	intents: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
		readonly operationCount: number;
		readonly operationIndex: number;
	}>[],
	authorSequence = 4,
	vertexDigest = "f".repeat(64),
	author = "author-local"
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		kind: "displaced",
		ok: true,
		source: Object.freeze({ author, authorSequence, intents: Object.freeze(intents), vertexDigest }),
	});
}

async function settleRoomDrain(): Promise<void> {
	for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
}

function issuedEntries(): readonly Readonly<{
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
}>[] {
	return probe.issueInputs.flatMap((input) => {
		const entries = Reflect.get(input, "operations");
		return Array.isArray(entries) ? entries : [];
	}) as readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[];
}

function expectFreshLogicalTimes(
	entries: readonly Readonly<{ readonly logicalTime: number }>[],
	captured: readonly number[]
): void {
	const times = entries.map(({ logicalTime }) => logicalTime);
	expect(times.every((value) => Number.isSafeInteger(value) && value > Math.max(...captured))).toBe(true);
	expect(times.every((value) => !captured.includes(value))).toBe(true);
	expect(times.every((value, index) => index === 0 || value > (times[index - 1] as number))).toBe(true);
}

beforeEach(() => {
	probe.bootstrapIssues = 0;
	probe.completionOutcomes = [];
	probe.completedSources = [];
	probe.events = [];
	probe.issuanceNames = [];
	probe.issueInputs = [];
	probe.issueOutcomes = [];
	probe.journalInstalled = false;
	probe.journalNames = [];
	probe.nextCapabilityId = 0;
	probe.readinessOutcome = undefined;
	probe.prepareAnchors = [];
	probe.publicationOutcomes = [];
	probe.publishCalls = 0;
	probe.rebaseGate = undefined;
	probe.rebasePages = [];
	probe.rebaseReads = 0;
	probe.recoveredVertices = [];
	probe.recoveryOutcomes = [];
	probe.recoveryInputs = [];
	probe.consumedCapabilityIds = [];
	probe.signerCalls = 0;
	probe.targetBootstrapCommitted = false;
	probe.trustNames = [];
	probe.trustStores = [];
});

describe("Phase 3g room-owned rebase scheduling RED", () => {
	it("separates plane-local stores, authenticates both anchors and bootstraps the empty target once", async () => {
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const first = await create(roomInput());
		expect(probe.trustNames).toHaveLength(2);
		expect(probe.trustNames).toContain("target-plane--ahe");
		expect(new Set(probe.trustNames)).toHaveProperty("size", 2);
		expect(probe.trustStores).toHaveLength(4);
		expect(probe.trustStores[0]?.store).not.toBe(probe.trustStores[1]?.store);
		expect(probe.issuanceNames).toEqual(["shared-lineage"]);
		expect(probe.journalNames).toEqual(["target-plane"]);
		expect([...probe.prepareAnchors].sort()).toEqual(["a".repeat(64), "a".repeat(64), "b".repeat(64), "b".repeat(64)]);
		expect(probe.bootstrapIssues).toBe(1);
		expect(probe.recoveryInputs).toHaveLength(2);
		expect(Reflect.get(probe.recoveryInputs[0] ?? {}, "capability")).not.toEqual(
			Reflect.get(probe.recoveryInputs[1] ?? {}, "capability")
		);
		expect(Reflect.get(Reflect.get(probe.recoveryInputs[0] ?? {}, "displacedSource") ?? {}, "capability")).not.toEqual(
			Reflect.get(Reflect.get(probe.recoveryInputs[1] ?? {}, "displacedSource") ?? {}, "capability")
		);
		expect(probe.recoveryInputs[1]).toMatchObject({
			displacedSource: {
				capability: { anchor: "a".repeat(64) },
				exactCanonicalLatchedAclBytes: Uint8Array.of(3),
			},
		});
		await first.close();
		const second = await create(roomInput());
		expect(probe.bootstrapIssues).toBe(1);
		expect(probe.issuanceNames).toEqual(["shared-lineage", "shared-lineage"]);
		expect(probe.journalNames).toEqual(["target-plane", "target-plane"]);
		expect(probe.trustNames).toHaveLength(4);
		await second.close();
	});

	it("recovers a committed target bootstrap after a pre-journal crash without issuing a duplicate", async () => {
		probe.targetBootstrapCommitted = true;
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const recovered = await create(roomInput());
		expect(probe.bootstrapIssues).toBe(0);
		expect(probe.recoveryInputs).toHaveLength(1);
		expect(probe.journalInstalled).toBe(true);
		await recovered.close();
	});

	it("does not bootstrap an inconsistent issuance lineage after recovery installs journal genesis", async () => {
		probe.recoveryOutcomes = [
			Object.freeze({
				detail: "v3 recovery issuance lineage is inconsistent",
				kind: "issuance-rejected",
				ok: false,
			}),
		];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		await expect(create(roomInput())).rejects.toThrow("issuance-rejected");
		expect(probe.bootstrapIssues).toBe(0);
		expect(probe.recoveryInputs).toHaveLength(1);
		expect(probe.journalInstalled).toBe(true);
	});

	it("rejects wrong readiness scope and snapshot scope before bootstrap or recovery", async () => {
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		for (const selected of ["readiness", "snapshot"] as const) {
			const expectedScope = {
				anchorDigest: "b".repeat(64),
				epoch: 0,
				objectId: `creator:${"d".repeat(32)}`,
			};
			probe.readinessOutcome = {
				ok: true,
				ready: true,
				rowCount: 1,
				scope: selected === "readiness" ? { ...expectedScope, anchorDigest: "c".repeat(64) } : expectedScope,
				snapshot: {
					genesisDigest: "1".repeat(64),
					highWatermark: 0,
					kind: "v3-live-journal-snapshot-token-1",
					orderedRowDigest: "2".repeat(64),
					parametersDigest: "3".repeat(64),
					scope: selected === "snapshot" ? { ...expectedScope, objectId: `creator:${"e".repeat(32)}` } : expectedScope,
					snapshotDigest: "4".repeat(64),
				},
			};
			await expect(create(roomInput())).rejects.toThrow("readiness");
			expect(probe.bootstrapIssues).toBe(0);
			expect(probe.recoveryInputs).toEqual([]);
		}
	});

	it("retires structural source rows, accepts the full configured plane bound, and gates new issue on rebase", async () => {
		let release!: () => void;
		probe.rebaseGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		probe.rebasePages = [
			...Array.from({ length: 8192 }, (_, index) =>
				displaced(Object.freeze([]), index + 1, (index + 1).toString(16).padStart(64, "0"))
			),
			{ kind: "empty", ok: true },
		];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void>; issue(operation: Readonly<Record<string, unknown>>): Promise<void> }>;
		const session = await create(roomInput());
		const issued = session.issue(Object.freeze({ action: "message", clientOperationId: "after-rebase" }));
		await settleRoomDrain();
		expect(probe.issueInputs).toEqual([]);
		release();
		await issued;
		expect(probe.completedSources).toHaveLength(8192);
		expect(probe.issueInputs).toHaveLength(1);
		expect(probe.events.at(-1)).toBe("issue");
		expect(probe.events.slice(0, -1).every((event) => event.startsWith("complete:"))).toBe(true);
		await session.close();
	});

	it("orders exact rebase and transform inputs while expire and held review perform no issue", async () => {
		const intents = Object.freeze([
			Object.freeze({
				logicalTime: 1,
				operation: Object.freeze({ action: "rebase-me", clientOperationId: "r-1" }),
				operationCount: 4,
				operationIndex: 0,
			}),
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({ action: "transform-me", clientOperationId: "t-1", value: 1 }),
				operationCount: 4,
				operationIndex: 1,
			}),
			Object.freeze({
				logicalTime: 5,
				operation: Object.freeze({ action: "expire-me", clientOperationId: "e-1" }),
				operationCount: 4,
				operationIndex: 2,
			}),
			Object.freeze({
				logicalTime: 7,
				operation: Object.freeze({ action: "review-me", clientOperationId: "h-1" }),
				operationCount: 4,
				operationIndex: 3,
			}),
		]);
		probe.rebasePages = [displaced(intents), { kind: "empty", ok: true }];
		const controlledApplication = Object.freeze({
			...application(),
			displacementPolicies: Object.freeze({
				"expire-me": "expire",
				"message": "rebase",
				"rebase-me": "rebase",
				"review-me": "manual-review",
				"transform-me": "transform",
			}),
			transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) =>
				Object.freeze({ ...operation, value: 2 }),
		});
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const first = await create(roomInput(controlledApplication));
		await settleRoomDrain();
		const issued = issuedEntries();
		expect(issued.map(({ operation }) => operation)).toEqual([
			{ action: "rebase-me", clientOperationId: "r-1" },
			{ action: "transform-me", clientOperationId: "t-1", value: 2 },
		]);
		expectFreshLogicalTimes(issued, [1, 3, 5, 7]);
		expect(probe.signerCalls).toBe(2);
		expect(probe.completedSources).toEqual([]);
		const issuedBeforeReopen = probe.issueInputs.length;
		const rebaseReadsBeforeReopen = probe.rebaseReads;
		probe.recoveredVertices = issued.map(({ logicalTime, operation }, index) =>
			acceptedVertex(operation, logicalTime, 7 + index, 0xb0 + index)
		);
		probe.rebasePages = [displaced(intents), { kind: "empty", ok: true }];
		await first.close();
		const reopened = await create(roomInput(controlledApplication));
		await settleRoomDrain();
		expect(probe.rebaseReads).toBeGreaterThan(rebaseReadsBeforeReopen);
		expect(probe.issueInputs).toHaveLength(issuedBeforeReopen);
		expect(probe.completedSources).toEqual([]);
		await reopened.close();
	});

	it("closes one source exactly once after every child has a terminal outcome", async () => {
		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 1,
						operation: Object.freeze({ action: "rebase-me", clientOperationId: "r-1" }),
						operationCount: 3,
						operationIndex: 0,
					}),
					Object.freeze({
						logicalTime: 3,
						operation: Object.freeze({ action: "transform-me", clientOperationId: "t-1", value: 1 }),
						operationCount: 3,
						operationIndex: 1,
					}),
					Object.freeze({
						logicalTime: 5,
						operation: Object.freeze({ action: "expire-me", clientOperationId: "e-1" }),
						operationCount: 3,
						operationIndex: 2,
					}),
				])
			),
			{ kind: "empty", ok: true },
		];
		const controlledApplication = Object.freeze({
			...application(),
			displacementPolicies: Object.freeze({
				"expire-me": "expire",
				"message": "rebase",
				"rebase-me": "rebase",
				"review-me": "manual-review",
				"transform-me": "transform",
			}),
			transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) =>
				Object.freeze({ ...operation, value: 2 }),
		});
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const session = await create(roomInput(controlledApplication));
		await settleRoomDrain();
		const issued = issuedEntries();
		expect(issued.map(({ operation }) => operation)).toEqual([
			{ action: "rebase-me", clientOperationId: "r-1" },
			{ action: "transform-me", clientOperationId: "t-1", value: 2 },
		]);
		expectFreshLogicalTimes(issued, [1, 3, 5]);
		expect(probe.signerCalls).toBe(2);
		expect(probe.completedSources).toEqual([{ authorSequence: 4, digest: "f".repeat(64) }]);
		expect(probe.publishCalls).toBeGreaterThanOrEqual(2);
		await session.close();
	});

	it("batches sixteen compatible rebases behind one target signature", async () => {
		const intents = Object.freeze(
			Array.from({ length: 16 }, (_, index) =>
				Object.freeze({
					logicalTime: index + 1,
					operation: Object.freeze({ action: "message", clientOperationId: `rebased-${index}` }),
					operationCount: 16,
					operationIndex: index,
				})
			)
		);
		probe.rebasePages = [displaced(intents), { kind: "empty", ok: true }];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const session = await create(roomInput());
		await settleRoomDrain();
		const issued = issuedEntries();
		expect(issued.map(({ operation }) => operation)).toEqual(intents.map(({ operation }) => operation));
		expectFreshLogicalTimes(
			issued,
			intents.map(({ logicalTime }) => logicalTime)
		);
		expect(probe.signerCalls).toBe(1);
		expect(probe.completedSources).toEqual([{ authorSequence: 4, digest: "f".repeat(64) }]);
		await session.close();
	});

	it("splits seventeen compatible rebases into sixteen plus one", async () => {
		const intents = Object.freeze(
			Array.from({ length: 16 }, (_, index) =>
				Object.freeze({
					logicalTime: index + 1,
					operation: Object.freeze({ action: "message", clientOperationId: `rebased-${index}` }),
					operationCount: 16,
					operationIndex: index,
				})
			)
		);
		probe.issueInputs = [];
		probe.signerCalls = 0;
		probe.completedSources = [];
		probe.rebasePages = [
			displaced(intents, 4, "f".repeat(64)),
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 17,
						operation: Object.freeze({ action: "message", clientOperationId: "rebased-16" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				]),
				5,
				"e".repeat(64)
			),
			{ kind: "empty", ok: true },
		];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const split = await create(roomInput());
		await settleRoomDrain();
		expect(probe.issueInputs.map((input) => (Reflect.get(input, "operations") as unknown[]).length)).toEqual([16, 1]);
		const issued = issuedEntries();
		expect(issued.map(({ operation }) => operation)).toEqual([
			...intents.map(({ operation }) => operation),
			{ action: "message", clientOperationId: "rebased-16" },
		]);
		expectFreshLogicalTimes(issued, [...intents.map(({ logicalTime }) => logicalTime), 17]);
		expect(probe.signerCalls).toBe(2);
		expect(probe.completedSources).toEqual([
			{ authorSequence: 4, digest: "f".repeat(64) },
			{ authorSequence: 5, digest: "e".repeat(64) },
		]);
		await split.close();
	});

	it("refuses a foreign-author displaced intent before signing or issuing", async () => {
		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 3,
						operation: Object.freeze({ action: "message", clientOperationId: "foreign" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				]),
				4,
				"f".repeat(64),
				"author-foreign"
			),
		];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const session = await create(roomInput());
		await settleRoomDrain();
		expect(probe.rebaseReads).toBe(1);
		expect(probe.issueInputs).toEqual([]);
		expect(probe.signerCalls).toBe(0);
		expect(probe.completedSources).toEqual([]);
		await session.close();
	});

	it("sorts displaced pages before assigning fresh target logical times", async () => {
		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 9,
						operation: Object.freeze({ action: "message", clientOperationId: "late" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				]),
				6,
				"c".repeat(64)
			),
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 1,
						operation: Object.freeze({ action: "message", clientOperationId: "early" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				]),
				2,
				"a".repeat(64)
			),
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 5,
						operation: Object.freeze({ action: "message", clientOperationId: "middle" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				]),
				4,
				"b".repeat(64)
			),
			{ kind: "empty", ok: true },
		];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void> }>;
		const session = await create(roomInput());
		await settleRoomDrain();
		const issued = issuedEntries();
		expect(issued.map(({ operation }) => Reflect.get(operation, "clientOperationId"))).toEqual([
			"early",
			"middle",
			"late",
		]);
		expectFreshLogicalTimes(issued, [1, 5, 9]);
		await session.close();
	});

	it("suppresses an accepted exact identity before issue and rejects changed bytes", async () => {
		const current = Object.freeze({ action: "message", clientOperationId: "accepted-current", text: "same" });
		probe.recoveredVertices = [acceptedVertex(current, 21, 3)];
		probe.rebasePages = [
			displaced(
				Object.freeze([Object.freeze({ logicalTime: 1, operation: current, operationCount: 1, operationIndex: 0 })])
			),
			{ kind: "empty", ok: true },
		];
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void>; issue(operation: Readonly<Record<string, unknown>>): Promise<void> }>;
		const accepted = await create(roomInput());
		await settleRoomDrain();
		expect(probe.issueInputs).toEqual([]);
		expect(probe.signerCalls).toBe(0);
		expect(probe.completedSources).toEqual([{ authorSequence: 4, digest: "f".repeat(64) }]);
		await accepted.close();

		probe.completedSources = [];
		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 1,
						operation: Object.freeze({ ...current, text: "changed" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				])
			),
		];
		const conflict = await create(roomInput());
		await settleRoomDrain();
		expect(probe.issueInputs).toEqual([]);
		expect(probe.signerCalls).toBe(0);
		expect(probe.completedSources).toEqual([]);
		await expect(conflict.issue(Object.freeze({ action: "message", clientOperationId: "later" }))).rejects.toThrow();
		await conflict.close();
	});

	it("keeps the source pending and terminally exposes target issue or publication failure", async () => {
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void>; issue(operation: Readonly<Record<string, unknown>>): Promise<void> }>;
		for (const kind of [
			"authorization-rejected",
			"issuance-rejected",
			"admission-rejected",
			"journal-rejected",
			"graph-rejected",
		] as const) {
			probe.rebasePages = [
				displaced(
					Object.freeze([
						Object.freeze({
							logicalTime: 1,
							operation: Object.freeze({ action: "message", clientOperationId: `failure-${kind}` }),
							operationCount: 1,
							operationIndex: 0,
						}),
					])
				),
			];
			probe.issueOutcomes = [Object.freeze({ detail: `controlled ${kind}`, kind, ok: false })];
			const session = await create(roomInput());
			await settleRoomDrain();
			expect(probe.completedSources).toEqual([]);
			await expect(session.issue(Object.freeze({ action: "message", clientOperationId: "later" }))).rejects.toThrow();
			await session.close();
		}
		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 1,
						operation: Object.freeze({ action: "message", clientOperationId: "publication-failure" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				])
			),
		];
		probe.publicationOutcomes = [
			Object.freeze({ kind: "empty", ok: true }),
			Object.freeze({ detail: "controlled publication", kind: "publish-failed", ok: false }),
		];
		const publicationSession = await create(roomInput());
		await settleRoomDrain();
		expect(probe.completedSources).toEqual([]);
		await expect(
			publicationSession.issue(Object.freeze({ action: "message", clientOperationId: "after-publication" }))
		).rejects.toThrow();
		await publicationSession.close();
	});

	it("keeps a failed source completion pending and retries it on reopen", async () => {
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void>; issue(operation: Readonly<Record<string, unknown>>): Promise<void> }>;
		probe.issueInputs = [];
		probe.signerCalls = 0;
		probe.completedSources = [];
		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 1,
						operation: Object.freeze({ action: "expire-me", clientOperationId: "completion-retry" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				])
			),
		];
		probe.completionOutcomes = [Object.freeze({ detail: "controlled completion", kind: "store-failed", ok: false })];
		const failedCompletion = await create(roomInput());
		await settleRoomDrain();
		expect(probe.issueInputs).toEqual([]);
		expect(probe.completedSources).toEqual([{ authorSequence: 4, digest: "f".repeat(64) }]);
		await expect(
			failedCompletion.issue(Object.freeze({ action: "message", clientOperationId: "after-completion-failure" }))
		).rejects.toThrow();
		await failedCompletion.close();

		probe.rebasePages = [
			displaced(
				Object.freeze([
					Object.freeze({
						logicalTime: 1,
						operation: Object.freeze({ action: "expire-me", clientOperationId: "completion-retry" }),
						operationCount: 1,
						operationIndex: 0,
					}),
				])
			),
			{ kind: "empty", ok: true },
		];
		probe.completionOutcomes = [Object.freeze({ kind: "published", ok: true })];
		const retriedCompletion = await create(roomInput());
		await settleRoomDrain();
		expect(probe.issueInputs).toEqual([]);
		expect(probe.completedSources).toEqual([
			{ authorSequence: 4, digest: "f".repeat(64) },
			{ authorSequence: 4, digest: "f".repeat(64) },
		]);
		await retriedCompletion.close();
	});

	it("fails unknown policy and unstable transform identity before target issuance", async () => {
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void>; issue(operation: Readonly<Record<string, unknown>>): Promise<void> }>;
		let unstableTransformCalls = 0;
		const mutations = [
			Object.freeze({
				application: application(),
				operation: Object.freeze({ action: "unknown", clientOperationId: "unknown-1" }),
			}),
			Object.freeze({
				application: Object.freeze({
					...application(),
					displacementPolicies: Object.freeze({
						...(Reflect.get(application(), "displacementPolicies") as Record<string, unknown>),
						"transform-me": "transform",
					}),
					transformDisplacedOperation: () =>
						Object.freeze({ action: "transform-me", clientOperationId: "changed-identity", value: 2 }),
				}),
				operation: Object.freeze({ action: "transform-me", clientOperationId: "source-identity", value: 1 }),
			}),
			Object.freeze({
				application: Object.freeze({
					...application(),
					transformDisplacedOperation: () =>
						Object.freeze({ action: "message", clientOperationId: "source-identity", text: "changed-action" }),
				}),
				operation: Object.freeze({ action: "transform-me", clientOperationId: "source-identity", value: 1 }),
			}),
			Object.freeze({
				application: Object.freeze({
					...application(),
					displacementPolicies: Object.freeze({
						...(Reflect.get(application(), "displacementPolicies") as Record<string, unknown>),
						"transform-me": "transform",
					}),
					transformDisplacedOperation: () => Object.freeze({ action: "transform-me", value: 2 }),
				}),
				operation: Object.freeze({ action: "transform-me", clientOperationId: "source-identity", value: 1 }),
			}),
			Object.freeze({
				application: Object.freeze({
					...application(),
					transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) => {
						unstableTransformCalls += 1;
						return Object.freeze({ ...operation, value: unstableTransformCalls % 2 });
					},
				}),
				operation: Object.freeze({ action: "transform-me", clientOperationId: "unstable-output", value: 1 }),
			}),
		] as const;
		for (const mutation of mutations) {
			probe.issueInputs = [];
			probe.signerCalls = 0;
			probe.rebasePages = [
				displaced(
					Object.freeze([
						Object.freeze({
							logicalTime: 1,
							operation: mutation.operation,
							operationCount: 1,
							operationIndex: 0,
						}),
					])
				),
			];
			const session = await create(roomInput(mutation.application));
			await settleRoomDrain();
			expect(probe.issueInputs).toEqual([]);
			expect(probe.completedSources).toEqual([]);
			await expect(
				session.issue(Object.freeze({ action: "message", clientOperationId: "after-invalid-policy" }))
			).rejects.toThrow();
			await session.close();
			probe.rebasePages = [];
		}
		expect(unstableTransformCalls).toBeGreaterThanOrEqual(2);
	});

	it("rejects partial, extra and accessor-backed policy evidence before consuming a source row", async () => {
		const accessorPolicies = Object.assign(Object.create(null) as Record<string, unknown>, {
			"expire-me": "expire",
			"rebase-me": "rebase",
			"review-me": "manual-review",
			"transform-me": "transform",
		});
		Object.defineProperty(accessorPolicies, "message", {
			enumerable: true,
			get: () => "rebase",
		});
		const invalidTables = [
			Object.freeze({}),
			Object.freeze({
				...(Reflect.get(application(), "displacementPolicies") as Record<string, unknown>),
				unknown: "expire",
			}),
			Object.freeze(accessorPolicies),
		] as const;
		const create = Reflect.get(await roomModule, "createV3RoomSession") as (
			input: unknown
		) => Promise<{ close(): Promise<void>; issue(operation: Readonly<Record<string, unknown>>): Promise<void> }>;
		for (const displacementPolicies of invalidTables) {
			probe.issueInputs = [];
			probe.signerCalls = 0;
			const readsBefore = probe.rebaseReads;
			probe.rebasePages = [
				displaced(
					Object.freeze([
						Object.freeze({
							logicalTime: 1,
							operation: Object.freeze({ action: "message", clientOperationId: "policy-source" }),
							operationCount: 1,
							operationIndex: 0,
						}),
					])
				),
			];
			const selectedApplication = Object.freeze({ ...application(), displacementPolicies });
			let failure: unknown;
			let rebaseIssueCount = 0;
			let session: Awaited<ReturnType<typeof create>> | undefined;
			try {
				session = await create(roomInput(selectedApplication));
				await settleRoomDrain();
				rebaseIssueCount = probe.issueInputs.length;
				try {
					await session.issue(Object.freeze({ action: "message", clientOperationId: "after-invalid-table" }));
				} catch (error) {
					failure = error;
				}
			} catch (error) {
				failure = error;
			}
			expect(rebaseIssueCount).toBe(0);
			expect(probe.completedSources).toEqual([]);
			expect(probe.rebaseReads).toBe(readsBefore);
			expect(failure).toBeInstanceOf(Error);
			await session?.close();
			probe.rebasePages = [];
		}
	});
});
