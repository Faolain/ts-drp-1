import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	acceptedOperation,
	expectedTargetObjectId,
	MIGRATION_ACTIVATION_DECISION_KEYS,
	prepareChatMigration,
	prepareZoneMigration,
} from "./fixtures/phase-3h/migration-rehearsal-fixture.js";

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Phase 3h creator-owned migration record RED", () => {
	it("keeps the activation decision distinct from the migration record", () => {
		expect(MIGRATION_ACTIVATION_DECISION_KEYS).toContain("migrationRecordDigest");
		expect(MIGRATION_ACTIVATION_DECISION_KEYS).toContain("migrationRecordVertexDigest");
		expect(MIGRATION_ACTIVATION_DECISION_KEYS).not.toContain("exactCanonicalApplicationStateBytes");
	});
	it("derives one exact nonce-bound target object identity without caller selection", () => {
		const nonce = new Uint8Array(32).fill(0x53);
		const source = `creator:${"d".repeat(32)}`;
		const first = expectedTargetObjectId(source, nonce);
		const second = expectedTargetObjectId(source, new Uint8Array(nonce));
		expect(first).toBe(second);
		expect(first).toMatch(/^creator:[0-9a-f]{32}$/u);
		expect(first).not.toBe(source);
		expect(expectedTargetObjectId(source, new Uint8Array(32).fill(0x54))).not.toBe(first);
	});

	it("defines deterministic chat and zone application-state checkpoints", () => {
		const chat = prepareChatMigration([
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
		]);
		expect(decodeCanonical(chat.exactCanonicalApplicationStateBytes)).toEqual([
			{ clientOperationId: "first", text: "first" },
			{ clientOperationId: "later", text: "second" },
		]);
		expect(chat.importOperations).toEqual([
			{ action: "message", clientOperationId: "first", text: "first" },
			{ action: "message", clientOperationId: "later", text: "second" },
		]);

		const zone = prepareZoneMigration([
			acceptedOperation(Object.freeze({ action: "placeBlock", id: "z", kind: "wood", x: 5, y: 8 })),
			acceptedOperation(Object.freeze({ action: "placeBlock", id: "a", kind: "stone", x: 2, y: 3 })),
		]);
		expect(decodeCanonical(zone.exactCanonicalApplicationStateBytes)).toEqual([
			{ id: "a", kind: "stone", x: 2, y: 3 },
			{ id: "z", kind: "wood", x: 5, y: 8 },
		]);
		expect(zone.importOperations).toEqual([
			{ action: "placeBlock", id: "a", kind: "stone", x: 2, y: 3 },
			{ action: "placeBlock", id: "z", kind: "wood", x: 5, y: 8 },
		]);
	});

	it("rejects every duplicate chat or zone application identity before target creation", () => {
		const operation = Object.freeze({ action: "message", clientOperationId: "stable", text: "same" });
		for (const author of ["a".repeat(64), "b".repeat(64)]) {
			expect(() =>
				prepareChatMigration([
					acceptedOperation(operation, { author: "a".repeat(64) }),
					acceptedOperation(operation, { author, authorSequence: 2, logicalTime: 2 }),
				])
			).toThrow(/identity conflicts/u);
		}
		expect(() =>
			prepareZoneMigration([
				acceptedOperation(Object.freeze({ action: "placeBlock", id: "same", kind: "stone", x: 1, y: 2 })),
				acceptedOperation(Object.freeze({ action: "placeBlock", id: "same", kind: "wood", x: 3, y: 4 })),
			])
		).toThrow(/identity conflicts/u);
	});

	it("defines the exact closed migration record whose digest is content identity only", () => {
		const record = Object.freeze({
			applicationStateDigest: "1".repeat(64),
			archivePolicy: "retain-source",
			authorityKind: "creator-ed25519-registered-vertex-v1",
			exactCanonicalApplicationStateBytes: encodeCanonical([{ clientOperationId: "one", text: "durable" }]),
			kind: "ts-drp-v3-room-migration-record",
			rehearsalNonce: new Uint8Array(32).fill(0x53),
			sourceAcceptedOperationCount: 1,
			sourceAcceptedOperationsDigest: "2".repeat(64),
			sourceAnchorDigest: "3".repeat(64),
			sourceBlueprintDigest: "4".repeat(64),
			sourceCreatorAuthor: "5".repeat(64),
			sourceObjectId: `creator:${"6".repeat(32)}`,
			targetAnchorDigest: "7".repeat(64),
			targetBlueprintDigest: "4".repeat(64),
			targetCreatorAuthor: "5".repeat(64),
			targetImportOperationCount: 1,
			targetImportOperationsDigest: "8".repeat(64),
			targetObjectId: `creator:${"9".repeat(32)}`,
			version: 1,
		});
		const bytes = encodeCanonical(record);
		expect(decodeCanonical(bytes)).toEqual(record);
		const expectedKeys = [
			"applicationStateDigest",
			"archivePolicy",
			"authorityKind",
			"exactCanonicalApplicationStateBytes",
			"kind",
			"rehearsalNonce",
			"sourceAcceptedOperationCount",
			"sourceAcceptedOperationsDigest",
			"sourceAnchorDigest",
			"sourceBlueprintDigest",
			"sourceCreatorAuthor",
			"sourceObjectId",
			"targetAnchorDigest",
			"targetBlueprintDigest",
			"targetCreatorAuthor",
			"targetImportOperationCount",
			"targetImportOperationsDigest",
			"targetObjectId",
			"version",
		];
		expect(
			Reflect.ownKeys(decodeCanonical(bytes) as object)
				.map(String)
				.sort()
		).toEqual(expectedKeys.sort());
		expect(hex(hashDomain("ts-drp/v3-room-migration-record/v1", bytes))).toMatch(/^[0-9a-f]{64}$/u);
	});
});
