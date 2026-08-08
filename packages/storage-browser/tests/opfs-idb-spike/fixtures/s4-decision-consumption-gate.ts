import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type DecisionEvidence, parseSpikeEvidence, type SpikeEvidence } from "./evidence-schema.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const LINK_KEYS = ["schemaVersion", "gate", "status", "decision", "artifacts"] as const;
const DECISION_LINK_KEYS = ["jsonPath", "jsonSha256", "markdownPath", "markdownSha256"] as const;
const ARTIFACT_KEYS = ["strictIdb", "measurement", "clearControl"] as const;
const CITATION_KEYS = [
	"path",
	"sha256",
	"freshSuccessfulRun",
	"engine",
	"testOnlyForcedObservedDurability",
	"oracleStatus",
	"timingBasis",
	"scoringWeight",
] as const;
const ENGINE_KEYS = [
	"browserName",
	"browserVersion",
	"executableRevision",
	"userAgent",
	"operatingSystem",
	"playwrightVersion",
] as const;

type JsonRecord = Readonly<Record<string, unknown>>;

interface ArtifactCitation {
	readonly path: string;
	readonly sha256: string;
	readonly freshSuccessfulRun: true;
	readonly engine: Readonly<{
		readonly browserName: string;
		readonly browserVersion: string;
		readonly executableRevision: string;
		readonly userAgent: string;
		readonly operatingSystem: string;
		readonly playwrightVersion: string;
	}>;
	readonly testOnlyForcedObservedDurability: "absent" | "not-applicable";
	readonly oracleStatus: "pass" | "not-applicable";
	readonly timingBasis: "correctness-only" | "not-applicable";
	readonly scoringWeight: "none" | "decision-input";
}

interface DecisionLink {
	readonly schemaVersion: 1;
	readonly gate: "phase-2d-storage-substrate-decision-consumption";
	readonly status: "preimplementation-required-before-2d";
	readonly decision: Readonly<{
		readonly jsonPath: string;
		readonly jsonSha256: string;
		readonly markdownPath: string;
		readonly markdownSha256: string;
	}>;
	readonly artifacts: Readonly<{
		readonly strictIdb: ArtifactCitation;
		readonly measurement: ArtifactCitation;
		readonly clearControl: ArtifactCitation;
	}>;
}

export interface DecisionConsumptionGateOptions {
	readonly rootDirectory: string;
	readonly linkPath: string;
}

function closedRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new TypeError(`${label} must contain its exact fields`);
	}
	return value as JsonRecord;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty`);
	return value;
}

function digest(bytes: Buffer): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readExact(rootDirectory: string, relativePath: unknown, expectedDigest: unknown, label: string): Buffer {
	const relative = nonEmptyString(relativePath, `${label} path`);
	const pinnedDigest = nonEmptyString(expectedDigest, `${label} SHA-256`);
	if (!SHA256.test(pinnedDigest)) throw new TypeError(`${label} SHA-256 is malformed`);
	const root = path.resolve(rootDirectory);
	const resolved = path.resolve(root, relative);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new TypeError(`${label} path escapes the governed root`);
	}
	if (!fs.existsSync(resolved)) throw new TypeError(`${label} is missing at the cited path: ${relative}`);
	const bytes = fs.readFileSync(resolved);
	if (digest(bytes) !== pinnedDigest) throw new TypeError(`${label} exact-byte SHA-256 mismatch`);
	return bytes;
}

function parseCitation(value: unknown, label: string): ArtifactCitation {
	const citation = closedRecord(value, CITATION_KEYS, label);
	const engine = closedRecord(citation.engine, ENGINE_KEYS, `${label} engine identity`);
	for (const key of ENGINE_KEYS) nonEmptyString(engine[key], `${label} engine ${key}`);
	if (
		citation.freshSuccessfulRun !== true ||
		(citation.testOnlyForcedObservedDurability !== "absent" &&
			citation.testOnlyForcedObservedDurability !== "not-applicable") ||
		(citation.oracleStatus !== "pass" && citation.oracleStatus !== "not-applicable") ||
		(citation.timingBasis !== "correctness-only" && citation.timingBasis !== "not-applicable") ||
		(citation.scoringWeight !== "none" && citation.scoringWeight !== "decision-input")
	) {
		throw new TypeError(`${label} is not citable fresh successful evidence`);
	}
	return citation as unknown as ArtifactCitation;
}

function parseLink(bytes: Buffer): DecisionLink {
	const link = closedRecord(JSON.parse(bytes.toString("utf8")) as unknown, LINK_KEYS, "2d consumption link");
	const decision = closedRecord(link.decision, DECISION_LINK_KEYS, "decision pair link");
	const artifacts = closedRecord(link.artifacts, ARTIFACT_KEYS, "artifact citations");
	if (
		link.schemaVersion !== 1 ||
		link.gate !== "phase-2d-storage-substrate-decision-consumption" ||
		link.status !== "preimplementation-required-before-2d"
	) {
		throw new TypeError("2d consumption link is not the preimplementation readiness gate");
	}
	for (const key of DECISION_LINK_KEYS) nonEmptyString(decision[key], `decision pair ${key}`);
	return {
		schemaVersion: 1,
		gate: "phase-2d-storage-substrate-decision-consumption",
		status: "preimplementation-required-before-2d",
		decision: decision as unknown as DecisionLink["decision"],
		artifacts: {
			strictIdb: parseCitation(artifacts.strictIdb, "strict-IDB citation"),
			measurement: parseCitation(artifacts.measurement, "measurement citation"),
			clearControl: parseCitation(artifacts.clearControl, "clear-control citation"),
		},
	};
}

function requireArtifactKind<Kind extends SpikeEvidence["artifactKind"]>(
	value: SpikeEvidence,
	kind: Kind,
	label: string
): asserts value is Extract<SpikeEvidence, { readonly artifactKind: Kind }> {
	if (value.artifactKind !== kind) throw new TypeError(`${label} cites the wrong artifact kind`);
}

function requireDecisionContract(
	decision: DecisionEvidence,
	link: DecisionLink,
	markdown: string,
	decisionJsonDigest: string
): void {
	const { strictIdb, measurement, clearControl } = link.artifacts;
	if (
		!decision.custodyFateSharingSurface.includes("CryptoKey") ||
		!decision.custodyFateSharingSurface.includes("Phase-5")
	) {
		throw new TypeError("decision does not carry the Phase-5 CryptoKey custody fate-sharing consequence");
	}
	if (!decision.crashAtomicityMechanism.includes("benchmark proves no crash atomicity")) {
		throw new TypeError("decision overstates benchmark crash-atomicity evidence");
	}
	for (const risk of ["multi-tab", "custody", "crash", "real-pressure"]) {
		if (!decision.implementationRisk.includes(risk)) throw new TypeError(`decision omits implementation risk: ${risk}`);
	}
	if (!decision.measurementArtifactDigests.includes(measurement.sha256)) {
		throw new TypeError("decision does not cite the exact measurement artifact SHA-256");
	}
	const requiredConsequences = [
		"workload:generation/blob/pointer-swap-only",
		"vote-slot-parity:unmeasured-and-non-citable;owners:2d,5c;revisit:after-2d-and-5c-executable-vote-transaction",
		"timing-basis:correctness-only;asymmetric-unwarmed-opfs-first-raw-values-not-scored",
		`artifact-sha256:strict-idb-capability=${strictIdb.sha256}`,
		`artifact-sha256:substrate-measurement=${measurement.sha256}`,
		`artifact-sha256:bucket-clear-control=${clearControl.sha256}`,
	];
	for (const consequence of requiredConsequences) {
		if (!decision.consequences.includes(consequence))
			throw new TypeError(`decision consequence is missing: ${consequence}`);
	}
	if (decision.chosen === "opfs") {
		const opfsCas = decision.consequences.find((item) => item.startsWith("opfs-cas:"));
		if (
			opfsCas === undefined ||
			!opfsCas.includes("exact-byte insert-if-absent CAS") ||
			!opfsCas.includes("one strict IDB transaction") ||
			!opfsCas.includes("signer-state and outbox")
		) {
			throw new TypeError("OPFS choice lacks the reviewed 2d/5c CAS and strict-transaction consequence");
		}
	}
	for (const required of [
		`Chosen: ${decision.chosen}`,
		`Decision JSON SHA-256: ${decisionJsonDigest}`,
		`Strict IDB SHA-256: ${strictIdb.sha256}`,
		`Measurement SHA-256: ${measurement.sha256}`,
		`Clear control SHA-256: ${clearControl.sha256}`,
	]) {
		if (!markdown.includes(required)) throw new TypeError(`decision Markdown is not paired: missing ${required}`);
	}
}

/**
 * Executes the private Phase-2d preimplementation decision-consumption gate.
 * This validates evidence custody and linkage only; it defines no production 2d store schema.
 * @param options - Governed root and repo-relative link path.
 * @returns The closed, S0-parsed substrate decision when the link is ready.
 */
export function requirePhase2dDecisionConsumptionReady(options: DecisionConsumptionGateOptions): DecisionEvidence {
	const fullLinkPath = path.resolve(options.rootDirectory, options.linkPath);
	if (!fs.existsSync(fullLinkPath)) {
		throw new TypeError(`required preimplementation 2d consumption link is missing: ${options.linkPath}`);
	}
	const linkBytes = fs.readFileSync(fullLinkPath);
	const link = parseLink(linkBytes);
	const decisionJson = readExact(
		options.rootDirectory,
		link.decision.jsonPath,
		link.decision.jsonSha256,
		"decision JSON"
	);
	const decisionMarkdown = readExact(
		options.rootDirectory,
		link.decision.markdownPath,
		link.decision.markdownSha256,
		"decision Markdown"
	).toString("utf8");
	const strictIdb = readExact(
		options.rootDirectory,
		link.artifacts.strictIdb.path,
		link.artifacts.strictIdb.sha256,
		"strict-IDB artifact"
	);
	const measurement = readExact(
		options.rootDirectory,
		link.artifacts.measurement.path,
		link.artifacts.measurement.sha256,
		"measurement artifact"
	);
	const clearControl = readExact(
		options.rootDirectory,
		link.artifacts.clearControl.path,
		link.artifacts.clearControl.sha256,
		"clear-control artifact"
	);

	const strictEvidence = parseSpikeEvidence(JSON.parse(strictIdb.toString("utf8")) as unknown);
	const measurementEvidence = parseSpikeEvidence(JSON.parse(measurement.toString("utf8")) as unknown);
	const clearEvidence = parseSpikeEvidence(JSON.parse(clearControl.toString("utf8")) as unknown);
	const decision = parseSpikeEvidence(JSON.parse(decisionJson.toString("utf8")) as unknown);
	requireArtifactKind(strictEvidence, "strict-idb-capability", "strict-IDB citation");
	requireArtifactKind(measurementEvidence, "substrate-measurement", "measurement citation");
	requireArtifactKind(clearEvidence, "bucket-clear-control", "clear-control citation");
	requireArtifactKind(decision, "storage-substrate-decision", "decision pair");
	if (decision.artifactKind !== "storage-substrate-decision") throw new TypeError("decision kind narrowed incorrectly");

	const citations = link.artifacts;
	if (citations.strictIdb.testOnlyForcedObservedDurability !== "absent") {
		throw new TypeError("forced strict-IDB evidence is non-citable");
	}
	if (citations.strictIdb.oracleStatus !== "not-applicable" || citations.strictIdb.timingBasis !== "not-applicable") {
		throw new TypeError("strict-IDB citation carries benchmark claims");
	}
	if (
		citations.measurement.testOnlyForcedObservedDurability !== "not-applicable" ||
		citations.measurement.oracleStatus !== "pass" ||
		citations.measurement.timingBasis !== "correctness-only" ||
		citations.measurement.scoringWeight !== "decision-input"
	) {
		throw new TypeError("measurement citation is corrupt, oracle-failed, forced, or timing-selected");
	}
	if (
		citations.clearControl.testOnlyForcedObservedDurability !== "not-applicable" ||
		citations.clearControl.oracleStatus !== "not-applicable" ||
		citations.clearControl.timingBasis !== "not-applicable" ||
		citations.clearControl.scoringWeight !== "none"
	) {
		throw new TypeError("clear-control citation has non-zero scoring weight");
	}
	const engines = Object.values(citations).map(({ engine }) => JSON.stringify(engine));
	if (new Set(engines).size !== 1) throw new TypeError("cited artifacts do not share one full pinned engine identity");
	if (
		`${citations.measurement.engine.browserName}-${citations.measurement.engine.browserVersion}` !==
		measurementEvidence.engineBuild
	) {
		throw new TypeError("measurement engine build does not match the full pinned engine identity");
	}
	requireDecisionContract(decision, link, decisionMarkdown, link.decision.jsonSha256);
	return decision;
}
