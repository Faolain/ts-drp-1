import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { TrustedBlueprintCatalog } from "../../../packages/blueprint-catalog/src/index.js";
import packageGolden from "../track-p2-b/forward-counter-package.json" with { type: "json" };

export const APPLICATION_BATCH_LIMITS = Object.freeze({
	maxBytes: 65_536,
	maxDepth: 8,
	maxItems: 1_024,
});

export interface ApplicationBatchEntry {
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
}

export interface AcceptedOperationFact {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

const COUNTER_BATCH_ARTIFACT_SOURCE = `function addReducer(input){const value=input.operation.value??1;const state=input.state+value;return {output:state,state}}function applicationBatchReducer(input){let state=input.state;const output=[];for(const entry of input.operation.batch.entries){const operation=entry.operation;if(operation.action==="add"){state+=operation.value??1;output.push(state)}else if(operation.action==="set"){state=operation.value??0;output.push(state)}else if(operation.action==="read-value"){output.push(state)}else{throw new TypeError("unknown batch action")}}return {output,state}}function causalJoinReducer(input){return {output:null,state:input.state}}function readReducer(input){return {output:input.state,state:input.state}}function setReducer(input){const state=input.operation.value??0;return {output:state,state}}export const blueprint={exportSchemaVersion:1,artifactId:"counter.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{add:addReducer,applicationBatch:applicationBatchReducer,causalJoin:causalJoinReducer,"read-value":readReducer,set:setReducer}};`;

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds the one counter catalog shared by the Phase 3f-c and Phase 3g genuine node fixtures.
 * The helper owns fixture material only; production still authenticates every package and artifact byte.
 * @param variant Optional controlled artifact variant used by authority-mismatch tests.
 * @returns Exact catalog, package bytes and blueprint digest.
 */
export function counterBatchCatalog(variant = "default"): Readonly<{
	readonly catalog: TrustedBlueprintCatalog;
	readonly blueprintDigest: string;
}> {
	const artifactBytes = new TextEncoder().encode(COUNTER_BATCH_ARTIFACT_SOURCE);
	const artifactDigest = hex(hashDomain(packageGolden.artifactDigestDomain, artifactBytes));
	const blueprintPackage = Object.freeze({
		...packageGolden.package,
		implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
		manifest: Object.freeze({
			...packageGolden.package.manifest,
			schemaVersion: 2,
			workBudgetProfile: "blueprint-work-budget-v1",
			operations: Object.freeze([
				Object.freeze({
					...packageGolden.package.manifest.operations[0],
					maxCanonicalOperationBytes: variant === "default" ? 65_536 : 65_535,
				}),
				Object.freeze({
					argumentSchema: Object.freeze({
						fields: Object.freeze([Object.freeze({ name: "batch", required: true, type: "canonical-object" })]),
						kind: "closed-record",
					}),
					maxCanonicalOperationBytes: 65_536,
					name: "applicationBatch",
				}),
				Object.freeze({
					argumentSchema: Object.freeze({ fields: Object.freeze([]), kind: "closed-record" }),
					maxCanonicalOperationBytes: 65_536,
					name: "causalJoin",
				}),
				...packageGolden.package.manifest.operations
					.slice(1)
					.map((operation) => Object.freeze({ ...operation, maxCanonicalOperationBytes: 65_536 })),
			]),
		}),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
	const blueprintDigest = hex(hashDomain(packageGolden.blueprintDigestDomain, canonicalBlueprintPackageBytes));
	const resolved = Object.freeze({
		artifactDigest,
		artifactId: blueprintPackage.implementation.artifactId,
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes: artifactBytes,
		runtimeProfile: "ecmascript-2024-sync-v1" as const,
		evidence: Object.freeze({
			catalogDigest: "9".repeat(64),
			lintEvidenceDigest: "a".repeat(64),
			conformanceReceiptDigest: "b".repeat(64),
			conformanceDigest: "c".repeat(64),
			conformanceTier: "nightly" as const,
			conformanceResult: "passed" as const,
			engines: Object.freeze([
				Object.freeze({ name: "node" as const, build: "phase-3g" }),
				Object.freeze({ name: "chromium" as const, build: "phase-3g" }),
				Object.freeze({ name: "firefox" as const, build: "phase-3g" }),
				Object.freeze({ name: "webkit" as const, build: "phase-3g" }),
			]),
		}),
	});
	return Object.freeze({
		blueprintDigest,
		catalog: Object.freeze({
			blueprintDigests: Object.freeze([blueprintDigest]),
			catalogDigest: "9".repeat(64),
			resolve(requested: string) {
				if (requested !== blueprintDigest) throw new TypeError("unknown Phase 3g counter blueprint");
				return resolved;
			},
		}),
	});
}

function detachedOperation(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(encodeCanonical(operation), APPLICATION_BATCH_LIMITS);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("application batching fixture operation is not canonical");
	}
	return Object.freeze({ ...(decoded as Readonly<Record<string, unknown>>) });
}

/**
 * Builds one immutable captured room request without implementing production validation.
 * @param logicalTime Captured room logical time.
 * @param operation Detached application operation.
 * @returns One immutable batch entry.
 */
export function batchEntry(logicalTime: number, operation: Readonly<Record<string, unknown>>): ApplicationBatchEntry {
	return Object.freeze({ logicalTime, operation: detachedOperation(operation) });
}

/**
 * Returns maximal-count rows for the selected prepared runtime.
 * @param product Shipped application profile.
 * @param count Requested entry count.
 * @returns Immutable application entries.
 */
export function maximalEntries(product: "chat" | "counter" | "zone", count = 16): readonly ApplicationBatchEntry[] {
	return Object.freeze(
		Array.from({ length: count }, (_, index) =>
			batchEntry(
				index + 1,
				product === "chat"
					? Object.freeze({
							action: "message",
							clientOperationId: `message-${index}`,
							text: `${index}:`.padEnd(256, "m"),
						})
					: product === "zone"
						? Object.freeze({ action: "placeBlock", id: `block-${index}`, kind: "stone", x: index, y: -index })
						: Object.freeze({ action: "add", value: index + 1 })
			)
		)
	);
}

/**
 * Returns fixed fixture data whose genuine node envelope is exactly at, or one byte over, the frozen limit.
 * The test never reconstructs or measures the reserved envelope itself.
 * @param overByOne Whether the genuine node envelope must exceed the byte ceiling by one.
 * @returns Two immutable application entries.
 */
export function byteBoundaryEntries(overByOne: boolean): readonly ApplicationBatchEntry[] {
	return Object.freeze([
		batchEntry(1, Object.freeze({ action: "payload", text: "a".repeat(overByOne ? 65_365 : 65_364) })),
		batchEntry(2, Object.freeze({ action: "payload", text: "b" })),
	]);
}

/**
 * Returns genuine outer-envelope inputs at exactly 1,024 or 1,025 canonical items.
 * @param overByOne Whether the genuine envelope must exceed the item ceiling by one.
 * @returns Two immutable counter operations.
 */
export function itemBoundaryEntries(overByOne: boolean): readonly ApplicationBatchEntry[] {
	return Object.freeze([
		batchEntry(
			1,
			Object.freeze({
				action: "payload",
				data: Object.freeze({
					pad: new Uint32Array(overByOne ? 2 : 1),
					values: Object.freeze(Array.from({ length: 481 }, () => 0)),
				}),
			})
		),
		batchEntry(2, Object.freeze({ action: "payload", text: "b" })),
	]);
}

/**
 * Builds one accepted-operation observation without forging a vertex.
 * @param input Genuine outer-vertex and child-operation facts.
 * @param operationIndex Zero-based child index.
 * @param operationCount Number of children in the genuine vertex.
 * @returns Immutable accepted-operation fact.
 */
export function acceptedOperation(
	input: Omit<AcceptedOperationFact, "operationCount" | "operationIndex">,
	operationIndex: number,
	operationCount: number
): AcceptedOperationFact {
	return Object.freeze({ ...input, operationCount, operationIndex });
}
