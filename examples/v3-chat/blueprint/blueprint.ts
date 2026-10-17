// Runtime admission detaches operations/state into canonical records and dense arrays.
// An array's length is non-enumerable; a canonical record cannot inherit a length.
function isCanonicalArray(value) {
	if (value === null || typeof value !== "object") return false;
	let count = 0;
	for (const key in value) {
		if (key !== "" + count) return false;
		count += 1;
	}
	return count === value.length;
}
function exactKeys(value, keys) {
	if (value === null || typeof value !== "object" || isCanonicalArray(value)) return false;
	let count = 0;
	for (const key in value) {
		if (!keys.includes(key)) return false;
		count += 1;
	}
	return count === keys.length;
}

function aclReducer(input) {
	return { output: input.operation, state: input.state };
}
function applicationBatchReducer(input) {
	const operation = input.operation;
	if (
		!exactKeys(operation, ["action", "batch"]) ||
		operation.action !== "applicationBatch" ||
		!exactKeys(operation.batch, ["entries", "version"]) ||
		operation.batch.version !== 1 ||
		!isCanonicalArray(operation.batch.entries) ||
		operation.batch.entries.length < 2 ||
		operation.batch.entries.length > 16
	)
		throw "invalid application batch";
	let prior = -1;
	const output = [];
	const state = [...input.state];
	for (const entry of operation.batch.entries) {
		if (
			!exactKeys(entry, ["logicalTime", "operation"]) ||
			typeof entry.logicalTime !== "number" ||
			entry.logicalTime % 1 !== 0 ||
			entry.logicalTime > 9007199254740991 ||
			entry.logicalTime < 0 ||
			entry.logicalTime <= prior ||
			!exactKeys(entry.operation, ["action", "clientOperationId", "text"]) ||
			entry.operation.action !== "message" ||
			typeof entry.operation.clientOperationId !== "string" ||
			entry.operation.clientOperationId.length === 0 ||
			typeof entry.operation.text !== "string"
		)
			throw "invalid application batch entry";
		prior = entry.logicalTime;
		const message = { clientOperationId: entry.operation.clientOperationId, text: entry.operation.text };
		state.push(message);
		output.push(message);
	}
	return { output, state };
}
function causalJoinReducer(input) {
	return { output: null, state: input.state };
}
function joinReducer(input) {
	return { output: input.operation.clientId, state: input.state };
}
function messageReducer(input) {
	if (
		!exactKeys(input.operation, ["action", "clientOperationId", "text"]) ||
		typeof input.operation.clientOperationId !== "string" ||
		input.operation.clientOperationId.length === 0 ||
		typeof input.operation.text !== "string"
	)
		throw "invalid message";
	const message = { clientOperationId: input.operation.clientOperationId, text: input.operation.text };
	const state = [...input.state, message];
	return { output: message, state };
}
function migrationActivationReducer(input) {
	const operation = input.operation;
	if (
		!exactKeys(operation, ["action", "decision"]) ||
		operation.action !== "migrationActivation" ||
		operation.decision === null ||
		typeof operation.decision !== "object" ||
		isCanonicalArray(operation.decision)
	)
		throw "invalid migration activation";
	return { output: null, state: input.state };
}
function migrationRecordReducer(input) {
	const migrationKeys = [
		"applicationStateDigest",
		"archivePolicy",
		"authorityKind",
		"exactCanonicalApplicationStateBytes",
		"kind",
		"rehearsalNonce",
		"sourceAcceptedOperationCount",
		"sourceAcceptedOperationsDigest",
		"sourceAnchorDigest",
		"sourceBlueprintDigest",
		"sourceCreatorAuthor",
		"sourceObjectId",
		"targetAnchorDigest",
		"targetBlueprintDigest",
		"targetCreatorAuthor",
		"targetImportOperationCount",
		"targetImportOperationsDigest",
		"targetObjectId",
		"version",
	];
	const operation = input.operation;
	const record = operation && operation.record;
	if (
		!exactKeys(operation, ["action", "record"]) ||
		operation.action !== "migrationRecord" ||
		!exactKeys(record, migrationKeys) ||
		record.kind !== "ts-drp-v3-room-migration-record" ||
		record.version !== 1 ||
		record.archivePolicy !== "retain-source" ||
		record.authorityKind !== "creator-ed25519-registered-vertex-v1"
	)
		throw "invalid migration record";
	return { output: null, state: input.state };
}
