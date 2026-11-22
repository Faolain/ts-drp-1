import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { EpochVertex } from "@ts-drp/compaction";
import { BlueprintStateMachine, foldBlueprintEpoch } from "@ts-drp/compaction/blueprint-fold";
import { prepareBlueprintAdmission, prepareBlueprintRuntime, type PreparedBlueprintRuntime } from "@ts-drp/protocol-v3";

export const BLUEPRINT_FOLD_OPERATION_COUNT = 4_096;
const ANCHOR_HASH = "0".repeat(64);
const ARTIFACT_SOURCE =
	'function addReducer(input){const state=input.state+input.operation.value;return {output:state,state}}export const blueprint={exportSchemaVersion:1,artifactId:"phase4a.counter",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{add:addReducer}};';

export interface BlueprintFoldWorkloadSummary {
	readonly exactCanonicalStateBytes: readonly number[];
	readonly operationCount: number;
	readonly orderLength: number;
	readonly outputCount: number;
	readonly stateDigest: string;
	readonly stateValue: number;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function hashForSequence(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

async function runtime(): Promise<Readonly<{ blueprintDigest: string; prepared: PreparedBlueprintRuntime }>> {
	const exactArtifactBytes = new TextEncoder().encode(ARTIFACT_SOURCE);
	const artifactDigest = hex(hashDomain("ts-drp/blueprint-artifact/v3", exactArtifactBytes));
	const canonicalBlueprintPackageBytes = encodeCanonical({
		implementation: {
			artifactDigest,
			artifactId: "phase4a.counter",
			runtimeProfile: "ecmascript-2024-sync-v1",
		},
		kind: "drp-blueprint-admission-package",
		manifest: {
			operationDiscriminator: "action",
			operations: [
				{
					argumentSchema: {
						fields: [{ name: "value", required: true, type: "safe-integer" }],
						kind: "closed-record",
					},
					name: "add",
				},
			],
			schemaVersion: 1,
		},
		protocolMajor: 3,
		schemaVersion: 1,
	});
	const blueprintDigest = hex(hashDomain("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes));
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	const prepared = await prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
		exactArtifactBytes,
		preparedBlueprintAdmission: admission,
	});
	return Object.freeze({ blueprintDigest, prepared });
}

function graph(): ReadonlyMap<string, EpochVertex> {
	const vertices = new Map<string, EpochVertex>();
	vertices.set(ANCHOR_HASH, {
		dependencies: [],
		epoch: 0,
		hash: ANCHOR_HASH,
		kind: "drp-epoch-anchor",
		objectId: "phase4a-live-worker",
	});
	for (let sequence = BLUEPRINT_FOLD_OPERATION_COUNT; sequence >= 1; sequence -= 1) {
		const hash = hashForSequence(sequence);
		vertices.set(hash, {
			anchor: ANCHOR_HASH,
			dependencies: [ANCHOR_HASH],
			epoch: 0,
			hash,
			kind: "drp-vertex",
			objectId: "phase4a-live-worker",
			operation: { action: "add", value: 1 },
		});
	}
	return vertices;
}

/**
 *
 */
export async function runBlueprintFoldWorkload(): Promise<BlueprintFoldWorkloadSummary> {
	const prepared = await runtime();
	const initialStateBytes = encodeCanonical(0);
	const machine = new BlueprintStateMachine({
		exactCanonicalInitialStateBytes: initialStateBytes,
		expectedBlueprintDigest: prepared.blueprintDigest,
		expectedInitialStateDigest: hex(hashDomain("ts-drp/state/v3", initialStateBytes)),
		preparedBlueprintRuntime: prepared.prepared,
	});
	const fold = foldBlueprintEpoch({
		anchorHash: ANCHOR_HASH,
		authorize: () => true,
		machine,
		vertices: graph(),
	});
	const snapshot = fold.adopt();
	const stateValue = decodeCanonical(snapshot.exactCanonicalStateBytes);
	if (stateValue !== BLUEPRINT_FOLD_OPERATION_COUNT) throw new Error("blueprint fold state did not converge");
	return Object.freeze({
		exactCanonicalStateBytes: Object.freeze(Array.from(snapshot.exactCanonicalStateBytes)),
		operationCount: BLUEPRINT_FOLD_OPERATION_COUNT,
		orderLength: fold.order.length,
		outputCount: fold.outputs.length,
		stateDigest: snapshot.stateDigest,
		stateValue,
	});
}
