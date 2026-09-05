import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import amendmentLogDocument from "../../../docs/protocol/amendments-v2.json" with { type: "json" };
import registryDocument from "../registry/field-registry.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const registryPath = "packages/protocol-v2/registry/field-registry.json";
const amendmentLogPath = "docs/protocol/amendments-v2.json";
const modelSourcePath = "packages/protocol-v2/formal/ahe-v2-signed-envelope-variables.qnt";
const variableMapPath = "packages/protocol-v2/formal/ahe-v2-variable-map.json";
const signoffPath = "packages/protocol-v2/formal/ahe-v2-variable-signoff.json";
const checkerPath = "packages/protocol-v2/tests/formal-model-variable-signoff.test.ts";

interface RegistryField {
	name: string;
}

interface RegistryKind {
	fields: RegistryField[];
}

interface ClassificationSource {
	envelopeKind: SignedEnvelopeKind;
	evidence: string;
}

interface FieldMapping {
	envelopeKind: SignedEnvelopeKind;
	field: string;
	modelVariable: string;
	registryPath: string;
}

interface Provenance {
	path: string;
	sha256: string;
}

interface VariableMap {
	amendmentLog: Provenance & { amendmentLogVersion: string };
	classificationSources: ClassificationSource[];
	fieldMappings: FieldMapping[];
	modelSource: Provenance;
	protocolMajor: number;
	registry: Provenance & { registryVersion: number };
	schemaVersion: string;
	signedEnvelopeKinds: SignedEnvelopeKind[];
}

interface VariableSignoff {
	checker: Provenance & {
		algorithm: string;
		contractTest: string;
	};
	decision: string;
	recordedAt: string;
	recordType: string;
	reviewedArtifacts: Provenance[];
	reviewedFieldIdentities: string[];
	schemaVersion: string;
	status: string;
}

const registry = registryDocument as unknown as {
	kinds: Record<string, RegistryKind>;
	protocolMajor: number;
	registryVersion: number;
};

const amendmentLog = amendmentLogDocument as {
	amendmentLogVersion: string;
};

/*
 * Registry v5 does not carry a "signed" flag, so signed-envelope kind selection
 * is a normative classification, not something this test pretends to infer
 * from registry metadata. D12 names vertex and SealVote signature suites; D10
 * requires the epoch anchor's profile/suite binding to be signed; and the
 * normative pacemaker defines signed round-change votes whose preimage is D06.
 * SealProposal and SealQC are bound proposal/certificate structures, but the
 * frozen sources do not define them as independently signed envelopes.
 *
 * Once those four kinds are selected, every required field below is derived
 * mechanically and in order from field-registry.json.
 */
const signedEnvelopeKinds = ["vertex", "epochAnchor", "sealVote", "roundChange"] as const;
type SignedEnvelopeKind = (typeof signedEnvelopeKinds)[number];

const classificationSources: ClassificationSource[] = [
	{
		envelopeKind: "vertex",
		evidence: "PH-N1-D12.requirements.activeSuites.identityAndVertex",
	},
	{
		envelopeKind: "epochAnchor",
		evidence: "PH-N1-D10.requirements.profileDigestAndCryptoSuiteIdSignedIn",
	},
	{
		envelopeKind: "sealVote",
		evidence: "PH-N1-D12.requirements.activeSuites.sealVote",
	},
	{
		envelopeKind: "roundChange",
		evidence: "production-hardening-tdd-plan-v2.md#the-normative-pacemaker:signed-round-change-votes",
	},
];

const artifactPaths = [modelSourcePath, variableMapPath, signoffPath] as const;
const greenArtifactsExist = artifactPaths.every((path) => existsSync(absolutePath(path)));

function absolutePath(path: string): string {
	return `${repositoryRoot}/${path}`;
}

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(absolutePath(path)))
		.digest("hex");
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(absolutePath(path), "utf8")) as T;
}

function stripQuintComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
}

function declaredQuintVariables(source: string): string[] {
	return Array.from(
		stripQuintComments(source).matchAll(/^\s*var\s+([A-Za-z][A-Za-z0-9_]*)\s*:/gmu),
		(match) => match[1]
	);
}

function requiredFieldMappings(): Array<Pick<FieldMapping, "envelopeKind" | "field" | "registryPath">> {
	return signedEnvelopeKinds.flatMap((envelopeKind) =>
		registry.kinds[envelopeKind].fields.map(({ name }, index) => ({
			envelopeKind,
			field: name,
			registryPath: `kinds.${envelopeKind}.fields[${index}]`,
		}))
	);
}

function fieldIdentity(mapping: Pick<FieldMapping, "envelopeKind" | "field">): string {
	return `${mapping.envelopeKind}.${mapping.field}`;
}

describe("Phase -1 formal-model variable-set sign-off", () => {
	it("requires model source, its registry mapping, and a separate mechanical sign-off record", () => {
		const missingArtifacts = artifactPaths.filter((path) => !existsSync(absolutePath(path)));

		expect(
			missingArtifacts,
			"Phase -1 remains blocked: GREEN must add a real Quint declaration source, an exact registry mapping, and a hash-bound mechanical sign-off"
		).toEqual([]);
	});

	it.runIf(greenArtifactsExist)(
		"maps every registry-derived signed-envelope field one-to-one to an actual Quint variable",
		() => {
			const variableMap = readJson<VariableMap>(variableMapPath);
			const requiredMappings = requiredFieldMappings();
			const requiredIdentities = requiredMappings.map(fieldIdentity);
			const actualIdentities = variableMap.fieldMappings.map(fieldIdentity);
			const modelVariables = declaredQuintVariables(readFileSync(absolutePath(modelSourcePath), "utf8"));
			const mappedVariables = variableMap.fieldMappings.map(({ modelVariable }) => modelVariable);
			const quintTypecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", modelSourcePath], {
				cwd: repositoryRoot,
				encoding: "utf8",
			});

			expect(variableMap).toMatchObject({
				schemaVersion: "ahe-formal-variable-map-v1",
				protocolMajor: registry.protocolMajor,
				signedEnvelopeKinds: [...signedEnvelopeKinds],
				classificationSources,
				registry: {
					path: registryPath,
					registryVersion: registry.registryVersion,
					sha256: sha256(registryPath),
				},
				amendmentLog: {
					path: amendmentLogPath,
					amendmentLogVersion: amendmentLog.amendmentLogVersion,
					sha256: sha256(amendmentLogPath),
				},
				modelSource: {
					path: modelSourcePath,
					sha256: sha256(modelSourcePath),
				},
			});
			expect(
				quintTypecheck.status,
				`the project-local pinned Quint CLI must parse and typecheck the actual model source\n${quintTypecheck.stdout}\n${quintTypecheck.stderr}`
			).toBe(0);

			expect(
				variableMap.fieldMappings.map(({ envelopeKind, field, registryPath: path }) => ({
					envelopeKind,
					field,
					registryPath: path,
				}))
			).toEqual(requiredMappings);
			expect(new Set(actualIdentities).size, "duplicate signed-envelope field mapping").toBe(actualIdentities.length);
			expect(actualIdentities, "missing or extra registry-derived signed-envelope fields").toEqual(requiredIdentities);
			expect(new Set(mappedVariables).size, "one model variable cannot stand in for multiple signed fields").toBe(
				mappedVariables.length
			);
			expect(new Set(modelVariables).size, "duplicate Quint variable declaration").toBe(modelVariables.length);
			expect(modelVariables, "the actual Quint variable set must exactly match the mapped registry fields").toEqual(
				mappedVariables
			);
		}
	);

	it.runIf(greenArtifactsExist)("requires an explicit mechanical decision over the exact hash-pinned field set", () => {
		const variableMap = readJson<VariableMap>(variableMapPath);
		const signoff = readJson<VariableSignoff>(signoffPath);
		const requiredIdentities = requiredFieldMappings().map(fieldIdentity);

		expect(signoff).toMatchObject({
			schemaVersion: "ahe-formal-variable-signoff-v1",
			recordType: "mechanical",
			status: "complete",
			decision: "phase-n1-formal-variable-set-complete",
			checker: {
				algorithm: "exact-registry-field-to-quint-variable-bijection-v1",
				contractTest: "Phase -1 formal-model variable-set sign-off",
				path: checkerPath,
				sha256: sha256(checkerPath),
			},
			reviewedArtifacts: [
				{ path: registryPath, sha256: sha256(registryPath) },
				{ path: amendmentLogPath, sha256: sha256(amendmentLogPath) },
				{ path: modelSourcePath, sha256: sha256(modelSourcePath) },
				{ path: variableMapPath, sha256: sha256(variableMapPath) },
				{ path: checkerPath, sha256: sha256(checkerPath) },
			],
			reviewedFieldIdentities: requiredIdentities,
		});
		expect(variableMap.fieldMappings.map(fieldIdentity)).toEqual(signoff.reviewedFieldIdentities);
		expect(Number.isNaN(Date.parse(signoff.recordedAt)), "recordedAt must be an ISO-8601 timestamp").toBe(false);
		expect(new Date(signoff.recordedAt).toISOString()).toBe(signoff.recordedAt);
	});
});
