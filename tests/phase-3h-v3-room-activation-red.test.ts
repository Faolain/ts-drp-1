import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	expectedMigrationActivationDecision,
	expectedMigrationActivationDecisionDigest,
	MIGRATION_ACTIVATION_DECISION_KEYS,
} from "./fixtures/phase-3h/migration-rehearsal-fixture.js";

describe("Phase 3h-b creator-signed activation RED", () => {
	it("derives the exact signed decision from record and invite evidence without routing inputs", () => {
		const sourceObjectId = `creator:${"1".repeat(32)}`;
		const targetObjectId = `creator:${"2".repeat(32)}`;
		const invite = Object.freeze({
			detachedGenesisSignature: new Uint8Array(64).fill(1),
			exactCanonicalGenesisAnchorPreimageBytes: Uint8Array.of(2),
			exactCanonicalLatchedAclBytes: Uint8Array.of(3),
			exactCanonicalParametersCarrierBytes: Uint8Array.of(4),
			exactCanonicalProfileBytes: Uint8Array.of(5),
			exactCanonicalSignerSetBytes: Uint8Array.of(6),
			pinnedGenesisAnchorDigest: "7".repeat(64),
		});
		const recordBytes = encodeCanonical({
			applicationStateDigest: "8".repeat(64),
			rehearsalNonce: new Uint8Array(32).fill(9),
			sourceAcceptedOperationCount: 2,
			sourceAcceptedOperationsDigest: "a".repeat(64),
			sourceAnchorDigest: "b".repeat(64),
			sourceBlueprintDigest: "c".repeat(64),
			sourceCreatorAuthor: "d".repeat(64),
			sourceObjectId,
			targetAnchorDigest: invite.pinnedGenesisAnchorDigest,
			targetBlueprintDigest: "c".repeat(64),
			targetCreatorAuthor: "d".repeat(64),
			targetImportOperationCount: 2,
			targetImportOperationsDigest: "e".repeat(64),
			targetObjectId,
		});
		const decision = expectedMigrationActivationDecision(recordBytes, "f".repeat(64), invite);
		expect(Reflect.ownKeys(decision).map(String).sort()).toEqual([...MIGRATION_ACTIVATION_DECISION_KEYS].sort());
		expect(decision).toMatchObject({
			activationAuthority: "creator-ed25519-registered-vertex-v1",
			kind: "ts-drp-v3-room-migration-activation",
			migrationRecordVertexDigest: "f".repeat(64),
			sourceObjectId,
			targetObjectId,
			version: 1,
		});
		expect(expectedMigrationActivationDecisionDigest(decision)).toMatch(/^[0-9a-f]{64}$/u);
	});
});
