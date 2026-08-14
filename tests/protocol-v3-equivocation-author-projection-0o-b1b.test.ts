/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-b1b-v3/author-projection-contract.json" with { type: "json" };
import {
	createRemoteEquivocationObserver,
	type EquivocationScope,
	type PersistedEquivocationProof,
	type PersistedEquivocationState,
	type PersistedVertexWitness,
	type RawEd25519PublicKey,
	type RemoteObservationResult,
	type TransactObservation,
	verifyEquivocationProof,
	type VerifyReceivedVertexInput,
} from "../packages/protocol-v3/src/index.js";

interface AuthorProjectionSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}

interface PendingEquivocationPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
	readonly pairId: string;
}

interface DurableAuthorProjectionState {
	readonly slots: readonly AuthorProjectionSlot[];
	readonly pending: readonly PendingEquivocationPair[];
}

interface AuthorProjectionDecision<Result> {
	readonly state: DurableAuthorProjectionState;
	readonly result: Result;
}

interface ProjectionOptions {
	readCommittedSlotState(scope: EquivocationScope): Promise<PersistedEquivocationState>;
	enumerateCommittedAuthorSlots(author: string): Promise<readonly EquivocationScope[]>;
	transactAuthorProjection<Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result>;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	handoffProof(proof: PersistedEquivocationProof): Promise<void>;
}

interface Projection {
	reconcile(scope: EquivocationScope): Promise<{
		readonly enqueuedPairIds: readonly string[];
		readonly newDigestCount: number;
	}>;
	recover(author: string): Promise<{ readonly reconciledSlotCount: number }>;
	drainOne(author: string): Promise<{ readonly handedOff: boolean; readonly remainingPending: number }>;
}

interface ProjectionSurface {
	createDurableAuthorEquivocationProjection?(options: ProjectionOptions): Projection;
}

interface Vertex {
	readonly digest: Uint8Array;
	readonly witness: VerifyReceivedVertexInput;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const IMPLEMENTATION =
	process.env.PHASE_0O_B1B_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(REPOSITORY_ROOT, process.env.PHASE_0O_B1B_IMPLEMENTATION_MODULE);
const PUBLIC_ENTRY =
	process.env.PHASE_0O_B1B_MUTANT === "public-reexport"
		? resolve(CURRENT_DIRECTORY, contract.publicReexportMutantModule)
		: resolve(CURRENT_DIRECTORY, contract.publicEntryModule);
const projectionLoad = import(pathToFileURL(IMPLEMENTATION).href) as Promise<ProjectionSurface>;
const privateKeySeed = fromHex(contract.privateKeySeedHex);
const publicKey = ed25519.getPublicKey(privateKeySeed);
const ED25519_ORDER = BigInt(2) ** BigInt(252) + BigInt("27742317777372353535851937790883648493");

let committedOne: PersistedEquivocationState;
let committedTwo: PersistedEquivocationState;
let committedThree: PersistedEquivocationState;
let observationResults: readonly RemoteObservationResult[];
let staleCarrierState: PersistedEquivocationState;
let currentCarrierState: PersistedEquivocationState;

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function scope(): EquivocationScope {
	return {
		author: contract.author,
		authorSequence: contract.authorSequence,
		objectId: contract.objectId,
	};
}

function resolver(author: string): RawEd25519PublicKey | undefined {
	return author === contract.author ? { bytes: new Uint8Array(publicKey), format: "raw" } : undefined;
}

function preimage(dependency: string): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: contract.objectId,
		epoch: contract.epoch,
		anchor: contract.anchor,
		author: contract.author,
		authorSequence: contract.authorSequence,
		logicalTime: contract.logicalTime,
		dependencies: [dependency],
		operation: { ...contract.operation },
	};
}

function littleEndianInteger(bytes: Uint8Array): bigint {
	let value = BigInt(0);
	for (let index = bytes.byteLength - 1; index >= 0; index--) {
		value = (value << BigInt(8)) + BigInt(bytes[index] as number);
	}
	return value;
}

function littleEndianBytes(input: bigint, length: number): Uint8Array {
	let value = input;
	return Uint8Array.from({ length }, () => {
		const byte = Number(value & BigInt(255));
		value >>= BigInt(8);
		return byte;
	});
}

function signWithNonce(message: Uint8Array, nonce: bigint): Uint8Array {
	const expanded = new Uint8Array(createHash("sha512").update(privateKeySeed).digest());
	const scalarBytes = expanded.slice(0, 32);
	scalarBytes[0] = (scalarBytes[0] as number) & 248;
	scalarBytes[31] = ((scalarBytes[31] as number) & 63) | 64;
	const secretScalar = littleEndianInteger(scalarBytes);
	const encodedR = ed25519.ExtendedPoint.BASE.multiply(nonce).toRawBytes();
	const challenge =
		littleEndianInteger(createHash("sha512").update(encodedR).update(publicKey).update(message).digest()) %
		ED25519_ORDER;
	const encodedS = littleEndianBytes((nonce + challenge * secretScalar) % ED25519_ORDER, 32);
	const signature = new Uint8Array(64);
	signature.set(encodedR);
	signature.set(encodedS, 32);
	return signature;
}

function vertex(
	value: Readonly<Record<string, unknown>>,
	signatureFactory: (digest: Uint8Array) => Uint8Array = (digest) => ed25519.sign(digest, privateKeySeed)
): Vertex {
	const receivedCanonicalPreimageBytes = encodeCanonical(value);
	const digest = hashDomain(contract.domain, receivedCanonicalPreimageBytes);
	return {
		digest,
		witness: {
			domain: contract.domain,
			expectedAnchor: contract.anchor,
			receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey: resolver,
			signature: signatureFactory(digest),
			suiteId: contract.suiteId,
		},
	};
}

function emptyEquivocationState(): PersistedEquivocationState {
	return {
		proofs: [],
		slotSignal: {
			author: contract.author,
			observedForkCount: 0,
			advisoryLimitReached: false,
			withinAdvisoryLimitProofCount: 0,
			overAdvisoryLimitProofCount: 0,
		},
		vertices: [],
	};
}

class ObservationStore {
	state = emptyEquivocationState();

	readonly transactObservation: TransactObservation = (_scope, apply): Promise<RemoteObservationResult> => {
		const decision = apply(structuredClone(this.state));
		this.state = structuredClone(decision.state);
		return Promise.resolve(structuredClone(decision.result));
	};
}

async function buildCorpus(): Promise<void> {
	const vertices = contract.dependencies.map((dependency) => vertex(preimage(dependency)));
	const store = new ObservationStore();
	const observer = createRemoteEquivocationObserver({
		perSlotAdvisoryProofLimit: 1,
		transactObservation: store.transactObservation,
	});
	const results: RemoteObservationResult[] = [];
	results.push(await observer.observe((vertices[0] as Vertex).witness));
	committedOne = structuredClone(store.state);
	results.push(await observer.observe((vertices[1] as Vertex).witness));
	committedTwo = structuredClone(store.state);
	results.push(await observer.observe((vertices[2] as Vertex).witness));
	committedThree = structuredClone(store.state);
	observationResults = structuredClone(results);

	const recarrierStore = new ObservationStore();
	const recarrierObserver = createRemoteEquivocationObserver({
		perSlotAdvisoryProofLimit: 1,
		transactObservation: recarrierStore.transactObservation,
	});
	const base = vertices[0] as Vertex;
	const alternate = vertex(preimage(contract.dependencies[0] as string), (digest) => signWithNonce(digest, BigInt(7)));
	const baseCarrier = encodeCanonical({
		domain: base.witness.domain,
		expectedAnchor: base.witness.expectedAnchor,
		preimage: base.witness.receivedCanonicalPreimageBytes,
		signature: base.witness.signature,
		suiteId: base.witness.suiteId,
	});
	const alternateCarrier = encodeCanonical({
		domain: alternate.witness.domain,
		expectedAnchor: alternate.witness.expectedAnchor,
		preimage: alternate.witness.receivedCanonicalPreimageBytes,
		signature: alternate.witness.signature,
		suiteId: alternate.witness.suiteId,
	});
	const lesser = Buffer.compare(baseCarrier, alternateCarrier) < 0 ? base : alternate;
	const greater = lesser === base ? alternate : base;
	const recarrierFork = vertex(preimage("44".repeat(32)));
	await recarrierObserver.observe(greater.witness);
	await recarrierObserver.observe(recarrierFork.witness);
	staleCarrierState = structuredClone(recarrierStore.state);
	await recarrierObserver.observe(lesser.witness);
	currentCarrierState = structuredClone(recarrierStore.state);
	expect(currentCarrierState.proofs[0]?.proofId).toBe(staleCarrierState.proofs[0]?.proofId);
	expect(currentCarrierState.proofs[0]?.canonicalProofBytes).not.toEqual(
		staleCarrierState.proofs[0]?.canonicalProofBytes
	);
}

class AuthorStore {
	state: DurableAuthorProjectionState = { pending: [], slots: [] };
	failNextCommit = false;
	failNextPendingRemoval = false;
	private serial = Promise.resolve();

	readonly transactAuthorProjection: ProjectionOptions["transactAuthorProjection"] = async <Result>(
		_author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result> => {
		let release!: () => void;
		const prior = this.serial;
		this.serial = new Promise<void>((resolveSerial) => {
			release = resolveSerial;
		});
		await prior;
		try {
			const decision = apply(structuredClone(this.state));
			const pendingRemoval = this.failNextPendingRemoval && decision.state.pending.length < this.state.pending.length;
			if (this.failNextCommit || pendingRemoval) {
				this.failNextCommit = false;
				this.failNextPendingRemoval = false;
				throw new Error("INJECTED_AUTHOR_PROJECTION_COMMIT_LOSS");
			}
			this.state = structuredClone(decision.state);
			return structuredClone(decision.result);
		} finally {
			release();
		}
	};
}

class Harness {
	readonly authorStore = new AuthorStore();
	readonly handoffs: PersistedEquivocationProof[] = [];
	readonly reads: EquivocationScope[] = [];
	readonly enumerations: string[] = [];
	committed: PersistedEquivocationState = structuredClone(committedThree);
	handoffFailure = false;
	enumeratedScopes: readonly EquivocationScope[] = [scope()];

	options(): ProjectionOptions {
		return {
			enumerateCommittedAuthorSlots: async (author) => {
				this.enumerations.push(author);
				return structuredClone(this.enumeratedScopes);
			},
			handoffProof: async (proof) => {
				if (this.handoffFailure) throw new Error("INJECTED_HANDOFF_CRASH");
				this.handoffs.push(structuredClone(proof));
			},
			readCommittedSlotState: async (requestedScope) => {
				this.reads.push(structuredClone(requestedScope));
				return structuredClone(this.committed);
			},
			resolveAuthorPublicKey: resolver,
			transactAuthorProjection: this.authorStore.transactAuthorProjection,
		};
	}
}

async function requireFactory(): Promise<(options: ProjectionOptions) => Projection> {
	const loaded = await projectionLoad;
	if (typeof loaded.createDurableAuthorEquivocationProjection !== "function") {
		throw new Error("PHASE_0O_B1B_MISSING_DEEP_HELPER:createDurableAuthorEquivocationProjection");
	}
	return loaded.createDurableAuthorEquivocationProjection;
}

async function coordinator(harness: Harness): Promise<Projection> {
	return (await requireFactory())(harness.options());
}

function digestHexes(state: PersistedEquivocationState): string[] {
	return state.vertices.map((vertexWitness) => toHex(vertexWitness.digest)).sort();
}

function recursiveBytes(value: unknown, seen = new Set<unknown>()): number {
	if (value instanceof Uint8Array) return value.byteLength;
	if (value === null || typeof value !== "object" || seen.has(value)) return 0;
	seen.add(value);
	let total = 0;
	for (const key of Reflect.ownKeys(value)) {
		total += recursiveBytes(Reflect.get(value, key), seen);
	}
	return total;
}

function pairKeys(state: DurableAuthorProjectionState): string[] {
	return state.pending.map((row) => `${row.lesserDigestHex}:${row.greaterDigestHex}`).sort();
}

beforeAll(buildCorpus);

describe("Phase 0o-b1b durable author projection causal RED", () => {
	it("[governance] freezes an additive recovery-enumerated, zero-copy and at-least-once-handoff contract", () => {
		const supplement = resolve(CURRENT_DIRECTORY, contract.supplementDirectory);
		expect(existsSync(supplement)).toBe(true);
		expect(readdirSync(supplement).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(supplement, "profile.json"), "utf8")) as {
			readonly profileId: string;
			readonly baseProfileId: string;
			readonly durability: Record<string, unknown>;
			readonly pendingRow: Record<string, unknown>;
		};
		expect(profile).toMatchObject({
			baseProfileId: contract.baseProfileId,
			profileId: contract.profileId,
			durability: {
				authorScopedRecoveryEnumeration: true,
				externalHandoffExactlyOnceClaimed: false,
				projectionAndPendingCoCommit: true,
			},
			pendingRow: {
				payloadCopies: 0,
				proofBodyCopies: 0,
				uint8ArrayValues: 0,
			},
		});
		const specification = readFileSync(resolve(supplement, "spec.md"), "utf8");
		for (const phrase of [
			"newDigests × postUnionDigests",
			"readCommittedSlotState",
			"enumerateCommittedAuthorSlots",
			"at-least-once",
			"no acknowledgement API",
			"state.proofs",
			"current committed witnesses",
		]) {
			expect(specification).toContain(phrase);
		}
		const workflow = readFileSync(resolve(REPOSITORY_ROOT, contract.workflow), "utf8");
		for (const phrase of [
			"permissions:\n  contents: read",
			"timeout-minutes: 10",
			"PHASE_0O_B1B_IMPLEMENTATION_MODULE",
			"--no-coverage --maxWorkers=1 --minWorkers=1",
			"public-export-contract.mjs",
			"equivocation-digest-identity-v1/check-freeze.mjs",
			"equivocation-evidence-projection-v1/check-freeze.mjs",
		]) {
			expect(workflow).toContain(phrase);
		}
	});

	it("[authoritative-auth] validates every full-slot witness before any irreversible union", async () => {
		const harness = new Harness();
		const invalid = structuredClone(committedTwo) as {
			proofs: PersistedEquivocationState["proofs"];
			slotSignal: PersistedEquivocationState["slotSignal"];
			vertices: PersistedVertexWitness[];
		};
		invalid.vertices[0] = {
			...(invalid.vertices[0] as PersistedVertexWitness),
			witness: {
				...(invalid.vertices[0] as PersistedVertexWitness).witness,
				signature: new Uint8Array(64),
			},
		};
		harness.committed = invalid;
		const projection = await coordinator(harness);
		await expect(projection.reconcile(scope())).rejects.toThrow("authoritative committed slot is invalid");
		expect(harness.authorStore.state).toEqual({ pending: [], slots: [] });
		expect(harness.reads).toEqual([scope()]);
	});

	it("[monotone-union] never replaces prior registered digests with a later authoritative subset", async () => {
		const harness = new Harness();
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		const all = digestHexes(committedThree);
		harness.committed = {
			...structuredClone(committedThree),
			vertices: structuredClone(committedThree.vertices.slice(1)),
		};
		await projection.reconcile(scope());
		expect(harness.authorStore.state.slots[0]?.digestHexes).toEqual(all);
	});

	it("[cross-product] enqueues newDigests × postUnionDigests, including each new-to-prior pair", async () => {
		const harness = new Harness();
		harness.committed = structuredClone(committedOne);
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		harness.committed = structuredClone(committedThree);
		await projection.reconcile(scope());
		expect(harness.authorStore.state.pending).toHaveLength(3);
		const all = digestHexes(committedThree);
		expect(pairKeys(harness.authorStore.state)).toEqual([
			`${all[0]}:${all[1]}`,
			`${all[0]}:${all[2]}`,
			`${all[1]}:${all[2]}`,
		]);
	});

	it("[pair-identity] collapses order and same-digest encounters to one canonical unordered non-self row", async () => {
		const harness = new Harness();
		harness.committed = {
			...structuredClone(committedThree),
			vertices: [
				...structuredClone(committedThree.vertices).reverse(),
				structuredClone(committedThree.vertices[0] as PersistedVertexWitness),
			],
		};
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		expect(harness.authorStore.state.pending).toHaveLength(3);
		expect(new Set(harness.authorStore.state.pending.map((row) => row.pairId))).toHaveLength(3);
		for (const row of harness.authorStore.state.pending) {
			expect(row.lesserDigestHex < row.greaterDigestHex).toBe(true);
			expect(row.pairId).toMatch(/^[0-9a-f]{64}$/u);
		}
	});

	it("[lifetime-enqueue] is exact across permutations, retry, serialized concurrency, drain and redelivery", async () => {
		const harness = new Harness();
		const projection = await coordinator(harness);
		await Promise.all([
			projection.reconcile(scope()),
			projection.reconcile(scope()),
			projection.reconcile(scope()),
			projection.reconcile(scope()),
		]);
		expect(harness.authorStore.state.pending).toHaveLength(3);
		for (let drain = 0; drain < 3; drain++) {
			await projection.drainOne(contract.author);
		}
		expect(harness.authorStore.state.pending).toEqual([]);
		expect(harness.handoffs).toHaveLength(3);
		harness.committed = {
			...structuredClone(committedThree),
			vertices: [...structuredClone(committedThree.vertices)].reverse(),
		};
		await projection.reconcile(scope());
		expect(harness.authorStore.state.pending).toEqual([]);
		expect(harness.authorStore.state.slots[0]?.digestHexes).toEqual(digestHexes(committedThree));
	});

	it("[durability-recovery] atomically co-commits projection+rows and recovers a first lost author write by injected enumeration", async () => {
		const harness = new Harness();
		const projection = await coordinator(harness);
		harness.authorStore.failNextCommit = true;
		await expect(projection.reconcile(scope())).rejects.toThrow("INJECTED_AUTHOR_PROJECTION_COMMIT_LOSS");
		expect(harness.authorStore.state).toEqual({ pending: [], slots: [] });
		await expect(projection.recover(contract.author)).resolves.toEqual({ reconciledSlotCount: 1 });
		expect(harness.enumerations).toEqual([contract.author]);
		expect(harness.authorStore.state.slots).toHaveLength(1);
		expect(harness.authorStore.state.pending).toHaveLength(3);
	});

	it("[zero-durable-bytes] stores only scope, digest text and pair identity with a total recursive byte census", async () => {
		const harness = new Harness();
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		expect(recursiveBytes(harness.authorStore.state)).toBe(0);
		expect(Object.keys(harness.authorStore.state).sort()).toEqual(["pending", "slots"]);
		for (const row of harness.authorStore.state.pending) {
			expect(Object.keys(row).sort()).toEqual(["greaterDigestHex", "lesserDigestHex", "pairId", "scope"]);
		}
	});

	it("[read-independence] does not touch proof bodies or caller deltas and byte-preserves conforming state.proofs", async () => {
		const harness = new Harness();
		const committed = structuredClone(committedThree);
		const proofBytes = committed.proofs.map((proof) => new Uint8Array(proof.canonicalProofBytes));
		const hostile = Object.create(null) as PersistedEquivocationState;
		Object.defineProperties(hostile, {
			newlyPersistedProofIds: {
				get: () => {
					throw new Error("caller delta read");
				},
			},
			proofs: {
				get: () => {
					throw new Error("state.proofs read");
				},
			},
			slotSignal: { value: structuredClone(committed.slotSignal) },
			vertices: { value: structuredClone(committed.vertices) },
		});
		harness.options = () => ({
			...new Harness().options(),
			enumerateCommittedAuthorSlots: async () => [scope()],
			handoffProof: async (proof) => {
				harness.handoffs.push(structuredClone(proof));
			},
			readCommittedSlotState: async () => hostile,
			transactAuthorProjection: harness.authorStore.transactAuthorProjection,
		});
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		expect(committed.proofs.map((proof) => proof.canonicalProofBytes)).toEqual(proofBytes);
	});

	it("[current-carrier] re-materializes authenticated current witnesses and rejects stale-carrier caching", async () => {
		const harness = new Harness();
		harness.committed = structuredClone(staleCarrierState);
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		harness.authorStore.failNextPendingRemoval = true;
		await expect(projection.drainOne(contract.author)).rejects.toThrow("INJECTED_AUTHOR_PROJECTION_COMMIT_LOSS");
		expect(harness.authorStore.state.pending).toHaveLength(1);
		expect(harness.handoffs).toEqual([staleCarrierState.proofs[0]]);
		harness.committed = structuredClone(currentCarrierState);
		await projection.drainOne(contract.author);
		expect(harness.handoffs).toHaveLength(2);
		expect(harness.handoffs[1]).toEqual(currentCarrierState.proofs[0]);
		expect(harness.handoffs[1]).not.toEqual(staleCarrierState.proofs[0]);
	});

	it("[at-least-once-handoff] retains a row after successful handoff plus removal crash and retries delivery", async () => {
		const harness = new Harness();
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		harness.authorStore.failNextPendingRemoval = true;
		await expect(projection.drainOne(contract.author)).rejects.toThrow("INJECTED_AUTHOR_PROJECTION_COMMIT_LOSS");
		expect(harness.handoffs).toHaveLength(1);
		expect(harness.authorStore.state.pending).toHaveLength(3);
		await projection.drainOne(contract.author);
		expect(harness.handoffs).toHaveLength(2);
		expect(harness.handoffs[1]).toEqual(harness.handoffs[0]);
		expect(harness.authorStore.state.pending).toHaveLength(2);
	});

	it("[handoff-recompute] fails closed on a forged row identity and leaves it pending", async () => {
		const harness = new Harness();
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		const row = harness.authorStore.state.pending[0] as PendingEquivocationPair;
		harness.authorStore.state = {
			...harness.authorStore.state,
			pending: [{ ...row, pairId: "00".repeat(32) }],
		};
		await expect(projection.drainOne(contract.author)).resolves.toEqual({
			handedOff: false,
			remainingPending: 1,
		});
		expect(harness.handoffs).toEqual([]);
		expect(harness.authorStore.state.pending).toHaveLength(1);
	});

	it("[fail-closed-removal] retains an unmaterializable row and successful drain removes only that row", async () => {
		const harness = new Harness();
		harness.committed = structuredClone(committedTwo);
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		const digests = [...(harness.authorStore.state.slots[0]?.digestHexes ?? [])];
		const invalid = structuredClone(committedTwo) as {
			proofs: PersistedEquivocationState["proofs"];
			slotSignal: PersistedEquivocationState["slotSignal"];
			vertices: PersistedVertexWitness[];
		};
		invalid.vertices[0] = {
			...(invalid.vertices[0] as PersistedVertexWitness),
			witness: {
				...(invalid.vertices[0] as PersistedVertexWitness).witness,
				receivedCanonicalPreimageBytes: new Uint8Array([1, 2, 3]),
			},
		};
		harness.committed = invalid;
		await projection.drainOne(contract.author);
		expect(harness.authorStore.state.pending).toHaveLength(1);
		expect(harness.authorStore.state.slots[0]?.digestHexes).toEqual(digests);
		harness.committed = structuredClone(committedTwo);
		await projection.drainOne(contract.author);
		expect(harness.authorStore.state.pending).toEqual([]);
		expect(harness.authorStore.state.slots[0]?.digestHexes).toEqual(digests);
	});

	it("[invariance] leaves admission, resolution, slotSignal, proof bytes and standalone verification invariant", async () => {
		const beforeState = structuredClone(committedThree);
		const beforeResults = structuredClone(observationResults);
		const verifications = beforeState.proofs.map((proof) =>
			verifyEquivocationProof({
				canonicalProofBytes: proof.canonicalProofBytes,
				resolveAuthorPublicKey: resolver,
			})
		);
		const harness = new Harness();
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		for (let drain = 0; drain < 3; drain++) {
			await projection.drainOne(contract.author);
		}
		expect(harness.authorStore.state.pending).toEqual([]);
		await projection.recover(contract.author);
		expect(observationResults).toEqual(beforeResults);
		expect(committedThree).toEqual(beforeState);
		expect(
			beforeState.proofs.map((proof) =>
				verifyEquivocationProof({
					canonicalProofBytes: proof.canonicalProofBytes,
					resolveAuthorPublicKey: resolver,
				})
			)
		).toEqual(verifications);
		expect(verifications.every((verification) => verification.verified)).toBe(true);
	});

	it("[capture-detach] once-captures hostile authoritative fields/bytes without caller Array dispatch or TOCTOU", async () => {
		const harness = new Harness();
		const reads: Record<string, number> = {};
		const read = <Value>(key: string, value: Value): Value => {
			reads[key] = (reads[key] ?? 0) + 1;
			return value;
		};
		const original = committedTwo.vertices;
		const hostileVertices = [] as PersistedVertexWitness[];
		for (let index = 0; index < original.length; index++) {
			const vertexWitness = original[index] as PersistedVertexWitness;
			const digest = new Uint8Array(vertexWitness.digest);
			const preimageBytes = new Uint8Array(vertexWitness.witness.receivedCanonicalPreimageBytes);
			const witness = Object.defineProperties(Object.create(null), {
				domain: { get: () => read(`${index}.domain`, vertexWitness.witness.domain) },
				expectedAnchor: { get: () => read(`${index}.anchor`, vertexWitness.witness.expectedAnchor) },
				receivedCanonicalPreimageBytes: {
					get: () => read(`${index}.preimage`, preimageBytes),
				},
				signature: {
					get: () => {
						const result = read(`${index}.signature`, new Uint8Array(vertexWitness.witness.signature));
						preimageBytes.fill(0);
						return result;
					},
				},
				suiteId: { get: () => read(`${index}.suite`, vertexWitness.witness.suiteId) },
			}) as PersistedVertexWitness["witness"];
			Object.defineProperty(hostileVertices, index, {
				get: () => {
					const hostileVertex = Object.defineProperties(Object.create(null), {
						digest: { get: () => read(`${index}.digest`, digest) },
						witness: {
							get: () => {
								const result = read(`${index}.witness`, witness);
								digest.fill(255);
								return result;
							},
						},
					});
					return read(`${index}.vertex`, hostileVertex);
				},
			});
		}
		Object.defineProperties(hostileVertices, {
			[Symbol.iterator]: {
				value: () => {
					throw new Error("caller iterator dispatched");
				},
			},
			length: { value: original.length },
			map: {
				value: () => {
					throw new Error("caller map dispatched");
				},
			},
			slice: {
				value: () => {
					throw new Error("caller slice dispatched");
				},
			},
		});
		const hostileState = Object.defineProperties(Object.create(null), {
			vertices: { get: () => read("state.vertices", hostileVertices) },
		}) as PersistedEquivocationState;
		harness.options = () => ({
			enumerateCommittedAuthorSlots: async () => [scope()],
			handoffProof: async () => undefined,
			readCommittedSlotState: async () => hostileState,
			resolveAuthorPublicKey: resolver,
			transactAuthorProjection: harness.authorStore.transactAuthorProjection,
		});
		const projection = await coordinator(harness);
		await projection.reconcile(scope());
		expect(harness.authorStore.state.pending).toHaveLength(1);
		expect(Object.values(reads).every((count) => count === 1)).toBe(true);
	});

	it("[durable-capture] index-captures nested durable rows and digest sets without iterator dispatch", async () => {
		const harness = new Harness();
		let transactionCount = 0;
		const hostileArray = <Value>(values: readonly Value[]): Value[] => {
			const array = [] as Value[];
			for (let index = 0; index < values.length; index++) {
				Object.defineProperty(array, index, { value: values[index] });
			}
			Object.defineProperties(array, {
				[Symbol.iterator]: {
					value: () => {
						throw new Error("durable iterator dispatched");
					},
				},
				map: {
					value: () => {
						throw new Error("durable map dispatched");
					},
				},
				slice: {
					value: () => {
						throw new Error("durable slice dispatched");
					},
				},
			});
			return array;
		};
		const options = harness.options();
		options.transactAuthorProjection = async <Result>(
			_author: string,
			apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
		): Promise<Result> => {
			transactionCount++;
			const plain = structuredClone(harness.authorStore.state);
			const hostileSlots = hostileArray(
				plain.slots.map((slot) => ({
					scope: structuredClone(slot.scope),
					digestHexes: hostileArray(slot.digestHexes),
				}))
			);
			const hostilePending = hostileArray(
				plain.pending.map((row) =>
					Object.defineProperties(Object.create(null), {
						greaterDigestHex: { value: row.greaterDigestHex },
						lesserDigestHex: { value: row.lesserDigestHex },
						pairId: { value: row.pairId },
						scope: { value: structuredClone(row.scope) },
					})
				)
			);
			const decision = apply({ pending: hostilePending, slots: hostileSlots });
			harness.authorStore.state = structuredClone(decision.state);
			return structuredClone(decision.result);
		};
		const projection = (await requireFactory())(options);
		await projection.reconcile(scope());
		await projection.reconcile(scope());
		expect(transactionCount).toBe(2);
		expect(harness.authorStore.state.pending).toHaveLength(3);
	});

	it("[injected-only] has no default store or wall-clock dependency", async () => {
		const factory = await requireFactory();
		expect(() => factory(undefined as unknown as ProjectionOptions)).toThrow(TypeError);
		const harness = new Harness();
		const options = harness.options();
		for (const capability of [
			options.readCommittedSlotState,
			options.enumerateCommittedAuthorSlots,
			options.transactAuthorProjection,
			options.resolveAuthorPublicKey,
			options.handoffProof,
		]) {
			Object.defineProperties(capability, {
				bind: {
					get: () => {
						throw new Error("caller bind property dispatched");
					},
				},
				call: {
					get: () => {
						throw new Error("caller call property dispatched");
					},
				},
			});
		}
		const originalNow = Date.now;
		const originalRandom = Math.random;
		Date.now = () => {
			throw new Error("wall clock accessed");
		};
		Math.random = () => {
			throw new Error("randomness accessed");
		};
		try {
			const projection = factory(options);
			await projection.reconcile(scope());
			expect(harness.authorStore.state.pending).toHaveLength(3);
		} finally {
			Date.now = originalNow;
			Math.random = originalRandom;
		}
	});

	it("[public-boundary] pins the closed source/built/runtime root and all three deep helpers", async () => {
		const symbols = [
			"createDurableAuthorEquivocationProjection",
			"deriveEquivocationProofId",
			"materializeCurrentEquivocationProof",
		];
		const publicSource = readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts"), "utf8");
		const sourceAudit = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b1b-v3/public-entry-type-audit.ts"),
			"utf8"
		);
		const builtAudit = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b1b-v3/built-package-type-audit.ts"),
			"utf8"
		);
		const closedGuard = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b1b-v3/public-export-contract.mjs"),
			"utf8"
		);
		const sourceRuntime = await import(pathToFileURL(PUBLIC_ENTRY).href);
		const packageRuntime = await import("@ts-drp/protocol-v3");
		expect(Object.keys(sourceRuntime).sort()).toEqual([
			"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
			"admitReceivedVertex",
			"authenticateCurrentEpochAnchor",
			"createAdmissionBoundTransactionalVertexIssuer",
			"extractAdmittedReceivedVertex",
			"installCreatorAnchorTrustRoot",
			"isAnchorTrustStateRecordBytes",
			"openCurrentAnchorTrust",
			"prepareBlueprintAdmission",
			"prepareBlueprintRuntime",
		]);
		for (const symbol of symbols) {
			expect(publicSource).not.toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
			expect(sourceAudit).toContain(`import { ${symbol} }`);
			expect(builtAudit).toContain(`import { ${symbol} }`);
			expect(closedGuard).not.toContain(symbol);
			expect(packageRuntime).not.toHaveProperty(symbol);
		}
	});
});
