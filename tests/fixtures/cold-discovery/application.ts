import { ed25519 } from "@noble/curves/ed25519.js";

import type { TrustedBlueprintCatalog } from "../../../packages/blueprint-catalog/dist/src/index.js";
import { encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";

export const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
export const author = hex(ed25519.getPublicKey(seed));
export const bootstrapOperation = Object.freeze({ action: "add", value: 0 });
export const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

/**
 * Hex encoding shared by trusted carriers and detached observations.
 * @param bytes
 */
export function hex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode an allowlisted trusted byte carrier, never snapshot material.
 * @param value
 */
export function unhex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new Error("INVALID_TRUSTED_HEX");
	return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

/**
 * Domain digest using the actual production canonical owner.
 * @param domain
 * @param bytes
 */
export function digest(domain: string, bytes: Uint8Array): string {
	return hex(hashDomain(domain, bytes));
}

/** A fixed arithmetic application; the catalog is host-trusted, as in inherited fixtures. */
export function application(): {
	catalog: TrustedBlueprintCatalog;
	canonicalBlueprintPackageBytes: Uint8Array;
	blueprintDigest: string;
} {
	const artifactId = "cold-discovery-counter.v1";
	const exactArtifactBytes = new TextEncoder().encode(
		`function acl(input){return {output:input.operation,state:input.state}}function add(input){return {output:input.state+input.operation.value,state:input.state+input.operation.value}}export const blueprint={exportSchemaVersion:1,artifactId:"${artifactId}",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{acl,add}};`
	);
	const artifactDigest = digest("ts-drp/blueprint-artifact/v3", exactArtifactBytes);
	const canonicalBlueprintPackageBytes = encodeCanonical({
		kind: "drp-blueprint-admission-package",
		protocolMajor: 3,
		schemaVersion: 1,
		implementation: { artifactId, artifactDigest, runtimeProfile: "ecmascript-2024-sync-v1" },
		manifest: {
			schemaVersion: 2,
			operationDiscriminator: "action",
			workBudgetProfile: "blueprint-work-budget-v1",
			operations: [
				{
					name: "acl",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: {
						kind: "closed-record",
						fields: [
							{ name: "group", required: true, type: "string" },
							{ name: "kind", required: true, type: "string" },
							{ name: "target", required: true, type: "string" },
						],
					},
				},
				{
					name: "add",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: { kind: "closed-record", fields: [{ name: "value", required: true, type: "safe-integer" }] },
				},
			],
		},
	});
	const blueprintDigest = digest("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes);
	const catalogDigest = digest("ts-drp/cold-discovery-fixture-catalog/v1", canonicalBlueprintPackageBytes);
	const resolved = Object.freeze({
		artifactDigest,
		artifactId,
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		runtimeProfile: "ecmascript-2024-sync-v1" as const,
		evidence: Object.freeze({
			catalogDigest,
			lintEvidenceDigest: "a".repeat(64),
			conformanceReceiptDigest: "b".repeat(64),
			conformanceDigest: "c".repeat(64),
			conformanceTier: "nightly" as const,
			conformanceResult: "passed" as const,
			engines: Object.freeze(
				(["node", "chromium", "firefox", "webkit"] as const).map((name) => ({ name, build: "fixture-trusted" }))
			),
		}),
	});
	return {
		canonicalBlueprintPackageBytes,
		blueprintDigest,
		catalog: Object.freeze({
			blueprintDigests: Object.freeze([blueprintDigest]),
			catalogDigest,
			resolve(requested: string): typeof resolved {
				if (requested !== blueprintDigest) throw new Error("UNKNOWN_FIXTURE_BLUEPRINT");
				return resolved;
			},
		}),
	};
}

/**
 * Actual detached Ed25519 signing; test callbacks may count calls.
 * @param bytes
 */
export function sign(bytes: Uint8Array): Promise<Uint8Array> {
	return Promise.resolve(ed25519.sign(bytes, seed));
}
