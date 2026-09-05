import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { createV3ChatApplication } from "../../../examples/v3-chat/src/index.js";
import type { V3RoomAcceptedOperation, V3RoomProjectionInput } from "../../../examples/v3-room/src/index.js";

const ARTIFACT_ID = "f5b-transient-payload.v1";

// Local workload artifact, not production chat: text is authenticated transient
// input. Both reducers retain only the operation identity, including in output.
// The message/applicationBatch ABI and every admission ceiling are unchanged.
const ARTIFACT_SOURCE = `
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function message(operation) {
  if (!exactKeys(operation, ["action", "clientOperationId", "text"]) || operation.action !== "message" ||
    typeof operation.clientOperationId !== "string" || operation.clientOperationId.length === 0 ||
    typeof operation.text !== "string") throw new TypeError("invalid transient message");
  return {clientOperationId: operation.clientOperationId, text: operation.clientOperationId};
}
function messageReducer(input) {
  const selected = message(input.operation);
  return {output: selected, state: [...input.state, selected]};
}
function applicationBatchReducer(input) {
  const operation = input.operation;
  if (!exactKeys(operation, ["action", "batch"]) || operation.action !== "applicationBatch" ||
    !exactKeys(operation.batch, ["entries", "version"]) || operation.batch.version !== 1 ||
    !Array.isArray(operation.batch.entries) || operation.batch.entries.length < 2 || operation.batch.entries.length > 16)
    throw new TypeError("invalid transient batch");
  let prior = -1;
  const output = [];
  const state = [...input.state];
  for (const entry of operation.batch.entries) {
    if (!exactKeys(entry, ["logicalTime", "operation"]) || !Number.isSafeInteger(entry.logicalTime) ||
      entry.logicalTime < 0 || entry.logicalTime <= prior) throw new TypeError("invalid transient batch entry");
    prior = entry.logicalTime;
    const selected = message(entry.operation);
    state.push(selected);
    output.push(selected);
  }
  return {output, state};
}
function aclReducer(input) { return {output: input.operation, state: input.state}; }
function joinReducer(input) { return {output: input.operation.clientId, state: input.state}; }
function causalJoinReducer(input) { return {output: null, state: input.state}; }
function migrationActivationReducer(input) { return {output: null, state: input.state}; }
function migrationRecordReducer(input) { return {output: null, state: input.state}; }
export const blueprint = {
  exportSchemaVersion: 1, artifactId: "${ARTIFACT_ID}", runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: {acl: aclReducer, applicationBatch: applicationBatchReducer, causalJoin: causalJoinReducer,
    join: joinReducer, message: messageReducer, migrationActivation: migrationActivationReducer,
    migrationRecord: migrationRecordReducer}
};`;

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function boundedOperations(operations: readonly V3RoomAcceptedOperation[]): readonly V3RoomAcceptedOperation[] {
	return operations.map((row) =>
		row.operation.action === "message"
			? { ...row, operation: { ...row.operation, text: row.operation.clientOperationId } }
			: row
	);
}

/**
 * Builds a distinct local catalog/package; the real room still validates it.
 * @returns The test-only application with transient bytes excluded from state.
 */
export function createTransientPayloadApplication(): ReturnType<typeof createV3ChatApplication> {
	const base = createV3ChatApplication("alice");
	const baseDigest = base.catalog.blueprintDigests[0];
	if (baseDigest === undefined || base.migration === undefined) throw new TypeError("F5B_TRANSIENT_BASE_REQUIRED");
	const prior = base.catalog.resolve(baseDigest);
	const parsed = decodeCanonical(base.canonicalBlueprintPackageBytes) as Record<string, unknown>;
	const exactArtifactBytes = new TextEncoder().encode(ARTIFACT_SOURCE);
	const artifactDigest = hex(hashDomain("ts-drp/blueprint-artifact/v3", exactArtifactBytes));
	const canonicalBlueprintPackageBytes = encodeCanonical({
		...parsed,
		implementation: { artifactId: ARTIFACT_ID, artifactDigest, runtimeProfile: "ecmascript-2024-sync-v1" },
	});
	const blueprintDigest = hex(hashDomain("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes));
	const catalogDigest = hex(hashDomain("ts-drp/f5b-transient-catalog/v1", canonicalBlueprintPackageBytes));
	const resolved = Object.freeze({
		...prior,
		artifactId: ARTIFACT_ID,
		artifactDigest,
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		evidence: Object.freeze({ ...prior.evidence, catalogDigest }),
	});
	const migration = base.migration;
	return Object.freeze({
		...base,
		canonicalBlueprintPackageBytes,
		catalog: Object.freeze({
			blueprintDigests: Object.freeze([blueprintDigest]),
			catalogDigest,
			resolve(requested: string) {
				if (requested !== blueprintDigest) throw new TypeError("F5B_TRANSIENT_UNKNOWN_BLUEPRINT");
				return resolved;
			},
		}),
		transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) =>
			Object.freeze({ ...operation, text: "r".repeat(33_000) }),
		projectAcceptedOperations: (input: V3RoomProjectionInput) =>
			base.projectAcceptedOperations({
				...input,
				currentEpochOperations: boundedOperations(input.currentEpochOperations),
			}),
		migration: Object.freeze({
			canonicalStateBytes: migration.canonicalStateBytes,
			prepare: (accepted: readonly V3RoomAcceptedOperation[]) => migration.prepare(boundedOperations(accepted)),
		}),
	});
}
