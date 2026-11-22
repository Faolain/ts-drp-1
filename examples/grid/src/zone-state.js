/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Executable JavaScript host boundary; public types are declared in zone-state.d.ts. */
// Raw host boundary. Arithmetic and application authority transitions delegate
// to the exact toolchain artifact used by the genuine catalog.
import {
	canonicalArrayResourceForSizing,
	canonicalArrayResourcesForSizing,
	canonicalBytesResourceForSizing,
	canonicalRecordResourceForSizing,
} from "@ts-drp/canonical/resource";
import {decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {createCanonicalWalker} from "@ts-drp/canonical/exact";

import { blueprint } from "./zone-state-artifact.mjs";
import { blueprint as predecessorBlueprint } from "./zone-state-predecessor-artifact.mjs";

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

function denseDataArray(value) {
	if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return undefined;
	const values = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
		values.push(descriptor.value);
	}
	return values;
}

// These are the existing captured outcome fields, not a new proof codec or an
// assertion that its signatures are valid. Inner BYTES remain opaque here.
function outcomeResource(outcome) {
	return canonicalRecordResourceForSizing({
		action: outcome.action,
		proof: canonicalRecordResourceForSizing({
			action: outcome.proof.action,
			approvals: canonicalArrayResourcesForSizing(outcome.proof.approvals.map(approval =>
				canonicalRecordResourceForSizing({
					signature: canonicalBytesResourceForSizing(approval.signature.byteLength),
					signer: approval.signer,
				}))),
			clientOperationId: outcome.proof.clientOperationId,
			exactCanonicalIntentBytes: canonicalBytesResourceForSizing(outcome.proof.exactCanonicalIntentBytes.byteLength),
			exactCanonicalPayloadBytes: canonicalBytesResourceForSizing(outcome.proof.exactCanonicalPayloadBytes.byteLength),
		}),
	});
}

/**
 * Seeds the immutable creator identity authenticated by the room genesis.
 * @param creatorAuthor - Genesis signer identity.
 * @param creatorPeerId - Creator transport identity bound to the room id.
 * @returns Empty versioned application state.
 */
function emptyZoneState(creatorAuthor, creatorPeerId) {
	return Object.freeze({
		version: 2,
		creatorAuthor,
		creatorPeerId,
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

/**
 * Captures the raw host boundary over the genuine shared artifact.
 * @param creatorAuthor - Expected authenticated creator signer.
 * @param creatorPeerId - Expected creator transport identity.
 * @param artifactVersion - Exact supported catalog generation; never caller-supplied executable code.
 * @returns Pure transition and strict snapshot capture facade.
 */
function createZoneStateKernel(creatorAuthor, creatorPeerId, artifactVersion = "current") {
	if (artifactVersion !== "current" && artifactVersion !== "predecessor")
		throw new TypeError("v3 zone artifact generation is unsupported");
	// Keep the genuine predecessor read/continuation owner until authenticated
	// recovery and retirement discharge every supported predecessor dependency.
	// This selector grants neither cross-blueprint migration nor wire authority.
	const selectedBlueprint = artifactVersion === "predecessor" ? predecessorBlueprint : blueprint;
	if (
		typeof creatorAuthor !== "string" ||
		!/^[0-9a-f]{64}$/u.test(creatorAuthor) ||
		typeof creatorPeerId !== "string" ||
		creatorPeerId.length === 0
	) {
		throw new TypeError("v3 zone creator identity is invalid");
	}
	// Resource alternatives retain the SAME structural member checks. A foreign
	// Writer's local bootstrap may start at order1 and is an ORIGINAL reducer
	// no-op; including its full structural roster only overbounds state resources.
	// This does not install it or establish creator/Writer authority.
	function rosterResourceMembers(value) {
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
		return Object.freeze(entries);
	}
	function rosterValue(value) {
		const entries = rosterResourceMembers(value);
		return entries !== undefined && entries[0].order === 0 && entries[0].author === creatorAuthor && entries[0].peerId === creatorPeerId
			? entries
			: undefined;
	}
	// States and blocks this kernel itself captured. Each is a deeply frozen data value (its byte
	// arrays are fixed-length copies whose contents captureState never inspects), so capturing it
	// again would return a field-for-field identical value: the capture is reused instead.
	// A state captured with an uninstalled roster allowed is reused only where that is allowed.
	const capturedStates = new WeakMap();
	const capturedBlocks = new WeakSet();
	function captureState(value, allowUninstalledRoster = false) {
		const prior = capturedStates.get(value);
		if (prior !== undefined && (prior === false || allowUninstalledRoster)) return value;
		if (
			!exactKeys(value, ["version", "creatorAuthor", "creatorPeerId", "blocks", "outcomes", "roster"]) ||
			value.version !== 2 ||
			value.creatorAuthor !== creatorAuthor ||
			value.creatorPeerId !== creatorPeerId ||
			!Array.isArray(value.blocks) ||
			!Array.isArray(value.outcomes) ||
			!Array.isArray(value.roster)
		)
			throw new TypeError("v3 zone authenticated projection state is invalid");
		const roster =
			value.roster.length === 0 &&
			(allowUninstalledRoster || (value.blocks.length === 0 && value.outcomes.length === 0))
				? Object.freeze([])
				: rosterValue(value.roster);
		if (roster === undefined) throw new TypeError("v3 zone authenticated roster is invalid");
		const blocks = [];
		for (const candidate of value.blocks) {
			const block = capturedBlocks.has(candidate) ? candidate : blockValue(candidate, false);
			if (block === undefined || (blocks.length !== 0 && compareText(blocks[blocks.length - 1].id, block.id) >= 0)) {
				throw new TypeError("v3 zone authenticated projection state is invalid");
			}
			capturedBlocks.add(block);
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
		const captured = Object.freeze({
			version: 2,
			creatorAuthor,
			creatorPeerId,
			blocks: Object.freeze(blocks),
			outcomes: Object.freeze(outcomes),
			roster,
		});
		capturedStates.set(captured, allowUninstalledRoster);
		return captured;
	}
	function apply(state, operation, author) {
		const capturedState = captureState(state, true);
		// Canonical admission rejects raw accessors/prototypes and detaches binary
		// proof bytes before the artifact sees its declared canonical-input domain.
		const capturedOperation = decodeCanonical(encodeCanonical(operation));
		const action = capturedOperation.action;
		if (action === "join" || action === "$drp.author-fence.v1")
			return Object.freeze({ state: capturedState, output: null });
		const reducer = selectedBlueprint.reducers[action];
		if (typeof reducer !== "function") throw new TypeError("v3 zone operation is invalid");
		let result;
		try {
			result = reducer({
				state: capturedState,
				operation: capturedOperation,
				...(author === undefined ? {} : { executionContext: { author } }),
			});
		} catch (error) {
			if (typeof error === "string") throw new TypeError(error);
			throw error;
		}
		const freezeOutput = (value) => {
			if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
			for (const nested of Object.values(value)) freezeOutput(nested);
			return Object.freeze(value);
		};
		return Object.freeze({
			state: captureState(result.state, true),
			output: freezeOutput(decodeCanonical(encodeCanonical(result.output))),
		});
	}
	// SAME genuine BlueprintStateMachine depth/item envelope. No new fixture-sized
	// byte ceiling or relaxation of canonical admission.
	const PLACEMENT_BASE_LIMITS = Object.freeze({maxDepth: 16, maxItems: 16_384});
	/** The closed material record: its base vector and operation groups, or undefined. */
	function placementGrowthMaterial(material) {
		if (!exactKeys(material, ["exactCanonicalBaseStateBytes", "currentOperations", "protectedOperations",
			"recoveryOperations"])) return undefined;
		const bases = denseDataArray(material.exactCanonicalBaseStateBytes);
		const groups = [material.currentOperations, material.protectedOperations, material.recoveryOperations]
			.map(denseDataArray);
		if (bases === undefined || bases.length === 0 || groups.some(group => group === undefined)) return undefined;
		if (bases.some(bytes => !(bytes instanceof Uint8Array))) return undefined;
		return {bases, groups};
	}
	/** Resource data only. The native source owner must establish the exact
	 * recognized artifact and completeness of every base/operation vector.
	 * Placement order still determines the actual state; this upper bound covers
	 * any subset/order, original roster declarations and causalJoin no-ops without
	 * running reducers or constructing a future state. One owner for the sync and
	 * the resumable seed: each captured base contributes its blocks and its header,
	 * then complete() adds the operation groups and returns the projection. */
	function placementGrowthAccumulator(groups, bounded) {
		const rows = new Map();
		const headers = [];
		let rosterResource = {byteLength: 1, items: 1, maxDepth: 0};
		const includeRoster = roster => {
			const resource = canonicalArrayResourcesForSizing(roster.map(member => canonicalRecordResourceForSizing(member)));
			rosterResource = {byteLength: Math.max(rosterResource.byteLength, resource.byteLength),
				items: Math.max(rosterResource.items, resource.items), maxDepth: Math.max(rosterResource.maxDepth, resource.maxDepth)};
			return resource;
		};
		let rowBytes = 0;
		const includeBlock = block => {
			const resource = canonicalRecordResourceForSizing(block);
			const prior = rows.get(block.id);
			// The captured block schema always has four primitive fields. Its
			// item/depth shape is identical; keep the widest actual version per id.
			if (prior === undefined || resource.byteLength > prior.byteLength) {
				rows.set(block.id, resource); rowBytes += resource.byteLength - (prior?.byteLength ?? 0);
			}
		};
		const includeHeader = state => {
			headers.push({
				version: state.version,
				creatorAuthor: state.creatorAuthor,
				creatorPeerId: state.creatorPeerId,
				outcomes: canonicalArrayResourcesForSizing(state.outcomes.map(outcomeResource)),
				roster: includeRoster(state.roster),
			});
		};
		const complete = () => {
			const includeOperation = (value, includeBlock, includeRoster) => {
				// Detach/validate actual supplied operation material, like apply().
				const operation = decodeCanonical(encodeCanonical(value));
				const block = blockValue(operation, true);
				if (block !== undefined) { includeBlock(block); return true; }
				// Original closed catalog action with no arguments; no new control
				// classification or authority is inferred from this state no-op.
				if (exactKeys(operation, ["action"]) && operation.action === "causalJoin") return true;
				if (exactKeys(operation, ["action", "roster"]) && operation.action === "installRoster" &&
					exactKeys(operation.roster, ["entries"])) {
					const roster = rosterResourceMembers(operation.roster.entries);
					if (roster === undefined) return false;
					// A declaration is only an actual possible resource alternative.
					// The original reducer/author owner still decides if it may install.
					includeRoster(roster);
					return true;
				}
				if (!exactKeys(operation, ["action", "batch"]) || operation.action !== "applicationBatch" ||
					!exactKeys(operation.batch, ["entries", "version"]) || operation.batch.version !== 1) return false;
				const entries = denseDataArray(operation.batch.entries);
				if (entries === undefined || entries.length < 2 || entries.length > 16) return false;
				let prior = -1;
				for (const entry of entries) {
					if (!exactKeys(entry, ["logicalTime", "operation"]) || !Number.isSafeInteger(entry.logicalTime) ||
						entry.logicalTime < 0 || entry.logicalTime <= prior) return false;
					const placement = blockValue(entry.operation, true);
					if (placement === undefined) return false;
					prior = entry.logicalTime;
					includeBlock(placement);
				}
				return true;
			};
			for (const group of groups) for (const operation of group)
				if (!includeOperation(operation, includeBlock, includeRoster)) return undefined;
			// All captured blocks have the same primitive four-field item/depth
			// shape. Original ARRAY algebra supplies count/framing; only the sum of
			// exact child bytes varies. Never rebuild the complete child vector.
			const unit = canonicalRecordResourceForSizing({id: "x", kind: "x", x: 0, y: 0});
			const minimumPlacementBytes = canonicalRecordResourceForSizing({action: "placeBlock", id: "x", kind: "x", x: 0, y: 0}).byteLength;
			const rosterUnit = canonicalRecordResourceForSizing({author: creatorAuthor, peerId: "x", order: 0});
			const bound = (count, sum, roster) => {
				const uniform = canonicalArrayResourceForSizing(count, unit);
				const blocks = {...uniform, byteLength: uniform.byteLength + sum - count * unit.byteLength};
				const resources = headers.map(header => canonicalRecordResourceForSizing({...header, blocks, roster}));
				const resource = Object.freeze({byteLength: Math.max(...resources.map(row => row.byteLength)),
					items: Math.max(...resources.map(row => row.items)), maxDepth: Math.max(...resources.map(row => row.maxDepth)), blockCount: count});
				// SAME original BlueprintStateMachine item/depth envelope. This is
				// local planner availability, never a new operation validity limit.
				return !bounded || resource.items <= 16_384 && resource.maxDepth <= 16 ? resource : undefined;
			};
			if (bound(rows.size, rowBytes, rosterResource) === undefined) return undefined;
			const prepare = operations => {
				const values = denseDataArray(operations);
				if (values === undefined) return undefined;
				const changed = new Map();
				let count = rows.size, sum = rowBytes, roster = {...rosterResource};
				const addBlock = block => {
					const resource = canonicalRecordResourceForSizing(block), prior = changed.get(block.id) ?? rows.get(block.id);
					if (prior === undefined || resource.byteLength > prior.byteLength) {
						changed.set(block.id, resource); count += prior === undefined ? 1 : 0;
						sum += resource.byteLength - (prior?.byteLength ?? 0);
					}
				};
				const addRoster = members => {
					const resource = canonicalArrayResourcesForSizing(members.map(member => canonicalRecordResourceForSizing(member)));
					roster = {byteLength: Math.max(roster.byteLength, resource.byteLength), items: Math.max(roster.items, resource.items),
						maxDepth: Math.max(roster.maxDepth, resource.maxDepth)};
				};
				for (const operation of values) if (!includeOperation(operation, addBlock, addRoster)) return undefined;
				const resource = bound(count, sum, roster);
				return resource === undefined ? undefined : {changed, count, sum, roster, resource};
			};
			return Object.freeze({
				advance: operations => {
					try {
						const next = prepare(operations); if (next === undefined) return false;
						for (const [id, resource] of next.changed) rows.set(id, resource);
						rowBytes = next.sum; rosterResource = next.roster; return true;
					} catch { return false; }
				},
				quote: candidateOperation => {
					try {return prepare([candidateOperation])?.resource;} catch {return undefined;}
				},
				// SAME max-per-ID/roster/header theorem over complete accepted and
				// protected material. No candidate, fabricated operation or reducer.
				quoteWithoutApplicationCandidate: () => {
					try {return bound(rows.size, rowBytes, rosterResource);} catch {return undefined;}
				},
				// Whole-window resource DATA, not a prospective operation. Each new
				// block is a placement operation with only its action field removed;
				// each possible roster is an ARRAY already inside its declaration.
				// Their aggregate encoded bytes therefore cost at most the ORIGINAL
				// whole-operation byte budget ONCE, including batch wrappers. Existing
				// max-per-ID material remains, even for overwritten IDs. Only the
				// blocks ARRAY count header can grow outside those operation bytes.
				quoteWindow: declaration => {
					try {
						if (!exactKeys(declaration, ["maxAdditionalActions", "maxAdditionalOperationBytes"]) ||
							![Object.prototype, null].includes(Object.getPrototypeOf(declaration))) return undefined;
						const descriptors = Object.getOwnPropertyDescriptors(declaration);
						const actions = descriptors.maxAdditionalActions.value, budget = descriptors.maxAdditionalOperationBytes.value;
						if (![actions, budget].every(value => Number.isSafeInteger(value) && value >= 0) ||
							!descriptors.maxAdditionalActions.enumerable || !descriptors.maxAdditionalOperationBytes.enumerable) return undefined;
						if (actions === 0 || budget === 0) {
							const resource = bound(rows.size, rowBytes, rosterResource);
							return resource === undefined ? undefined : Object.freeze({byteLength: resource.byteLength,
								items: resource.items, maxDepth: resource.maxDepth});
						}
						const count = rows.size + Math.min(actions, Math.floor(budget / minimumPlacementBytes));
						if (!Number.isSafeInteger(count)) return undefined;
						// One roster action can contain many members. Its actual complete
						// encoding pays for every primitive member and ARRAY edge; fixed
						// author width/nonempty peer/safe integer make this the minimum.
						const futureRoster = canonicalArrayResourceForSizing(Math.floor(budget / rosterUnit.byteLength), rosterUnit);
						const roster = {byteLength: rosterResource.byteLength,
							items: Math.max(rosterResource.items, futureRoster.items),
							maxDepth: Math.max(rosterResource.maxDepth, futureRoster.maxDepth)};
						// Byte and item maxima need not occur together. This rectangle
						// uses existing roster bytes plus the aggregate growth budget,
						// and independently dominates every possible roster item shape.
						const resource = bound(count, rowBytes, roster);
						if (resource === undefined || !Number.isSafeInteger(resource.byteLength + budget)) return undefined;
						return Object.freeze({byteLength: resource.byteLength + budget, items: resource.items, maxDepth: resource.maxDepth});
					} catch {return undefined;}
				},
			});
		};
		return {includeBlock, includeHeader, complete};
	}
	function placementGrowthProjection(material, bounded) {
		try {
			const captured = placementGrowthMaterial(material);
			if (captured === undefined) return undefined;
			const growth = placementGrowthAccumulator(captured.groups, bounded);
			for (const bytes of captured.bases) {
				const state = captureState(decodeCanonical(bytes, PLACEMENT_BASE_LIMITS));
				const exact = encodeCanonical(state);
				if (exact.byteLength !== bytes.byteLength || !exact.every((byte, index) => byte === bytes[index])) return undefined;
				state.blocks.forEach(growth.includeBlock);
				growth.includeHeader(state);
			}
			return growth.complete();
		} catch {
			// Missing/unsupported pure material is not invalidity or admission.
			return undefined;
		}
	}
	const STATE_FIELDS = Object.freeze(["version", "creatorAuthor", "creatorPeerId", "blocks", "outcomes", "roster"]);
	/** The resumable form of createPlacementGrowthProjection over the SAME material and the SAME result:
	 * each base is walked in bounded byte steps (createCanonicalWalker accepts exactly the exact canonical
	 * bytes, so the sync form's re-encode comparison holds without a re-encode), every block, outcome and
	 * roster entry passes the same captureState checks, and the order captureState normalizes (approval
	 * signers, roster orders) must already hold, as the sync form's byte comparison requires. Then the
	 * same completion. A refused base throws from step; the seed grants nothing. */
	function beginPlacementGrowthProjection(material) {
		let captured;
		try {
			captured = placementGrowthMaterial(material);
		} catch {
			return undefined;
		}
		if (captured === undefined) return undefined;
		const growth = placementGrowthAccumulator(captured.groups, true);
		const invalid = () => {
			throw new TypeError("v3 zone authenticated projection state is invalid");
		};
		let index = 0;
		let walker;
		let base;
		let state = "walking";
		const visit = event => {
			if (event.depth === 0) {
				if (event.type === "value" || event.kind !== "object") invalid();
				return;
			}
			if (event.depth === 1) {
				const field = event.key;
				if (event.type === "leave") {
					base.field = undefined;
					return;
				}
				if (!STATE_FIELDS.includes(field)) invalid();
				base.fields.add(field);
				if (event.type === "enter") {
					if (event.kind !== "array" || (field !== "blocks" && field !== "outcomes" && field !== "roster")) invalid();
					base.field = field;
					return;
				}
				if (field === "version" ? event.value !== 2 : field === "creatorAuthor" ? event.value !== creatorAuthor :
					field === "creatorPeerId" ? event.value !== creatorPeerId : true) invalid();
				return;
			}
			if (event.type !== "value" || event.depth !== 2) invalid();
			if (base.field === "blocks") {
				const block = blockValue(event.value, false);
				if (block === undefined || (base.lastBlockId !== undefined && compareText(base.lastBlockId, block.id) >= 0)) invalid();
				base.lastBlockId = block.id;
				base.blockCount++;
				growth.includeBlock(block);
			} else if (base.field === "outcomes") {
				const outcome = outcomeValue(event.value);
				if (outcome === undefined || base.outcomeIds.has(outcome.proof.clientOperationId) ||
					event.value.proof.approvals[0].signer !== outcome.proof.approvals[0].signer) invalid();
				base.outcomeIds.add(outcome.proof.clientOperationId);
				base.outcomes.push(outcome);
			} else if (base.field === "roster") {
				base.roster.push(event.value);
			} else invalid();
		};
		const closeBase = () => {
			if (base.fields.size !== STATE_FIELDS.length) invalid();
			let roster = Object.freeze([]);
			if (base.roster.length !== 0 || base.blockCount !== 0 || base.outcomes.length !== 0) {
				roster = rosterValue(base.roster);
				if (roster === undefined || roster.some((entry, at) => entry.order !== base.roster[at].order)) invalid();
			}
			growth.includeHeader({version: 2, creatorAuthor, creatorPeerId, outcomes: base.outcomes, roster});
		};
		return Object.freeze({
			step(byteBudget) {
				if (state === "failed") throw new TypeError("v3 zone placement seed failed");
				if (state === "walked") return true;
				try {
					if (walker === undefined) {
						walker = createCanonicalWalker(captured.bases[index], {splitDepth: 2, limits: PLACEMENT_BASE_LIMITS});
						base = {fields: new Set(), field: undefined, lastBlockId: undefined, blockCount: 0, outcomes: [],
							outcomeIds: new Set(), roster: []};
					}
					if (!walker.step(byteBudget, visit)) return false;
					closeBase();
					walker = undefined;
					index++;
					if (index < captured.bases.length) return false;
					state = "walked";
					return true;
				} catch (error) {
					state = "failed";
					throw error;
				}
			},
			finish() {
				if (state !== "walked") return undefined;
				try {
					return growth.complete();
				} catch {
					return undefined;
				}
			},
		});
	}
	function createPlacementGrowthProjection(material) {
		return placementGrowthProjection(material, true);
	}
	function readPlacementGrowthBound(material) {
		if (!exactKeys(material, ["exactCanonicalBaseStateBytes", "currentOperations", "protectedOperations",
			"recoveryOperations", "candidateOperation"])) return undefined;
		const {candidateOperation, ...seed} = material;
		return placementGrowthProjection(seed, false)?.quote(candidateOperation);
	}
	const reduce = (input) => apply(input.state, input.operation, input.executionContext?.author);
	return Object.freeze({
		emptyState: () => emptyZoneState(creatorAuthor, creatorPeerId),
		apply,
		captureState,
		blockForOperation: (operation) => blockValue(operation, true),
		readPlacementGrowthBound,
		createPlacementGrowthProjection,
		beginPlacementGrowthProjection,
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
