// The room owner supplies authenticated executionContext.author. Neither this
// reducer nor a stored sender field grants membership, Writer or import authority.
//
// Version 4, the rolling window (Track W). The state keeps the most recent messages
// in application order, oldest first. Each member's allocation ceiling bounds the
// exact canonical bytes of that member's messages in the window: a member's new
// message pushes out that member's own oldest messages, so one member never
// displaces another and nothing is kept for the room's lifetime. The native
// admission policy caps what a member adds in one epoch at the ceiling, so no
// message admitted in an epoch is pushed out before that epoch is sealed.
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
// Bytes of an unsigned LEB128 varint (exact for every safe integer and twice one).
function varintBytes(value) {
	let bytes = 1;
	let rest = value;
	while (rest >= 128) {
		rest = Math.floor(rest / 128);
		bytes += 1;
	}
	return bytes;
}
// UTF-8 bytes of a string; an unpaired surrogate is refused, as the canonical codec does.
function utf8Bytes(text) {
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (next < 0xdc00 || next > 0xdfff) throw "shipping chat text has an unpaired surrogate";
			bytes += 4;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) throw "shipping chat text has an unpaired surrogate";
		else bytes += 3;
	}
	return bytes;
}
// Exact canonical bytes of one message record: the object tag and count (2), its four
// keys (48), the author string (66) and the three value tags (3) are 119 bytes; then
// each variable value's length varint and payload, and the display time's zigzag varint.
function recordBytes(message) {
	const id = utf8Bytes(message.clientOperationId);
	const text = utf8Bytes(message.text);
	return 119 + varintBytes(id) + id + varintBytes(message.displayTimeMs * 2) + varintBytes(text) + text;
}
function captureCapacity(value) {
	if (
		!exactKeys(value, ["version", "basisObjectId", "allocations"]) ||
		value.version !== 1 ||
		typeof value.basisObjectId !== "string" ||
		value.basisObjectId.length === 0 ||
		value.basisObjectId.length > 1024 ||
		!denseArray(value.allocations)
	)
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
			row[1] > 65536 ||
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
// A member's ceiling, or -1 for an author without an allocation row.
function ceilingOf(capacity, author) {
	for (const row of capacity.allocations) if (row[0] === author) return row[1];
	return -1;
}
function chargeOf(messages, author) {
	let charge = 0;
	for (const message of messages) if (message.author === author) charge += recordBytes(message);
	return charge;
}
// The window rule: remove the author's oldest messages until the author's charge fits.
function fitShare(messages, author, ceiling) {
	const limit = ceiling < 0 ? 0 : ceiling;
	let charge = chargeOf(messages, author);
	let index = 0;
	while (charge > limit) {
		while (messages[index].author !== author) index += 1;
		for (const removed of messages.splice(index, 1)) charge -= recordBytes(removed);
	}
}
function captureState(value) {
	if (!exactKeys(value, ["version", "messages", "capacity"]) || value.version !== 4 || !denseArray(value.messages))
		throw "invalid chat window state";
	const capacity = captureCapacity(value.capacity);
	const messages = [];
	const seen = {};
	const charges = {};
	for (const row of value.messages) {
		const message = captureMessage(row);
		const key = message.author + "\u0000" + message.clientOperationId;
		if (seen[key] === true) throw "shipping chat window identities repeat";
		seen[key] = true;
		charges[message.author] =
			(charges[message.author] === undefined ? 0 : charges[message.author]) + recordBytes(message);
		messages.push(message);
	}
	for (const author in charges)
		if (charges[author] > ceilingOf(capacity, author)) throw "shipping chat window exceeds a share";
	return { version: 4, messages, capacity };
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
	// Totality: a lower ceiling applies the window rule; the native policy accepts only
	// allocations that keep every holder's current window.
	const authors = {};
	for (const message of state.messages) authors[message.author] = true;
	for (const author in authors) fitShare(state.messages, author, ceilingOf(capacity, author));
	return {
		state: { version: 4, messages: state.messages, capacity },
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
	let index = 0;
	for (const prior of state.messages) {
		if (prior.author === message.author && prior.clientOperationId === message.clientOperationId) {
			if (prior.displayTimeMs !== message.displayTimeMs || prior.text !== message.text)
				throw "shipping chat identity conflicts";
			// An exact retry refreshes its message: it becomes the member's newest.
			state.messages.splice(index, 1);
			state.messages.push(prior);
			return { output: message, state };
		}
		index += 1;
	}
	const ceiling = ceilingOf(state.capacity, message.author);
	if (ceiling < 0) throw "shipping chat author has no share";
	if (recordBytes(message) > ceiling) throw "shipping chat message exceeds its author's share";
	state.messages.push(message);
	fitShare(state.messages, message.author, ceiling);
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
