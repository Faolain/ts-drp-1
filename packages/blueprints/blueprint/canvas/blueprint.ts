// The artifact sees only canonical detached records and dense arrays. The host
// boundary retains raw prototype/accessor checks before invoking these reducers.
function denseArray(value, size) {
	if (value === null || typeof value !== "object" || value.length !== size) return false;
	let count = 0;
	for (const key in value) {
		if (key !== "" + count) return false;
		count += 1;
	}
	return count === size;
}
function exactKeys(value, keys) {
	if (value === null || typeof value !== "object" || denseArray(value, value.length)) return false;
	let count = 0;
	for (const key in value) {
		if (!keys.includes(key)) return false;
		count += 1;
	}
	return count === keys.length;
}
function integer(value, minimum, maximum) {
	if (typeof value !== "number" || value % 1 !== 0 || value < minimum || value > maximum)
		throw "invalid canvas integer";
	return value === 0 ? 0 : value;
}
function captureRgb(value, maximum) {
	if (!denseArray(value, 3)) throw "invalid canvas RGB";
	return [integer(value[0], 0, maximum), integer(value[1], 0, maximum), integer(value[2], 0, maximum)];
}
function captureState(value) {
	if (!exactKeys(value, ["version", "width", "height", "counters"]) || value.version !== 1)
		throw "invalid canvas state";
	const width = integer(value.width, 1, 64), height = integer(value.height, 1, 64);
	if (!denseArray(value.counters, width * height)) throw "invalid canvas counter array";
	const counters = [];
	for (const pixel of value.counters) counters.push(captureRgb(pixel, 9007199254740991));
	return { version: 1, width, height, counters };
}
function captureOperation(value) {
	const splash = value && value.action === "splash";
	if (!exactKeys(value, splash ? ["action", "offset", "rgb", "size"] : ["action", "offset", "rgb"]) ||
		(!splash && value.action !== "paint") || !denseArray(value.offset, 2)) throw "invalid canvas operation";
	const offset = [integer(value.offset[0], 0, 63), integer(value.offset[1], 0, 63)];
	const rgb = captureRgb(value.rgb, 255);
	if (!splash) return { action: "paint", offset, rgb };
	if (!denseArray(value.size, 2)) throw "invalid canvas splash size";
	return { action: "splash", offset, rgb, size: [integer(value.size[0], 1, 64), integer(value.size[1], 1, 64)] };
}
function apply(stateValue, operationValue) {
	const state = captureState(stateValue), operation = captureOperation(operationValue);
	const x = operation.offset[0], y = operation.offset[1];
	const width = operation.action === "splash" ? operation.size[0] : 1;
	const height = operation.action === "splash" ? operation.size[1] : 1;
	if (x + width > state.width || y + height > state.height) throw "canvas region outside dimensions";
	// Validate the entire region before computing any successor pixel.
	for (let dx = 0; dx < width; dx++) {
		for (let dy = 0; dy < height; dy++) {
			const pixel = state.counters[(x + dx) * state.height + y + dy];
			for (let channel = 0; channel < 3; channel++) {
				if (pixel[channel] > 9007199254740991 - operation.rgb[channel]) throw "canvas counter overflow";
			}
		}
	}
	for (let dx = 0; dx < width; dx++) {
		for (let dy = 0; dy < height; dy++) {
			const index = (x + dx) * state.height + y + dy, pixel = state.counters[index];
			state.counters[index] = [pixel[0] + operation.rgb[0], pixel[1] + operation.rgb[1], pixel[2] + operation.rgb[2]];
		}
	}
	return { state, output: operation };
}
function paintReducer(input) {
	if (!exactKeys(input.operation, ["action", "clientOperationId", "payload"]) || input.operation.action !== "paint" ||
		typeof input.operation.clientOperationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.operation.clientOperationId) ||
		!exactKeys(input.operation.payload, ["offset", "rgb"])) throw "paint action mismatch";
	return apply(input.state, { action: "paint", offset: input.operation.payload.offset, rgb: input.operation.payload.rgb });
}
function splashReducer(input) {
	if (!exactKeys(input.operation, ["action", "clientOperationId", "payload"]) || input.operation.action !== "splash" ||
		typeof input.operation.clientOperationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.operation.clientOperationId) ||
		!exactKeys(input.operation.payload, ["offset", "rgb", "size"])) throw "splash action mismatch";
	return apply(input.state, { action: "splash", offset: input.operation.payload.offset, rgb: input.operation.payload.rgb,
		size: input.operation.payload.size });
}
function aclReducer(input) { return { state: input.state, output: input.operation }; }
function applicationBatchReducer(input) {
	const operation = input.operation;
	if (!exactKeys(operation, ["action", "batch"]) || operation.action !== "applicationBatch" ||
		!exactKeys(operation.batch, ["entries", "version"]) || operation.batch.version !== 1 ||
		!denseArray(operation.batch.entries, operation.batch.entries.length) ||
		operation.batch.entries.length < 2 || operation.batch.entries.length > 16) throw "invalid canvas batch";
	let state = input.state, prior = -1;
	const output = [];
	for (const entry of operation.batch.entries) {
		if (!exactKeys(entry, ["logicalTime", "operation"]) ||
			integer(entry.logicalTime, 0, 9007199254740991) <= prior) throw "invalid canvas batch entry";
		prior = entry.logicalTime;
		const result = entry.operation.action === "paint" ? paintReducer({ state, operation: entry.operation }) :
			entry.operation.action === "splash" ? splashReducer({ state, operation: entry.operation }) : null;
		if (result === null) throw "invalid canvas batch action";
		state = result.state;
		output.push(result.output);
	}
	return { state, output };
}
function causalJoinReducer(input) { return { state: input.state, output: null }; }
function migrationActivationReducer(input) {
	if (!exactKeys(input.operation, ["action", "decision"]) || input.operation.action !== "migrationActivation" ||
		input.operation.decision === null || typeof input.operation.decision !== "object" ||
		denseArray(input.operation.decision, input.operation.decision.length)) throw "invalid migration activation";
	return { state: input.state, output: null };
}
function migrationRecordReducer(input) {
	const record = input.operation && input.operation.record;
	if (!exactKeys(input.operation, ["action", "record"]) || input.operation.action !== "migrationRecord" ||
		!exactKeys(record, ["applicationStateDigest", "archivePolicy", "authorityKind", "exactCanonicalApplicationStateBytes",
			"kind", "rehearsalNonce", "sourceAcceptedOperationCount", "sourceAcceptedOperationsDigest", "sourceAnchorDigest",
			"sourceBlueprintDigest", "sourceCreatorAuthor", "sourceObjectId", "targetAnchorDigest", "targetBlueprintDigest",
			"targetCreatorAuthor", "targetImportOperationCount", "targetImportOperationsDigest", "targetObjectId", "version"]) ||
		record.kind !== "ts-drp-v3-room-migration-record" || record.version !== 1 || record.archivePolicy !== "retain-source" ||
		record.authorityKind !== "creator-ed25519-registered-vertex-v1") throw "invalid migration record";
	return { state: input.state, output: null };
}
