import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	VALID_CLEAR_CONTROL_EVIDENCE,
	VALID_DECISION_EVIDENCE,
	VALID_MEASUREMENT_EVIDENCE,
	VALID_STRICT_IDB_CAPABILITY_EVIDENCE,
} from "./fixtures/evidence-schema.js";
import { requirePhase2dDecisionConsumptionReady } from "./fixtures/s4-decision-consumption-gate.js";

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "../..");
const S4_LINK_PATH = "tests/opfs-idb-spike/artifacts/phase-2d-storage-substrate-decision-link-v1.json";
const temporaryDirectories: string[] = [];

interface MutableLink {
	decision: { jsonPath: string; jsonSha256: string; markdownPath: string; markdownSha256: string };
	artifacts: {
		strictIdb: { testOnlyForcedObservedDurability: string };
		measurement: { oracleStatus: string; sha256: string };
		clearControl: { scoringWeight: string };
	};
}

interface MutableDecision {
	measurementArtifactDigests: string[];
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(bytes: string): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function createSyntheticBundle(chosen: "idb-strict" | "opfs"): { readonly root: string; readonly linkPath: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2-spike-s4-gate-"));
	temporaryDirectories.push(root);
	const artifactDirectory = path.join(root, "artifacts");
	fs.mkdirSync(artifactDirectory);
	const strictJson = JSON.stringify(VALID_STRICT_IDB_CAPABILITY_EVIDENCE);
	const measurementJson = JSON.stringify(VALID_MEASUREMENT_EVIDENCE);
	const clearJson = JSON.stringify(VALID_CLEAR_CONTROL_EVIDENCE);
	const artifactDigests = {
		strictIdb: sha256(strictJson),
		measurement: sha256(measurementJson),
		clearControl: sha256(clearJson),
	};
	fs.writeFileSync(path.join(artifactDirectory, "strict-idb-capability.json"), strictJson);
	fs.writeFileSync(path.join(artifactDirectory, "substrate-measurement.json"), measurementJson);
	fs.writeFileSync(path.join(artifactDirectory, "bucket-clear-control.json"), clearJson);
	const consequences = [
		"workload:generation/blob/pointer-swap-only",
		"vote-slot-parity:unmeasured-and-non-citable;owners:2d,5c;revisit:after-2d-and-5c-executable-vote-transaction",
		"timing-basis:correctness-only;asymmetric-unwarmed-opfs-first-raw-values-not-scored",
		`artifact-sha256:strict-idb-capability=${artifactDigests.strictIdb}`,
		`artifact-sha256:substrate-measurement=${artifactDigests.measurement}`,
		`artifact-sha256:bucket-clear-control=${artifactDigests.clearControl}`,
	];
	if (chosen === "opfs") {
		consequences.push(
			"opfs-cas:2d/5c keep exact-byte insert-if-absent CAS, vote slot, signer-state and outbox in one strict IDB transaction; OPFS holds generation/blob bytes outside that race boundary"
		);
	}
	const decisionJson = JSON.stringify({
		...VALID_DECISION_EVIDENCE,
		chosen,
		measurementArtifactDigests: [artifactDigests.measurement],
		custodyFateSharingSurface:
			"The selected vote-log endpoint and non-extractable CryptoKey endpoint remain a Phase-5 fate-sharing input, not eviction evidence.",
		crashAtomicityMechanism:
			"The benchmark proves no crash atomicity; 2d/5c retain the strict transaction boundary and substrate-specific recovery work.",
		implementationRisk:
			"Single-engine, single-writer evidence leaves migration, multi-tab, custody, crash and real-pressure risks open.",
		consequences,
	});
	const decisionDigest = sha256(decisionJson);
	const markdown = [
		"# Storage substrate decision v1",
		`Chosen: ${chosen}`,
		`Decision JSON SHA-256: ${decisionDigest}`,
		`Strict IDB SHA-256: ${artifactDigests.strictIdb}`,
		`Measurement SHA-256: ${artifactDigests.measurement}`,
		`Clear control SHA-256: ${artifactDigests.clearControl}`,
		"The choice is correctness-only for the generation/blob/pointer-swap workload; raw asymmetric timing is not scored.",
	].join("\n");
	fs.writeFileSync(path.join(artifactDirectory, "storage-substrate-decision-v1.json"), decisionJson);
	fs.writeFileSync(path.join(artifactDirectory, "storage-substrate-decision-v1.md"), markdown);
	const engine = {
		browserName: "chromium",
		browserVersion: "149.0.7827.55",
		executableRevision: "chromium-1234567",
		userAgent: "Mozilla/5.0 synthetic S4 control Chromium/149.0.7827.55",
		operatingSystem: "synthetic-control-os",
		playwrightVersion: "1.61.1",
	};
	const citationBase = {
		freshSuccessfulRun: true,
		engine,
	};
	const link = {
		schemaVersion: 1,
		gate: "phase-2d-storage-substrate-decision-consumption",
		status: "preimplementation-required-before-2d",
		decision: {
			jsonPath: "artifacts/storage-substrate-decision-v1.json",
			jsonSha256: decisionDigest,
			markdownPath: "artifacts/storage-substrate-decision-v1.md",
			markdownSha256: sha256(markdown),
		},
		artifacts: {
			strictIdb: {
				...citationBase,
				path: "artifacts/strict-idb-capability.json",
				sha256: artifactDigests.strictIdb,
				testOnlyForcedObservedDurability: "absent",
				oracleStatus: "not-applicable",
				timingBasis: "not-applicable",
				scoringWeight: "decision-input",
			},
			measurement: {
				...citationBase,
				path: "artifacts/substrate-measurement.json",
				sha256: artifactDigests.measurement,
				testOnlyForcedObservedDurability: "not-applicable",
				oracleStatus: "pass",
				timingBasis: "correctness-only",
				scoringWeight: "decision-input",
			},
			clearControl: {
				...citationBase,
				path: "artifacts/bucket-clear-control.json",
				sha256: artifactDigests.clearControl,
				testOnlyForcedObservedDurability: "not-applicable",
				oracleStatus: "not-applicable",
				timingBasis: "not-applicable",
				scoringWeight: "none",
			},
		},
	};
	const linkPath = "phase-2d-link.json";
	fs.writeFileSync(path.join(root, linkPath), JSON.stringify(link));
	return { root, linkPath };
}

describe("Phase 2-spike S4 decision bundle and future 2d consumption gate", () => {
	it("accepts exact-byte correctness-only bundles for both legal substrate choices", () => {
		for (const chosen of ["idb-strict", "opfs"] as const) {
			const bundle = createSyntheticBundle(chosen);
			expect(
				requirePhase2dDecisionConsumptionReady({ rootDirectory: bundle.root, linkPath: bundle.linkPath }).chosen
			).toBe(chosen);
		}
	});

	it("rejects mismatched pair digests, forced S1, oracle-failed S2, and scored S3 citations", () => {
		const mutations = [
			(link: MutableLink): void => {
				link.decision.jsonPath = "artifacts/missing-decision.json";
			},
			(link: MutableLink): void => {
				link.decision.jsonSha256 = "0".repeat(64);
			},
			(link: MutableLink): void => {
				link.decision.markdownSha256 = "0".repeat(64);
			},
			(link: MutableLink): void => {
				link.artifacts.strictIdb.testOnlyForcedObservedDurability = "not-applicable";
			},
			(link: MutableLink): void => {
				link.artifacts.measurement.oracleStatus = "not-applicable";
			},
			(link: MutableLink): void => {
				link.artifacts.measurement.sha256 = "0".repeat(64);
			},
			(link: MutableLink): void => {
				link.artifacts.clearControl.scoringWeight = "decision-input";
			},
		];
		for (const mutate of mutations) {
			const bundle = createSyntheticBundle("idb-strict");
			const fullLinkPath = path.join(bundle.root, bundle.linkPath);
			const link = JSON.parse(fs.readFileSync(fullLinkPath, "utf8")) as MutableLink;
			mutate(link);
			fs.writeFileSync(fullLinkPath, JSON.stringify(link));
			expect(() =>
				requirePhase2dDecisionConsumptionReady({ rootDirectory: bundle.root, linkPath: bundle.linkPath })
			).toThrow(TypeError);
		}
	});

	it("rejects caller link-path escapes and additional uncited measurement digests", () => {
		const escapedBundle = createSyntheticBundle("idb-strict");
		const governedRoot = path.join(escapedBundle.root, "governed-root");
		fs.mkdirSync(governedRoot);
		fs.renameSync(path.join(escapedBundle.root, "artifacts"), path.join(governedRoot, "artifacts"));
		fs.renameSync(
			path.join(escapedBundle.root, escapedBundle.linkPath),
			path.join(escapedBundle.root, "outside-link.json")
		);
		expect
			.soft(() =>
				requirePhase2dDecisionConsumptionReady({ rootDirectory: governedRoot, linkPath: "../outside-link.json" })
			)
			.toThrow(TypeError);

		const digestBundle = createSyntheticBundle("idb-strict");
		const fullLinkPath = path.join(digestBundle.root, digestBundle.linkPath);
		const link = JSON.parse(fs.readFileSync(fullLinkPath, "utf8")) as MutableLink;
		const fullDecisionPath = path.join(digestBundle.root, link.decision.jsonPath);
		const decision = JSON.parse(fs.readFileSync(fullDecisionPath, "utf8")) as MutableDecision;
		decision.measurementArtifactDigests.push(sha256("uncited measurement artifact"));
		const decisionJson = JSON.stringify(decision);
		const decisionDigest = sha256(decisionJson);
		fs.writeFileSync(fullDecisionPath, decisionJson);

		const fullMarkdownPath = path.join(digestBundle.root, link.decision.markdownPath);
		const markdown = fs
			.readFileSync(fullMarkdownPath, "utf8")
			.replace(`Decision JSON SHA-256: ${link.decision.jsonSha256}`, `Decision JSON SHA-256: ${decisionDigest}`);
		fs.writeFileSync(fullMarkdownPath, markdown);
		link.decision.jsonSha256 = decisionDigest;
		link.decision.markdownSha256 = sha256(markdown);
		fs.writeFileSync(fullLinkPath, JSON.stringify(link));
		expect
			.soft(() =>
				requirePhase2dDecisionConsumptionReady({ rootDirectory: digestBundle.root, linkPath: digestBundle.linkPath })
			)
			.toThrow(TypeError);
	});

	it("requires the finalized fresh S1/S2/S3 evidence, paired decision, and preimplementation 2d link in-repo", () => {
		expect(() =>
			requirePhase2dDecisionConsumptionReady({ rootDirectory: PACKAGE_DIRECTORY, linkPath: S4_LINK_PATH })
		).not.toThrow();
	});
});
