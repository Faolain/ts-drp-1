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
function captureState(value) {
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
	for (const prior of state) {
		if (compareIdentity(prior, message) !== 0) continue;
		if (prior.displayTimeMs !== message.displayTimeMs || prior.text !== message.text)
			throw "shipping chat identity conflicts";
		return { output: message, state };
	}
	state.push(message);
	state.sort(compareIdentity);
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
