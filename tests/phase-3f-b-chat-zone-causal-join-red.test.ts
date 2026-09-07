import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { describe, expect, it, vi } from "vitest";

import { runFrontierScenario } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import type { V3ZoneApi } from "../examples/grid/src/v3-zone.js";
import type { V3RoomHeadAuthority } from "../examples/v3-room/src/index.js";
import type { TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
}));

const roomEntryProbe = vi.hoisted(() => ({
	applications: [] as unknown[],
	inputs: [] as Array<Readonly<{ objectId: string; creatorInvite?: unknown; roomHeadAuthority?: unknown }>>,
	failure: undefined as Error | undefined,
	sessions: [] as Array<{
		readonly channel: unknown;
		committedProjection: boolean;
		emitProjection(value: unknown): void;
		readonly openCommittedProjection: boolean[];
		readonly openOptions: unknown[];
	}>,
}));

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => {
	const current = await importOriginal<Record<string, unknown>>();
	return {
		...current,
		createV3RoomSession: vi.fn(
			(
				input: Readonly<{
					readonly application: unknown;
					readonly objectId: string;
					onProjection(value: unknown): void;
				}>
			) => {
				roomEntryProbe.inputs.push(input);
				if (roomEntryProbe.failure !== undefined) return Promise.reject(roomEntryProbe.failure);
				roomEntryProbe.applications.push(input.application);
				const channel = Object.freeze({
					close: () => undefined,
					publish: () => Promise.resolve(true),
					stats: () =>
						Object.freeze({
							authorityMismatch: 0,
							delivered: 0,
							dropped: 0,
							localSequencedKeys: 0,
							malformed: 0,
							overLimit: 0,
							published: 0,
							rateLimited: 0,
							received: 0,
							remoteSequencedKeys: 0,
							sequencedKeys: 0,
							sequencedSenders: 0,
							stale: 0,
							subscriberFailures: 0,
							unauthorized: 0,
							writerBuckets: 0,
						}),
					subscribe: (): (() => void) => () => undefined,
				});
				const session = {
					channel,
					committedProjection: false,
					emitProjection(value: unknown): void {
						input.onProjection(value);
						this.committedProjection = true;
					},
					openCommittedProjection: [] as boolean[],
					openOptions: [] as unknown[],
				};
				roomEntryProbe.sessions.push(session);
				return Promise.resolve(
					Object.freeze({
						invite: "00",
						objectId: input.objectId,
						roomId: input.objectId,
						trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
						close: () => Promise.resolve(),
						issue: () => Promise.resolve(),
						openEphemeral: (options: unknown) => {
							session.openOptions.push(options);
							session.openCommittedProjection.push(session.committedProjection);
							return channel;
						},
						previewLatchedAcl: () => Object.freeze({ current: Object.freeze({ epoch: 0 }) }),
						projection: () => Object.freeze({}),
					})
				);
			}
		),
	};
});

interface ProductApplication {
	readonly batchableOperationActions: readonly string[];
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
	projectAcceptedOperations(input: {
		readonly authenticatedBase: undefined;
		readonly currentEpochOperations: readonly unknown[];
	}): Readonly<Record<string, unknown>>;
}

describe("grid per-open room-head authority wiring", () => {
	it("passes a frozen open context and the exact provider, then reacquires reopen authority after close", async () => {
		const created = entryAuthority();
		const reopened = entryAuthority("reopen");
		const factory = vi.fn().mockReturnValueOnce(created).mockResolvedValueOnce(reopened);
		const api = await authorityZone(factory);
		const before = roomEntryProbe.inputs.length;
		try {
			await api.create(authorityEnrollment());
			const input = roomEntryProbe.inputs[before];
			if (input === undefined) throw new Error("grid room open absent");
			expect(factory).toHaveBeenCalledTimes(1);
			expect(factory.mock.calls[0]).toEqual([
				{
					author: "c".repeat(64),
					creatorInvite: input.creatorInvite,
					objectId: input.objectId,
					operation: "create",
				},
			]);
			expect(Object.isFrozen(factory.mock.calls[0]?.[0])).toBe(true);
			expect(input.roomHeadAuthority).toBe(created);
			expect(api.snapshot().ready).toBe(true);
			await api.close();
			const invite = authorityJoinInvite(input);
			await api.join(invite);
			const next = roomEntryProbe.inputs[before + 1];
			if (next === undefined) throw new Error("grid room reopen absent");
			expect(factory).toHaveBeenCalledTimes(2);
			expect(factory.mock.calls[1]).toEqual([
				{
					author: "c".repeat(64),
					creatorInvite: next.creatorInvite,
					objectId: input.objectId,
					operation: "join",
				},
			]);
			expect(Object.isFrozen(factory.mock.calls[1]?.[0])).toBe(true);
			expect(next.roomHeadAuthority).toBe(reopened);
			expect(reopened.initialization).toEqual({ kind: "reopen" });
		} finally {
			await api.close();
		}
	});

	it("refuses absent or noncallable factories before opening the shared room", async () => {
		for (const factory of [undefined, null, {}]) {
			const before = roomEntryProbe.inputs.length;
			const selected: { api?: V3ZoneApi } = {};
			try {
				await expect(
					(async (): Promise<void> => {
						selected.api = await authorityZone(factory);
						await selected.api.create(authorityEnrollment());
					})()
				).rejects.toBeInstanceOf(TypeError);
				expect(roomEntryProbe.inputs).toHaveLength(before);
				if (selected.api !== undefined) expect(selected.api.snapshot().ready).toBe(false);
			} finally {
				await selected.api?.close();
			}
		}
	});

	it("rejects malformed providers, including every missing method and initialization kind", async () => {
		const valid = entryAuthority();
		const invalid = [
			undefined,
			null,
			{},
			{ ...valid, initialization: undefined },
			{ ...valid, initialization: { kind: "unknown" } },
			...["begin", "commit", "create", "migrate", "read"].map((method) => ({ ...valid, [method]: undefined })),
		];
		for (const provider of invalid) {
			const factory = vi.fn(() => provider);
			const api = await authorityZone(factory);
			const before = roomEntryProbe.inputs.length;
			try {
				await expect(api.create(authorityEnrollment())).rejects.toBeInstanceOf(TypeError);
				expect(factory).toHaveBeenCalledTimes(1);
				expect(roomEntryProbe.inputs).toHaveLength(before);
				expect(api.snapshot()).toMatchObject({ ready: false, zoneId: "", invite: "" });
			} finally {
				await api.close();
			}
		}
	});

	it("propagates factory failure without fallback and permits a fresh successful attempt", async () => {
		const failure = new Error("authority service unavailable");
		const provider = entryAuthority();
		const factory = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(provider);
		const api = await authorityZone(factory);
		const before = roomEntryProbe.inputs.length;
		try {
			await expect(api.create(authorityEnrollment())).rejects.toBe(failure);
			expect(roomEntryProbe.inputs).toHaveLength(before);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(api.snapshot()).toMatchObject({ ready: false, zoneId: "", invite: "" });
			await api.create(authorityEnrollment());
			expect(factory).toHaveBeenCalledTimes(2);
			expect(roomEntryProbe.inputs[before]?.roomHeadAuthority).toBe(provider);
		} finally {
			await api.close();
		}
	});

	it("propagates shared-room authority refusal without substituting initialization", async () => {
		const failure = new Error("D110C_FLOOR_MIGRATION_REQUIRED");
		const provider = entryAuthority("reopen");
		const factory = vi.fn(() => provider);
		const api = await authorityZone(factory);
		const before = roomEntryProbe.inputs.length;
		roomEntryProbe.failure = failure;
		try {
			await expect(api.create(authorityEnrollment())).rejects.toBe(failure);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(roomEntryProbe.inputs).toHaveLength(before + 1);
			expect(roomEntryProbe.inputs[before]?.roomHeadAuthority).toBe(provider);
			expect(provider.initialization).toEqual({ kind: "reopen" });
			expect(api.snapshot()).toMatchObject({ ready: false, zoneId: "", invite: "" });
		} finally {
			roomEntryProbe.failure = undefined;
			await api.close();
		}
	});

	it("does not acquire authority for an invalid invite identity", async () => {
		const factory = vi.fn(() => entryAuthority("reopen"));
		const api = await authorityZone(factory);
		const before = roomEntryProbe.inputs.length;
		try {
			await expect(api.join("00")).rejects.toBeInstanceOf(TypeError);
			expect(factory).not.toHaveBeenCalled();
			expect(roomEntryProbe.inputs).toHaveLength(before);
			expect(api.snapshot().ready).toBe(false);
		} finally {
			await api.close();
		}
	});
});

function operations(application: ProductApplication): readonly unknown[] {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	if (decoded === null || typeof decoded !== "object") throw new TypeError("invalid product package");
	const manifest = Reflect.get(decoded, "manifest");
	const result = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "operations") : undefined;
	if (!Array.isArray(result)) throw new TypeError("invalid product operations");
	return result;
}

function expectExactOperations(application: ProductApplication, names: readonly string[]): void {
	const descriptors = operations(application);
	expect(descriptors.map((operation) => String(Reflect.get(operation, "name")))).toEqual(names);
	expect(descriptors.find((operation) => Reflect.get(operation, "name") === "causalJoin")).toEqual({
		argumentSchema: { fields: [], kind: "closed-record" },
		maxCanonicalOperationBytes: 65_536,
		name: "causalJoin",
	});
}

function expectSameApplication(
	actual: ProductApplication,
	expected: ProductApplication,
	vertices: readonly Readonly<Record<string, unknown>>[]
): void {
	expect(actual.bootstrapOperation).toEqual(expected.bootstrapOperation);
	expect(actual.canonicalBlueprintPackageBytes).toEqual(expected.canonicalBlueprintPackageBytes);
	expect(actual.catalog.blueprintDigests).toEqual(expected.catalog.blueprintDigests);
	expect(actual.catalog.catalogDigest).toBe(expected.catalog.catalogDigest);
	for (const digest of expected.catalog.blueprintDigests) {
		expect(actual.catalog.resolve(digest)).toEqual(expected.catalog.resolve(digest));
	}
	const input = { authenticatedBase: undefined, currentEpochOperations: vertices } as const;
	expect(actual.projectAcceptedOperations(input)).toEqual(expected.projectAcceptedOperations(input));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Shape-only capability for the existing mocked room; no freshness claim is made here.
function entryAuthority(kind: "create" | "reopen" = "create"): V3RoomHeadAuthority {
	const unavailable = (): ReturnType<V3RoomHeadAuthority["read"]> =>
		Promise.resolve({ ok: false, reason: "unavailable" } as const);
	return Object.freeze({
		initialization: Object.freeze({ kind }),
		begin: unavailable,
		commit: unavailable,
		create: unavailable,
		migrate: unavailable,
		read: unavailable,
	});
}

async function authorityZone(factory: unknown): Promise<V3ZoneApi> {
	const zone = await import("../examples/grid/src/v3-zone.js");
	return Reflect.apply(zone.createV3ZoneApi, undefined, [
		Object.freeze({
			ephemeralUnreliableWebRtcSnapshot: () => undefined,
			keychain: Object.freeze({
				localAuthorId: "c".repeat(64),
				signWithLocalAuthor: () => Promise.resolve(new Uint8Array(64).fill(0x41)),
			}),
			networkNode: Object.freeze({ peerId: "zone-creator-peer" }),
			openRoomNetwork: () => {
				throw new Error("mocked room must not open a transport");
			},
		}),
		(): void => undefined,
		factory,
	]);
}

function authorityEnrollment(): string {
	return hex(
		encodeCanonical({
			author: "d".repeat(64),
			kind: "ts-drp-v3-zone-enrollment",
			peerId: "peer:zone-member",
			version: 1,
		})
	);
}

function authorityJoinInvite(input: Readonly<{ objectId: string; creatorInvite?: unknown }>): string {
	const material = input.creatorInvite;
	if (material === null || typeof material !== "object") throw new TypeError("creator material absent");
	const roomInvite = hex(
		encodeCanonical({
			...material,
			kind: "ts-drp-example-v3-room-creator-invite",
			version: 1,
		})
	);
	return hex(encodeCanonical({ kind: "ts-drp-v3-zone-invite", roomInvite, version: 1, zoneId: input.objectId }));
}

async function expectNeutralReducer(
	application: ProductApplication,
	state: unknown = Object.freeze({ durable: "unchanged" })
): Promise<void> {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	if (decoded === null || typeof decoded !== "object") throw new TypeError("invalid product package");
	const blueprintDigest = application.catalog.resolve(
		String(application.catalog.blueprintDigests[0] ?? "")
	).blueprintDigest;
	const resolved = application.catalog.resolve(blueprintDigest);
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: application.canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	const runtime = await prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes: application.canonicalBlueprintPackageBytes,
		exactArtifactBytes: resolved.exactArtifactBytes,
		expectedBlueprintDigest: blueprintDigest,
		preparedBlueprintAdmission: admission,
	});
	const reducer = runtime.reducers.causalJoin;
	if (reducer === undefined) throw new TypeError("missing causalJoin reducer");
	expect(reducer({ operation: Object.freeze({ action: "causalJoin" }), state })).toEqual({ output: null, state });
}

function accepted(
	operation: Readonly<Record<string, unknown>>,
	fill: number,
	author = "a".repeat(64)
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		author,
		authorSequence: fill,
		logicalTime: fill,
		operation,
		operationCount: 1,
		operationIndex: 0,
		vertexDigest: fill.toString(16).padStart(2, "0").repeat(32),
	});
}

describe("Phase 3f-b real chat and zone causalJoin composition RED", () => {
	it("uses the genuine chat package and keeps causal joins out of the visible transcript", async () => {
		const chat = (await import("../examples/v3-chat/src/index.js")) as unknown as Record<string, unknown>;
		const create = Reflect.get(chat, "createV3ChatApplication");
		expect(create).toBeTypeOf("function");
		const application = Reflect.apply(create as (...args: unknown[]) => unknown, undefined, [
			"alice",
		]) as ProductApplication;
		expect(application.batchableOperationActions).toEqual(["message"]);
		expectExactOperations(application, [
			"acl",
			"applicationBatch",
			"causalJoin",
			"join",
			"message",
			"migrationActivation",
			"migrationRecord",
		]);
		await expectNeutralReducer(application);
		const beforeEntry = roomEntryProbe.applications.length;
		const chatApi = Reflect.get(globalThis, "d9336V3Chat") as Readonly<{
			close(): Promise<void>;
			join(input: Readonly<Record<string, unknown>>): Promise<void>;
		}>;
		await chatApi.join({ channelName: "phase-3f-b", clientId: "alice", databaseName: "phase-3f-b", invite: "00" });
		const entryApplication = roomEntryProbe.applications[beforeEntry] as ProductApplication | undefined;
		expect(entryApplication).toBeDefined();
		if (entryApplication !== undefined) {
			expectSameApplication(entryApplication, application, [
				accepted(Object.freeze({ action: "join", clientId: "alice" }), 0x31),
				accepted(Object.freeze({ action: "acl", group: "writer", kind: "grant", target: "e".repeat(64) }), 0x32),
				accepted(Object.freeze({ action: "causalJoin" }), 0x33),
				accepted(
					Object.freeze({ action: "message", clientOperationId: "message-entry-visible", text: "entry-visible" }),
					0x34
				),
			]);
		}
		await chatApi.close();
		const frontier = await runFrontierScenario(17, {
			application,
			operation: Object.freeze({ action: "message", clientOperationId: "message-visible", text: "visible" }),
			seedOperation: Object.freeze({ action: "message", clientOperationId: "message-seed", text: "seed" }),
		});
		expect(frontier.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(frontier.issued.map(({ operation }) => operation)).toEqual([
			{ action: "causalJoin" },
			{ action: "message", clientOperationId: "message-visible", text: "visible" },
		]);
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(
					Object.freeze({ action: "message", clientOperationId: "message-durable", text: "already durable" }),
					1
				),
				...frontier.issued.map(({ operation }, index) => accepted(operation, index + 2)),
			],
		});
		expect(Reflect.get(projection, "accepted")).toMatchObject([{ text: "already durable" }, { text: "visible" }]);
	});

	it("uses the genuine zone package while retaining durable join telemetry", async () => {
		const zone = (await import("../examples/grid/src/v3-zone.js")) as unknown as Record<string, unknown>;
		const create = Reflect.get(zone, "createV3ZoneApplication");
		expect(create).toBeTypeOf("function");
		const creatorAuthor = "b".repeat(64);
		const application = Reflect.apply(create as (...args: unknown[]) => unknown, undefined, [
			Object.freeze([Object.freeze({ author: creatorAuthor, order: 0, peerId: "peer:creator" })]),
			"peer:creator",
			creatorAuthor,
		]) as ProductApplication;
		expect(application.batchableOperationActions).toEqual(["placeBlock"]);
		expectExactOperations(application, [
			"applicationBatch",
			"causalJoin",
			"commit-outcome-v1",
			"installRoster",
			"migrationActivation",
			"migrationRecord",
			"placeBlock",
		]);
		await expectNeutralReducer(
			application,
			Object.freeze({
				version: 1,
				blocks: [{ id: "retained", kind: "stone", x: 3, y: 4 }],
				outcomes: [],
				roster: [{ author: creatorAuthor, order: 0, peerId: "peer:creator" }],
			})
		);
		const beforeEntry = roomEntryProbe.applications.length;
		const localAuthor = "c".repeat(64);
		const localPeerId = "zone-creator-peer";
		const zoneApi = Reflect.apply(Reflect.get(zone, "createV3ZoneApi") as (...args: unknown[]) => unknown, undefined, [
			Object.freeze({
				ephemeralUnreliableWebRtcSnapshot: () => undefined,
				keychain: Object.freeze({
					localAuthorId: localAuthor,
					signWithLocalAuthor: () => Promise.resolve(new Uint8Array(64).fill(0x41)),
				}),
				networkNode: Object.freeze({ peerId: localPeerId }),
				openRoomNetwork: () => {
					throw new Error("mocked room must not open a transport");
				},
			}),
			(): void => undefined,
			(): V3RoomHeadAuthority => entryAuthority(),
		]) as Readonly<{ close(): Promise<void>; create(enrollment: string): Promise<void> }>;
		await zoneApi.create(
			hex(
				encodeCanonical({
					author: "d".repeat(64),
					kind: "ts-drp-v3-zone-enrollment",
					peerId: "peer:zone-member",
					version: 1,
				})
			)
		);
		const entryApplication = roomEntryProbe.applications[beforeEntry] as ProductApplication | undefined;
		const entrySession = roomEntryProbe.sessions[beforeEntry];
		expect(entryApplication).toBeDefined();
		expect(entrySession).toBeDefined();
		if (entryApplication !== undefined) {
			const entryMembers = Object.freeze([
				Object.freeze({ author: localAuthor, order: 0, peerId: localPeerId }),
				Object.freeze({ author: "d".repeat(64), order: 1, peerId: "peer:zone-member" }),
			]);
			const expectedEntryApplication = Reflect.apply(create as (...args: unknown[]) => unknown, undefined, [
				entryMembers,
				localPeerId,
				localAuthor,
			]) as ProductApplication;
			expectSameApplication(entryApplication, expectedEntryApplication, [
				accepted(
					Object.freeze({ action: "installRoster", roster: Object.freeze({ entries: entryMembers }) }),
					0x31,
					localAuthor
				),
				accepted(Object.freeze({ action: "causalJoin" }), 0x32, localAuthor),
				accepted(
					Object.freeze({ action: "placeBlock", id: "entry-block", kind: "stone", x: 3, y: 4 }),
					0x33,
					localAuthor
				),
			]);
			if (entrySession !== undefined) {
				const projection = entryApplication.projectAcceptedOperations({
					authenticatedBase: undefined,
					currentEpochOperations: [
						accepted(
							Object.freeze({ action: "installRoster", roster: Object.freeze({ entries: entryMembers }) }),
							0x41,
							localAuthor
						),
					],
				});
				const openCount = entrySession.openOptions.length;
				entrySession.emitProjection(projection);
				expect(entrySession.openOptions).toHaveLength(openCount);
				await Promise.resolve();
				expect(entrySession.openOptions).toHaveLength(openCount + 1);
				expect(entrySession.openOptions.at(-1)).toEqual({
					maxMessageBytes: 65_536,
					maxSequencedKeys: 9,
					maxSequencedSenders: 2,
				});
				expect(entrySession.openCommittedProjection.at(-1)).toBe(true);
			}
		}
		await zoneApi.close();
		const frontier = await runFrontierScenario(17, {
			application,
			operation: Object.freeze({ action: "placeBlock", id: "block", kind: "stone", x: 1, y: 2 }),
			seedOperation: Object.freeze({ action: "placeBlock", id: "seed", kind: "stone", x: 0, y: 0 }),
		});
		expect(frontier.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(frontier.issued.map(({ operation }) => operation)).toEqual([
			{ action: "causalJoin" },
			{ action: "placeBlock", id: "block", kind: "stone", x: 1, y: 2 },
		]);
		const zoneVertices = [
			accepted(
				Object.freeze({
					action: "installRoster",
					roster: Object.freeze({
						entries: Object.freeze([Object.freeze({ author: creatorAuthor, order: 0, peerId: "peer:creator" })]),
					}),
				}),
				1,
				creatorAuthor
			),
			accepted(Object.freeze({ action: "placeBlock", id: "seed", kind: "stone", x: 0, y: 0 }), 2),
			...frontier.issued.map(({ operation }, index) => accepted(operation, index + 3)),
		];
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: zoneVertices,
		});
		expect(Reflect.get(projection, "blocks")).toEqual([
			{ id: "block", kind: "stone", x: 1, y: 2 },
			{ id: "seed", kind: "stone", x: 0, y: 0 },
		]);
		expect(Reflect.get(projection, "transportPeerAuthors")).toEqual([
			{ author: creatorAuthor, peerId: "peer:creator" },
		]);
		expect(Reflect.get(projection, "writerAuthors")).toEqual([creatorAuthor]);
		expect(Reflect.get(projection, "acceptedDigests")).toEqual(
			zoneVertices.map((vertex) => Reflect.get(vertex, "vertexDigest"))
		);
	});
});
