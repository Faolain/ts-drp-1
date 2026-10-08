import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";
import type { V3RoomAcceptedOperation, V3RoomAuthenticatedProjectionBase } from "../examples/v3-room/src/index.js";
import type { TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";

const chatProbe = vi.hoisted(() => ({ issues: [] as Readonly<Record<string, unknown>>[] }));

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createV3RoomSession: (input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> => {
		const application = Reflect.get(input, "application");
		if (typeof application !== "object" || application === null) throw new TypeError("missing chat application");
		return Promise.resolve(
			Object.freeze({
				close: () => Promise.resolve(),
				invite: "phase3g-controlled-invite",
				issue: (operation: Readonly<Record<string, unknown>>) => {
					chatProbe.issues.push(operation);
					return Promise.resolve();
				},
				openEphemeral: () => {
					throw new TypeError("controlled chat has no ephemeral channel");
				},
				previewLatchedAcl: () => Object.freeze({}),
				projection: () => Object.freeze({ accepted: [], transportPeerAuthors: [], writerAuthors: [] }),
				roomId: "phase3g-controlled-room",
				trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
			})
		);
	},
}));

beforeEach(() => {
	chatProbe.issues = [];
});

interface RebaseApplication {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
	readonly displacementPolicies: Readonly<Record<string, "expire" | "manual-review" | "rebase" | "transform">>;
	displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string;
	projectAcceptedOperations(input: {
		readonly authenticatedBase: undefined;
		readonly currentEpochOperations: readonly unknown[];
	}): Readonly<Record<string, unknown>>;
}

function operations(application: RebaseApplication): readonly Readonly<Record<string, unknown>>[] {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	const manifest = decoded !== null && typeof decoded === "object" ? Reflect.get(decoded, "manifest") : undefined;
	const values = manifest !== null && typeof manifest === "object" ? Reflect.get(manifest, "operations") : undefined;
	if (!Array.isArray(values)) throw new TypeError("Phase 3g product manifest is invalid");
	return values as readonly Readonly<Record<string, unknown>>[];
}

function accepted(
	operation: Readonly<Record<string, unknown>>,
	input: Readonly<{ readonly author: string; readonly sequence: number; readonly digestByte: number }>
): V3RoomAcceptedOperation {
	return Object.freeze({
		author: input.author,
		authorSequence: input.sequence,
		logicalTime: input.sequence * 2 + 1,
		operation,
		operationCount: 1,
		operationIndex: 0,
		vertexDigest: input.digestByte.toString(16).padStart(2, "0").repeat(32),
	});
}

describe("Phase 3g chat and zone stable rebase identity RED", () => {
	it("binds chat messages to author plus clientOperationId and preserves visible order", async () => {
		const module = await import("../examples/v3-chat/src/index.js");
		const application = Reflect.apply(
			Reflect.get(module, "createV3ChatApplication") as (...args: unknown[]) => unknown,
			undefined,
			["alice"]
		) as RebaseApplication;
		expect(application.displacementPolicies).toEqual({ message: "rebase" });
		const first = Object.freeze({ action: "message", clientOperationId: "message-1", text: "hello" });
		const second = Object.freeze({ action: "message", clientOperationId: "message-2", text: "world" });
		expect(application.displacedOperationIdentity(first)).toBe("message-1");
		const descriptor = operations(application).find((value) => Reflect.get(value, "name") === "message");
		expect(descriptor).toMatchObject({
			argumentSchema: {
				fields: [
					{ name: "clientOperationId", required: true, type: "string" },
					{ name: "text", required: true, type: "string" },
				],
				kind: "closed-record",
			},
		});
		const authorA = "a".repeat(64);
		const authorB = "b".repeat(64);
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(first, { author: authorA, digestByte: 1, sequence: 1 }),
				accepted(first, { author: authorA, digestByte: 2, sequence: 2 }),
				accepted(first, { author: authorB, digestByte: 3, sequence: 1 }),
				accepted(second, { author: authorA, digestByte: 4, sequence: 3 }),
			],
		});
		expect(Reflect.get(projection, "accepted")).toEqual([
			expect.objectContaining({ author: authorA, clientOperationId: "message-1", text: "hello" }),
			expect.objectContaining({ author: authorB, clientOperationId: "message-1", text: "hello" }),
			expect.objectContaining({ author: authorA, clientOperationId: "message-2", text: "world" }),
		]);
		expect(() =>
			application.projectAcceptedOperations({
				authenticatedBase: undefined,
				currentEpochOperations: [
					accepted(first, { author: authorA, digestByte: 5, sequence: 4 }),
					accepted(Object.freeze({ ...first, text: "changed" }), {
						author: authorA,
						digestByte: 6,
						sequence: 5,
					}),
				],
			})
		).toThrow();
	});

	it("mints a distinct client operation identity through each public chat send", async () => {
		await import("../examples/v3-chat/src/index.js");
		const api = Reflect.get(globalThis, "d9336V3Chat") as Readonly<{
			close(): Promise<void>;
			join(
				input: Readonly<{ channelName: string; clientId: "alice"; databaseName: string; invite: string }>
			): Promise<void>;
			send(text: string): Promise<void>;
		}>;
		await api.join({ channelName: "phase3g-chat", clientId: "alice", databaseName: "phase3g-chat", invite: "00" });
		await api.send("first public send");
		await api.send("second public send");
		expect(chatProbe.issues).toEqual([
			{
				action: "message",
				clientOperationId: expect.stringMatching(/\S+/u),
				text: "first public send",
			},
			{
				action: "message",
				clientOperationId: expect.stringMatching(/\S+/u),
				text: "second public send",
			},
		]);
		expect(Reflect.get(chatProbe.issues[0], "clientOperationId")).not.toBe(
			Reflect.get(chatProbe.issues[1], "clientOperationId")
		);
		await api.close();
	});

	it("reuses the genuine zone block id and projects one deterministic sorted board", async () => {
		const module = await import("../examples/grid/src/v3-zone.js");
		const author = "a".repeat(64);
		const application = Reflect.apply(
			Reflect.get(module, "createV3ZoneApplication") as (...args: unknown[]) => unknown,
			undefined,
			[Object.freeze([Object.freeze({ author, order: 0, peerId: "peer:creator" })]), "peer:creator", author]
		) as RebaseApplication;
		const first = Object.freeze({ action: "placeBlock", id: "block-b", kind: "stone", x: 1, y: 2 });
		const second = Object.freeze({ action: "placeBlock", id: "block-a", kind: "dirt", x: 3, y: 4 });
		expect(application.displacementPolicies).toEqual({ placeBlock: "rebase" });
		expect(application.displacedOperationIdentity(first)).toBe("block-b");
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(first, { author, digestByte: 0x11, sequence: 1 }),
				accepted(first, { author, digestByte: 0x12, sequence: 2 }),
				accepted(second, { author, digestByte: 0x13, sequence: 3 }),
			],
		});
		expect(Reflect.get(projection, "blocks")).toEqual([
			{ id: second.id, kind: second.kind, x: second.x, y: second.y },
			{ id: first.id, kind: first.kind, x: first.x, y: first.y },
		]);
		expect(Reflect.get(projection, "acceptedDigests")).toEqual(["11".repeat(32), "12".repeat(32), "13".repeat(32)]);
	});
});

describe("grid authenticated successor projection semantics RED", () => {
	const creator = "a".repeat(64);
	const writer = "b".repeat(64);
	const outsider = "c".repeat(64);
	const roster = [
		{ author: creator, peerId: "peer:creator", order: 0 },
		{ author: writer, peerId: "peer:writer", order: 1 },
	];
	const blocks = [
		{ id: "block-a", kind: "dirt", x: 3, y: 4 },
		{ id: "block-b", kind: "stone", x: 1, y: 2 },
	];
	const state = { version: 1, blocks, outcomes: [], roster };
	const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
	// Unit boundary: the shared room authenticates these bytes and metadata before
	// calling the application. This helper proves no checkpoint, QC or signature.
	const base = (bytes: Uint8Array, epoch = 1): V3RoomAuthenticatedProjectionBase => ({
		blueprintDigest: "d".repeat(64),
		epoch,
		exactCanonicalApplicationStateBytes: bytes,
		objectId: "creator:00000000000000000000000000000001",
		stateDigest: hex(hashDomain("ts-drp/state/v3", bytes)),
	});
	const application = async (members = roster): Promise<ReturnType<typeof createV3ZoneApplication>> => {
		const { createV3ZoneApplication } = await import("../examples/grid/src/v3-zone.js");
		return createV3ZoneApplication(members, "peer:creator", creator);
	};
	const authority = {
		transportPeerAuthors: roster.map(({ author, peerId }) => ({ author, peerId })),
		writerAuthors: [creator, writer],
	};

	it("uses installRoster bootstrap and never interprets reserved join as application authority", async () => {
		const app = await application();
		expect(app.bootstrapOperation.action).toBe("installRoster");
		for (const authenticatedBase of [undefined, base(encodeCanonical(state))]) {
			const before = app.projectAcceptedOperations({ authenticatedBase, currentEpochOperations: [] });
			const after = app.projectAcceptedOperations({
				authenticatedBase,
				currentEpochOperations: [
					accepted(
						{ action: "join", roster: { entries: [{ author: outsider, peerId: "peer:forged", order: 0 }] } },
						{ author: creator, sequence: 1, digestByte: 7 }
					),
				],
			});
			if (app.migration === undefined) throw new TypeError("grid migration capability missing");
			expect(app.migration.canonicalStateBytes(after)).toEqual(app.migration.canonicalStateBytes(before));
			expect(after.writerAuthors).toEqual(before.writerAuthors);
			expect(after.transportPeerAuthors).toEqual(before.transportPeerAuthors);
		}
	});

	it("serializes creator-accepted roster authority and recovers it with no current operations", async () => {
		const app = await application();
		const projection = app.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(
					{ action: "installRoster", roster: { entries: [...roster].reverse() } },
					{ author: creator, sequence: 0, digestByte: 1 }
				),
				...blocks.map((block, index) =>
					accepted({ action: "placeBlock", ...block }, { author: writer, sequence: index + 1, digestByte: index + 2 })
				),
			],
		});
		expect(projection).toMatchObject({ ...authority, blocks });
		if (app.migration === undefined) throw new TypeError("grid migration capability missing");
		const bytes = app.migration.canonicalStateBytes(projection);
		expect(decodeCanonical(bytes)).toEqual(state);
		const restored = app.projectAcceptedOperations({ authenticatedBase: base(bytes), currentEpochOperations: [] });
		expect(restored).toMatchObject({ ...authority, blocks });
		expect(app.migration.canonicalStateBytes(restored)).toEqual(bytes);
	});

	it("roundtrips all 64 writers through authenticated successor state and a current writer operation", async () => {
		const members = Array.from({ length: 64 }, (_, order) => ({
			author: order === 0 ? creator : order.toString(16).padStart(64, "0"),
			peerId: order === 0 ? "peer:creator" : `peer:writer-${order}`,
			order,
		}));
		const board = members.map((_, index) => ({
			id: `writer-block-${index.toString().padStart(2, "0")}`,
			kind: "stone",
			x: index,
			y: -(index + 1),
		}));
		const app = await application(members);
		const projection = app.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(
					{ action: "installRoster", roster: { entries: members } },
					{ author: creator, sequence: 0, digestByte: 1 }
				),
				...members.map((member, index) =>
					accepted(
						{ action: "placeBlock", ...board[index] },
						{ author: member.author, sequence: 1, digestByte: index + 2 }
					)
				),
			],
		});
		const expectedAuthority = {
			writerAuthors: members.map(({ author }) => author),
			transportPeerAuthors: members.map(({ author, peerId }) => ({ author, peerId })),
		};
		expect(projection).toMatchObject({ ...expectedAuthority, blocks: board });
		if (app.migration === undefined) throw new TypeError("grid migration capability missing");
		const bytes = app.migration.canonicalStateBytes(projection);
		expect(decodeCanonical(bytes)).toEqual({ version: 1, blocks: board, outcomes: [], roster: members });
		const lastMember = members[63];
		const lastBlock = board[63];
		if (lastMember === undefined || lastBlock === undefined) throw new TypeError("64-writer fixture is incomplete");
		const updated = { ...lastBlock, x: 164, y: -164 };
		const restored = app.projectAcceptedOperations({
			authenticatedBase: base(bytes),
			currentEpochOperations: [
				accepted({ action: "placeBlock", ...updated }, { author: lastMember.author, sequence: 2, digestByte: 66 }),
			],
		});
		expect(restored).toMatchObject({ ...expectedAuthority, blocks: [...board.slice(0, 63), updated] });
		expect(restored.blocks.map(({ id }) => id)).toEqual(board.map(({ id }) => id));
		expect(restored.writerAuthors).toHaveLength(64);
		expect(restored.transportPeerAuthors).toHaveLength(64);
	});

	it("updates a stable block over authenticated state and preserves authority over repeated empty successor reopens", async () => {
		const app = await application();
		if (app.migration === undefined) throw new TypeError("grid migration capability missing");
		const updated = { ...blocks[1], id: "block-b", kind: "stone", x: 99, y: -7 };
		let projection = app.projectAcceptedOperations({
			authenticatedBase: base(encodeCanonical(state)),
			currentEpochOperations: [
				accepted({ action: "placeBlock", ...updated }, { author: writer, sequence: 4, digestByte: 4 }),
			],
		});
		const expectedState = { ...state, blocks: [blocks[0], updated] };
		expect(projection).toMatchObject({ ...authority, blocks: expectedState.blocks });
		for (let epoch = 2; epoch <= 4; epoch += 1) {
			const bytes = app.migration.canonicalStateBytes(projection);
			expect(decodeCanonical(bytes)).toEqual(expectedState);
			projection = app.projectAcceptedOperations({ authenticatedBase: base(bytes, epoch), currentEpochOperations: [] });
			expect(projection).toMatchObject({ ...authority, blocks: expectedState.blocks });
			expect(app.migration.canonicalStateBytes(projection)).toEqual(bytes);
		}
	});

	it("does not seed or overwrite projection authority from constructor bootstrap members", async () => {
		const app = await application([{ author: outsider, peerId: "peer:injected", order: 0 }]);
		expect(app.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })).toMatchObject({
			transportPeerAuthors: [],
			writerAuthors: [],
			blocks: [],
		});
		expect(
			app.projectAcceptedOperations({ authenticatedBase: base(encodeCanonical(state)), currentEpochOperations: [] })
		).toMatchObject({ ...authority, blocks });
	});

	it.each([
		["wrong creator author", [{ ...roster[0], author: outsider }, roster[1]]],
		["wrong creator peer", [{ ...roster[0], peerId: "peer:wrong" }, roster[1]]],
		["missing creator", [roster[1]]],
		["duplicate entry", [...roster, roster[1]]],
		["conflicting peer author", [...roster, { author: outsider, peerId: "peer:writer", order: 2 }]],
		["conflicting order", [...roster, { author: outsider, peerId: "peer:other", order: 1 }]],
		["duplicate author", [...roster, { author: writer, peerId: "peer:other", order: 2 }]],
		["negative order", [roster[0], { ...roster[1], order: -1 }]],
		["extra member key", [roster[0], { ...roster[1], extra: true }]],
	] as const)("rejects authenticated roster %s", async (_label, invalidRoster) => {
		const app = await application();
		expect(() =>
			app.projectAcceptedOperations({
				authenticatedBase: base(encodeCanonical({ ...state, roster: invalidRoster })),
				currentEpochOperations: [],
			})
		).toThrow(/^v3 zone authenticated roster is invalid$/u);
	});

	it.each([
		["old array state", blocks],
		["wrong version", { ...state, version: 2 }],
		["extra state key", { ...state, extra: true }],
		["missing roster", { version: 1, blocks, outcomes: [] }],
		["non-array roster", { ...state, roster: {} }],
		["duplicate block identity", { ...state, blocks: [blocks[0], blocks[0]] }],
		["malformed coordinate", { ...state, blocks: [{ ...blocks[0], x: "3" }] }],
		["malformed outcome", { ...state, outcomes: [{}] }],
	] as const)("rejects malformed authenticated %s", async (_label, invalidState) => {
		const app = await application();
		expect(() =>
			app.projectAcceptedOperations({
				authenticatedBase: base(encodeCanonical(invalidState)),
				currentEpochOperations: [],
			})
		).toThrow(/^v3 zone authenticated (projection state|roster) is invalid$/u);
	});

	for (const withBase of [false, true]) {
		it.each([
			["extra key", { entries: roster, extra: "unregistered-authority" }],
			["nonobject", "not-a-roster"],
			["array", roster],
		] as const)(
			`rejects creator join roster envelope %s with authenticated base ${withBase}`,
			async (_label, envelope) => {
				const app = await application();
				expect(() =>
					app.projectAcceptedOperations({
						authenticatedBase: withBase ? base(encodeCanonical(state)) : undefined,
						currentEpochOperations: [
							accepted({ action: "installRoster", roster: envelope }, { author: creator, sequence: 6, digestByte: 6 }),
						],
					})
				).toThrow(/^v3 zone roster conflicts$/u);
			}
		);
	}

	it.each([
		["creator mismatch", [{ ...roster[0], author: outsider }, roster[1]]],
		["peer rebind", [roster[0], { ...roster[1], author: outsider }]],
		["order rebind", [roster[0], { ...roster[1], order: 0 }]],
		["duplicate member", [...roster, roster[1]]],
	] as const)("rejects current creator join %s against authenticated roster", async (_label, entries) => {
		const app = await application();
		expect(() =>
			app.projectAcceptedOperations({
				authenticatedBase: base(encodeCanonical(state)),
				currentEpochOperations: [
					accepted({ action: "installRoster", roster: { entries } }, { author: creator, sequence: 6, digestByte: 6 }),
				],
			})
		).toThrow(/^v3 zone roster conflicts$/u);
	});
});
