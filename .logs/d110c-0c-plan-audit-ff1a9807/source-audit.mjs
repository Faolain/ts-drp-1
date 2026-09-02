import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const adoption = read("packages/node/src/creator-adoption.ts");
const publicRecovery = read("packages/node/src/creator-adoption-recover.ts");
const room = read("examples/v3-room/src/index.ts");
const live = read("packages/node/src/v3-live.ts");
const browserFixture = read("packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts");
const packageJson = JSON.parse(read("packages/node/package.json"));

const checks = Object.freeze({
	additivePendingClassifierPinned: adoption.includes("!inspectCreatorTrustAdvance({"),
	combinedIssuanceCeilingAbsent:
		live.includes("skipped > filterPayload.parameters.maxEpochVertices") &&
		live.includes("skippedGenesis > filterPayload.parameters.maxEpochVertices"),
	existingPublicRecoveryExport: Object.hasOwn(packageJson.exports, "./creator-adoption-recover"),
	genesisCarrierEqualityPinned:
		adoption.includes("input.exactCanonicalAnchorPreimageBytes,") &&
		adoption.includes("currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes"),
	genesisCurrentOpenerPinned: adoption.includes("const openedCurrent = openCurrentAnchorTrust({"),
	oldAndNewAheFaultSeams:
		browserFixture.includes('failBeforePublication: ordering === "old-ahe"') &&
		browserFixture.includes('control.fault = "commit-unavailable-once"'),
	pendingChainEpochsPinned: adoption.includes("currentEpoch: 0,") && adoption.includes("successorEpoch: 1,"),
	pendingProjectionPinned:
		adoption.includes('uniqueCandidateByKind(currentCandidates, "v3-live-generation-1")') &&
		adoption.includes('currentProjectionKind: "v3-live-generation-1"'),
	publicRecoveryInputKeyCount: (publicRecovery.match(/^\s*"[A-Za-z].*",$/gmu) ?? []).length === 11,
	roomCommitsFloorAfterPendingRecovery:
		room.indexOf("const recoveredPending = await recoverPendingCreatorSuccessorAdoption") <
		room.indexOf("openedRoomHeadState = await commitRoomHeadAdvance", room.indexOf("const recoveredPending")),
	roomUsesExistingRecovery: room.includes("recoverPendingCreatorSuccessorAdoption({"),
	scanCountersOutsideRead:
		live.indexOf("let skipped = 0;") < live.indexOf("readOutboxPage: async") &&
		live.indexOf("let skippedGenesis = 0;") < live.indexOf("readOutboxPage: async"),
	sharedCheckpointOpenerAvailable: adoption.includes('from "@ts-drp/protocol-v3/creator-checkpoint"'),
	sharedTransitionClassifierAvailable: adoption.includes('from "./internal/creator-transition-advance.js"'),
});

if (Object.values(checks).some((value) => value !== true)) {
	throw new TypeError(`D110C_0C_SOURCE_AUDIT_FAILED:${JSON.stringify(checks)}`);
}
process.stdout.write(`${JSON.stringify({ base: "ff1a9807528b1f29c8d1f381f0c093baf5a5d506", checks }, null, 2)}\n`);
