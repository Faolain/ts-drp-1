import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-v3/equivocation-contract.json" with { type: "json" };
import {
	createRemoteEquivocationObserver as productionFactory,
	verifyEquivocationProof as productionVerifyEquivocationProof,
} from "../packages/protocol-v3/src/index.js";
import type {
	EquivocationProofVerification,
	PersistedEquivocationState,
	PersistedVertexWitness,
	RawEd25519PublicKey,
	RemoteEquivocationObserver,
	RemoteEquivocationObserverOptions,
	RemoteObservationResult,
	TransactObservation,
	VerifyEquivocationProofInput,
	VerifyReceivedVertexInput,
} from "../packages/protocol-v3/src/index.js";

type AccessorControl = "compliant" | "nested-vertex-reread" | "production" | "proof-input-reread" | "state-reread";
type ObserverCategory = "control" | "nested-vertex" | "state";

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

interface CapturedVertex {
	readonly digest: Uint8Array;
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

const CONTROL = (process.env.PHASE_0O_A_PASS_2_CONTROL ?? "production") as AccessorControl;

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

function authoritativeResolver(author: string): RawEd25519PublicKey | undefined {
	return author === contract.author
		? { bytes: ed25519.getPublicKey(fromHex(contract.privateKeySeedHex)), format: "raw" }
		: undefined;
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

function emptyState(vertices: readonly PersistedVertexWitness[] = []): PersistedEquivocationState {
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

function captureVertex(vertex: PersistedVertexWitness): CapturedVertex {
	if (vertex === null || typeof vertex !== "object") {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	const digest = vertex.digest;
	const witness = vertex.witness;
	if (witness === null || typeof witness !== "object") {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	const domain = witness.domain;
	const expectedAnchor = witness.expectedAnchor;
	const receivedCanonicalPreimageBytes = witness.receivedCanonicalPreimageBytes;
	const signature = witness.signature;
	const suiteId = witness.suiteId;
	if (
		!(digest instanceof Uint8Array) ||
		typeof domain !== "string" ||
		typeof expectedAnchor !== "string" ||
		!(receivedCanonicalPreimageBytes instanceof Uint8Array) ||
		!(signature instanceof Uint8Array) ||
		typeof suiteId !== "string"
	) {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	return { digest, domain, expectedAnchor, receivedCanonicalPreimageBytes, signature, suiteId };
}

function detachCapturedVertex(captured: CapturedVertex): PersistedVertexWitness {
	return {
		digest: new Uint8Array(captured.digest),
		witness: {
			domain: captured.domain,
			expectedAnchor: captured.expectedAnchor,
			receivedCanonicalPreimageBytes: new Uint8Array(captured.receivedCanonicalPreimageBytes),
			signature: new Uint8Array(captured.signature),
			suiteId: captured.suiteId,
		},
	};
}

function detachVertexOnce(vertex: PersistedVertexWitness): PersistedVertexWitness {
	return detachCapturedVertex(captureVertex(vertex));
}

function detachVertexWithReread(vertex: PersistedVertexWitness): PersistedVertexWitness {
	captureVertex(vertex);
	return detachVertexOnce(vertex);
}

function detachState(
	state: PersistedEquivocationState,
	mode: "compliant" | "nested-vertex-reread" | "state-reread"
): PersistedEquivocationState {
	if (state === null || typeof state !== "object") {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const capturedVertices = state.vertices;
	if (!Array.isArray(capturedVertices)) {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const vertices = mode === "state-reread" ? state.vertices : capturedVertices;
	if (!Array.isArray(vertices)) {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const detachVertex = mode === "nested-vertex-reread" ? detachVertexWithReread : detachVertexOnce;
	return {
		proofs: state.proofs,
		slotSignal: state.slotSignal,
		vertices: vertices.map(detachVertex),
	};
}

function controlledFactory(
	options: RemoteEquivocationObserverOptions,
	mode: "compliant" | "nested-vertex-reread" | "state-reread"
): RemoteEquivocationObserver {
	return productionFactory({
		perSlotAdvisoryProofLimit: options.perSlotAdvisoryProofLimit,
		transactObservation: (scope, apply) =>
			options.transactObservation(scope, (state) => apply(detachState(state, mode))),
	});
}

function observerFor(
	category: ObserverCategory,
	options: RemoteEquivocationObserverOptions
): RemoteEquivocationObserver {
	if (CONTROL === "production") return productionFactory(options);
	if (CONTROL === "state-reread" && category === "state") {
		return controlledFactory(options, "state-reread");
	}
	if (CONTROL === "nested-vertex-reread" && category === "nested-vertex") {
		return controlledFactory(options, "nested-vertex-reread");
	}
	return controlledFactory(options, "compliant");
}

async function observeState(
	category: ObserverCategory,
	state: PersistedEquivocationState,
	candidate = materializeVertex(basePreimage())
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
		: productionVerifyEquivocationProof({
				canonicalProofBytes: proof.canonicalProofBytes,
				resolveAuthorPublicKey: authoritativeResolver,
			}).verified;
}

function acceptedForkSummary(
	outcome: ObservationOutcome,
	candidate: MaterializedVertex,
	stored: MaterializedVertex
): Readonly<Record<string, unknown>> {
	return {
		committed: outcome.committed,
		disposition: outcome.emitted?.disposition,
		newlyPersistedProofIds: outcome.emitted?.newlyPersistedProofIds,
		observedForkCount: outcome.emitted?.slotSignal?.observedForkCount,
		orderedDigests: outcome.emitted?.resolution?.orderedDigests,
		proofVerified: proofVerified(outcome.persisted),
		rejected: outcome.rejected,
		expected: {
			committed: true,
			disposition: "equivocation",
			newlyPersistedProofIds: [expectedProofId(candidate.digest, stored.digest)],
			observedForkCount: 1,
			orderedDigests: [toHex(candidate.digest), toHex(stored.digest)].sort(),
			proofVerified: true,
			rejected: false,
		},
	};
}

function expectAcceptedFork(
	outcome: ObservationOutcome,
	candidate: MaterializedVertex,
	stored: MaterializedVertex
): void {
	const summary = acceptedForkSummary(outcome, candidate, stored);
	const { expected, ...actual } = summary;
	expect(actual).toEqual(expected);
}

function verifyProofCompliantly(input: VerifyEquivocationProofInput): EquivocationProofVerification {
	let canonicalProofBytes: unknown;
	let resolver: unknown;
	try {
		canonicalProofBytes = input.canonicalProofBytes;
		resolver = input.resolveAuthorPublicKey;
	} catch {
		return { verified: false };
	}
	if (!(canonicalProofBytes instanceof Uint8Array) || typeof resolver !== "function") {
		return { verified: false };
	}
	return productionVerifyEquivocationProof({
		canonicalProofBytes: new Uint8Array(canonicalProofBytes),
		resolveAuthorPublicKey: resolver.bind(input) as VerifyEquivocationProofInput["resolveAuthorPublicKey"],
	});
}

function verifyProofWithReread(input: VerifyEquivocationProofInput): EquivocationProofVerification {
	if (!(input.canonicalProofBytes instanceof Uint8Array) || typeof input.resolveAuthorPublicKey !== "function") {
		return { verified: false };
	}
	return productionVerifyEquivocationProof({
		canonicalProofBytes: input.canonicalProofBytes,
		resolveAuthorPublicKey: input.resolveAuthorPublicKey.bind(input),
	});
}

function verifyProofUnderTest(input: VerifyEquivocationProofInput): EquivocationProofVerification {
	if (CONTROL === "production") return productionVerifyEquivocationProof(input);
	if (CONTROL === "proof-input-reread") return verifyProofWithReread(input);
	return verifyProofCompliantly(input);
}

async function validProofBytes(): Promise<Uint8Array> {
	let state = emptyState();
	const observer = productionFactory({
		perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
		transactObservation: (_scope, apply) => {
			const decision = apply(state);
			state = decision.state;
			return Promise.resolve(decision.result);
		},
	});
	await observer.observe(materializeVertex(basePreimage()).witness);
	await observer.observe(
		materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] })).witness
	);
	const proof = state.proofs[0];
	if (proof === undefined) throw new Error("test setup did not persist an equivocation proof");
	return proof.canonicalProofBytes;
}

describe("Phase 0o-a pass-2 state accessor capture RED", () => {
	it("[state-capture] consumes only the first clean state.vertices capture", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const forged = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		let verticesReads = 0;
		const state: PersistedEquivocationState = {
			...emptyState(),
			get vertices(): readonly PersistedVertexWitness[] {
				verticesReads++;
				return verticesReads <= 2 ? [persistedVertex(clean)] : [persistedVertex(forged)];
			},
		};
		const outcome = await observeState("state", state, candidate);
		expectAcceptedFork(outcome, candidate, clean);
		expect(verticesReads).toBe(1);
	});

	it("[state-capture] rejects an invalid first capture without decision, commit, or emission", async () => {
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const forged = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		let verticesReads = 0;
		const state: PersistedEquivocationState = {
			...emptyState(),
			get vertices(): readonly PersistedVertexWitness[] {
				verticesReads++;
				return verticesReads === 1 ? [persistedVertex(forged)] : [persistedVertex(clean)];
			},
		};
		const outcome = await observeState("state", state);
		expect({
			committed: outcome.committed,
			emitted: outcome.emitted,
			rejected: outcome.rejected,
			verticesReads,
		}).toEqual({
			committed: false,
			emitted: undefined,
			rejected: true,
			verticesReads: 1,
		});
	});
});

describe("Phase 0o-a pass-2 nested persisted vertex capture RED", () => {
	it("[nested-vertex-capture] captures vertex.digest once and consumes only that authenticated digest", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		let digestReads = 0;
		const vertex: PersistedVertexWitness = {
			get digest(): Uint8Array {
				digestReads++;
				return digestReads === 1 ? clean.digest : new Uint8Array(32).fill(0xaa);
			},
			witness: persistedVertex(clean).witness,
		};
		const outcome = await observeState("nested-vertex", emptyState([vertex]), candidate);
		expectAcceptedFork(outcome, candidate, clean);
		expect(digestReads).toBe(1);
	});

	it("[nested-vertex-capture] captures vertex.witness once and consumes only that authenticated witness", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const forged = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		let witnessReads = 0;
		const vertex: PersistedVertexWitness = {
			digest: new Uint8Array(clean.digest),
			get witness(): PersistedVertexWitness["witness"] {
				witnessReads++;
				return witnessReads === 1 ? persistedVertex(clean).witness : persistedVertex(forged).witness;
			},
		};
		const outcome = await observeState("nested-vertex", emptyState([vertex]), candidate);
		expectAcceptedFork(outcome, candidate, clean);
		expect(witnessReads).toBe(1);
	});

	it("[nested-vertex-capture] captures every nested witness field once before authentication and copying", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const forged = materializeVertex(
			basePreimage({ logicalTime: contract.logicalTime + 1 }),
			contract.wrongPrivateKeySeedHex
		);
		const cleanWitness = persistedVertex(clean).witness;
		const forgedWitness = persistedVertex(forged).witness;
		const reads = {
			domain: 0,
			expectedAnchor: 0,
			receivedCanonicalPreimageBytes: 0,
			signature: 0,
			suiteId: 0,
		};
		const witness: PersistedVertexWitness["witness"] = {
			get domain(): string {
				reads.domain++;
				return reads.domain === 1 ? cleanWitness.domain : forgedWitness.domain;
			},
			get expectedAnchor(): string {
				reads.expectedAnchor++;
				return reads.expectedAnchor === 1 ? cleanWitness.expectedAnchor : forgedWitness.expectedAnchor;
			},
			get receivedCanonicalPreimageBytes(): Uint8Array {
				reads.receivedCanonicalPreimageBytes++;
				return reads.receivedCanonicalPreimageBytes === 1
					? cleanWitness.receivedCanonicalPreimageBytes
					: forgedWitness.receivedCanonicalPreimageBytes;
			},
			get signature(): Uint8Array {
				reads.signature++;
				return reads.signature === 1 ? cleanWitness.signature : forgedWitness.signature;
			},
			get suiteId(): string {
				reads.suiteId++;
				return reads.suiteId === 1 ? cleanWitness.suiteId : forgedWitness.suiteId;
			},
		};
		const outcome = await observeState(
			"nested-vertex",
			emptyState([{ digest: new Uint8Array(clean.digest), witness }]),
			candidate
		);
		expectAcceptedFork(outcome, candidate, clean);
		expect(reads).toEqual({
			domain: 1,
			expectedAnchor: 1,
			receivedCanonicalPreimageBytes: 1,
			signature: 1,
			suiteId: 1,
		});
	});
});

describe("Phase 0o-a pass-2 proof input accessor capture RED", () => {
	it("[proof-input-capture] captures canonicalProofBytes once before validation and copying", async () => {
		const proofBytes = await validProofBytes();
		let proofBytesReads = 0;
		let resolverCalls = 0;
		const verification = verifyProofUnderTest({
			get canonicalProofBytes(): Uint8Array {
				proofBytesReads++;
				return proofBytesReads === 1 ? proofBytes : ({ typeChangingSentinel: true } as unknown as Uint8Array);
			},
			resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined {
				resolverCalls++;
				return authoritativeResolver(author);
			},
		});
		expect({ proofBytesReads, resolverCalls, verified: verification.verified }).toEqual({
			proofBytesReads: 1,
			resolverCalls: 2,
			verified: true,
		});
	});

	it("[proof-input-capture] captures one resolver and uses that same function for both proof vertices", async () => {
		const proofBytes = await validProofBytes();
		let resolverReads = 0;
		let authoritativeCalls = 0;
		let swappedCalls = 0;
		const verification = verifyProofUnderTest({
			canonicalProofBytes: proofBytes,
			get resolveAuthorPublicKey(): VerifyEquivocationProofInput["resolveAuthorPublicKey"] {
				resolverReads++;
				if (resolverReads === 1) {
					return (author: string): RawEd25519PublicKey | undefined => {
						authoritativeCalls++;
						return authoritativeResolver(author);
					};
				}
				return (): RawEd25519PublicKey | undefined => {
					swappedCalls++;
					return undefined;
				};
			},
		});
		expect({
			authoritativeCalls,
			resolverReads,
			swappedCalls,
			verified: verification.verified,
		}).toEqual({
			authoritativeCalls: 2,
			resolverReads: 1,
			swappedCalls: 0,
			verified: true,
		});
	});

	it("[proof-input-capture] captures both invalid inputs once and fails before copy or resolver calls", () => {
		let proofBytesReads = 0;
		let resolverCalls = 0;
		let resolverReads = 0;
		const verification = verifyProofUnderTest({
			get canonicalProofBytes(): Uint8Array {
				proofBytesReads++;
				return { typeChangingSentinel: true } as unknown as Uint8Array;
			},
			get resolveAuthorPublicKey(): VerifyEquivocationProofInput["resolveAuthorPublicKey"] {
				resolverReads++;
				return (): RawEd25519PublicKey | undefined => {
					resolverCalls++;
					return undefined;
				};
			},
		});
		expect({
			proofBytesReads,
			resolverCalls,
			resolverReads,
			verification,
		}).toEqual({
			proofBytesReads: 1,
			resolverCalls: 0,
			resolverReads: 1,
			verification: { verified: false },
		});
	});
});

describe("Phase 0o-a pass-2 plain-data control", () => {
	it("[control] continues to accept a genuine plain same-slot fork and emit a verified proof", async () => {
		const candidate = materializeVertex(basePreimage());
		const clean = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const outcome = await observeState("control", emptyState([persistedVertex(clean)]), candidate);
		expectAcceptedFork(outcome, candidate, clean);
	});
});
