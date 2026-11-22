import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-v3/equivocation-contract.json" with { type: "json" };
import {
	createRemoteEquivocationObserver as productionFactory,
	verifyEquivocationProof,
} from "../packages/protocol-v3/src/index.js";
import type {
	PersistedEquivocationState,
	PersistedVertexWitness,
	RawEd25519PublicKey,
	RemoteEquivocationObserver,
	RemoteEquivocationObserverOptions,
	RemoteObservationResult,
	TransactObservation,
	VerifyReceivedVertexInput,
} from "../packages/protocol-v3/src/index.js";

type ArrayDispatchControl = "compliant" | "iterator-dispatch" | "map-dispatch" | "production" | "slice-dispatch";
type ArrayDispatchCategory = "control" | "iterator" | "map" | "slice";
type SanitizerMode = Exclude<ArrayDispatchControl, "production">;

interface MaterializedVertex {
	readonly digest: Uint8Array;
	readonly witness: VerifyReceivedVertexInput;
}

interface ObservationOutcome {
	readonly committed: boolean;
	readonly emitted: RemoteObservationResult | undefined;
	readonly persisted: PersistedEquivocationState | undefined;
	readonly rejected: boolean;
}

interface DispatchCounts {
	iterator: number;
	map: number;
	slice: number;
}

const CONTROL = (process.env.PHASE_0O_A_PASS_3_CONTROL ?? "production") as ArrayDispatchControl;

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function basePreimage(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: contract.objectId,
		epoch: contract.epoch,
		anchor: contract.anchor,
		author: contract.author,
		authorSequence: contract.baseSequence,
		logicalTime: contract.logicalTime,
		dependencies: [...contract.dependencies],
		operation: { ...contract.operation },
		...overrides,
	};
}

function authoritativeResolver(author: string): RawEd25519PublicKey | undefined {
	return author === contract.author
		? { bytes: ed25519.getPublicKey(fromHex(contract.privateKeySeedHex)), format: "raw" }
		: undefined;
}

function materializeVertex(
	preimage: Readonly<Record<string, unknown>>,
	privateKeySeedHex = contract.privateKeySeedHex
): MaterializedVertex {
	const privateKeySeed = fromHex(privateKeySeedHex);
	const receivedCanonicalPreimageBytes = encodeCanonical(preimage);
	const digest = hashDomain(contract.domain, receivedCanonicalPreimageBytes);
	return {
		digest,
		witness: {
			domain: contract.domain,
			expectedAnchor: contract.anchor,
			receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey: authoritativeResolver,
			signature: ed25519.sign(digest, privateKeySeed),
			suiteId: contract.suiteId,
		},
	};
}

function persistedVertex(vertex: MaterializedVertex): PersistedVertexWitness {
	return {
		digest: new Uint8Array(vertex.digest),
		witness: {
			domain: vertex.witness.domain,
			expectedAnchor: vertex.witness.expectedAnchor,
			receivedCanonicalPreimageBytes: new Uint8Array(vertex.witness.receivedCanonicalPreimageBytes),
			signature: new Uint8Array(vertex.witness.signature),
			suiteId: vertex.witness.suiteId,
		},
	};
}

function stateWith(vertices: readonly PersistedVertexWitness[]): PersistedEquivocationState {
	return {
		proofs: [],
		slotSignal: {
			author: contract.author,
			observedForkCount: Math.max(0, vertices.length - 1),
			advisoryLimitReached: false,
			withinAdvisoryLimitProofCount: 0,
			overAdvisoryLimitProofCount: 0,
		},
		vertices,
	};
}

function primitiveOwnedIndexCopy(vertices: readonly PersistedVertexWitness[]): PersistedVertexWitness[] {
	const copy: PersistedVertexWitness[] = [];
	for (let index = 0; index < vertices.length; index++) {
		copy[index] = vertices[index] as PersistedVertexWitness;
	}
	return copy;
}

function sanitizeCoordinatorState(state: PersistedEquivocationState, mode: SanitizerMode): PersistedEquivocationState {
	if (state === null || typeof state !== "object") {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const capturedVertices = state.vertices;
	if (!Array.isArray(capturedVertices)) {
		throw new TypeError("persisted equivocation state is malformed");
	}

	let selectedVertices: readonly PersistedVertexWitness[];
	if (mode === "map-dispatch") {
		selectedVertices = capturedVertices.map((vertex) => vertex);
	} else if (mode === "slice-dispatch") {
		selectedVertices = capturedVertices.slice();
	} else if (mode === "iterator-dispatch") {
		const iteratedVertices: PersistedVertexWitness[] = [];
		for (const vertex of capturedVertices) iteratedVertices.push(vertex);
		selectedVertices = iteratedVertices;
	} else {
		selectedVertices = primitiveOwnedIndexCopy(capturedVertices);
	}

	return {
		proofs: state.proofs,
		slotSignal: state.slotSignal,
		vertices: primitiveOwnedIndexCopy(selectedVertices),
	};
}

function controlledFactory(
	options: RemoteEquivocationObserverOptions,
	mode: SanitizerMode
): RemoteEquivocationObserver {
	return productionFactory({
		perSlotAdvisoryProofLimit: options.perSlotAdvisoryProofLimit,
		transactObservation: (scope, apply) =>
			options.transactObservation(scope, (state) => apply(sanitizeCoordinatorState(state, mode))),
	});
}

function observerFor(
	category: ArrayDispatchCategory,
	options: RemoteEquivocationObserverOptions
): RemoteEquivocationObserver {
	if (CONTROL === "production") return productionFactory(options);
	if (CONTROL === "map-dispatch" && category === "map") return controlledFactory(options, "map-dispatch");
	if (CONTROL === "slice-dispatch" && category === "slice") return controlledFactory(options, "slice-dispatch");
	if (CONTROL === "iterator-dispatch" && category === "iterator") {
		return controlledFactory(options, "iterator-dispatch");
	}
	return controlledFactory(options, "compliant");
}

async function observeState(
	category: ArrayDispatchCategory,
	state: PersistedEquivocationState,
	candidate: MaterializedVertex
): Promise<ObservationOutcome> {
	let committed = false;
	let emitted: RemoteObservationResult | undefined;
	let persisted: PersistedEquivocationState | undefined;
	const transactObservation: TransactObservation = (_scope, apply) => {
		const decision = apply(state);
		committed = true;
		emitted = decision.result;
		persisted = decision.state;
		return Promise.resolve(decision.result);
	};
	const observer = observerFor(category, {
		perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
		transactObservation,
	});
	let rejected = false;
	try {
		await observer.observe(candidate.witness);
	} catch {
		rejected = true;
	}
	return { committed, emitted, persisted, rejected };
}

function expectedProofId(left: Uint8Array, right: Uint8Array): string {
	const [first, second] = compareBytes(left, right) < 0 ? [left, right] : [right, left];
	return toHex(hashDomain(contract.proofDomain, first, second));
}

function proofVerified(state: PersistedEquivocationState | undefined): boolean | undefined {
	const proof = state?.proofs[0];
	return proof === undefined
		? undefined
		: verifyEquivocationProof({
				canonicalProofBytes: proof.canonicalProofBytes,
				resolveAuthorPublicKey: authoritativeResolver,
			}).verified;
}

function outcomeSummary(
	outcome: ObservationOutcome,
	hostileVertex?: PersistedVertexWitness
): Readonly<Record<string, unknown>> {
	return {
		admitted: outcome.emitted?.admitted,
		committed: outcome.committed,
		disposition: outcome.emitted?.disposition,
		liveHostileVertexPersisted:
			hostileVertex === undefined ? false : outcome.persisted?.vertices.includes(hostileVertex),
		newlyPersistedProofIds: outcome.emitted?.newlyPersistedProofIds,
		observedForkCount: outcome.emitted?.slotSignal?.observedForkCount,
		orderedDigests: outcome.emitted?.resolution?.orderedDigests,
		proofVerified: proofVerified(outcome.persisted),
		rejected: outcome.rejected,
	};
}

function expectedForkSummary(
	candidate: MaterializedVertex,
	stored: MaterializedVertex
): Readonly<Record<string, unknown>> {
	return {
		admitted: true,
		committed: true,
		disposition: "equivocation",
		liveHostileVertexPersisted: false,
		newlyPersistedProofIds: [expectedProofId(candidate.digest, stored.digest)],
		observedForkCount: 1,
		orderedDigests: [toHex(candidate.digest), toHex(stored.digest)].sort(),
		proofVerified: true,
		rejected: false,
	};
}

function safetyErrors(
	outcome: ObservationOutcome,
	candidate: MaterializedVertex,
	stored: MaterializedVertex,
	counts: DispatchCounts,
	hostileVertex?: PersistedVertexWitness
): string[] {
	const errors: string[] = [];
	if (counts.map !== 0) errors.push(`coordinator-owned map invoked ${counts.map} time(s)`);
	if (counts.slice !== 0) errors.push(`coordinator-owned slice invoked ${counts.slice} time(s)`);
	if (counts.iterator !== 0) errors.push(`coordinator-owned Symbol.iterator invoked ${counts.iterator} time(s)`);

	const summary = outcomeSummary(outcome, hostileVertex);
	const acceptedAuthenticatedFork = JSON.stringify(summary) === JSON.stringify(expectedForkSummary(candidate, stored));
	const rejectedBeforeDecision =
		!outcome.committed && outcome.emitted === undefined && outcome.persisted === undefined && outcome.rejected;
	if (!acceptedAuthenticatedFork && !rejectedBeforeDecision) {
		errors.push(`unsafe committed outcome: ${JSON.stringify(summary)}`);
	}
	return errors;
}

function installOwnMethod(target: readonly PersistedVertexWitness[], name: PropertyKey, value: unknown): void {
	Object.defineProperty(target, name, {
		configurable: true,
		enumerable: false,
		value,
		writable: true,
	});
}

describe("Phase 0o-a pass-3 coordinator-owned Array dispatch RED", () => {
	it("[map-dispatch] never invokes own map or persists its accessor-backed forged vertex", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const wrongKey = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		const cleanPersisted = persistedVertex(clean);
		const wrongKeyPersisted = persistedVertex(wrongKey);
		const forgedDigest = new Uint8Array(32).fill(0xaa);
		let digestReads = 0;
		let witnessReads = 0;
		const accessorVertex: PersistedVertexWitness = {
			get digest(): Uint8Array {
				digestReads++;
				return digestReads === 1 ? cleanPersisted.digest : forgedDigest;
			},
			get witness(): PersistedVertexWitness["witness"] {
				witnessReads++;
				return witnessReads === 1 ? cleanPersisted.witness : wrongKeyPersisted.witness;
			},
		};
		const counts: DispatchCounts = { iterator: 0, map: 0, slice: 0 };
		const coordinatorVertices = [cleanPersisted];
		installOwnMethod(coordinatorVertices, "map", (): PersistedVertexWitness[] => {
			counts.map++;
			return [accessorVertex];
		});

		const outcome = await observeState("map", stateWith(coordinatorVertices), candidate);
		expect(safetyErrors(outcome, candidate, clean, counts, accessorVertex)).toEqual([]);
	});

	it("[map-dispatch] also ignores an inherited Array-subclass map override", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const wrongKey = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		const counts: DispatchCounts = { iterator: 0, map: 0, slice: 0 };
		class CoordinatorVertices extends Array<PersistedVertexWitness> {}
		installOwnMethod(CoordinatorVertices.prototype, "map", (): PersistedVertexWitness[] => {
			counts.map++;
			return [persistedVertex(wrongKey)];
		});
		const coordinatorVertices = new CoordinatorVertices(persistedVertex(clean));

		const outcome = await observeState("map", stateWith(coordinatorVertices), candidate);
		expect(safetyErrors(outcome, candidate, clean, counts)).toEqual([]);
	});

	it("[slice-dispatch] never invokes a mapped result's hostile slice or commits its wrong-key vertex", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const wrongKey = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		const cleanPersisted = persistedVertex(clean);
		const wrongKeyPersisted = persistedVertex(wrongKey);
		const counts: DispatchCounts = { iterator: 0, map: 0, slice: 0 };
		const hostileSlice = (): PersistedVertexWitness[] => {
			counts.slice++;
			return [wrongKeyPersisted];
		};
		const mappedResult = [cleanPersisted];
		installOwnMethod(mappedResult, "slice", hostileSlice);
		const coordinatorVertices = [cleanPersisted];
		installOwnMethod(coordinatorVertices, "map", (): PersistedVertexWitness[] => {
			counts.map++;
			return mappedResult;
		});
		installOwnMethod(coordinatorVertices, "slice", hostileSlice);

		const outcome = await observeState("slice", stateWith(coordinatorVertices), candidate);
		expect(safetyErrors(outcome, candidate, clean, counts)).toEqual([]);
	});

	it("[iterator-dispatch] never trusts clean iteration while deciding over forged indexed values", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const wrongKey = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		const cleanPersisted = persistedVertex(clean);
		const wrongKeyPersisted = persistedVertex(wrongKey);
		const counts: DispatchCounts = { iterator: 0, map: 0, slice: 0 };
		const cleanIterator = function* (): Generator<PersistedVertexWitness> {
			counts.iterator++;
			yield cleanPersisted;
		};
		const mappedResult = [wrongKeyPersisted];
		installOwnMethod(mappedResult, Symbol.iterator, cleanIterator);
		const coordinatorVertices = [cleanPersisted];
		installOwnMethod(coordinatorVertices, "map", (): PersistedVertexWitness[] => {
			counts.map++;
			return mappedResult;
		});
		installOwnMethod(coordinatorVertices, Symbol.iterator, cleanIterator);

		const outcome = await observeState("iterator", stateWith(coordinatorVertices), candidate);
		expect(safetyErrors(outcome, candidate, clean, counts)).toEqual([]);
	});

	it("[control] continues to accept a plain same-slot fork and persist a verifying proof", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const counts: DispatchCounts = { iterator: 0, map: 0, slice: 0 };
		const outcome = await observeState("control", stateWith([persistedVertex(clean)]), candidate);
		expect(safetyErrors(outcome, candidate, clean, counts)).toEqual([]);
	});
});
