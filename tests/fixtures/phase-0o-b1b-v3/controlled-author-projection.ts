import { compareBytes, decodeCanonical } from "@ts-drp/canonical";

import {
	type EquivocationScope,
	type PersistedEquivocationProof,
	type PersistedEquivocationState,
	type PersistedVertexWitness,
	type RawEd25519PublicKey,
	verifyReceivedVertex,
} from "../../../packages/protocol-v3/src/index.js";
import {
	deriveEquivocationProofId,
	materializeCurrentEquivocationProof,
} from "../phase-0o-b1a-v3/controlled-equivocation-projection.js";

export interface AuthorProjectionSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}

export interface PendingEquivocationPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
	readonly pairId: string;
}

export interface DurableAuthorProjectionState {
	readonly slots: readonly AuthorProjectionSlot[];
	readonly pending: readonly PendingEquivocationPair[];
}

interface MutableDurableAuthorProjectionState {
	slots: AuthorProjectionSlot[];
	pending: PendingEquivocationPair[];
	cache?: Uint8Array;
}

export interface AuthorProjectionDecision<Result> {
	readonly state: DurableAuthorProjectionState;
	readonly result: Result;
}

export interface DurableAuthorEquivocationProjectionOptions {
	readCommittedSlotState(scope: EquivocationScope): Promise<PersistedEquivocationState>;
	enumerateCommittedAuthorSlots(author: string): Promise<readonly EquivocationScope[]>;
	transactAuthorProjection<Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result>;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	handoffProof(proof: PersistedEquivocationProof): Promise<void>;
}

export interface ReconcileAuthorProjectionResult {
	readonly enqueuedPairIds: readonly string[];
	readonly newDigestCount: number;
}

export interface RecoverAuthorProjectionResult {
	readonly reconciledSlotCount: number;
}

export interface DrainAuthorProjectionResult {
	readonly handedOff: boolean;
	readonly remainingPending: number;
}

export interface DurableAuthorEquivocationProjection {
	reconcile(scope: EquivocationScope): Promise<ReconcileAuthorProjectionResult>;
	recover(author: string): Promise<RecoverAuthorProjectionResult>;
	drainOne(author: string): Promise<DrainAuthorProjectionResult>;
}

type Mutant =
	| "array-dispatch"
	| "cache-proof-body"
	| "caller-delta"
	| "durable-array-dispatch"
	| "late-capture"
	| "no-recovery"
	| "ordered-pair"
	| "presented-only-pairs"
	| "read-proofs"
	| "remove-before-handoff"
	| "remove-before-auth"
	| "repeat-new"
	| "replace-union"
	| "self-pair"
	| "skip-authentication"
	| "stale-carrier"
	| "trust-row";

const mutant = process.env.PHASE_0O_B1B_MUTANT as Mutant | undefined;
const staleProofCache = new Map<string, PersistedEquivocationProof>();

function bytesToHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function hexToBytes(value: string): Uint8Array | undefined {
	if (!/^[0-9a-f]{64}$/u.test(value)) return undefined;
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function captureScope(value: unknown): EquivocationScope | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as Partial<EquivocationScope>;
	const author = candidate.author;
	const authorSequence = candidate.authorSequence;
	const objectId = candidate.objectId;
	if (
		typeof author !== "string" ||
		typeof objectId !== "string" ||
		!Number.isSafeInteger(authorSequence) ||
		(authorSequence as number) < 0
	) {
		return undefined;
	}
	return { author, authorSequence: authorSequence as number, objectId };
}

function scopeKey(scope: EquivocationScope): string {
	return `${scope.author.length}:${scope.author}|${scope.objectId.length}:${scope.objectId}|${scope.authorSequence}`;
}

function sameScope(left: EquivocationScope, right: EquivocationScope): boolean {
	return (
		left.author === right.author && left.authorSequence === right.authorSequence && left.objectId === right.objectId
	);
}

function detachVertex(value: unknown): PersistedVertexWitness | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as Partial<PersistedVertexWitness>;
	const capturedDigest = candidate.digest;
	if (!(capturedDigest instanceof Uint8Array) || capturedDigest.byteLength !== 32) return undefined;
	const digest = new Uint8Array(capturedDigest);
	const capturedWitness = candidate.witness;
	if (capturedWitness === null || typeof capturedWitness !== "object") return undefined;
	const domain = capturedWitness.domain;
	const expectedAnchor = capturedWitness.expectedAnchor;
	const capturedPreimage = capturedWitness.receivedCanonicalPreimageBytes;
	if (!(capturedPreimage instanceof Uint8Array)) return undefined;
	const receivedCanonicalPreimageBytes =
		mutant === "late-capture" ? capturedPreimage : new Uint8Array(capturedPreimage);
	const capturedSignature = capturedWitness.signature;
	const suiteId = capturedWitness.suiteId;
	if (
		typeof domain !== "string" ||
		typeof expectedAnchor !== "string" ||
		!(capturedSignature instanceof Uint8Array) ||
		capturedSignature.byteLength !== 64 ||
		typeof suiteId !== "string"
	) {
		return undefined;
	}
	return {
		digest,
		witness: {
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes: new Uint8Array(receivedCanonicalPreimageBytes),
			signature: new Uint8Array(capturedSignature),
			suiteId,
		},
	};
}

function captureCommittedVertices(
	value: unknown,
	scope: EquivocationScope,
	resolveAuthorPublicKey: DurableAuthorEquivocationProjectionOptions["resolveAuthorPublicKey"]
): readonly PersistedVertexWitness[] | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const state = value as PersistedEquivocationState & {
		readonly newlyPersistedProofIds?: unknown;
	};
	if (mutant === "read-proofs") void state.proofs;
	if (mutant === "caller-delta") void state.newlyPersistedProofIds;
	const capturedVertices = state.vertices;
	if (!Array.isArray(capturedVertices)) return undefined;
	const length = capturedVertices.length;
	const vertices: PersistedVertexWitness[] = [];
	if (mutant === "array-dispatch") {
		for (const valueVertex of capturedVertices) {
			const detached = detachVertex(valueVertex);
			if (detached === undefined) return undefined;
			vertices.push(detached);
		}
	} else {
		for (let index = 0; index < length; index++) {
			const detached = detachVertex(capturedVertices[index]);
			if (detached === undefined) return undefined;
			vertices.push(detached);
		}
	}
	for (let index = 0; index < vertices.length; index++) {
		const vertex = vertices[index] as PersistedVertexWitness;
		if (mutant !== "skip-authentication") {
			const verified = verifyReceivedVertex({
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				receivedCanonicalPreimageBytes: vertex.witness.receivedCanonicalPreimageBytes,
				resolveAuthorPublicKey,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			});
			if (!verified.accepted || verified.digest === undefined || compareBytes(verified.digest, vertex.digest) !== 0) {
				return undefined;
			}
		}
		let decoded: unknown;
		try {
			decoded = decodeCanonical(vertex.witness.receivedCanonicalPreimageBytes);
		} catch {
			return undefined;
		}
		if (decoded === null || typeof decoded !== "object") return undefined;
		const preimage = decoded as Record<string, unknown>;
		if (
			preimage.author !== scope.author ||
			preimage.authorSequence !== scope.authorSequence ||
			preimage.objectId !== scope.objectId
		) {
			return undefined;
		}
	}
	return vertices;
}

function canonicalPair(
	leftHex: string,
	rightHex: string,
	enableIdentityMutant = false
): readonly [lesserDigestHex: string, greaterDigestHex: string] | undefined {
	if (leftHex === rightHex) {
		return enableIdentityMutant && mutant === "self-pair" ? [leftHex, rightHex] : undefined;
	}
	if (enableIdentityMutant && mutant === "ordered-pair") return [leftHex, rightHex];
	return leftHex < rightHex ? [leftHex, rightHex] : [rightHex, leftHex];
}

function cloneScope(scope: EquivocationScope): EquivocationScope {
	return { author: scope.author, authorSequence: scope.authorSequence, objectId: scope.objectId };
}

function copyStrings(values: readonly string[]): string[] {
	const copy: string[] = [];
	const length = values.length;
	for (let index = 0; index < length; index++) copy.push(values[index] as string);
	return copy;
}

function contains(values: readonly string[], sought: string): boolean {
	for (let index = 0; index < values.length; index++) {
		if (values[index] === sought) return true;
	}
	return false;
}

function cloneState(state: DurableAuthorProjectionState): MutableDurableAuthorProjectionState {
	if (state === null || typeof state !== "object") throw new TypeError("durable author projection is malformed");
	const capturedSlots = state.slots;
	const capturedPending = state.pending;
	if (!Array.isArray(capturedSlots) || !Array.isArray(capturedPending)) {
		throw new TypeError("durable author projection is malformed");
	}
	if (mutant === "durable-array-dispatch") {
		void capturedSlots[Symbol.iterator]();
		void capturedPending[Symbol.iterator]();
	}
	const slots: AuthorProjectionSlot[] = [];
	const slotLength = capturedSlots.length;
	for (let index = 0; index < slotLength; index++) {
		const slot = capturedSlots[index] as AuthorProjectionSlot;
		if (slot === null || typeof slot !== "object") throw new TypeError("durable projection slot is malformed");
		const capturedScope = captureScope(slot.scope);
		const capturedDigests = slot.digestHexes;
		if (capturedScope === undefined || !Array.isArray(capturedDigests)) {
			throw new TypeError("durable projection slot is malformed");
		}
		const digestHexes = copyStrings(capturedDigests);
		for (let digestIndex = 0; digestIndex < digestHexes.length; digestIndex++) {
			if (!/^[0-9a-f]{64}$/u.test(digestHexes[digestIndex] as string)) {
				throw new TypeError("durable projection digest is malformed");
			}
		}
		slots.push({ scope: capturedScope, digestHexes });
	}
	const pending: PendingEquivocationPair[] = [];
	const pendingLength = capturedPending.length;
	for (let index = 0; index < pendingLength; index++) {
		const row = capturedPending[index] as PendingEquivocationPair;
		if (row === null || typeof row !== "object") throw new TypeError("pending pair row is malformed");
		const capturedScope = captureScope(row.scope);
		const lesserDigestHex = row.lesserDigestHex;
		const greaterDigestHex = row.greaterDigestHex;
		const capturedPairId = row.pairId;
		if (
			capturedScope === undefined ||
			typeof lesserDigestHex !== "string" ||
			typeof greaterDigestHex !== "string" ||
			typeof capturedPairId !== "string"
		) {
			throw new TypeError("pending pair row is malformed");
		}
		pending.push({
			scope: capturedScope,
			lesserDigestHex,
			greaterDigestHex,
			pairId: capturedPairId,
		});
	}
	return { pending, slots };
}

function pairId(pair: readonly [string, string]): string | undefined {
	const left = hexToBytes(pair[0]);
	const right = hexToBytes(pair[1]);
	if (left === undefined || right === undefined || pair[0] === pair[1]) return undefined;
	return deriveEquivocationProofId(left, right);
}

/**
 * Creates a deep-only coordinator over caller-injected authoritative slot reads and durable author state.
 * @param options - Injected authoritative reads, durable transactions, recovery enumeration and handoff.
 * @returns A durable author projection coordinator.
 */
export function createDurableAuthorEquivocationProjection(
	options: DurableAuthorEquivocationProjectionOptions
): DurableAuthorEquivocationProjection {
	if (options === null || typeof options !== "object") throw new TypeError("projection options are required");
	const readCommittedSlotState = options.readCommittedSlotState;
	const enumerateCommittedAuthorSlots = options.enumerateCommittedAuthorSlots;
	const transactAuthorProjection = options.transactAuthorProjection;
	const resolveAuthorPublicKey = options.resolveAuthorPublicKey;
	const handoffProof = options.handoffProof;
	if (
		typeof readCommittedSlotState !== "function" ||
		typeof enumerateCommittedAuthorSlots !== "function" ||
		typeof transactAuthorProjection !== "function" ||
		typeof resolveAuthorPublicKey !== "function" ||
		typeof handoffProof !== "function"
	) {
		throw new TypeError("all injected projection capabilities are required");
	}
	const authoritativeResolver = (author: string): RawEd25519PublicKey | undefined =>
		Reflect.apply(resolveAuthorPublicKey, options, [author]);
	const readSlot = (scope: EquivocationScope): Promise<PersistedEquivocationState> =>
		Reflect.apply(readCommittedSlotState, options, [scope]) as Promise<PersistedEquivocationState>;
	const enumerateSlots = (author: string): Promise<readonly EquivocationScope[]> =>
		Reflect.apply(enumerateCommittedAuthorSlots, options, [author]) as Promise<readonly EquivocationScope[]>;
	const transact = <Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result> => Reflect.apply(transactAuthorProjection, options, [author, apply]) as Promise<Result>;
	const handoff = (proof: PersistedEquivocationProof): Promise<void> =>
		Reflect.apply(handoffProof, options, [proof]) as Promise<void>;

	const reconcile = async (uncapturedScope: EquivocationScope): Promise<ReconcileAuthorProjectionResult> => {
		const scope = captureScope(uncapturedScope);
		if (scope === undefined) throw new TypeError("projection scope is malformed");
		const committed = await readSlot(cloneScope(scope));
		const vertices =
			mutant === "late-capture"
				? captureCommittedVertices(await Promise.resolve(committed), scope, authoritativeResolver)
				: captureCommittedVertices(committed, scope, authoritativeResolver);
		if (vertices === undefined) throw new TypeError("authoritative committed slot is invalid");
		const presentedDigestHexes: string[] = [];
		let duplicateDigestObserved = false;
		for (let index = 0; index < vertices.length; index++) {
			const digestHex = bytesToHex((vertices[index] as PersistedVertexWitness).digest);
			if (presentedDigestHexes.includes(digestHex)) duplicateDigestObserved = true;
			else presentedDigestHexes.push(digestHex);
		}
		presentedDigestHexes.sort();

		return transact(scope.author, (durable) => {
			const next = cloneState(durable);
			const key = scopeKey(scope);
			let slotIndex = -1;
			for (let index = 0; index < next.slots.length; index++) {
				if (scopeKey((next.slots[index] as AuthorProjectionSlot).scope) === key) {
					slotIndex = index;
					break;
				}
			}
			const prior = slotIndex === -1 ? [] : copyStrings((next.slots[slotIndex] as AuthorProjectionSlot).digestHexes);
			const newDigests =
				mutant === "repeat-new"
					? copyStrings(presentedDigestHexes)
					: presentedDigestHexes.filter((digest) => !contains(prior, digest));
			const postUnion: string[] = mutant === "replace-union" ? copyStrings(presentedDigestHexes) : copyStrings(prior);
			if (mutant !== "replace-union") {
				for (let index = 0; index < presentedDigestHexes.length; index++) {
					const digest = presentedDigestHexes[index] as string;
					if (!contains(postUnion, digest)) postUnion.push(digest);
				}
			}
			postUnion.sort();
			const enqueuedPairIds: string[] = [];
			const lefts = mutant === "presented-only-pairs" ? newDigests : newDigests;
			const rights = mutant === "presented-only-pairs" ? newDigests : postUnion;
			for (let leftIndex = 0; leftIndex < lefts.length; leftIndex++) {
				for (let rightIndex = 0; rightIndex < rights.length; rightIndex++) {
					const pair = canonicalPair(lefts[leftIndex] as string, rights[rightIndex] as string, duplicateDigestObserved);
					if (pair === undefined) continue;
					const id = pairId(pair);
					if (id === undefined && mutant !== "self-pair") continue;
					const identity = `${key}|${pair[0]}|${pair[1]}`;
					let exists = false;
					for (let pendingIndex = 0; pendingIndex < next.pending.length; pendingIndex++) {
						const row = next.pending[pendingIndex] as PendingEquivocationPair;
						if (`${scopeKey(row.scope)}|${row.lesserDigestHex}|${row.greaterDigestHex}` === identity) {
							exists = true;
							break;
						}
					}
					if (!exists) {
						next.pending.push({
							scope: cloneScope(scope),
							lesserDigestHex: pair[0],
							greaterDigestHex: pair[1],
							pairId: id ?? "self-pair",
						});
						enqueuedPairIds.push(id ?? "self-pair");
					}
				}
			}
			const slot = { scope: cloneScope(scope), digestHexes: postUnion };
			if (slotIndex === -1) next.slots.push(slot);
			else next.slots[slotIndex] = slot;
			if (mutant === "cache-proof-body") {
				next.cache = new Uint8Array(vertices[0]?.witness.receivedCanonicalPreimageBytes ?? []);
			}
			return {
				state: next,
				result: { enqueuedPairIds, newDigestCount: newDigests.length },
			};
		});
	};

	const recover = async (author: string): Promise<RecoverAuthorProjectionResult> => {
		if (typeof author !== "string") throw new TypeError("author is malformed");
		if (mutant === "no-recovery") return { reconciledSlotCount: 0 };
		const capturedScopes = await enumerateSlots(author);
		if (!Array.isArray(capturedScopes)) throw new TypeError("author recovery enumeration is malformed");
		const length = capturedScopes.length;
		let reconciledSlotCount = 0;
		for (let index = 0; index < length; index++) {
			const scope = captureScope(capturedScopes[index]);
			if (scope === undefined || scope.author !== author) {
				throw new TypeError("author recovery enumeration returned an invalid scope");
			}
			await reconcile(scope);
			reconciledSlotCount++;
		}
		return { reconciledSlotCount };
	};

	const drainOne = async (author: string): Promise<DrainAuthorProjectionResult> => {
		const selection = await transact(author, (state) => {
			const captured = cloneState(state);
			return {
				state,
				result: { pendingCount: captured.pending.length, row: captured.pending[0] },
			};
		});
		const row = selection.row;
		if (row === undefined) return { handedOff: false, remainingPending: 0 };
		const scope = captureScope(row.scope);
		const pair = canonicalPair(row.lesserDigestHex, row.greaterDigestHex);
		const expectedPairId = pair === undefined ? undefined : pairId(pair);
		if (
			scope === undefined ||
			scope.author !== author ||
			pair === undefined ||
			(mutant !== "trust-row" &&
				(row.lesserDigestHex !== pair[0] || row.greaterDigestHex !== pair[1] || row.pairId !== expectedPairId))
		) {
			const remainingPending = await transact(author, (state) => ({
				state,
				result: state.pending.length,
			}));
			return { handedOff: false, remainingPending };
		}
		const committed = await readSlot(cloneScope(scope));
		const vertices = captureCommittedVertices(committed, scope, authoritativeResolver);
		let proof: PersistedEquivocationProof | undefined;
		if (vertices !== undefined) {
			let lesser: PersistedVertexWitness | undefined;
			let greater: PersistedVertexWitness | undefined;
			for (let index = 0; index < vertices.length; index++) {
				const vertex = vertices[index] as PersistedVertexWitness;
				const digestHex = bytesToHex(vertex.digest);
				if (digestHex === pair[0]) lesser = vertex;
				if (digestHex === pair[1]) greater = vertex;
			}
			if (lesser !== undefined && greater !== undefined) {
				proof = materializeCurrentEquivocationProof({
					scope,
					vertices: [lesser, greater],
					resolveAuthorPublicKey: authoritativeResolver,
				});
			}
		}
		if (mutant === "stale-carrier" && proof !== undefined) {
			const stale = staleProofCache.get(row.pairId);
			if (stale === undefined) staleProofCache.set(row.pairId, structuredClone(proof));
			else proof = structuredClone(stale);
		}
		if (proof === undefined || (mutant !== "trust-row" && proof.proofId !== expectedPairId)) {
			if (mutant === "remove-before-auth") {
				await transact(author, (state) => {
					const next = cloneState(state);
					next.pending.splice(0, 1);
					return { state: next, result: undefined };
				});
			}
			const remainingPending = await transact(author, (state) => ({
				state,
				result: state.pending.length,
			}));
			return { handedOff: false, remainingPending };
		}
		if (mutant === "remove-before-handoff" && selection.pendingCount === 3) {
			await transact(author, (state) => {
				const next = cloneState(state);
				if (next.pending.length === 3) next.pending.splice(0, 1);
				return { state: next, result: undefined };
			});
		}
		await handoff(structuredClone(proof));
		const remainingPending = await transact(author, (state) => {
			const next = cloneState(state);
			const index = next.pending.findIndex(
				(candidate) =>
					sameScope(candidate.scope, row.scope) &&
					candidate.lesserDigestHex === row.lesserDigestHex &&
					candidate.greaterDigestHex === row.greaterDigestHex &&
					candidate.pairId === row.pairId
			);
			if (index !== -1) next.pending.splice(index, 1);
			return { state: next, result: next.pending.length };
		});
		return { handedOff: true, remainingPending };
	};

	return { drainOne, reconcile, recover };
}
