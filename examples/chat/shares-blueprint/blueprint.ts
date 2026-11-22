// The room owner supplies authenticated executionContext.author. Neither this
// reducer nor a stored sender field grants membership, Writer or import authority.
//
// Version 5, membership-aware shares (Track W2, the owner's "guarantee and borrow").
// The state keeps the most recent messages in application order, oldest first, within
// one window budget (capacity.windowBytes). Each share holder has a guarantee (an
// equal split of the budget among current holders, never below the allowance) and
// may borrow what others leave unused: the window keeps any messages up to the
// budget. When a message does not fit, a departed member's message leaves first
// (an author without a share row), oldest first; when there is none, the oldest
// message of an author above their guarantee. The native admission policy caps what
// a holder adds in one checkpoint at the allowance, which is at most every guarantee,
// so no message admitted in a checkpoint leaves the window before it is sealed. An
// admin's share update (capacityAllocation) installs new rows; the native policy
// accepts only the exact rows its pure formula gives for the checkpoint's ACL.
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
function wholeNumber(value, maximum) {
	return typeof value === "number" && value % 1 === 0 && value >= 0 && value <= maximum;
}
function captureMessage(value) {
	if (
		!exactKeys(value, ["author", "clientOperationId", "displayTimeMs", "text"]) ||
		typeof value.author !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.author) ||
		typeof value.clientOperationId !== "string" ||
		!/^[A-Za-z0-9._:-]{1,128}$/.test(value.clientOperationId) ||
		!wholeNumber(value.displayTimeMs, 9007199254740991) ||
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
// At most 16 share rows, sorted by author; every guarantee at least the allowance, and
// the guarantees together within the window budget.
function captureCapacity(value) {
	if (
		!exactKeys(value, ["version", "basisObjectId", "allowanceBytes", "windowBytes", "allocations"]) ||
		value.version !== 2 ||
		typeof value.basisObjectId !== "string" ||
		value.basisObjectId.length === 0 ||
		value.basisObjectId.length > 1024 ||
		!wholeNumber(value.allowanceBytes, 32768) ||
		!wholeNumber(value.windowBytes, 32768) ||
		!denseArray(value.allocations) ||
		value.allocations.length > 16
	)
		throw "invalid chat shares";
	const allowanceBytes = value.allowanceBytes === 0 ? 0 : value.allowanceBytes;
	const allocations = [];
	let previous = "";
	let guaranteed = 0;
	for (const row of value.allocations) {
		if (
			!denseArray(row) ||
			row.length !== 3 ||
			typeof row[0] !== "string" ||
			!/^[0-9a-f]{64}$/.test(row[0]) ||
			row[0] <= previous ||
			!wholeNumber(row[1], 32768) ||
			row[1] < allowanceBytes ||
			!wholeNumber(row[2], 9007199254740991)
		)
			throw "invalid chat share row";
		previous = row[0];
		guaranteed += row[1];
		allocations.push([row[0], row[1] === 0 ? 0 : row[1], row[2] === 0 ? 0 : row[2]]);
	}
	if (guaranteed > value.windowBytes) throw "chat shares exceed the window";
	return {
		version: 2,
		basisObjectId: value.basisObjectId,
		allowanceBytes,
		windowBytes: value.windowBytes === 0 ? 0 : value.windowBytes,
		allocations,
	};
}
// A holder's guarantee, or -1 for an author without a share row (a departed member, or a
// Writer still waiting for a place).
function guaranteeOf(capacity, author) {
	for (const row of capacity.allocations) if (row[0] === author) return row[1];
	return -1;
}
function windowCharges(messages) {
	const charges = { total: 0, byAuthor: {} };
	for (const message of messages) {
		const bytes = recordBytes(message);
		charges.total += bytes;
		charges.byAuthor[message.author] =
			(charges.byAuthor[message.author] === undefined ? 0 : charges.byAuthor[message.author]) + bytes;
	}
	return charges;
}
function oldestDeparted(state) {
	for (let index = 0; index < state.messages.length; index += 1)
		if (guaranteeOf(state.capacity, state.messages[index].author) < 0) return index;
	return -1;
}
function oldestSurplus(state, charges) {
	for (let index = 0; index < state.messages.length; index += 1) {
		const author = state.messages[index].author;
		if (charges.byAuthor[author] > guaranteeOf(state.capacity, author)) return index;
	}
	return -1;
}
// The reclaim rule: while the window is over its budget, a departed member's oldest
// message leaves; when there is none, the oldest message of an author above their
// guarantee. One always exists while over budget, because the guarantees sum to at
// most the budget.
function reclaim(state) {
	const charges = windowCharges(state.messages);
	while (charges.total > state.capacity.windowBytes) {
		let index = oldestDeparted(state);
		if (index < 0) index = oldestSurplus(state, charges);
		if (index < 0) throw "shipping chat window cannot fit";
		for (const removed of state.messages.splice(index, 1)) {
			const bytes = recordBytes(removed);
			charges.total -= bytes;
			charges.byAuthor[removed.author] -= bytes;
		}
	}
}
function captureState(value) {
	if (!exactKeys(value, ["version", "messages", "capacity"]) || value.version !== 5 || !denseArray(value.messages))
		throw "invalid chat shares state";
	const capacity = captureCapacity(value.capacity);
	const messages = [];
	const seen = {};
	for (const row of value.messages) {
		const message = captureMessage(row);
		const key = message.author + "\u0000" + message.clientOperationId;
		if (seen[key] === true) throw "shipping chat window identities repeat";
		seen[key] = true;
		messages.push(message);
	}
	if (windowCharges(messages).total > capacity.windowBytes) throw "shipping chat window exceeds its budget";
	return { version: 5, messages, capacity };
}
function capacityAllocationReducer(input) {
	const operation = input.operation;
	if (
		!exactKeys(operation, ["action", "capacity", "epoch", "aclDigest"]) ||
		operation.action !== "capacityAllocation" ||
		!wholeNumber(operation.epoch, 9007199254740991) ||
		typeof operation.aclDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(operation.aclDigest)
	)
		throw "invalid chat share update";
	const state = captureState(input.state);
	const capacity = captureCapacity(operation.capacity);
	if (capacity.basisObjectId !== state.capacity.basisObjectId) throw "chat share basis is immutable";
	if (capacity.allowanceBytes !== state.capacity.allowanceBytes) throw "chat share allowance is immutable";
	// New rows can shrink the budget: reclaim applies, departed members first.
	state.capacity = capacity;
	reclaim(state);
	return { state, output: null };
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
			// An exact retry refreshes its message: it becomes the newest.
			state.messages.splice(index, 1);
			state.messages.push(prior);
			return { output: message, state };
		}
		index += 1;
	}
	if (guaranteeOf(state.capacity, message.author) < 0) throw "shipping chat author has no share";
	if (recordBytes(message) > state.capacity.allowanceBytes) throw "shipping chat message exceeds the allowance";
	state.messages.push(message);
	reclaim(state);
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
			!wholeNumber(entry.logicalTime, 9007199254740991) ||
			entry.logicalTime <= prior ||
			entry.operation === null ||
			typeof entry.operation !== "object"
		)
			throw "invalid shipping chat batch entry";
		prior = entry.logicalTime;
		// A batch carries messages and share updates (both batchable), in order.
		const child = { state, operation: entry.operation, executionContext: input.executionContext };
		const result =
			entry.operation.action === "capacityAllocation" ? capacityAllocationReducer(child) : messageReducer(child);
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
