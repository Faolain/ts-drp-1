import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { openTrustedBlueprintCatalogBytes } from "@ts-drp/blueprint-catalog/bytes";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
	it("retains the exact predecessor catalog and executes its genuine isolated kernel", async () => {
		const material = JSON.parse(
			readFileSync(new URL("../examples/grid/src/zone-catalog-predecessor-material.json", import.meta.url), "utf8")
		) as {
			catalogBytes: string;
			assets: Record<string, string>;
		};
		const catalog = openTrustedBlueprintCatalogBytes({
			catalogBytes: new Uint8Array(Buffer.from(material.catalogBytes, "hex")),
			assets: Object.fromEntries(
				Object.entries(material.assets).map(([name, value]) => [name, new Uint8Array(Buffer.from(value, "hex"))])
			),
		});
		const predecessorDigest = "f9bfacb0c2a26815aff3d36122e0ddfdb5459b45ed6fa76e75712b762787c557";
		expect(catalog.blueprintDigests).toEqual([predecessorDigest]);
		const exactArtifact = readFileSync(
			new URL("../examples/grid/src/zone-state-predecessor-artifact.mjs", import.meta.url)
		);
		expect(createHash("sha256").update(exactArtifact).digest("hex")).toBe(
			"8134d30e8769f21f65ce34efc008a44fc72e9f60e4d729eee2ca0286f1e60fc2"
		);
		expect(catalog.resolve(predecessorDigest).exactArtifactBytes).toEqual(new Uint8Array(exactArtifact));
		const { createZoneStateKernel } = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64),
			peer = "retained-creator";
		const predecessor = createZoneStateKernel(creator, peer, "predecessor");
		const installed = predecessor.apply(
			predecessor.emptyState(),
			{
				action: "installRoster",
				roster: {
					entries: [{ author: creator, order: 0, peerId: peer }],
				},
			},
			creator
		).state;
		const placed = predecessor.apply(
			installed,
			{ action: "placeBlock", id: "retained", kind: "stone", x: 1, y: 2 },
			creator
		).state;
		expect(placed.blocks).toEqual([{ id: "retained", kind: "stone", x: 1, y: 2 }]);
		const continued = predecessor.apply(
			predecessor.captureState(decodeCanonical(encodeCanonical(placed))),
			{ action: "placeBlock", id: "continued", kind: "wood", x: 3, y: 4 },
			creator
		).state;
		expect(continued.blocks).toHaveLength(2);
		// The old executable is not silently replaced by the candidate's v2 inheritance reducer.
		const inheritedV2 = {
			action: "migrationRecord",
			record: {
				applicationStateDigest: "a".repeat(64),
				archivePolicy: "retain-source",
				authorityKind: "creator-ed25519-registered-vertex-v1",
				applicationState: continued,
				kind: "ts-drp-v3-room-migration-record",
				rehearsalNonce: new Uint8Array(32),
				sourceAcceptedOperationCount: 2,
				sourceAcceptedOperationsDigest: "b".repeat(64),
				sourceAnchorDigest: "c".repeat(64),
				sourceBlueprintDigest: predecessorDigest,
				sourceCreatorAuthor: creator,
				sourceObjectId: "grid:source",
				targetAnchorDigest: "d".repeat(64),
				targetBlueprintDigest: "e".repeat(64),
				targetCreatorAuthor: creator,
				targetImportOperationCount: 2,
				targetImportOperationsDigest: "f".repeat(64),
				targetObjectId: "grid:target",
				targetAclDigest: "0".repeat(64),
				targetEpoch: 0,
				version: 2,
			},
		};
		// Pure execution control, not a signed admission/authentication claim.
		expect(() => predecessor.apply(continued, inheritedV2, creator)).toThrow("invalid migration record");
		expect(createZoneStateKernel(creator, peer).apply(continued, inheritedV2, creator).state).toEqual(continued);
		expect(() => Reflect.apply(createZoneStateKernel, undefined, [creator, peer, "unknown"])).toThrow();
	});
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
			"migrationActivation",
			"migrationRecord",
		]);
		expect(migrationDescriptor(application, "migrationActivation")).toEqual({
			argumentSchema: {
				fields: [{ name: "decision", required: true, type: "canonical-object" }],
				kind: "closed-record",
			},
			maxCanonicalOperationBytes: 65_536,
			name: "migrationActivation",
		});
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
			"commit-outcome-v1",
			"installRoster",
			"migrationActivation",
			"migrationRecord",
			"placeBlock",
		]);
		expect(migrationDescriptor(application, "migrationActivation")).toEqual({
			argumentSchema: {
				fields: [{ name: "decision", required: true, type: "canonical-object" }],
				kind: "closed-record",
			},
			maxCanonicalOperationBytes: 65_536,
			name: "migrationActivation",
		});
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
		const historical = prepareZoneMigration(accepted);
		const current = migrationCapability(application).prepare(accepted);
		expect(current.importOperations).toEqual(historical.importOperations);
		expect(decodeCanonical(current.exactCanonicalApplicationStateBytes)).toEqual({
			version: 2,
			creatorAuthor: "a".repeat(64),
			creatorPeerId: "creator",
			blocks: decodeCanonical(historical.exactCanonicalApplicationStateBytes),
			outcomes: [],
			roster: [],
		});
		// Accepted creator join authority survives preparation; constructor members
		// alone deliberately did not populate the blocks-only case above.
		const roster = [
			{ author: "a".repeat(64), order: 0, peerId: "creator" },
			{ author: "b".repeat(64), order: 1, peerId: "writer" },
		];
		const withRoster = migrationCapability(application).prepare([
			acceptedOperation(
				{ action: "installRoster", roster: { entries: [...roster].reverse() } },
				{
					author: "a".repeat(64),
					authorSequence: 0,
					logicalTime: 0,
					vertexDigest: "0".repeat(64),
				}
			),
			...accepted,
		]);
		expect(withRoster.importOperations).toEqual(historical.importOperations);
		expect(decodeCanonical(withRoster.exactCanonicalApplicationStateBytes)).toEqual({
			version: 2,
			creatorAuthor: "a".repeat(64),
			creatorPeerId: "creator",
			blocks: decodeCanonical(historical.exactCanonicalApplicationStateBytes),
			outcomes: [],
			roster,
		});
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

	it("prepares the complete inherited chat snapshot rather than only current rows", async () => {
		const { createV3ChatApplication } = await import("../examples/v3-chat/src/index.js");
		const application = createV3ChatApplication("alice");
		const source = encodeCanonical([
			{ clientOperationId: "inherited", text: "before rollover" },
			{ clientOperationId: "current", text: "after rollover" },
		]);
		const rows = [acceptedOperation({ action: "message", clientOperationId: "current", text: "after rollover" })];
		const prepared = migrationCapability(application).prepare(rows, source);
		expect(prepared.exactCanonicalApplicationStateBytes).toEqual(source);
		expect(prepared.importOperations).toEqual([
			{ action: "message", clientOperationId: "inherited", text: "before rollover" },
			{ action: "message", clientOperationId: "current", text: "after rollover" },
		]);
	});

	it("prepares inherited Grid blocks and refuses a foreign snapshot creator seed", async () => {
		const { createV3ZoneApplication } = await import("../examples/grid/src/v3-zone.js");
		const author = "a".repeat(64);
		const roster = [{ author, order: 0, peerId: "creator" }];
		const application = createV3ZoneApplication(roster, "creator", author);
		const state = {
			version: 2,
			creatorAuthor: author,
			creatorPeerId: "creator",
			blocks: [{ id: "inherited", kind: "stone", x: 1, y: 2 }],
			outcomes: [],
			roster,
		};
		const source = encodeCanonical(state);
		const prepared = migrationCapability(application).prepare([], source);
		expect(prepared.exactCanonicalApplicationStateBytes).toEqual(source);
		expect(prepared.importOperations).toEqual([{ action: "placeBlock", ...state.blocks[0] }]);
		expect(() =>
			migrationCapability(application).prepare([], encodeCanonical({ ...state, creatorAuthor: "b".repeat(64) }))
		).toThrow();
	});
});
