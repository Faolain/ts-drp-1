// This self-contained module is both the live state owner and the exact-byte
// artifact body. Keep its single export declaration at the end for composition.

function exactKeys(value, keys) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && Object.hasOwn(descriptor, "value");
		})
	);
}

function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function emptyZoneState() {
	return Object.freeze({
		version: 1,
		blocks: Object.freeze([]),
		outcomes: Object.freeze([]),
		roster: Object.freeze([]),
	});
}

function blockValue(value, operation) {
	if (!exactKeys(value, operation ? ["action", "id", "kind", "x", "y"] : ["id", "kind", "x", "y"])) return undefined;
	if (
		(operation && value.action !== "placeBlock") ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.kind !== "string" ||
		value.kind.length === 0 ||
		!Number.isSafeInteger(value.x) ||
		!Number.isSafeInteger(value.y)
	)
		return undefined;
	return Object.freeze({ id: value.id, kind: value.kind, x: value.x, y: value.y });
}

function outcomeValue(value) {
	if (!exactKeys(value, ["action", "proof"]) || value.action !== "commit-outcome-v1") return undefined;
	const proof = value.proof;
	if (
		!exactKeys(proof, [
			"action",
			"approvals",
			"clientOperationId",
			"exactCanonicalIntentBytes",
			"exactCanonicalPayloadBytes",
		]) ||
		proof.action !== "commit-outcome-v1" ||
		typeof proof.clientOperationId !== "string" ||
		proof.clientOperationId.length === 0 ||
		!(proof.exactCanonicalIntentBytes instanceof Uint8Array) ||
		!(proof.exactCanonicalPayloadBytes instanceof Uint8Array) ||
		!Array.isArray(proof.approvals) ||
		proof.approvals.length !== 2
	)
		return undefined;
	const approvals = [];
	for (const approval of proof.approvals) {
		if (
			!exactKeys(approval, ["signature", "signer"]) ||
			typeof approval.signer !== "string" ||
			!/^[0-9a-f]{64}$/u.test(approval.signer) ||
			!(approval.signature instanceof Uint8Array) ||
			approval.signature.length !== 64
		)
			return undefined;
		approvals.push(Object.freeze({ signer: approval.signer, signature: new Uint8Array(approval.signature) }));
	}
	approvals.sort((left, right) => compareText(left.signer, right.signer));
	if (approvals[0].signer === approvals[1].signer) return undefined;
	return Object.freeze({
		action: "commit-outcome-v1",
		proof: Object.freeze({
			action: "commit-outcome-v1",
			approvals: Object.freeze(approvals),
			clientOperationId: proof.clientOperationId,
			exactCanonicalIntentBytes: new Uint8Array(proof.exactCanonicalIntentBytes),
			exactCanonicalPayloadBytes: new Uint8Array(proof.exactCanonicalPayloadBytes),
		}),
	});
}

function createZoneStateKernel(creatorAuthor, creatorPeerId) {
	if (
		typeof creatorAuthor !== "string" ||
		!/^[0-9a-f]{64}$/u.test(creatorAuthor) ||
		typeof creatorPeerId !== "string" ||
		creatorPeerId.length === 0
	) {
		throw new TypeError("v3 zone creator identity is invalid");
	}
	function rosterValue(value) {
		if (!Array.isArray(value) || value.length === 0) return undefined;
		const entries = [];
		const authors = new Set();
		const peers = new Set();
		const orders = new Set();
		for (const member of value) {
			if (
				!exactKeys(member, ["author", "peerId", "order"]) ||
				typeof member.author !== "string" ||
				!/^[0-9a-f]{64}$/u.test(member.author) ||
				typeof member.peerId !== "string" ||
				member.peerId.length === 0 ||
				!Number.isSafeInteger(member.order) ||
				member.order < 0 ||
				authors.has(member.author) ||
				peers.has(member.peerId) ||
				orders.has(member.order)
			)
				return undefined;
			authors.add(member.author);
			peers.add(member.peerId);
			orders.add(member.order);
			entries.push(Object.freeze({ author: member.author, peerId: member.peerId, order: member.order }));
		}
		entries.sort((left, right) => left.order - right.order);
		return entries[0].order === 0 && entries[0].author === creatorAuthor && entries[0].peerId === creatorPeerId
			? Object.freeze(entries)
			: undefined;
	}
	function captureState(value) {
		if (
			!exactKeys(value, ["version", "blocks", "outcomes", "roster"]) ||
			value.version !== 1 ||
			!Array.isArray(value.blocks) ||
			!Array.isArray(value.outcomes) ||
			!Array.isArray(value.roster)
		)
			throw new TypeError("v3 zone authenticated projection state is invalid");
		const roster =
			value.roster.length === 0 && value.blocks.length === 0 && value.outcomes.length === 0
				? Object.freeze([])
				: rosterValue(value.roster);
		if (roster === undefined) throw new TypeError("v3 zone authenticated roster is invalid");
		const blocks = [];
		for (const candidate of value.blocks) {
			const block = blockValue(candidate, false);
			if (block === undefined || (blocks.length !== 0 && compareText(blocks[blocks.length - 1].id, block.id) >= 0)) {
				throw new TypeError("v3 zone authenticated projection state is invalid");
			}
			blocks.push(block);
		}
		const outcomes = [];
		const outcomeIds = new Set();
		for (const candidate of value.outcomes) {
			const outcome = outcomeValue(candidate);
			if (outcome === undefined || outcomeIds.has(outcome.proof.clientOperationId)) {
				throw new TypeError("v3 zone authenticated projection state is invalid");
			}
			outcomeIds.add(outcome.proof.clientOperationId);
			outcomes.push(outcome);
		}
		return Object.freeze({ version: 1, blocks: Object.freeze(blocks), outcomes: Object.freeze(outcomes), roster });
	}
	function apply(state, operation, author) {
		if (
			!exactKeys(state, ["version", "blocks", "outcomes", "roster"]) ||
			state.version !== 1 ||
			!Array.isArray(state.blocks) ||
			!Array.isArray(state.outcomes) ||
			!Array.isArray(state.roster) ||
			operation === null ||
			typeof operation !== "object" ||
			Array.isArray(operation)
		)
			throw new TypeError("v3 zone projection state is invalid");
		const action = operation.action;
		if (action === "join" || action === "causalJoin" || action === "$drp.author-fence.v1") {
			return Object.freeze({ state, output: null });
		}
		if (action === "installRoster") {
			if (typeof author !== "string" || !/^[0-9a-f]{64}$/u.test(author))
				throw new TypeError("v3 zone execution context is unavailable");
			if (author !== creatorAuthor) return Object.freeze({ state, output: operation });
			if (!exactKeys(operation, ["action", "roster"]) || !exactKeys(operation.roster, ["entries"])) {
				throw new TypeError("v3 zone roster conflicts");
			}
			const roster = rosterValue(operation.roster.entries);
			if (
				roster === undefined ||
				(state.roster.length !== 0 &&
					(state.roster.length !== roster.length ||
						state.roster.some(
							(member, index) =>
								member.author !== roster[index].author ||
								member.peerId !== roster[index].peerId ||
								member.order !== roster[index].order
						)))
			)
				throw new TypeError("v3 zone roster conflicts");
			return Object.freeze({ state: Object.freeze({ ...state, roster }), output: operation });
		}
		if (action === "placeBlock") {
			const block = blockValue(operation, true);
			if (block === undefined) throw new TypeError("v3 zone placeBlock operation is invalid");
			const blocks = state.blocks.filter((existing) => existing.id !== block.id);
			blocks.push(block);
			blocks.sort((left, right) => compareText(left.id, right.id));
			return Object.freeze({ state: Object.freeze({ ...state, blocks: Object.freeze(blocks) }), output: operation });
		}
		if (action === "commit-outcome-v1") {
			const outcome = outcomeValue(operation);
			if (outcome === undefined) throw new TypeError("v3 zone outcome proof is invalid");
			if (state.outcomes.some((existing) => existing.proof.clientOperationId === outcome.proof.clientOperationId)) {
				throw new TypeError("v3 zone outcome identity conflicts");
			}
			return Object.freeze({
				state: Object.freeze({ ...state, outcomes: Object.freeze([...state.outcomes, outcome]) }),
				output: outcome,
			});
		}
		if (action === "applicationBatch") {
			if (
				!exactKeys(operation, ["action", "batch"]) ||
				!exactKeys(operation.batch, ["entries", "version"]) ||
				operation.batch.version !== 1 ||
				!Array.isArray(operation.batch.entries) ||
				operation.batch.entries.length < 2 ||
				operation.batch.entries.length > 16
			)
				throw new TypeError("invalid application batch");
			let prior = -1;
			let next = state;
			const output = [];
			for (const entry of operation.batch.entries) {
				if (
					!exactKeys(entry, ["logicalTime", "operation"]) ||
					!Number.isSafeInteger(entry.logicalTime) ||
					entry.logicalTime < 0 ||
					entry.logicalTime <= prior ||
					blockValue(entry.operation, true) === undefined
				)
					throw new TypeError("invalid application batch entry");
				prior = entry.logicalTime;
				const result = apply(next, entry.operation, author);
				next = result.state;
				output.push(result.output);
			}
			return Object.freeze({ state: next, output: Object.freeze(output) });
		}
		if (action === "migrationRecord") {
			const keys = [
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
			if (
				!exactKeys(operation, ["action", "record"]) ||
				!exactKeys(operation.record, keys) ||
				operation.record.kind !== "ts-drp-v3-room-migration-record" ||
				operation.record.version !== 1 ||
				operation.record.archivePolicy !== "retain-source" ||
				operation.record.authorityKind !== "creator-ed25519-registered-vertex-v1"
			)
				throw new TypeError("invalid migration record");
			return Object.freeze({ state, output: null });
		}
		if (action === "migrationActivation") {
			if (
				!exactKeys(operation, ["action", "decision"]) ||
				operation.decision === null ||
				typeof operation.decision !== "object" ||
				Array.isArray(operation.decision)
			) {
				throw new TypeError("invalid migration activation");
			}
			return Object.freeze({ state, output: null });
		}
		throw new TypeError("v3 zone operation is invalid");
	}
	const reduce = (input) => apply(input.state, input.operation, input.executionContext?.author);
	return Object.freeze({
		apply,
		captureState,
		blockForOperation: (operation) => blockValue(operation, true),
		reducers: Object.freeze({
			"applicationBatch": reduce,
			"causalJoin": reduce,
			"commit-outcome-v1": reduce,
			"installRoster": reduce,
			"migrationActivation": reduce,
			"migrationRecord": reduce,
			"placeBlock": reduce,
		}),
	});
}

export { createZoneStateKernel, emptyZoneState };
