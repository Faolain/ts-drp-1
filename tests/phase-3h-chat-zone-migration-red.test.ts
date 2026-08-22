import { decodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it, vi } from "vitest";

import {
	acceptedOperation,
	migrationCapability,
	migrationDescriptor,
	operationNames,
	prepareChatMigration,
	prepareZoneMigration,
} from "./fixtures/phase-3h/migration-rehearsal-fixture.js";

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
}));

describe("Phase 3h chat and zone migration composition RED", () => {
	it("adds one non-batchable neutral migration record to the genuine chat blueprint", async () => {
		const chat = await import("../examples/v3-chat/src/index.js");
		const application = Reflect.apply(
			Reflect.get(chat, "createV3ChatApplication") as (...args: unknown[]) => unknown,
			undefined,
			["alice"]
		) as Parameters<typeof operationNames>[0];
		expect(operationNames(application)).toEqual([
			"acl",
			"applicationBatch",
			"causalJoin",
			"join",
			"message",
			"migrationRecord",
		]);
		expect(migrationDescriptor(application)).toEqual({
			argumentSchema: {
				fields: [{ name: "record", required: true, type: "canonical-object" }],
				kind: "closed-record",
			},
			maxCanonicalOperationBytes: 65_536,
			name: "migrationRecord",
		});
		const accepted = [
			acceptedOperation(Object.freeze({ action: "message", clientOperationId: "later", text: "second" }), {
				authorSequence: 2,
				logicalTime: 5,
				vertexDigest: "2".repeat(64),
			}),
			acceptedOperation(Object.freeze({ action: "message", clientOperationId: "first", text: "first" }), {
				authorSequence: 1,
				logicalTime: 3,
				vertexDigest: "1".repeat(64),
			}),
		];
		expect(migrationCapability(application).prepare(accepted)).toEqual(prepareChatMigration(accepted));
		const orderedTies = [
			acceptedOperation(Object.freeze({ action: "message", clientOperationId: "author-later", text: "author" }), {
				author: "b".repeat(64),
				authorSequence: 0,
				logicalTime: 1,
				vertexDigest: "0".repeat(64),
			}),
			acceptedOperation(
				Object.freeze({ action: "message", clientOperationId: "operation-index-second", text: "index-1" }),
				{
					author: "a".repeat(64),
					authorSequence: 1,
					logicalTime: 1,
					operationCount: 2,
					operationIndex: 1,
					vertexDigest: "1".repeat(64),
				}
			),
			acceptedOperation(Object.freeze({ action: "message", clientOperationId: "sequence-later", text: "sequence" }), {
				author: "a".repeat(64),
				authorSequence: 2,
				logicalTime: 1,
				vertexDigest: "0".repeat(64),
			}),
			acceptedOperation(Object.freeze({ action: "message", clientOperationId: "vertex-later", text: "vertex" }), {
				author: "a".repeat(64),
				authorSequence: 1,
				logicalTime: 1,
				vertexDigest: "2".repeat(64),
			}),
			acceptedOperation(
				Object.freeze({ action: "message", clientOperationId: "operation-index-first", text: "index-0" }),
				{
					author: "a".repeat(64),
					authorSequence: 1,
					logicalTime: 1,
					operationCount: 2,
					operationIndex: 0,
					vertexDigest: "1".repeat(64),
				}
			),
		];
		const actualTies = migrationCapability(application).prepare(orderedTies);
		expect(actualTies).toEqual(prepareChatMigration(orderedTies));
		expect(
			(
				decodeCanonical(actualTies.exactCanonicalApplicationStateBytes) as readonly Readonly<{
					readonly clientOperationId: string;
				}>[]
			).map(({ clientOperationId }) => clientOperationId)
		).toEqual(["operation-index-first", "operation-index-second", "vertex-later", "sequence-later", "author-later"]);
		expect(() =>
			migrationCapability(application).prepare([
				acceptedOperation(Object.freeze({ action: "message", clientOperationId: "same", text: "one" })),
				acceptedOperation(Object.freeze({ action: "message", clientOperationId: "same", text: "two" }), {
					author: "b".repeat(64),
					authorSequence: 2,
					logicalTime: 2,
				}),
			])
		).toThrow();
	});

	it("adds one non-batchable neutral migration record to the genuine zone blueprint", async () => {
		const zone = await import("../examples/grid/src/v3-zone.js");
		const application = Reflect.apply(
			Reflect.get(zone, "createV3ZoneApplication") as (...args: unknown[]) => unknown,
			undefined,
			[
				Object.freeze([Object.freeze({ author: "a".repeat(64), order: 0, peerId: "creator" })]),
				"creator",
				"a".repeat(64),
			]
		) as Parameters<typeof operationNames>[0];
		expect(operationNames(application)).toEqual([
			"applicationBatch",
			"causalJoin",
			"join",
			"migrationRecord",
			"placeBlock",
		]);
		expect(migrationDescriptor(application)).toEqual({
			argumentSchema: {
				fields: [{ name: "record", required: true, type: "canonical-object" }],
				kind: "closed-record",
			},
			maxCanonicalOperationBytes: 65_536,
			name: "migrationRecord",
		});
		const accepted = [
			acceptedOperation(Object.freeze({ action: "placeBlock", id: "z", kind: "wood", x: 5, y: 8 })),
			acceptedOperation(Object.freeze({ action: "placeBlock", id: "a", kind: "stone", x: 2, y: 3 }), {
				authorSequence: 2,
				logicalTime: 2,
			}),
		];
		expect(migrationCapability(application).prepare(accepted)).toEqual(prepareZoneMigration(accepted));
		expect(() =>
			migrationCapability(application).prepare([
				acceptedOperation(Object.freeze({ action: "placeBlock", id: "same", kind: "stone", x: 1, y: 2 })),
				acceptedOperation(Object.freeze({ action: "placeBlock", id: "same", kind: "wood", x: 3, y: 4 }), {
					authorSequence: 2,
					logicalTime: 2,
				}),
			])
		).toThrow();
	});
});
