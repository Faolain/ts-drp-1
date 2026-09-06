import { decodeCanonical } from "@ts-drp/canonical";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { describe, expect, it, vi } from "vitest";

import { acceptedOperation, maximalEntries } from "./fixtures/phase-3f-c/application-batching-fixture.js";
import type { TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
}));

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createV3RoomSession: vi.fn(() =>
		Promise.resolve(
			Object.freeze({
				close: () => Promise.resolve(),
				invite: "00",
				issue: () => Promise.resolve(),
				openEphemeral: () => Object.freeze({ close: () => undefined }),
				previewLatchedAcl: () => Object.freeze({}),
				projection: () => Object.freeze({}),
				roomId: "phase-3f-c",
				trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
			})
		)
	),
}));

interface BatchApplication {
	readonly batchableOperationActions: readonly string[];
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
	projectAcceptedOperations(input: {
		readonly authenticatedBase: undefined;
		readonly currentEpochOperations: readonly unknown[];
	}): Readonly<Record<string, unknown>>;
}

function manifest(application: BatchApplication): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	if (decoded === null || typeof decoded !== "object") throw new TypeError("invalid product package");
	const value = Reflect.get(decoded, "manifest");
	if (value === null || typeof value !== "object") throw new TypeError("invalid product manifest");
	return value as Readonly<Record<string, unknown>>;
}

function operationNames(application: BatchApplication): readonly string[] {
	const operations = Reflect.get(manifest(application), "operations");
	if (!Array.isArray(operations)) throw new TypeError("invalid product operations");
	return operations.map((operation) => String(Reflect.get(operation, "name")));
}

function operationDescriptor(application: BatchApplication, name: string): Readonly<Record<string, unknown>> {
	const operations = Reflect.get(manifest(application), "operations");
	if (!Array.isArray(operations)) throw new TypeError("invalid product operations");
	const descriptor = operations.find((operation) => Reflect.get(operation, "name") === name);
	if (descriptor === null || typeof descriptor !== "object") throw new TypeError(`missing ${name} descriptor`);
	return descriptor as Readonly<Record<string, unknown>>;
}

async function reduceOperation(
	application: BatchApplication,
	state: unknown,
	operation: Readonly<Record<string, unknown>>
): Promise<Readonly<{ readonly output: unknown; readonly state: unknown }>> {
	const blueprintDigest = String(application.catalog.blueprintDigests[0] ?? "");
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
	const reducer = runtime.reducers.applicationBatch;
	if (reducer === undefined) throw new TypeError("missing genuine applicationBatch reducer");
	return reducer({ operation, state });
}

async function reduceBatch(
	application: BatchApplication,
	state: unknown,
	entries: readonly Readonly<{ readonly logicalTime: number; readonly operation: Readonly<Record<string, unknown>> }>[]
): Promise<Readonly<{ readonly output: unknown; readonly state: unknown }>> {
	return reduceOperation(
		application,
		state,
		Object.freeze({ action: "applicationBatch", batch: Object.freeze({ entries, version: 1 }) })
	);
}

function malformedBatchOperations(
	entry: Readonly<{ readonly logicalTime: number; readonly operation: Readonly<Record<string, unknown>> }>
): readonly Readonly<Record<string, unknown>>[] {
	const entries = Object.freeze([entry, Object.freeze({ ...entry, logicalTime: entry.logicalTime + 1 })]);
	const sparseEntries = new Array<
		Readonly<{ readonly logicalTime: number; readonly operation: Readonly<Record<string, unknown>> }>
	>(2);
	sparseEntries[0] = entry;
	return Object.freeze([
		Object.freeze({ action: "applicationBatch", batch: Object.freeze({ entries, version: 1 }), extra: true }),
		Object.freeze({
			action: "applicationBatch",
			batch: Object.freeze({ entries, extra: true, version: 1 }),
		}),
		Object.freeze({
			action: "applicationBatch",
			batch: Object.freeze({
				entries: Object.freeze([Object.freeze({ ...entry, extra: true }), entries[1]]),
				version: 1,
			}),
		}),
		Object.freeze({
			action: "applicationBatch",
			batch: Object.freeze({
				entries: Object.freeze([Object.freeze({ operation: entry.operation }), entries[1]]),
				version: 1,
			}),
		}),
		Object.freeze({
			action: "applicationBatch",
			batch: Object.freeze({ entries: Object.freeze(sparseEntries), version: 1 }),
		}),
		Object.freeze({
			action: "applicationBatch",
			batch: Object.freeze({
				entries: Object.freeze([
					Object.freeze({
						logicalTime: entry.logicalTime,
						operation: Object.freeze({ ...entry.operation, extra: true }),
					}),
					entries[1],
				]),
				version: 1,
			}),
		}),
	]);
}

describe("Phase 3f-c real chat and zone batching composition RED", () => {
	it("advances chat to the authenticated batch manifest and accepted-operation projector", async () => {
		const chat = await import("../examples/v3-chat/src/index.js");
		const application = Reflect.apply(
			Reflect.get(chat, "createV3ChatApplication") as (...args: unknown[]) => unknown,
			undefined,
			["alice"]
		) as BatchApplication;
		expect(application.batchableOperationActions).toEqual(["message"]);
		expect(manifest(application)).toMatchObject({ schemaVersion: 2, workBudgetProfile: "blueprint-work-budget-v1" });
		expect(operationNames(application)).toEqual([
			"acl",
			"applicationBatch",
			"causalJoin",
			"join",
			"message",
			"migrationActivation",
			"migrationRecord",
		]);
		expect(operationDescriptor(application, "applicationBatch")).toEqual({
			argumentSchema: { fields: [{ name: "batch", required: true, type: "canonical-object" }], kind: "closed-record" },
			maxCanonicalOperationBytes: 65_536,
			name: "applicationBatch",
		});
		expect(application.projectAcceptedOperations).toBeTypeOf("function");
		await expect(
			reduceBatch(application, Object.freeze([]), [
				Object.freeze({
					logicalTime: 3,
					operation: Object.freeze({ action: "message", clientOperationId: "message-1", text: "first" }),
				}),
				Object.freeze({
					logicalTime: 5,
					operation: Object.freeze({ action: "message", clientOperationId: "message-2", text: "second" }),
				}),
			])
		).resolves.toEqual({
			output: [
				{ clientOperationId: "message-1", text: "first" },
				{ clientOperationId: "message-2", text: "second" },
			],
			state: [
				{ clientOperationId: "message-1", text: "first" },
				{ clientOperationId: "message-2", text: "second" },
			],
		});
		const maximalChat = await reduceBatch(application, Object.freeze([]), maximalEntries("chat"));
		expect(maximalChat.output).toHaveLength(16);
		expect(maximalChat.state).toHaveLength(16);
		for (const operation of [
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("chat", 1), version: 1 }),
			}),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("chat", 2), version: 2 }),
			}),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("zone", 2), version: 1 }),
			}),
		]) {
			await expect(reduceOperation(application, Object.freeze([]), operation)).rejects.toThrow();
		}
		for (const operation of malformedBatchOperations(
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({ action: "message", clientOperationId: "message-shape", text: "shape" }),
			})
		)) {
			await expect(reduceOperation(application, Object.freeze([]), operation)).rejects.toThrow();
		}
		const vertexDigest = "1".repeat(64);
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				acceptedOperation(
					{
						author: "a".repeat(64),
						authorSequence: 1,
						logicalTime: 3,
						operation: { action: "message", clientOperationId: "message-1", text: "first" },
						vertexDigest,
					},
					0,
					2
				),
				acceptedOperation(
					{
						author: "a".repeat(64),
						authorSequence: 1,
						logicalTime: 5,
						operation: { action: "message", clientOperationId: "message-2", text: "second" },
						vertexDigest,
					},
					1,
					2
				),
			],
		});
		expect(Reflect.get(projection, "accepted")).toMatchObject([
			{ clientOperationId: "message-1", digest: vertexDigest, operationIndex: 0, text: "first" },
			{ clientOperationId: "message-2", digest: vertexDigest, operationIndex: 1, text: "second" },
		]);
	});

	it("advances zone to the same batch owner without inheriting chat controls", async () => {
		const zone = await import("../examples/grid/src/v3-zone.js");
		const author = "b".repeat(64);
		const application = Reflect.apply(
			Reflect.get(zone, "createV3ZoneApplication") as (...args: unknown[]) => unknown,
			undefined,
			[Object.freeze([Object.freeze({ author, order: 0, peerId: "peer:creator" })]), "peer:creator", author]
		) as BatchApplication;
		expect(application.batchableOperationActions).toEqual(["placeBlock"]);
		expect(manifest(application)).toMatchObject({ schemaVersion: 2, workBudgetProfile: "blueprint-work-budget-v1" });
		expect(operationNames(application)).toEqual([
			"applicationBatch",
			"causalJoin",
			"commit-outcome-v1",
			"join",
			"migrationActivation",
			"migrationRecord",
			"placeBlock",
		]);
		expect(operationDescriptor(application, "applicationBatch")).toEqual({
			argumentSchema: { fields: [{ name: "batch", required: true, type: "canonical-object" }], kind: "closed-record" },
			maxCanonicalOperationBytes: 65_536,
			name: "applicationBatch",
		});
		expect(application.projectAcceptedOperations).toBeTypeOf("function");
		const reduced = await reduceBatch(application, Object.freeze({ durable: "unchanged" }), [
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({ action: "placeBlock", id: "a", kind: "stone", x: 1, y: 2 }),
			}),
			Object.freeze({
				logicalTime: 5,
				operation: Object.freeze({ action: "placeBlock", id: "b", kind: "dirt", x: 3, y: 4 }),
			}),
		]);
		expect(reduced).toEqual({
			output: [
				{ action: "placeBlock", id: "a", kind: "stone", x: 1, y: 2 },
				{ action: "placeBlock", id: "b", kind: "dirt", x: 3, y: 4 },
			],
			state: { durable: "unchanged" },
		});
		const maximalZone = await reduceBatch(application, Object.freeze({ durable: "unchanged" }), maximalEntries("zone"));
		expect(maximalZone.output).toHaveLength(16);
		expect(maximalZone.state).toEqual({ durable: "unchanged" });
		for (const operation of [
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("zone", 1), version: 1 }),
			}),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("zone", 2), version: 2 }),
			}),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("chat", 2), version: 1 }),
			}),
		]) {
			await expect(reduceOperation(application, Object.freeze({ durable: "unchanged" }), operation)).rejects.toThrow();
		}
		for (const operation of malformedBatchOperations(
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({ action: "placeBlock", id: "shape", kind: "stone", x: 1, y: 2 }),
			})
		)) {
			await expect(reduceOperation(application, Object.freeze({ durable: "unchanged" }), operation)).rejects.toThrow();
		}
		const vertexDigest = "2".repeat(64);
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				acceptedOperation(
					{
						author,
						authorSequence: 1,
						logicalTime: 3,
						operation: { action: "placeBlock", id: "a", kind: "stone", x: 1, y: 2 },
						vertexDigest,
					},
					0,
					2
				),
				acceptedOperation(
					{
						author,
						authorSequence: 1,
						logicalTime: 5,
						operation: { action: "placeBlock", id: "b", kind: "dirt", x: 3, y: 4 },
						vertexDigest,
					},
					1,
					2
				),
			],
		});
		expect(Reflect.get(projection, "blocks")).toEqual([
			{ id: "a", kind: "stone", x: 1, y: 2 },
			{ id: "b", kind: "dirt", x: 3, y: 4 },
		]);
		expect(Reflect.get(projection, "acceptedDigests")).toEqual([vertexDigest]);
	});
});
