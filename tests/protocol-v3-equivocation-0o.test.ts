import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-v3/equivocation-contract.json" with { type: "json" };

interface RawEd25519PublicKey {
	readonly bytes: Uint8Array;
	readonly format: "raw";
}

interface VertexWitness {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

interface EquivocationScope {
	readonly author: string;
	readonly authorSequence: number;
	readonly objectId: string;
}

interface PersistedVertexWitness {
	readonly digest: Uint8Array;
	readonly witness: Omit<VertexWitness, "resolveAuthorPublicKey">;
}

interface PersistedEquivocationProof {
	readonly canonicalProofBytes: Uint8Array;
	readonly proofId: string;
}

interface SlotAdvisorySignal {
	readonly author: string;
	readonly observedForkCount: number;
	readonly advisoryLimitReached: boolean;
	readonly withinAdvisoryLimitProofCount: number;
	readonly overAdvisoryLimitProofCount: number;
}

interface EquivocationResolution {
	readonly orderedDigests: readonly string[];
	readonly preferredDigest: string;
}

interface PersistedEquivocationState {
	readonly proofs: readonly PersistedEquivocationProof[];
	readonly slotSignal: SlotAdvisorySignal;
	readonly vertices: readonly PersistedVertexWitness[];
}

interface RemoteObservationResult {
	readonly admitted: boolean;
	readonly disposition: "duplicate" | "equivocation" | "invalid" | "new";
	readonly digest?: Uint8Array;
	readonly newlyPersistedProofIds: readonly string[];
	readonly slotSignal?: SlotAdvisorySignal;
	readonly resolution?: EquivocationResolution;
}

interface EquivocationTransactionDecision {
	readonly result: RemoteObservationResult;
	readonly state: PersistedEquivocationState;
}

type ApplyEquivocationPolicy = (state: PersistedEquivocationState) => EquivocationTransactionDecision;

type TransactObservation = (
	scope: EquivocationScope,
	apply: ApplyEquivocationPolicy
) => Promise<RemoteObservationResult>;

interface RemoteEquivocationObserver {
	observe(input: VertexWitness): Promise<RemoteObservationResult>;
}

interface RemoteEquivocationObserverOptions {
	readonly perSlotAdvisoryProofLimit: number;
	readonly transactObservation: TransactObservation;
}

interface EquivocationProofVerification {
	readonly digests?: readonly [string, string];
	readonly proofId?: string;
	readonly scope?: EquivocationScope;
	readonly verified: boolean;
}

interface VerifyEquivocationProofInput {
	readonly canonicalProofBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

interface RegisteredVertexVerification {
	readonly accepted: boolean;
	readonly digest?: Uint8Array;
}

interface ProtocolV3EquivocationSurface {
	createRemoteEquivocationObserver?(options: RemoteEquivocationObserverOptions): RemoteEquivocationObserver;
	verifyEquivocationProof?(input: VerifyEquivocationProofInput): EquivocationProofVerification;
	verifyReceivedVertex?(input: VertexWitness): RegisteredVertexVerification;
}

interface MaterializedVertex {
	readonly digest: Uint8Array;
	readonly digestHex: string;
	readonly preimage: Readonly<Record<string, unknown>>;
	readonly witness: VertexWitness;
}

interface ProofEnvelope {
	readonly kind: string;
	readonly profile: string;
	readonly protocolMajor: number;
	readonly slot: EquivocationScope;
	readonly vertices: readonly {
		readonly digest: Uint8Array;
		readonly domain: string;
		readonly expectedAnchor: string;
		readonly preimage: Uint8Array;
		readonly signature: Uint8Array;
		readonly suiteId: string;
	}[];
}

type FailureMode = "async-reject" | "sync-throw";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATION_PATH =
	process.env.PHASE_0O_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(CURRENT_DIRECTORY, "..", process.env.PHASE_0O_IMPLEMENTATION_MODULE);
const SUPPLEMENT_DIRECTORY =
	process.env.PHASE_0O_SUPPLEMENT_DIRECTORY === undefined
		? resolve(CURRENT_DIRECTORY, contract.supplementDirectory)
		: resolve(CURRENT_DIRECTORY, "..", process.env.PHASE_0O_SUPPLEMENT_DIRECTORY);
const SUPPLEMENT_WORKFLOW =
	process.env.PHASE_0O_SUPPLEMENT_WORKFLOW === undefined
		? resolve(CURRENT_DIRECTORY, contract.supplementWorkflow)
		: resolve(CURRENT_DIRECTORY, "..", process.env.PHASE_0O_SUPPLEMENT_WORKFLOW);
const IMPLEMENTATION_URL = pathToFileURL(IMPLEMENTATION_PATH).href;
const implementationLoad = import(IMPLEMENTATION_URL)
	.then((loaded: unknown) => ({ loaded: loaded as ProtocolV3EquivocationSurface }))
	.catch((error: unknown) => ({ error }));
const ED25519_ORDER = BigInt(2) ** BigInt(252) + BigInt("27742317777372353535851937790883648493");

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function clone<Value>(value: Value): Value {
	return structuredClone(value);
}

function emptyState(author: string): PersistedEquivocationState {
	return {
		proofs: [],
		slotSignal: {
			author,
			observedForkCount: 0,
			advisoryLimitReached: false,
			withinAdvisoryLimitProofCount: 0,
			overAdvisoryLimitProofCount: 0,
		},
		vertices: [],
	};
}

function scopeKey(scope: EquivocationScope): string {
	return `${scope.objectId.length}:${scope.objectId}:${scope.author.length}:${scope.author}:${scope.authorSequence}`;
}

class AtomicObservationStore {
	readonly attempts: EquivocationScope[] = [];
	readonly states = new Map<string, PersistedEquivocationState>();
	private failureMode: FailureMode | undefined;

	failNext(mode: FailureMode): void {
		this.failureMode = mode;
	}

	readonly transactObservation: TransactObservation = (scope, apply) => {
		this.attempts.push(clone(scope));
		const failureMode = this.failureMode;
		this.failureMode = undefined;
		if (failureMode === "sync-throw") throw new Error("injected synchronous transaction failure");
		if (failureMode === "async-reject") {
			return Promise.reject(new Error("injected asynchronous transaction rejection"));
		}

		const key = scopeKey(scope);
		const before = clone(this.states.get(key) ?? emptyState(scope.author));
		const decision = apply(before);
		this.states.set(key, clone(decision.state));
		return Promise.resolve(clone(decision.result));
	};

	snapshot(scope: EquivocationScope): PersistedEquivocationState {
		return clone(this.states.get(scopeKey(scope)) ?? emptyState(scope.author));
	}
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

// Test-only RFC 8032 equation for a distinct strict-valid signature carrier.
function signWithNonce(message: Uint8Array, privateKeySeed: Uint8Array, nonce: bigint): Uint8Array {
	const expanded = new Uint8Array(createHash("sha512").update(privateKeySeed).digest());
	const scalarBytes = expanded.slice(0, 32);
	scalarBytes[0] = (scalarBytes[0] as number) & 248;
	scalarBytes[31] = ((scalarBytes[31] as number) & 63) | 64;
	const secretScalar = littleEndianInteger(scalarBytes);
	const publicKey = ed25519.getPublicKey(privateKeySeed);
	const encodedR = ed25519.ExtendedPoint.BASE.multiply(nonce).toRawBytes();
	const challenge =
		littleEndianInteger(createHash("sha512").update(encodedR).update(publicKey).update(message).digest()) %
		ED25519_ORDER;
	const encodedS = littleEndianBytes((nonce + challenge * secretScalar) % ED25519_ORDER, 32);
	const signature = new Uint8Array(64);
	signature.set(encodedR, 0);
	signature.set(encodedS, 32);
	return signature;
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
	options: {
		readonly privateKeySeed?: Uint8Array;
		readonly signatureNonce?: bigint;
	} = {}
): MaterializedVertex {
	const privateKeySeed = options.privateKeySeed ?? fromHex(contract.privateKeySeedHex);
	const publicKey = ed25519.getPublicKey(privateKeySeed);
	const receivedCanonicalPreimageBytes = encodeCanonical(preimage);
	const digest = hashDomain(contract.domain, receivedCanonicalPreimageBytes);
	const signature =
		options.signatureNonce === undefined
			? ed25519.sign(digest, privateKeySeed)
			: signWithNonce(digest, privateKeySeed, options.signatureNonce);
	return {
		digest,
		digestHex: toHex(digest),
		preimage,
		witness: {
			domain: contract.domain,
			expectedAnchor: contract.anchor,
			receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey(author): RawEd25519PublicKey | undefined {
				return author === contract.author ? { bytes: publicKey, format: "raw" } : undefined;
			},
			signature,
			suiteId: contract.suiteId,
		},
	};
}

function decodeProof(bytes: Uint8Array): ProofEnvelope {
	return decodeCanonical(bytes) as ProofEnvelope;
}

function proofStateSnapshot(state: PersistedEquivocationState): {
	readonly proofs: readonly { readonly bytesHex: string; readonly proofId: string }[];
	readonly slotSignal: SlotAdvisorySignal;
	readonly resolutionDigests: readonly string[];
} {
	return {
		proofs: state.proofs
			.map(({ canonicalProofBytes, proofId }) => ({ bytesHex: toHex(canonicalProofBytes), proofId }))
			.sort((left, right) => left.proofId.localeCompare(right.proofId)),
		slotSignal: state.slotSignal,
		resolutionDigests: state.vertices.map(({ digest }) => toHex(digest)).sort(),
	};
}

function expectedProofId(leftDigestHex: string, rightDigestHex: string): string {
	const [left, right] = [leftDigestHex, rightDigestHex].sort();
	return toHex(hashDomain(contract.proofDomain, fromHex(left as string), fromHex(right as string)));
}

function allPermutations<Value>(values: readonly Value[]): Value[][] {
	if (values.length <= 1) return [[...values]];
	const output: Value[][] = [];
	for (let index = 0; index < values.length; index++) {
		const selected = values[index] as Value;
		const remaining = values.filter((_value, candidateIndex) => candidateIndex !== index);
		for (const suffix of allPermutations(remaining)) output.push([selected, ...suffix]);
	}
	return output;
}

function seededDuplicateSchedule<Value>(values: readonly Value[], seed: number): Value[] {
	let state = seed >>> 0;
	const scheduled: Value[] = [];
	for (const value of values) {
		scheduled.push(value);
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		if ((state & 1) === 0) scheduled.push(value);
	}
	return scheduled;
}

async function requireSurfaceFunction<Key extends keyof ProtocolV3EquivocationSurface>(
	name: Key
): Promise<NonNullable<ProtocolV3EquivocationSurface[Key]>> {
	const result = await implementationLoad;
	if ("error" in result) {
		throw new Error(`PHASE_0O_IMPLEMENTATION_MODULE_UNAVAILABLE:${String(name)}`, { cause: result.error });
	}
	const candidate = result.loaded[name];
	if (typeof candidate !== "function") throw new Error(`PHASE_0O_MISSING_EXPORT:${String(name)}`);
	return candidate as NonNullable<ProtocolV3EquivocationSurface[Key]>;
}

async function createObserver(
	store: AtomicObservationStore,
	overrides: Partial<RemoteEquivocationObserverOptions> = {}
): Promise<RemoteEquivocationObserver> {
	const factory = await requireSurfaceFunction("createRemoteEquivocationObserver");
	return factory({
		perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
		transactObservation: store.transactObservation,
		...overrides,
	});
}

async function assertStrictlyAccepted(vertices: readonly MaterializedVertex[]): Promise<void> {
	const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
	for (const vertex of vertices) {
		const verification = verifyReceivedVertex(vertex.witness);
		expect(verification.accepted, `${vertex.digestHex}:${JSON.stringify(vertex.preimage)}`).toBe(true);
		expect(verification.digest).toEqual(vertex.digest);
	}
}

function primaryScope(): EquivocationScope {
	return {
		author: contract.author,
		authorSequence: contract.baseSequence,
		objectId: contract.objectId,
	};
}

describe("Phase 0o remote same-author equivocation RED", () => {
	it("keeps the fixture input-only, preserves frozen D.37, and requires the additive governed supplement", () => {
		expect(Object.keys(contract)).toEqual([
			"implementationModule",
			"supplementDirectory",
			"supplementWorkflow",
			"requiredSupplementFiles",
			"profileId",
			"proofKind",
			"proofDomain",
			"domain",
			"suiteId",
			"privateKeySeedHex",
			"wrongPrivateKeySeedHex",
			"author",
			"objectId",
			"anchor",
			"baseSequence",
			"gapSequence",
			"epoch",
			"logicalTime",
			"dependencies",
			"alternateDependencies",
			"operation",
			"perSlotAdvisoryProofLimit",
			"permutationSeed",
			"frozenD37",
		]);
		expect(contract).not.toHaveProperty("expected");
		expect(contract).not.toHaveProperty("digest");
		expect(contract).not.toHaveProperty("signature");
		expect(contract).not.toHaveProperty("proof");

		const frozenPaths = {
			derivation: resolve(CURRENT_DIRECTORY, "../packages/protocol-v3/formal/signed-field-derivation.json"),
			fixture: resolve(CURRENT_DIRECTORY, "fixtures/phase-n1prime-a/formal-action-contract.json"),
			model: resolve(CURRENT_DIRECTORY, "../packages/protocol-v3/formal/author-lineage-actions.qnt"),
			test: resolve(CURRENT_DIRECTORY, "protocol-v3-formal-action-model-n1prime-a.test.ts"),
		};
		expect(sha256File(frozenPaths.model)).toBe(contract.frozenD37.modelSha256);
		expect(sha256File(frozenPaths.test)).toBe(contract.frozenD37.testSha256);
		expect(sha256File(frozenPaths.fixture)).toBe(contract.frozenD37.fixtureSha256);
		expect(sha256File(frozenPaths.derivation)).toBe(contract.frozenD37.derivationSha256);

		expect(existsSync(SUPPLEMENT_DIRECTORY)).toBe(true);
		expect(readdirSync(SUPPLEMENT_DIRECTORY).sort()).toEqual([...contract.requiredSupplementFiles].sort());
		const profile = JSON.parse(readFileSync(resolve(SUPPLEMENT_DIRECTORY, "profile.json"), "utf8")) as {
			readonly frozenD37: typeof contract.frozenD37;
			readonly profileId: string;
			readonly proofDomain: string;
			readonly slotAdvisory: {
				readonly crossSlotAndRetentionOwner: string;
				readonly scope: string;
				readonly slotDurabilityOwner: string;
			};
			readonly vertexIdentity: string;
		};
		expect(profile).toEqual({
			frozenD37: contract.frozenD37,
			profileId: contract.profileId,
			proofDomain: contract.proofDomain,
			slotAdvisory: {
				crossSlotAndRetentionOwner: "phase-0o-b",
				scope: "per-slot-advisory-signal-only",
				slotDurabilityOwner: "injected-transaction-store",
			},
			vertexIdentity: "exact-authenticated-canonical-preimage-digest",
		});
		const specification = readFileSync(resolve(SUPPLEMENT_DIRECTORY, "spec.md"), "utf8");
		expect(specification).toContain("same digest");
		expect(specification).toContain("signature carrier");
		expect(specification).toContain("unordered digest pair");
		expect(specification).toContain("O(forks²)");
		expect(specification).toContain("Phase 0o-b");
		const model = readFileSync(resolve(SUPPLEMENT_DIRECTORY, "equivocation-digest-identity.qnt"), "utf8");
		expect(model).toContain("sameOperationDifferentDependencies");
		expect(model).toContain("sameOperationDifferentLogicalTime");
		expect(model).toContain("sameDigestDifferentSignatureCarrier");
		expect(model).not.toContain("module authorLineageActions");
		const freezePolicy = JSON.parse(readFileSync(resolve(SUPPLEMENT_DIRECTORY, "freeze-policy.json"), "utf8")) as {
			readonly checker: string;
			readonly profile: string;
			readonly workflow: string;
		};
		expect(freezePolicy).toMatchObject({
			checker: "check-freeze.mjs",
			profile: contract.profileId,
			workflow: ".github/workflows/protocol-v3-equivocation-digest-identity.yml",
		});
		expect(readFileSync(SUPPLEMENT_WORKFLOW, "utf8")).toContain("check-freeze.mjs");
	});

	it("requires an injected transaction boundary and exposes no default in-memory production store", async () => {
		const factory = await requireSurfaceFunction("createRemoteEquivocationObserver");
		expect(() =>
			factory({
				perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
				transactObservation: undefined as unknown as TransactObservation,
			})
		).toThrow(/transactObservation/iu);
		expect(() =>
			factory({
				perSlotAdvisoryProofLimit: 0,
				transactObservation: new AtomicObservationStore().transactObservation,
			})
		).toThrow(/perSlotAdvisoryProofLimit/iu);
	});

	it("admits same-operation dependency/logical-time forks in either order and keeps gaps and descendants valid", async () => {
		const forkA = materializeVertex(basePreimage());
		const forkDependencies = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const forkLogicalTime = materializeVertex(basePreimage({ logicalTime: contract.logicalTime + 1 }));
		expect(forkA.preimage.operation).toEqual(forkDependencies.preimage.operation);
		expect(forkA.preimage.operation).toEqual(forkLogicalTime.preimage.operation);
		expect(new Set([forkA.digestHex, forkDependencies.digestHex, forkLogicalTime.digestHex])).toHaveLength(3);
		await assertStrictlyAccepted([forkA, forkDependencies, forkLogicalTime]);

		const finalStates: ReturnType<typeof proofStateSnapshot>[] = [];
		for (const order of [
			[forkA, forkDependencies],
			[forkDependencies, forkA],
			[forkA, forkLogicalTime],
			[forkLogicalTime, forkA],
		]) {
			const store = new AtomicObservationStore();
			const observer = await createObserver(store);
			const results = [];
			for (const vertex of order) results.push(await observer.observe(vertex.witness));
			expect(results.every(({ admitted }) => admitted)).toBe(true);
			expect(results.map(({ disposition }) => disposition)).toEqual(["new", "equivocation"]);
			const state = store.snapshot(primaryScope());
			expect(state.proofs).toHaveLength(1);
			expect(state.vertices).toHaveLength(2);
			finalStates.push(proofStateSnapshot(state));
		}
		expect(finalStates[0]).toEqual(finalStates[1]);
		expect(finalStates[2]).toEqual(finalStates[3]);

		const gap = materializeVertex(
			basePreimage({
				authorSequence: contract.gapSequence,
				logicalTime: contract.logicalTime + 20,
			})
		);
		const childA = materializeVertex(
			basePreimage({
				authorSequence: contract.gapSequence + 1,
				dependencies: [forkA.digestHex],
				logicalTime: contract.logicalTime + 21,
			})
		);
		const childB = materializeVertex(
			basePreimage({
				authorSequence: contract.gapSequence + 2,
				dependencies: [forkDependencies.digestHex],
				logicalTime: contract.logicalTime + 22,
			})
		);
		await assertStrictlyAccepted([gap, childA, childB]);
		const gapStore = new AtomicObservationStore();
		const gapObserver = await createObserver(gapStore);
		for (const vertex of [gap, childA, childB]) {
			const result = await gapObserver.observe(vertex.witness);
			expect(result.admitted).toBe(true);
			expect(result.disposition).toBe("new");
		}
	});

	it("treats exact redelivery and a distinct accepted signature carrier as one digest with no evidence", async () => {
		const original = materializeVertex(basePreimage());
		const recarrier = materializeVertex(basePreimage(), { signatureNonce: BigInt(17) });
		expect(recarrier.digest).toEqual(original.digest);
		expect(recarrier.witness.receivedCanonicalPreimageBytes).toEqual(original.witness.receivedCanonicalPreimageBytes);
		expect(recarrier.witness.signature).not.toEqual(original.witness.signature);
		await assertStrictlyAccepted([original, recarrier]);

		const store = new AtomicObservationStore();
		const observer = await createObserver(store);
		const results = [
			await observer.observe(original.witness),
			await observer.observe(original.witness),
			await observer.observe(recarrier.witness),
			await observer.observe(recarrier.witness),
		];
		expect(results.map(({ disposition }) => disposition)).toEqual(["new", "duplicate", "duplicate", "duplicate"]);
		expect(results.every(({ admitted }) => admitted)).toBe(true);
		expect(results.every(({ newlyPersistedProofIds }) => newlyPersistedProofIds.length === 0)).toBe(true);
		const state = store.snapshot(primaryScope());
		expect(state.vertices).toHaveLength(1);
		expect(state.proofs).toHaveLength(0);
		expect(state.slotSignal).toEqual({
			author: contract.author,
			observedForkCount: 0,
			advisoryLimitReached: false,
			withinAdvisoryLimitProofCount: 0,
			overAdvisoryLimitProofCount: 0,
		});
	});

	it("canonicalizes proof carriers and verifies each proof standalone through the authoritative resolver", async () => {
		const original = materializeVertex(basePreimage());
		const recarrier = materializeVertex(basePreimage(), { signatureNonce: BigInt(23) });
		const fork = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
		const verifier = await requireSurfaceFunction("verifyEquivocationProof");
		const strictVerifier = await requireSurfaceFunction("verifyReceivedVertex");
		const publicKey = ed25519.getPublicKey(fromHex(contract.privateKeySeedHex));

		const proofStates = [];
		for (const order of [
			[original, recarrier, fork],
			[recarrier, original, fork],
			[fork, original, recarrier],
			[fork, recarrier, original],
		]) {
			const store = new AtomicObservationStore();
			const observer = await createObserver(store);
			for (const vertex of order) await observer.observe(vertex.witness);
			const state = store.snapshot(primaryScope());
			expect(state.proofs).toHaveLength(1);
			proofStates.push(proofStateSnapshot(state));
		}
		expect(proofStates.every((state) => JSON.stringify(state) === JSON.stringify(proofStates[0]))).toBe(true);

		const proof = proofStates[0]?.proofs[0];
		expect(proof).toBeDefined();
		const canonicalProofBytes = fromHex(proof?.bytesHex ?? "");
		const resolvedAuthors: string[] = [];
		const verification = verifier({
			canonicalProofBytes,
			resolveAuthorPublicKey(author): RawEd25519PublicKey | undefined {
				resolvedAuthors.push(author);
				return author === contract.author ? { bytes: publicKey, format: "raw" } : undefined;
			},
		});
		expect(verification).toEqual({
			digests: [original.digestHex, fork.digestHex].sort(),
			proofId: expectedProofId(original.digestHex, fork.digestHex),
			scope: primaryScope(),
			verified: true,
		});
		expect(resolvedAuthors.length).toBeGreaterThan(0);
		expect(new Set(resolvedAuthors)).toEqual(new Set([contract.author]));

		const decoded = decodeProof(canonicalProofBytes);
		expect(decoded.kind).toBe(contract.proofKind);
		expect(decoded.profile).toBe(contract.profileId);
		expect(decoded.protocolMajor).toBe(3);
		expect(decoded.slot).toEqual(primaryScope());
		expect(decoded.vertices).toHaveLength(2);
		expect(decoded.vertices.map(({ digest }) => toHex(digest))).toEqual([original.digestHex, fork.digestHex].sort());
		for (const vertex of decoded.vertices) {
			expect(vertex.domain).toBe(contract.domain);
			expect(vertex.expectedAnchor).toBe(contract.anchor);
			expect(vertex.suiteId).toBe(contract.suiteId);
			expect(
				strictVerifier({
					domain: vertex.domain,
					expectedAnchor: vertex.expectedAnchor,
					receivedCanonicalPreimageBytes: vertex.preimage,
					resolveAuthorPublicKey: () => ({ bytes: publicKey, format: "raw" }),
					signature: vertex.signature,
					suiteId: vertex.suiteId,
				}).accepted
			).toBe(true);
		}
	});

	it("rejects tampered, mismatched-slot, invalid-signature and wrong-resolver proofs and unauthenticated inputs", async () => {
		const left = materializeVertex(basePreimage());
		const right = materializeVertex(basePreimage({ logicalTime: contract.logicalTime + 1 }));
		const store = new AtomicObservationStore();
		const observer = await createObserver(store);
		await observer.observe(left.witness);
		await observer.observe(right.witness);
		const proof = store.snapshot(primaryScope()).proofs[0];
		expect(proof).toBeDefined();
		const verifier = await requireSurfaceFunction("verifyEquivocationProof");
		const publicKey = ed25519.getPublicKey(fromHex(contract.privateKeySeedHex));
		const wrongPublicKey = ed25519.getPublicKey(fromHex(contract.wrongPrivateKeySeedHex));
		const resolver = (): RawEd25519PublicKey => ({ bytes: publicKey, format: "raw" });

		const bitFlipped = new Uint8Array(proof?.canonicalProofBytes ?? []);
		bitFlipped[Math.floor(bitFlipped.byteLength / 2)] ^= 1;
		expect(verifier({ canonicalProofBytes: bitFlipped, resolveAuthorPublicKey: resolver }).verified).toBe(false);

		const mismatchedSlot = clone(decodeProof(proof?.canonicalProofBytes ?? new Uint8Array()));
		(mismatchedSlot.slot as { authorSequence: number }).authorSequence++;
		expect(
			verifier({
				canonicalProofBytes: encodeCanonical(mismatchedSlot),
				resolveAuthorPublicKey: resolver,
			}).verified
		).toBe(false);

		const invalidSignature = clone(decodeProof(proof?.canonicalProofBytes ?? new Uint8Array()));
		(invalidSignature.vertices[0]?.signature as Uint8Array)[0] ^= 1;
		expect(
			verifier({
				canonicalProofBytes: encodeCanonical(invalidSignature),
				resolveAuthorPublicKey: resolver,
			}).verified
		).toBe(false);
		expect(
			verifier({
				canonicalProofBytes: proof?.canonicalProofBytes ?? new Uint8Array(),
				resolveAuthorPublicKey: () => ({ bytes: wrongPublicKey, format: "raw" }),
			}).verified
		).toBe(false);

		const badInput = {
			...left.witness,
			signature: new Uint8Array(left.witness.signature),
		};
		badInput.signature[0] ^= 1;
		const attemptsBefore = store.attempts.length;
		const result = await observer.observe(badInput);
		expect(result).toEqual({
			admitted: false,
			disposition: "invalid",
			newlyPersistedProofIds: [],
		});
		expect(store.attempts).toHaveLength(attemptsBefore);
		expect(store.snapshot(primaryScope()).proofs).toHaveLength(1);
	});

	it("converges over every three-fork permutation without pair hardcoding, proof spam or first-arrival advisory state", async () => {
		const forks = [
			materializeVertex(basePreimage()),
			materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] })),
			materializeVertex(basePreimage({ logicalTime: contract.logicalTime + 1 })),
		];
		await assertStrictlyAccepted(forks);
		const expectedDigests = forks.map(({ digestHex }) => digestHex).sort();
		const snapshots = [];
		const finalSignals = [];
		const permutations = allPermutations(forks);
		expect(permutations).toHaveLength(6);
		for (let index = 0; index < permutations.length; index++) {
			const schedule = seededDuplicateSchedule(
				permutations[index] as readonly MaterializedVertex[],
				contract.permutationSeed + index
			);
			const store = new AtomicObservationStore();
			const observer = await createObserver(store);
			let persistedProofIdCount = 0;
			let finalResult: RemoteObservationResult | undefined;
			for (const vertex of schedule) {
				finalResult = await observer.observe(vertex.witness);
				persistedProofIdCount += finalResult.newlyPersistedProofIds.length;
				expect(finalResult.admitted).toBe(true);
			}
			const state = store.snapshot(primaryScope());
			expect(state.vertices).toHaveLength(3);
			expect(state.proofs).toHaveLength(3);
			expect(new Set(state.proofs.map(({ proofId }) => proofId)).size).toBe(3);
			expect(state.proofs.map(({ proofId }) => proofId).sort()).toEqual(
				[
					expectedProofId(forks[0]?.digestHex ?? "", forks[1]?.digestHex ?? ""),
					expectedProofId(forks[0]?.digestHex ?? "", forks[2]?.digestHex ?? ""),
					expectedProofId(forks[1]?.digestHex ?? "", forks[2]?.digestHex ?? ""),
				].sort()
			);
			expect(persistedProofIdCount).toBe(3);
			expect(finalResult?.resolution).toEqual({
				orderedDigests: expectedDigests,
				preferredDigest: expectedDigests[0],
			});
			expect(state.slotSignal).toEqual({
				author: contract.author,
				observedForkCount: 2,
				advisoryLimitReached: true,
				withinAdvisoryLimitProofCount: contract.perSlotAdvisoryProofLimit,
				overAdvisoryLimitProofCount: 3 - contract.perSlotAdvisoryProofLimit,
			});
			snapshots.push(proofStateSnapshot(state));
			finalSignals.push(state.slotSignal);
		}
		expect(snapshots.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(snapshots[0]))).toBe(true);
		expect(finalSignals.every((signal) => JSON.stringify(signal) === JSON.stringify(finalSignals[0]))).toBe(true);
	});

	it.each(["sync-throw", "async-reject"] as const)(
		"keeps proof, slot advisory signal and observable output opaque when the injected transaction %s",
		async (failureMode) => {
			const left = materializeVertex(basePreimage());
			const right = materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] }));
			const store = new AtomicObservationStore();
			const observer = await createObserver(store);
			await observer.observe(left.witness);
			const before = store.snapshot(primaryScope());
			store.failNext(failureMode);
			let settledOutput: RemoteObservationResult | undefined;
			const failed = observer.observe(right.witness).then((result) => {
				settledOutput = result;
				return result;
			});
			await expect(failed).rejects.toThrow(/transaction/iu);
			expect(settledOutput).toBeUndefined();
			expect(store.snapshot(primaryScope())).toEqual(before);

			const retried = await observer.observe(right.witness);
			expect(retried.admitted).toBe(true);
			expect(retried.disposition).toBe("equivocation");
			expect(retried.newlyPersistedProofIds).toHaveLength(1);
			const after = store.snapshot(primaryScope());
			expect(after.proofs).toHaveLength(1);
			expect(after.vertices).toHaveLength(2);
			expect(after.slotSignal.withinAdvisoryLimitProofCount).toBe(1);
		}
	);
});
