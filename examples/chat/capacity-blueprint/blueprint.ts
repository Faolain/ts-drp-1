// The room owner supplies authenticated executionContext.author. Neither this
// reducer nor a stored sender field grants membership, Writer or import authority.
function denseArray(value) {
	if (value === null || typeof value !== "object") return false;
	let count = 0;
	for (const key in value) {
		if (key !== "" + count) return false;
		count += 1;
	}
	return count === value.length;
}
function exactKeys(value, keys) {
	if (value === null || typeof value !== "object" || denseArray(value)) return false;
	let count = 0;
	for (const key in value) {
		if (!keys.includes(key)) return false;
		count += 1;
	}
	return count === keys.length;
}
function captureMessage(value) {
	if (
		!exactKeys(value, ["author", "clientOperationId", "displayTimeMs", "text"]) ||
		typeof value.author !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.author) ||
		typeof value.clientOperationId !== "string" ||
		!/^[A-Za-z0-9._:-]{1,128}$/.test(value.clientOperationId) ||
		typeof value.displayTimeMs !== "number" ||
		value.displayTimeMs % 1 !== 0 ||
		value.displayTimeMs < 0 ||
		value.displayTimeMs > 9007199254740991 ||
		typeof value.text !== "string" ||
		value.text.length === 0
	)
		throw "invalid shipping chat message";
	return {
		author: value.author,
		clientOperationId: value.clientOperationId,
		displayTimeMs: value.displayTimeMs === 0 ? 0 : value.displayTimeMs,
		text: value.text,
	};
}
function compareIdentity(left, right) {
	if (left.author !== right.author) return left.author < right.author ? -1 : 1;
	return left.clientOperationId < right.clientOperationId
		? -1
		: left.clientOperationId > right.clientOperationId
			? 1
			: 0;
}
function captureMessages(value) {
	if (!denseArray(value)) throw "invalid shipping chat state";
	const result = [];
	let previous = null;
	for (const row of value) {
		const message = captureMessage(row);
		if (previous !== null && compareIdentity(previous, message) >= 0)
			throw "shipping chat identities are not canonical";
		result.push(message);
		previous = message;
	}
	return result;
}

function captureCapacity(value) {
	if (!exactKeys(value, ["version", "basisObjectId", "allocations"]) || value.version !== 1 ||
		typeof value.basisObjectId !== "string" || value.basisObjectId.length === 0 || value.basisObjectId.length > 1024 || !denseArray(value.allocations))
		throw "invalid chat capacity";
	const allocations = [];
	let previous = "";
	for (const row of value.allocations) {
		if (
			!denseArray(row) ||
			row.length !== 3 ||
			typeof row[0] !== "string" ||
			!/^[0-9a-f]{64}$/.test(row[0]) ||
			row[0] <= previous ||
			typeof row[1] !== "number" ||
			row[1] % 1 !== 0 ||
			row[1] < 0 ||
			row[1] > 32768 ||
			typeof row[2] !== "number" ||
			row[2] % 1 !== 0 ||
			row[2] < 0 ||
			row[2] > 9007199254740991
		)
			throw "invalid chat capacity row";
		previous = row[0];
		allocations.push([row[0], row[1], row[2]]);
	}
	return { version: 1, basisObjectId: value.basisObjectId, allocations };
}
function captureState(value) {
	if (!exactKeys(value, ["version", "messages", "capacity"]) || value.version !== 3)
		throw "invalid chat capacity state";
	return { version: 3, messages: captureMessages(value.messages), capacity: captureCapacity(value.capacity) };
}
function capacityAllocationReducer(input) {
	const operation = input.operation;
	if (
		!exactKeys(operation, ["action", "capacity", "epoch", "aclDigest"]) ||
		operation.action !== "capacityAllocation" ||
		typeof operation.epoch !== "number" ||
		operation.epoch % 1 !== 0 ||
		operation.epoch < 0 ||
		operation.epoch > 9007199254740991 ||
		typeof operation.aclDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(operation.aclDigest)
	)
		throw "invalid chat capacity allocation";
	const state = captureState(input.state);
	const capacity = captureCapacity(operation.capacity);
	if (capacity.basisObjectId !== state.capacity.basisObjectId) throw "chat capacity basis is immutable";
	return {
		state: { version: 3, messages: state.messages, capacity },
		output: null,
	};
}
function migrationRecordReducer(input) {
	const operation = input.operation,
		record = operation.record;
	if (
		!exactKeys(operation, ["action", "record"]) ||
		operation.action !== "migrationRecord" ||
		record === null ||
		typeof record !== "object" ||
		record.version !== 2 ||
		record.kind !== "ts-drp-v3-room-migration-record" ||
		record.archivePolicy !== "retain-source" ||
		record.authorityKind !== "creator-ed25519-registered-vertex-v1" ||
		input.executionContext.author !== record.targetCreatorAuthor ||
		record.sourceCreatorAuthor !== record.targetCreatorAuthor ||
		record.targetEpoch !== 0
	)
		throw "invalid chat inherited state";
	const state = captureState(input.state);
	if (state.messages.length !== 0) throw "chat inherited state requires empty target prefix";
	return { state: captureState(record.applicationState), output: null };
}
function migrationActivationReducer(input) {
	if (!exactKeys(input.operation, ["action", "decision"]) || input.operation.action !== "migrationActivation")
		throw "invalid chat migration activation";
	return { state: captureState(input.state), output: null };
}

function messageReducer(input) {
	const operation = input.operation,
		context = input.executionContext;
	if (
		!exactKeys(operation, ["action", "clientOperationId", "displayTimeMs", "text"]) ||
		operation.action !== "message" ||
		!exactKeys(context, ["author"])
	)
		throw "invalid shipping chat operation";
	const message = captureMessage({
		author: context.author,
		clientOperationId: operation.clientOperationId,
		displayTimeMs: operation.displayTimeMs,
		text: operation.text,
	});
	const state = captureState(input.state);
	for (const prior of state.messages) {
		if (compareIdentity(prior, message) !== 0) continue;
		if (prior.displayTimeMs !== message.displayTimeMs || prior.text !== message.text)
			throw "shipping chat identity conflicts";
		return { output: message, state };
	}
	state.messages.push(message);
	state.messages.sort(compareIdentity);
	return { output: message, state };
}
function applicationBatchReducer(input) {
	const operation = input.operation;
	if (
		!exactKeys(operation, ["action", "batch"]) ||
		operation.action !== "applicationBatch" ||
		!exactKeys(operation.batch, ["version", "entries"]) ||
		operation.batch.version !== 1 ||
		!denseArray(operation.batch.entries) ||
		operation.batch.entries.length < 2 ||
		operation.batch.entries.length > 16
	)
		throw "invalid shipping chat batch";
	let state = input.state,
		prior = -1;
	const output = [];
	for (const entry of operation.batch.entries) {
		if (
			!exactKeys(entry, ["logicalTime", "operation"]) ||
			typeof entry.logicalTime !== "number" ||
			entry.logicalTime % 1 !== 0 ||
			entry.logicalTime < 0 ||
			entry.logicalTime > 9007199254740991 ||
			entry.logicalTime <= prior
		)
			throw "invalid shipping chat batch entry";
		prior = entry.logicalTime;
		const result = messageReducer({ state, operation: entry.operation, executionContext: input.executionContext });
		state = result.state;
		output.push(result.output);
	}
	return { state, output };
}
function causalJoinReducer(input) {
	return { state: captureState(input.state), output: null };
}
function aclReducer(input) {
	return { state: captureState(input.state), output: input.operation };
}
