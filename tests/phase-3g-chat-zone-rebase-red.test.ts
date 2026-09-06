import { decodeCanonical } from "@ts-drp/canonical";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
): Readonly<Record<string, unknown>> {
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
