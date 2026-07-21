import { frozenPublicCampaign } from "./campaign-plan.js";
import { PUBLIC_DECISION_RULES } from "./contract.js";
import { fingerprint, summarizePublicCampaign } from "./evidence.js";
import { sensitiveValueDigest } from "./redaction.js";
import {
	EVIDENCE_SCHEMA_VERSION,
	type ExperimentManifest,
	type PublicCampaignPlan,
	type ThresholdSet,
} from "./schemas.js";

const FROZEN_AT = "2026-07-20T08:00:00.000Z";

export const fixtureThresholdSet: ThresholdSet = {
	frozenAt: FROZEN_AT,
	id: "issue-5-preregistered-thresholds",
	rules: PUBLIC_DECISION_RULES,
	version: 1,
};

export const fixturePublicCampaign: PublicCampaignPlan = frozenPublicCampaign;

/**
 * Creates the deterministic, schema-valid Phase 00 CLI fixture.
 * @returns A fixture experiment manifest.
 */
export function createFixtureManifest(): ExperimentManifest {
	const runId = "fixture-issue-5";
	return {
		amendments: [],
		deadlineBudget: {
			children: {
				candidateAndFallbackMs: 5_000,
				cleanupMs: 5_000,
				endpointMs: 8_000,
				ownedFallbackMs: 12_000,
			},
			parentMs: 30_000,
		},
		endpointClasses: ["public-dht", "delegated-routing", "signed-registry", "public-relay", "owned-fallback"],
		evidenceChecksums: {
			"fixture.json": "0".repeat(64),
		},
		git: {
			dirty: true,
			lockfileDigest: "1".repeat(64),
			sha: "9".repeat(40),
		},
		networkCondition: "planned-matrix",
		publicCampaign: fixturePublicCampaign,
		publicCampaignFingerprint: fingerprint(fixturePublicCampaign),
		hardRequestCap: summarizePublicCampaign(fixturePublicCampaign).hardRequestCap,
		redaction: {
			diversity: "aggregate-only",
			namespaces: "per-run-pseudonyms",
			peerIds: "per-run-pseudonyms",
			rawOutputDirectory: `.network-spike-raw/${runId}`,
			saltId: "salt_a1b2c3d4e5f6",
			saltScope: "per-run",
			sensitiveValueDigests: [sensitiveValueDigest("fixture-private-namespace")],
			state: "redacted",
		},
		runId,
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		seed: 5,
		startedAt: FROZEN_AT,
		target: "public-campaign",
		thresholdSetFingerprint: fingerprint(fixtureThresholdSet),
		transportProfile: "balanced-matrix",
		versions: {
			browsers: {
				chromium: "134.0",
				firefox: "135.0",
				webkit: "18.4",
			},
			node: "22.15.0",
			os: "darwin-arm64",
			packages: {
				"@libp2p/webrtc": "6.0.26",
				"libp2p": "3.3.5",
				"typescript": "5.8.2",
			},
			pnpm: "10.24.0",
		},
	};
}

/**
 * Creates the complete CLI payload, including exact trials and request cap.
 * @returns The manifest, threshold set, and planned-matrix summary.
 */
export function createFixturePayload(): {
	manifest: ExperimentManifest;
	plannedMatrix: ReturnType<typeof summarizePublicCampaign>;
	thresholdSet: ThresholdSet;
} {
	const manifest = createFixtureManifest();
	return {
		manifest,
		plannedMatrix: summarizePublicCampaign(manifest.publicCampaign),
		thresholdSet: fixtureThresholdSet,
	};
}
