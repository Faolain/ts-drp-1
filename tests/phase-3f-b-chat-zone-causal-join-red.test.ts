import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { describe, expect, it, vi } from "vitest";

import { runFrontierScenario } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import type { TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
}));

const roomEntryProbe = vi.hoisted(() => ({ applications: [] as unknown[] }));

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => {
	const current = await importOriginal<Record<string, unknown>>();
	return {
		...current,
		createV3RoomSession: vi.fn((input: Readonly<{ readonly application: unknown; readonly objectId: string }>) => {
			roomEntryProbe.applications.push(input.application);
			return Promise.resolve(
				Object.freeze({
					invite: "00",
					roomId: input.objectId,
					trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
					close: () => Promise.resolve(),
					issue: () => Promise.resolve(),
					openEphemeral: () =>
						Object.freeze({
							close: () => undefined,
							publish: () => Promise.resolve(true),
							subscribe: (): (() => void) => () => undefined,
						}),
					previewLatchedAcl: () => Object.freeze({}),
					projection: () => Object.freeze({}),
				})
			);
		}),
	};
});

interface ProductApplication {
	readonly batchableOperationActions: readonly string[];
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
	projectAcceptedOperations(operations: readonly unknown[]): Readonly<Record<string, unknown>>;
}

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
	expect(actual.projectAcceptedOperations(vertices)).toEqual(expected.projectAcceptedOperations(vertices));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectNeutralReducer(application: ProductApplication): Promise<void> {
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
	const state = Object.freeze({ durable: "unchanged" });
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
		expectExactOperations(application, ["acl", "applicationBatch", "causalJoin", "join", "message"]);
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
		const projection = application.projectAcceptedOperations([
			accepted(Object.freeze({ action: "message", clientOperationId: "message-durable", text: "already durable" }), 1),
			...frontier.issued.map(({ operation }, index) => accepted(operation, index + 2)),
		]);
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
		expectExactOperations(application, ["applicationBatch", "causalJoin", "join", "placeBlock"]);
		await expectNeutralReducer(application);
		const beforeEntry = roomEntryProbe.applications.length;
		const localAuthor = "c".repeat(64);
		const localPeerId = "zone-creator-peer";
		const zoneApi = Reflect.apply(Reflect.get(zone, "createV3ZoneApi") as (...args: unknown[]) => unknown, undefined, [
			Object.freeze({
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
		expect(entryApplication).toBeDefined();
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
					Object.freeze({ action: "join", roster: Object.freeze({ entries: entryMembers }) }),
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
					action: "join",
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
		const projection = application.projectAcceptedOperations(zoneVertices);
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
