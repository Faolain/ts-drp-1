import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contractDocument from "./fixtures/phase-n1prime-b2b/codec-grammar-decision-contract.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface Provenance {
	path: string;
	sha256: string;
}

interface DecisionRecord {
	decision: number;
	decisionType: string;
	id: string;
	normativeSource: string;
	registryPaths: string[];
	requirements: Record<string, unknown>;
	status: string;
}

interface DecisionBinding {
	decisionId: string;
	decisionType: string;
	normativeSource?: string;
	registryPaths: string[];
}

interface Registry {
	codec: Record<string, unknown>;
	decisionBindings: DecisionBinding[];
	endianness: string;
	framing: Record<string, unknown>;
}

interface AmendmentLog {
	entries: DecisionRecord[];
}

interface Signoff {
	reviewedArtifacts: Provenance[];
	[key: string]: unknown;
}

interface Tuple {
	amendments: AmendmentLog;
	registry: Registry;
	signoff: Signoff;
	specification: string;
	specificationRecords: DecisionRecord[];
}

interface Contract {
	decision: DecisionRecord;
	historicalDecisions: {
		decisionRecordSha256: string[];
		idsInOrder: string[];
		registryBindingSha256: string[];
	};
	notice: string;
	preGreenTargetHashes: Record<string, string>;
	protectedArtifacts: Record<string, string>;
	signoff: {
		changedReviewedPaths: string[];
		nonHashContentSha256: string;
		reviewedPathsInOrder: string[];
		unchangedReviewedHashes: Record<string, string>;
	};
	status: string;
	targets: {
		amendments: string;
		registry: string;
		signoff: string;
		specification: string;
	};
}

const contract = contractDocument as Contract;
const expectedDecisionIds = [...contract.historicalDecisions.idsInOrder, contract.decision.id];
const expectedDecisionNumbers = expectedDecisionIds.map((_, index) => index + 1);
const expectedAnchor = "decision-v3-07";
const expectedAnchorMarker = `<a id="${expectedAnchor}"></a>`;
const expectedRegistryBinding: DecisionBinding = {
	decisionId: contract.decision.id,
	decisionType: contract.decision.decisionType,
	normativeSource: contract.decision.normativeSource,
	registryPaths: contract.decision.registryPaths,
};

function absolutePath(path: string): string {
	return resolve(repositoryRoot, path);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(absolutePath(path), "utf8")) as T;
}

function sha256Bytes(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
	return sha256Bytes(readFileSync(absolutePath(path)));
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)])
		);
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function semanticSha256(value: unknown): string {
	return sha256Bytes(stableJson(value));
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function extractNormativeDecisionRecords(markdown: string): DecisionRecord[] {
	return [...markdown.matchAll(/```json normative-decision\s*\n([\s\S]*?)\n```/gu)].map(
		([, json]) => JSON.parse(json) as DecisionRecord
	);
}

function recordAfterAnchor(markdown: string, marker: string): DecisionRecord | undefined {
	const markerIndex = markdown.indexOf(marker);
	if (markerIndex < 0 || markdown.indexOf(marker, markerIndex + marker.length) >= 0) {
		return undefined;
	}
	const fenceStart = markdown.indexOf("```json normative-decision", markerIndex + marker.length);
	const fenceEnd = markdown.indexOf("\n```", fenceStart);
	if (fenceStart < 0 || fenceEnd < 0) {
		return undefined;
	}
	const jsonStart = markdown.indexOf("\n", fenceStart) + 1;
	try {
		return JSON.parse(markdown.slice(jsonStart, fenceEnd)) as DecisionRecord;
	} catch {
		return undefined;
	}
}

function readRegistryPath(registry: Registry, path: string): unknown {
	return path.split(".").reduce<unknown>((value, segment) => {
		if (value === null || typeof value !== "object") {
			return undefined;
		}
		return (value as Record<string, unknown>)[segment];
	}, registry);
}

function actualReviewedHashes(): Record<string, string> {
	return Object.fromEntries(contract.signoff.reviewedPathsInOrder.map((path) => [path, sha256File(path)]));
}

function historicalErrors(tuple: Tuple): string[] {
	const errors: string[] = [];
	const bindings = tuple.registry.decisionBindings.slice(0, 6);
	const amendments = tuple.amendments.entries.slice(0, 6);
	const specification = tuple.specificationRecords.slice(0, 6);
	if (
		stableJson(bindings.map(({ decisionId }) => decisionId)) !== stableJson(contract.historicalDecisions.idsInOrder)
	) {
		errors.push("historical D01-D06 registry order changed");
	}
	if (stableJson(amendments.map(({ id }) => id)) !== stableJson(contract.historicalDecisions.idsInOrder)) {
		errors.push("historical D01-D06 amendment order changed");
	}
	if (stableJson(specification.map(({ id }) => id)) !== stableJson(contract.historicalDecisions.idsInOrder)) {
		errors.push("historical D01-D06 specification order changed");
	}
	if (stableJson(bindings.map(semanticSha256)) !== stableJson(contract.historicalDecisions.registryBindingSha256)) {
		errors.push("historical D01-D06 registry binding content changed");
	}
	if (stableJson(amendments.map(semanticSha256)) !== stableJson(contract.historicalDecisions.decisionRecordSha256)) {
		errors.push("historical D01-D06 amendment content changed");
	}
	if (stableJson(specification.map(semanticSha256)) !== stableJson(contract.historicalDecisions.decisionRecordSha256)) {
		errors.push("historical D01-D06 specification content changed");
	}
	return errors;
}

function validateD07Tuple(
	tuple: Tuple,
	reviewedHashes: Record<string, string>,
	enforcePreGreenTransition: boolean
): string[] {
	const errors = historicalErrors(tuple);
	const bindings = tuple.registry.decisionBindings;
	const amendments = tuple.amendments.entries;
	const specification = tuple.specificationRecords;
	const d07Bindings = bindings.filter(({ decisionId }) => decisionId === contract.decision.id);
	const d07Amendments = amendments.filter(({ id }) => id === contract.decision.id);
	const d07Specifications = specification.filter(({ id }) => id === contract.decision.id);
	if (d07Bindings.length === 0 && d07Amendments.length === 0 && d07Specifications.length === 0) {
		return [...errors, "D07 decision triple and normative anchor are absent"];
	}

	if (stableJson(bindings.map(({ decisionId }) => decisionId)) !== stableJson(expectedDecisionIds)) {
		errors.push("registry decisions are not exactly historical D01-D06 followed by D07");
	}
	if (stableJson(amendments.map(({ id }) => id)) !== stableJson(expectedDecisionIds)) {
		errors.push("amendments are not exactly historical D01-D06 followed by D07");
	}
	if (stableJson(specification.map(({ id }) => id)) !== stableJson(expectedDecisionIds)) {
		errors.push("specification decisions are not exactly historical D01-D06 followed by D07");
	}
	if (stableJson(amendments.map(({ decision }) => decision)) !== stableJson(expectedDecisionNumbers)) {
		errors.push("amendment decision numbers are not unique and consecutive through 7");
	}
	if (stableJson(specification.map(({ decision }) => decision)) !== stableJson(expectedDecisionNumbers)) {
		errors.push("specification decision numbers are not unique and consecutive through 7");
	}

	if (d07Bindings.length !== 1 || stableJson(d07Bindings[0]) !== stableJson(expectedRegistryBinding)) {
		errors.push("D07 registry binding is absent, duplicate, or incoherent");
	}
	if (d07Amendments.length !== 1 || stableJson(d07Amendments[0]) !== stableJson(contract.decision)) {
		errors.push("D07 amendment is absent, duplicate, or differs from the frozen contract");
	}
	if (d07Specifications.length !== 1 || stableJson(d07Specifications[0]) !== stableJson(contract.decision)) {
		errors.push("D07 specification is absent, duplicate, or differs from the frozen contract");
	}
	if (
		d07Amendments.length === 1 &&
		d07Specifications.length === 1 &&
		stableJson(d07Amendments[0]) !== stableJson(d07Specifications[0])
	) {
		errors.push("D07 amendment and specification records differ");
	}
	if (stableJson(recordAfterAnchor(tuple.specification, expectedAnchorMarker)) !== stableJson(contract.decision)) {
		errors.push("D07 normativeSource anchor does not resolve to its exact structured decision");
	}
	if (
		d07Bindings[0]?.normativeSource !== contract.decision.normativeSource ||
		d07Amendments[0]?.normativeSource !== contract.decision.normativeSource ||
		d07Specifications[0]?.normativeSource !== contract.decision.normativeSource
	) {
		errors.push("D07 normativeSource is not identical across registry, amendment, and specification");
	}
	if (
		stableJson(d07Bindings[0]?.registryPaths) !== stableJson(contract.decision.registryPaths) ||
		stableJson(d07Amendments[0]?.registryPaths) !== stableJson(contract.decision.registryPaths) ||
		stableJson(d07Specifications[0]?.registryPaths) !== stableJson(contract.decision.registryPaths)
	) {
		errors.push("D07 registryPaths are not identical codec/framing/endianness bindings");
	}

	const expectedRegistryValues = d07Amendments[0]?.requirements.registryValues as Record<string, unknown> | undefined;
	for (const path of contract.decision.registryPaths) {
		if (
			expectedRegistryValues === undefined ||
			stableJson(readRegistryPath(tuple.registry, path)) !== stableJson(expectedRegistryValues[path])
		) {
			errors.push(`D07 ${path} requirements do not exactly bind the registry value`);
		}
	}

	for (const requirementKey of ["authoritativeGrammar", "machineCompanion"] as const) {
		const provenance = d07Amendments[0]?.requirements[requirementKey] as Provenance | undefined;
		if (provenance === undefined || typeof provenance.path !== "string" || typeof provenance.sha256 !== "string") {
			errors.push(`D07 ${requirementKey} path/hash does not resolve to the accepted grammar tuple`);
			continue;
		}
		const resolvedPath = resolve(dirname(absolutePath(contract.targets.specification)), provenance.path);
		const actualHash = sha256Bytes(readFileSync(resolvedPath));
		if (actualHash !== provenance.sha256) {
			errors.push(`D07 ${requirementKey} path/hash does not resolve to the accepted grammar tuple`);
		}
	}
	if (
		d07Amendments[0]?.requirements.workedExamples !== "binding-conformance-examples-never-override-production-rules"
	) {
		errors.push("D07 does not subordinate worked examples to authoritative production rules");
	}

	const reviewedPaths = tuple.signoff.reviewedArtifacts.map(({ path }) => path);
	if (stableJson(reviewedPaths) !== stableJson(contract.signoff.reviewedPathsInOrder)) {
		errors.push("sign-off reviewed paths changed instead of refreshing only existing outward hashes");
	}
	const signoffWithoutReviewedArtifacts = clone(tuple.signoff);
	delete signoffWithoutReviewedArtifacts.reviewedArtifacts;
	if (semanticSha256(signoffWithoutReviewedArtifacts) !== contract.signoff.nonHashContentSha256) {
		errors.push("sign-off content other than outward reviewed-artifact hashes changed");
	}
	for (const reviewed of tuple.signoff.reviewedArtifacts) {
		if (reviewedHashes[reviewed.path] !== reviewed.sha256) {
			errors.push(`${reviewed.path}: sign-off carries a stale outward hash`);
		}
	}
	for (const [path, expectedHash] of Object.entries(contract.signoff.unchangedReviewedHashes)) {
		if (reviewedHashes[path] !== expectedHash) {
			errors.push(`${path}: b2b changed a protected schema/formal artifact`);
		}
		const reviewed = tuple.signoff.reviewedArtifacts.find((entry) => entry.path === path);
		if (reviewed?.sha256 !== expectedHash) {
			errors.push(`${path}: sign-off refreshed an unchanged artifact to a non-accepted hash`);
		}
	}

	if (enforcePreGreenTransition) {
		for (const path of contract.signoff.changedReviewedPaths) {
			if (reviewedHashes[path] === contract.preGreenTargetHashes[path]) {
				errors.push(`${path}: D07 did not change a required normative artifact`);
			}
		}
		if (sha256File(contract.targets.signoff) === contract.preGreenTargetHashes[contract.targets.signoff]) {
			errors.push("registry-model sign-off was not refreshed after the D07 normative changes");
		}
	}
	return errors;
}

function actualTuple(): Tuple {
	const specification = readFileSync(absolutePath(contract.targets.specification), "utf8");
	return {
		amendments: readJson<AmendmentLog>(contract.targets.amendments),
		registry: readJson<Registry>(contract.targets.registry),
		signoff: readJson<Signoff>(contract.targets.signoff),
		specification,
		specificationRecords: extractNormativeDecisionRecords(specification),
	};
}

function historicalEntryById<T>(entries: T[], id: string, readId: (entry: T) => string): T {
	const matches = entries.filter((entry) => readId(entry) === id);
	if (matches.length !== 1) {
		throw new TypeError(`${id}: illustrative control requires exactly one pinned historical entry`);
	}
	return clone(matches[0]);
}

function normativeDecisionBlock(record: DecisionRecord): string {
	const anchor = `decision-v3-${String(record.decision).padStart(2, "0")}`;
	return `<a id="${anchor}"></a>\n\n\`\`\`json normative-decision\n${JSON.stringify(record, null, "\t")}\n\`\`\``;
}

function illustrativeTuple(
	sourceTuple = actualTuple(),
	sourceReviewedHashes = actualReviewedHashes()
): { reviewedHashes: Record<string, string>; tuple: Tuple } {
	const tuple = clone(sourceTuple);
	tuple.registry.decisionBindings = contract.historicalDecisions.idsInOrder.map((id) =>
		historicalEntryById(tuple.registry.decisionBindings, id, ({ decisionId }) => decisionId)
	);
	tuple.amendments.entries = contract.historicalDecisions.idsInOrder.map((id) =>
		historicalEntryById(tuple.amendments.entries, id, ({ id: entryId }) => entryId)
	);
	tuple.specificationRecords = contract.historicalDecisions.idsInOrder.map((id) =>
		historicalEntryById(tuple.specificationRecords, id, ({ id: entryId }) => entryId)
	);
	tuple.specification = tuple.specificationRecords.map(normativeDecisionBlock).join("\n\n");
	const d07Json = JSON.stringify(contract.decision, null, "\t");
	tuple.registry.decisionBindings.push(clone(expectedRegistryBinding));
	tuple.amendments.entries.push(clone(contract.decision));
	tuple.specification += `\n\n${expectedAnchorMarker}\n\n\`\`\`json normative-decision\n${d07Json}\n\`\`\`\n`;
	tuple.specificationRecords.push(clone(contract.decision));
	return { reviewedHashes: sourceReviewedHashes, tuple };
}

describe("Phase -1 prime b2b D07 RED controls", () => {
	it("proves D01-D06 contain no prior numbered owner for codec, framing, or endianness", () => {
		const tuple = actualTuple();
		expect(contract.notice).toContain("NONNORMATIVE");
		expect(contract.status).toBe("NONNORMATIVE-RED-CONTRACT");
		expect(tuple.registry.decisionBindings.slice(0, 6).map(({ decisionId }) => decisionId)).toEqual(
			contract.historicalDecisions.idsInOrder
		);
		for (const path of contract.decision.registryPaths) {
			expect(
				tuple.registry.decisionBindings
					.slice(0, 6)
					.filter(({ registryPaths }) => registryPaths.includes(path))
					.map(({ decisionId }) => decisionId),
				`${path} unexpectedly already has a numbered D01-D06 owner`
			).toEqual([]);
		}
	});

	it("accepts one coherent illustrative D07 tuple and kills incoherence mutants", () => {
		const { reviewedHashes, tuple } = illustrativeTuple();
		expect(validateD07Tuple(tuple, reviewedHashes, false)).toEqual([]);

		const rebuiltFromSimulatedLive = illustrativeTuple(tuple, reviewedHashes);
		expect(validateD07Tuple(rebuiltFromSimulatedLive.tuple, rebuiltFromSimulatedLive.reviewedHashes, false)).toEqual(
			[]
		);
		expect(
			rebuiltFromSimulatedLive.tuple.registry.decisionBindings.filter(
				({ decisionId }) => decisionId === contract.decision.id
			)
		).toHaveLength(1);
		expect(
			rebuiltFromSimulatedLive.tuple.amendments.entries.filter(({ id }) => id === contract.decision.id)
		).toHaveLength(1);
		expect(
			rebuiltFromSimulatedLive.tuple.specificationRecords.filter(({ id }) => id === contract.decision.id)
		).toHaveLength(1);

		const missing = clone(tuple);
		missing.registry.decisionBindings.pop();
		expect(validateD07Tuple(missing, reviewedHashes, false)).toContain(
			"D07 registry binding is absent, duplicate, or incoherent"
		);

		const duplicate = clone(tuple);
		duplicate.registry.decisionBindings.push(clone(expectedRegistryBinding));
		duplicate.amendments.entries.push(clone(contract.decision));
		duplicate.specificationRecords.push(clone(contract.decision));
		duplicate.specification += `\n${normativeDecisionBlock(contract.decision)}\n`;
		expect(validateD07Tuple(duplicate, reviewedHashes, false)).toContain(
			"D07 registry binding is absent, duplicate, or incoherent"
		);
		expect(validateD07Tuple(duplicate, reviewedHashes, false)).toContain(
			"D07 amendment is absent, duplicate, or differs from the frozen contract"
		);
		expect(validateD07Tuple(duplicate, reviewedHashes, false)).toContain(
			"D07 specification is absent, duplicate, or differs from the frozen contract"
		);

		const mismatchedPaths = clone(tuple);
		mismatchedPaths.amendments.entries[6].registryPaths = ["codec"];
		expect(validateD07Tuple(mismatchedPaths, reviewedHashes, false)).toContain(
			"D07 registryPaths are not identical codec/framing/endianness bindings"
		);

		const staleGrammar = clone(tuple);
		(staleGrammar.amendments.entries[6].requirements.authoritativeGrammar as Provenance).sha256 = "0".repeat(64);
		expect(validateD07Tuple(staleGrammar, reviewedHashes, false)).toContain(
			"D07 amendment is absent, duplicate, or differs from the frozen contract"
		);

		const codecDrift = clone(tuple);
		codecDrift.registry.codec.id = "drp-canonical-profile-mutant";
		expect(validateD07Tuple(codecDrift, reviewedHashes, false)).toContain(
			"D07 codec requirements do not exactly bind the registry value"
		);

		const framingDrift = clone(tuple);
		framingDrift.registry.framing.domainLength = "U32LE";
		expect(validateD07Tuple(framingDrift, reviewedHashes, false)).toContain(
			"D07 framing requirements do not exactly bind the registry value"
		);

		const endianDrift = clone(tuple);
		endianDrift.registry.endianness = "little-endian";
		expect(validateD07Tuple(endianDrift, reviewedHashes, false)).toContain(
			"D07 endianness requirements do not exactly bind the registry value"
		);

		const examplesOverride = clone(tuple);
		examplesOverride.amendments.entries[6].requirements.workedExamples = "examples-override-productions";
		expect(validateD07Tuple(examplesOverride, reviewedHashes, false)).toContain(
			"D07 does not subordinate worked examples to authoritative production rules"
		);

		const sourceDrift = clone(tuple);
		sourceDrift.registry.decisionBindings[6].normativeSource = "./wrong.md#decision-v3-07";
		expect(validateD07Tuple(sourceDrift, reviewedHashes, false)).toContain(
			"D07 normativeSource is not identical across registry, amendment, and specification"
		);

		const reorderedHistory = clone(tuple);
		[reorderedHistory.amendments.entries[0], reorderedHistory.amendments.entries[1]] = [
			reorderedHistory.amendments.entries[1],
			reorderedHistory.amendments.entries[0],
		];
		expect(validateD07Tuple(reorderedHistory, reviewedHashes, false)).toContain(
			"historical D01-D06 amendment order changed"
		);

		const staleOutwardHash = clone(tuple);
		staleOutwardHash.signoff.reviewedArtifacts[0].sha256 = "f".repeat(64);
		expect(validateD07Tuple(staleOutwardHash, reviewedHashes, false)).toContain(
			`${contract.targets.registry}: sign-off carries a stale outward hash`
		);

		const signoffSemanticDrift = clone(tuple);
		signoffSemanticDrift.signoff.status = "mutant";
		expect(validateD07Tuple(signoffSemanticDrift, reviewedHashes, false)).toContain(
			"sign-off content other than outward reviewed-artifact hashes changed"
		);
	});

	it("pins accepted a/b/b2a tuples, the blocked c RED, and frozen v2 core artifacts byte-for-byte", () => {
		for (const [path, expectedHash] of Object.entries(contract.protectedArtifacts)) {
			expect(sha256File(path), path).toBe(expectedHash);
		}
		expect(basename(contract.targets.specification)).toBe("attested-hard-epochs-v5.md");
	});
});

describe("Phase -1 prime b2b D07 integration", () => {
	it("requires the exact codec-grammar decision triple and outward sign-off refresh", () => {
		expect(
			validateD07Tuple(actualTuple(), actualReviewedHashes(), true),
			"Phase -1 prime b2b remains RED until one coherent PH-N1P-D07 owns the accepted grammar"
		).toEqual([]);
	});
});
