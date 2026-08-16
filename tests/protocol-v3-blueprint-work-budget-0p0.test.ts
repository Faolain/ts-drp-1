import { encodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import legacyContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import contract from "./fixtures/phase-0p0-v3/blueprint-work-budget-contract.json" with { type: "json" };
import { auditSuccessorWorkflowRouting } from "./fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.js";
import successorContract from "./fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json" with { type: "json" };

interface BlueprintPreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
}

interface PreparedBlueprintAdmission {
	readonly blueprintDigest: string;
}

interface BlueprintSurface {
	prepareBlueprintAdmission?(input: BlueprintPreparationInput): PreparedBlueprintAdmission;
}

type BlueprintPackage = typeof contract.budgetedPackage;
type BudgetedOperation = BlueprintPackage["manifest"]["operations"][number];

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const IMPLEMENTATION =
	process.env.PHASE_0P0_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(REPOSITORY_ROOT, process.env.PHASE_0P0_IMPLEMENTATION_MODULE);
const surfaceLoad = import(pathToFileURL(IMPLEMENTATION).href) as Promise<BlueprintSurface>;
const encoder = new TextEncoder();

function clonePackage(): BlueprintPackage {
	return structuredClone(contract.budgetedPackage);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsignedBigEndian(value: number, bytes: 4 | 8): Uint8Array {
	const output = new Uint8Array(bytes);
	const view = new DataView(output.buffer);
	if (bytes === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

function independentDigest(bytes: Uint8Array): string {
	const domain = encoder.encode(contract.blueprintDigestDomain);
	return createHash("sha256")
		.update(
			concat([
				Uint8Array.from([0x44, 0x52, 0x50, 0]),
				unsignedBigEndian(domain.byteLength, 4),
				domain,
				unsignedBigEndian(bytes.byteLength, 8),
				bytes,
			])
		)
		.digest("hex");
}

async function requirePreparer(): Promise<NonNullable<BlueprintSurface["prepareBlueprintAdmission"]>> {
	const surface = await surfaceLoad;
	if (typeof surface.prepareBlueprintAdmission !== "function") {
		throw new Error("PHASE_0P0_MISSING_EXPORT:prepareBlueprintAdmission");
	}
	return surface.prepareBlueprintAdmission;
}

function preparedInput(packageValue: unknown): BlueprintPreparationInput {
	const canonicalBlueprintPackageBytes = encodeCanonical(packageValue);
	return {
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: independentDigest(canonicalBlueprintPackageBytes),
	};
}

async function expectRejects(packageValue: unknown): Promise<void> {
	const prepare = await requirePreparer();
	expect(() => prepare(preparedInput(packageValue))).toThrow();
}

async function expectPrepares(packageValue: unknown): Promise<PreparedBlueprintAdmission> {
	const prepare = await requirePreparer();
	const input = preparedInput(packageValue);
	const prepared = prepare(input);
	expect(prepared).toEqual({ blueprintDigest: input.expectedBlueprintDigest });
	expect(Object.isFrozen(prepared)).toBe(true);
	return prepared;
}

function operationAt(packageValue: BlueprintPackage, index: number): BudgetedOperation {
	const operation = packageValue.manifest.operations[index];
	if (operation === undefined) throw new Error(`fixture operation ${index} is absent`);
	return operation;
}

function sha256File(relativePath: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(REPOSITORY_ROOT, relativePath)))
		.digest("hex");
}

describe("Phase 0p-0 additive blueprint work-budget governance causal RED", () => {
	it("[governance] freezes an additive schema-only v3 supplement and explicit non-enforcement boundary", () => {
		const supplement = resolve(CURRENT_DIRECTORY, contract.supplementDirectory);
		expect(existsSync(supplement)).toBe(true);
		expect(readdirSync(supplement).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(supplement, "profile.json"), "utf8")) as Record<string, unknown>;
		expect(profile).toMatchObject({
			budgetedManifestSchemaVersion: 2,
			legacyManifestSchemaVersion: 1,
			packageSchemaVersion: 1,
			profileId: contract.profileId,
			binding: {
				includesMaxCanonicalOperationBytes: true,
				includesOperationDiscriminator: true,
				includesOperationIdentity: true,
				preimage: "exact-canonical-whole-blueprint-package-bytes",
				separateBudgetDigest: false,
			},
			claims: {
				operationByteEnforcement: false,
				parametersRegistryChange: false,
				protocolV2Change: false,
				reducerInvocation: false,
				wallClockOrInstructionMeter: false,
			},
		});
		const specification = readFileSync(resolve(supplement, "spec.md"), "utf8");
		for (const phrase of [
			"Existing manifest schema 1 remains valid and byte-for-byte unchanged",
			"positive safe integer",
			"exact canonical whole blueprint package bytes",
			"operation discriminator",
			"no second budget digest",
			"does not measure an operation",
			"Phase 0p-2",
			"frozen seven-field `parameters` kind is unchanged",
		]) {
			expect(specification).toContain(phrase);
		}
		const workflow = readFileSync(resolve(REPOSITORY_ROOT, contract.workflow), "utf8");
		for (const phrase of [
			"permissions:\n  contents: read",
			"timeout-minutes: 10",
			"PHASE_0P0_IMPLEMENTATION_MODULE",
			"--no-coverage --maxWorkers=1 --minWorkers=1",
			"protocol-v3-blueprint-admission-0i.test.ts",
			"protocol-v3-independent-reference-vectors-n1prime-c2.test.ts",
		]) {
			expect(workflow).toContain(phrase);
		}
		const workflowIdentity = successorContract.workflowIdentities.find(({ path }) => path === contract.workflow);
		expect(workflowIdentity).toBeDefined();
		if (workflowIdentity === undefined) throw new Error("work workflow identity is absent");
		expect(
			auditSuccessorWorkflowRouting(
				workflow,
				workflowIdentity,
				successorContract.predecessors.map(({ checker }) => checker)
			)
		).toEqual([]);
	});

	it("[canonical-positive] prepares the pinned manifest-v2 package under the existing whole-package digest", async () => {
		const bytes = encodeCanonical(contract.budgetedPackage);
		expect(bytes.byteLength).toBe(contract.expectedCanonicalByteLength);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(contract.expectedCanonicalSha256);
		expect(independentDigest(bytes)).toBe(contract.expectedBlueprintDigest);
		await expectPrepares(contract.budgetedPackage);
	});

	it("[limit-binding] changing only maxCanonicalOperationBytes changes blueprintDigest", async () => {
		const changed = clonePackage();
		operationAt(changed, 0).maxCanonicalOperationBytes = 4097;
		const originalInput = preparedInput(contract.budgetedPackage);
		const changedInput = preparedInput(changed);
		expect(changedInput.expectedBlueprintDigest).not.toBe(originalInput.expectedBlueprintDigest);
		await expectPrepares(changed);
	});

	it("[operation-identity-binding] changing or omitting a manifest operation changes blueprintDigest", async () => {
		const renamed = clonePackage();
		operationAt(renamed, 0).name = "append2";
		const omitted = clonePackage();
		omitted.manifest.operations.splice(2, 1);
		const baseDigest = preparedInput(contract.budgetedPackage).expectedBlueprintDigest;
		expect(preparedInput(renamed).expectedBlueprintDigest).not.toBe(baseDigest);
		expect(preparedInput(omitted).expectedBlueprintDigest).not.toBe(baseDigest);
		await expectPrepares(renamed);
		await expectPrepares(omitted);
	});

	it("[discriminator-binding] changing the declared discriminator changes blueprintDigest", async () => {
		const changed = clonePackage();
		changed.manifest.operationDiscriminator = "kind";
		const changedDigest = preparedInput(changed).expectedBlueprintDigest;
		expect(changedDigest).not.toBe(preparedInput(contract.budgetedPackage).expectedBlueprintDigest);
		await expectPrepares(changed);
	});

	it("[required-fields] rejects omitted profile, operation identity and per-operation limit", async () => {
		const profileOmitted = clonePackage() as unknown as Record<string, unknown>;
		delete (profileOmitted.manifest as Record<string, unknown>).workBudgetProfile;
		const nameOmitted = clonePackage();
		delete (operationAt(nameOmitted, 0) as Partial<BudgetedOperation>).name;
		const limitOmitted = clonePackage();
		delete (operationAt(limitOmitted, 0) as Partial<BudgetedOperation>).maxCanonicalOperationBytes;
		await expectRejects(profileOmitted);
		await expectRejects(nameOmitted);
		await expectRejects(limitOmitted);
	});

	it("[closed-unique-schema] rejects duplicate operations, unknown fields and wrong profile identity", async () => {
		const duplicate = clonePackage();
		operationAt(duplicate, 1).name = operationAt(duplicate, 0).name;
		const unknownManifest = clonePackage() as unknown as {
			manifest: Record<string, unknown>;
		};
		unknownManifest.manifest.unexpectedBudgetAuthority = true;
		const unknownOperation = clonePackage();
		(operationAt(unknownOperation, 0) as unknown as Record<string, unknown>).rawFrameBytes = 4096;
		const wrongProfile = clonePackage();
		wrongProfile.manifest.workBudgetProfile = "caller-budget-v1";
		await expectRejects(duplicate);
		await expectRejects(unknownManifest);
		await expectRejects(unknownOperation);
		await expectRejects(wrongProfile);
	});

	it("[limit-domain] rejects zero, negative, fractional, unsafe and nonnumeric limits", async () => {
		for (const malformed of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4096", null]) {
			const packageValue = clonePackage();
			(operationAt(packageValue, 0) as { maxCanonicalOperationBytes: unknown }).maxCanonicalOperationBytes = malformed;
			await expectRejects(packageValue);
		}
	});

	it("[legacy-v1-forward-only] preserves manifest-v1 preparation and rejects protocol-v2/package-version drift", async () => {
		await expectPrepares(legacyContract.package);
		const protocolV2 = clonePackage();
		protocolV2.protocolMajor = 2;
		const packageVersionBump = clonePackage();
		packageVersionBump.schemaVersion = 2;
		await expectRejects(protocolV2);
		await expectRejects(packageVersionBump);
	});

	it("[canonical-only] rejects a noncanonical byte carrier before schema preparation", async () => {
		const prepare = await requirePreparer();
		const input = preparedInput(contract.budgetedPackage);
		const trailing = new Uint8Array(input.canonicalBlueprintPackageBytes.byteLength + 1);
		trailing.set(input.canonicalBlueprintPackageBytes);
		trailing[trailing.length - 1] = 0;
		expect(() =>
			prepare({
				canonicalBlueprintPackageBytes: trailing,
				expectedBlueprintDigest: independentDigest(trailing),
			})
		).toThrow();
	});

	it("[protected-predecessors] preserves parameters, registries, vectors and regenerated references byte-for-byte", () => {
		for (const [path, expected] of Object.entries(contract.protectedArtifactSha256)) {
			expect(sha256File(path), path).toBe(expected);
		}
		const registry = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json"), "utf8")
		) as {
			kinds: { parameters: { fields: Array<{ name: string }> } };
		};
		expect(registry.kinds.parameters.fields.map(({ name }) => name)).toEqual([
			"maxEpochVertices",
			"maxEpochBytes",
			"maxDependencies",
			"snapshotChunkBytes",
			"maxSnapshotBytes",
			"maxPendingEntries",
			"maxPendingBytes",
		]);
		expect(registry.kinds.parameters.fields).toHaveLength(7);
	});

	it("[public-surface] keeps governance inside the existing preparer with no new runtime helper export", async () => {
		const publicEntry = (await import("../packages/protocol-v3/src/public.ts")) as Record<string, unknown>;
		expect(Object.keys(publicEntry).sort()).toEqual([
			"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
			"admitReceivedVertex",
			"authenticateCurrentEpochAnchor",
			"createAdmissionBoundTransactionalVertexIssuer",
			"extractAdmittedReceivedVertex",
			"installCreatorAnchorTrustRoot",
			"isAnchorTrustStateRecordBytes",
			"openCurrentAnchorTrust",
			"prepareBlueprintAdmission",
			"prepareBlueprintRuntime",
		]);
		expect(publicEntry).not.toHaveProperty("measureCanonicalOperationBytes");
		expect(publicEntry).not.toHaveProperty("enforceBlueprintWorkBudget");
	});
});
