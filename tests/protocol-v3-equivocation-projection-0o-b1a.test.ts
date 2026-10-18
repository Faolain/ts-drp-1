import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-b1a-v3/projection-contract.json" with { type: "json" };
import {
	createRemoteEquivocationObserver,
	type EquivocationProofVerification,
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

interface MaterializeCurrentEquivocationProofInput {
	readonly scope: EquivocationScope;
	readonly vertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

interface ProjectionSurface {
	deriveEquivocationProofId?(leftDigest: Uint8Array, rightDigest: Uint8Array): string;
	materializeCurrentEquivocationProof?(
		input: MaterializeCurrentEquivocationProofInput
	): PersistedEquivocationProof | undefined;
}

interface Vertex {
	readonly digest: Uint8Array;
	readonly witness: VerifyReceivedVertexInput;
}

interface RecarrierCorpus {
	readonly currentProof: PersistedEquivocationProof;
	readonly currentVertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
	readonly firstProofIdDelta: readonly string[];
	readonly recarrierProofIdDelta: readonly string[];
	readonly staleProof: PersistedEquivocationProof;
	readonly staleVertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const PROJECTION_IMPLEMENTATION =
	process.env.PHASE_0O_B1A_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(REPOSITORY_ROOT, process.env.PHASE_0O_B1A_IMPLEMENTATION_MODULE);
const PUBLIC_ENTRY =
	process.env.PHASE_0O_B1A_MUTANT === "public-reexport"
		? resolve(CURRENT_DIRECTORY, contract.publicReexportMutantModule)
		: resolve(CURRENT_DIRECTORY, contract.publicEntryModule);
const projectionLoad = import(pathToFileURL(PROJECTION_IMPLEMENTATION).href) as Promise<ProjectionSurface>;
const privateKeySeed = fromHex(contract.privateKeySeedHex);
const publicKey = ed25519.getPublicKey(privateKeySeed);
const ED25519_ORDER = BigInt(2) ** BigInt(252) + BigInt("27742317777372353535851937790883648493");

let baseVertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
let baseProof: PersistedEquivocationProof;
let recarrierCorpus: RecarrierCorpus;

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function preimage(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: contract.objectId,
		epoch: contract.epoch,
		anchor: contract.anchor,
		author: contract.author,
		authorSequence: contract.authorSequence,
		logicalTime: contract.logicalTime,
		dependencies: [...contract.dependencies],
		operation: { ...contract.operation },
		...overrides,
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

function carrierBytes(value: Vertex): Uint8Array {
	return encodeCanonical({
		domain: value.witness.domain,
		expectedAnchor: value.witness.expectedAnchor,
		preimage: value.witness.receivedCanonicalPreimageBytes,
		signature: value.witness.signature,
		suiteId: value.witness.suiteId,
	});
}

function emptyState(): PersistedEquivocationState {
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

class Store {
	state = emptyState();

	readonly transactObservation: TransactObservation = (_scope, apply): Promise<RemoteObservationResult> => {
		const decision = apply(structuredClone(this.state));
		this.state = structuredClone(decision.state);
		return Promise.resolve(structuredClone(decision.result));
	};
}

function orderedPair(vertices: readonly PersistedVertexWitness[]): [PersistedVertexWitness, PersistedVertexWitness] {
	expect(vertices).toHaveLength(2);
	return [
		structuredClone(vertices[0] as PersistedVertexWitness),
		structuredClone(vertices[1] as PersistedVertexWitness),
	];
}

async function genuinePair(
	left: Vertex,
	right: Vertex
): Promise<{
	readonly proof: PersistedEquivocationProof;
	readonly vertices: [PersistedVertexWitness, PersistedVertexWitness];
}> {
	const store = new Store();
	const observer = createRemoteEquivocationObserver({
		perSlotAdvisoryProofLimit: 2,
		transactObservation: store.transactObservation,
	});
	const firstResult = await observer.observe(left.witness);
	const result = await observer.observe(right.witness);
	expect(firstResult).toMatchObject({ admitted: true, disposition: "new" });
	expect(result).toMatchObject({ admitted: true, disposition: "equivocation" });
	expect(result.newlyPersistedProofIds).toHaveLength(1);
	expect(store.state.proofs).toHaveLength(1);
	return {
		proof: structuredClone(store.state.proofs[0] as PersistedEquivocationProof),
		vertices: orderedPair(store.state.vertices),
	};
}

async function genuineRecarrierCorpus(): Promise<RecARRIERCorpus> {
	const common = preimage({ logicalTime: contract.logicalTime + 9 });
	const deterministic = vertex(common);
	const alternate = vertex(common, (digest) => signWithNonce(digest, BigInt(7)));
	expect(alternate.digest).toEqual(deterministic.digest);
	expect(alternate.witness.signature).not.toEqual(deterministic.witness.signature);
	const [lesser, greater] =
		compareBytes(carrierBytes(deterministic), carrierBytes(alternate)) < 0
			? [deterministic, alternate]
			: [alternate, deterministic];
	const fork = vertex(
		preimage({
			logicalTime: contract.logicalTime + 9,
			dependencies: [...contract.alternateDependencies],
		})
	);
	const store = new Store();
	const observer = createRemoteEquivocationObserver({
		perSlotAdvisoryProofLimit: 2,
		transactObservation: store.transactObservation,
	});
	await observer.observe(greater.witness);
	const forkResult = await observer.observe(fork.witness);
	const staleProof = structuredClone(store.state.proofs[0] as PersistedEquivocationProof);
	const staleVertices = orderedPair(store.state.vertices);
	const recarrierResult = await observer.observe(lesser.witness);
	return {
		currentProof: structuredClone(store.state.proofs[0] as PersistedEquivocationProof),
		currentVertices: orderedPair(store.state.vertices),
		firstProofIdDelta: [...forkResult.newlyPersistedProofIds],
		recarrierProofIdDelta: [...recarrierResult.newlyPersistedProofIds],
		staleProof,
		staleVertices,
	};
}

type RecARRIERCorpus = RecarrierCorpus;

async function requireHelper<Name extends keyof ProjectionSurface>(
	name: Name
): Promise<NonNullable<ProjectionSurface[Name]>> {
	const loaded = await projectionLoad;
	const helper = loaded[name];
	if (typeof helper !== "function") throw new Error(`PHASE_0O_B1A_MISSING_DEEP_HELPER:${String(name)}`);
	return helper as NonNullable<ProjectionSurface[Name]>;
}

function verify(proof: PersistedEquivocationProof): EquivocationProofVerification {
	return verifyEquivocationProof({
		canonicalProofBytes: proof.canonicalProofBytes,
		resolveAuthorPublicKey: resolver,
	});
}

beforeAll(async () => {
	const pair = await genuinePair(
		vertex(preimage()),
		vertex(preimage({ dependencies: [...contract.alternateDependencies] }))
	);
	baseVertices = pair.vertices;
	baseProof = pair.proof;
	recarrierCorpus = await genuineRecarrierCorpus();
});

describe("Phase 0o-b1a projection/reconstruction causal RED", () => {
	it("[governance] hash-binds the frozen base without weakening its persistence contract", () => {
		for (const [path, hash] of Object.entries(contract.baseArtifactSha256)) {
			expect(sha256File(resolve(REPOSITORY_ROOT, path)), path).toBe(hash);
		}
		const supplement = resolve(CURRENT_DIRECTORY, contract.supplementDirectory);
		expect(existsSync(supplement)).toBe(true);
		expect(readdirSync(supplement).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(supplement, "profile.json"), "utf8")) as {
			readonly baseProfileId: string;
			readonly profileId: string;
			readonly projection: { readonly payloadOutboxCopies: number; readonly proofBodyCopies: number };
			readonly retention: {
				readonly amendsBasePersistence: boolean;
				readonly globalEvidenceBoundClaimed: boolean;
				readonly newlyPersistedProofIdsMeaning: string;
				readonly proofBodiesPersist: boolean;
				readonly witnessesPersist: boolean;
			};
		};
		expect(profile).toMatchObject({
			baseProfileId: contract.baseProfileId,
			profileId: contract.profileId,
			projection: { payloadOutboxCopies: 0, proofBodyCopies: 0 },
			retention: {
				amendsBasePersistence: false,
				globalEvidenceBoundClaimed: false,
				newlyPersistedProofIdsMeaning: "unchanged-exactly-once-for-conforming-0o-a-state",
				proofBodiesPersist: true,
				witnessesPersist: true,
			},
		});
		const specification = readFileSync(resolve(supplement, "spec.md"), "utf8");
		for (const required of [
			"state.proofs",
			"newlyPersistedProofIds",
			"zero proof bodies",
			"No stale carrier payload",
			"global storage bound",
		]) {
			expect(specification).toContain(required);
		}
		const policy = JSON.parse(readFileSync(resolve(supplement, "freeze-policy.json"), "utf8")) as {
			readonly baseProfile: string;
			readonly checker: string;
			readonly profile: string;
			readonly protectedArtifacts: readonly string[];
			readonly workflow: string;
		};
		expect(policy).toMatchObject({
			baseProfile: contract.baseProfileId,
			checker: "check-freeze.mjs",
			profile: contract.profileId,
			workflow: ".github/workflows/protocol-v3-equivocation-evidence-projection.yml",
		});
		for (const required of [
			"tests/protocol-v3-equivocation-projection-0o-b1a.test.ts",
			"tests/fixtures/phase-0o-b1a-v3/controlled-equivocation-projection.ts",
			"tests/fixtures/phase-0o-b1a-v3/public-entry-type-audit.ts",
			"tests/fixtures/phase-0o-b1a-v3/built-package-type-audit.ts",
		]) {
			expect(policy.protectedArtifacts).toContain(required);
		}
		const checker = readFileSync(resolve(supplement, "check-freeze.mjs"), "utf8");
		expect(checker).toContain("frozenBaseArtifacts");
		expect(checker).toContain("validateWorkflow");
		const workflow = readFileSync(
			resolve(REPOSITORY_ROOT, ".github/workflows/protocol-v3-equivocation-evidence-projection.yml"),
			"utf8"
		);
		for (const required of [
			"permissions:\n  contents: read",
			"ref: ${{ github.sha }}",
			"timeout-minutes: 10",
			"PHASE_0O_B1A_IMPLEMENTATION_MODULE",
			"--no-coverage --maxWorkers=1 --minWorkers=1",
			"tsconfig.public-entry-audit.json",
			"tsconfig.built-package-audit.json",
		]) {
			expect(workflow).toContain(required);
		}
	});

	it("[base-preservation] genuine 0o-a recarrier keeps proof bodies and exactly-once ID semantics", () => {
		expect(recarrierCorpus.firstProofIdDelta).toEqual([recarrierCorpus.currentProof.proofId]);
		expect(recarrierCorpus.recarrierProofIdDelta).toEqual([]);
		expect(recarrierCorpus.currentProof.proofId).toBe(recarrierCorpus.staleProof.proofId);
		expect(recarrierCorpus.currentProof.canonicalProofBytes).not.toEqual(
			recarrierCorpus.staleProof.canonicalProofBytes
		);
		expect(verify(recarrierCorpus.currentProof)).toMatchObject({
			proofId: recarrierCorpus.currentProof.proofId,
			verified: true,
		});
	});

	it("[pair-id] derives one detached order-independent ID with the exact frozen domain and strict inputs", async () => {
		const derive = await requireHelper("deriveEquivocationProofId");
		const left = new Uint8Array(baseVertices[0].digest);
		const right = new Uint8Array(baseVertices[1].digest);
		const leftBefore = new Uint8Array(left);
		const rightBefore = new Uint8Array(right);
		const expected = toHex(
			hashDomain(
				contract.proofDomain,
				...(compareBytes(left, right) < 0 ? ([left, right] as const) : ([right, left] as const))
			)
		);
		expect(derive(left, right)).toBe(expected);
		expect(derive(right, left)).toBe(expected);
		expect(expected).toBe(baseProof.proofId);
		expect(left).toEqual(leftBefore);
		expect(right).toEqual(rightBefore);
		expect(() => derive(left, left)).toThrow(TypeError);
		expect(() => derive(left.slice(0, 31), right)).toThrow(TypeError);
		expect(() => derive("not-bytes" as unknown as Uint8Array, right)).toThrow(TypeError);
	});

	it("[materialization-id] recomputes the ID and returns genuine verifier-accepted canonical bytes", async () => {
		const materialize = await requireHelper("materializeCurrentEquivocationProof");
		const attackerId = "00".repeat(32);
		const input = {
			scope: scope(),
			vertices: structuredClone(baseVertices),
			resolveAuthorPublicKey: resolver,
			proofId: attackerId,
		};
		const verticesBefore = structuredClone(input.vertices);
		const scopeBefore = structuredClone(input.scope);
		const proof = materialize(input);
		expect(proof).toEqual(baseProof);
		expect(proof?.proofId).not.toBe(attackerId);
		expect(input.vertices).toEqual(verticesBefore);
		expect(input.scope).toEqual(scopeBefore);
		expect(input.resolveAuthorPublicKey).toBe(resolver);
		expect(proof === undefined ? undefined : verify(proof)).toMatchObject({
			proofId: baseProof.proofId,
			verified: true,
		});
	});

	it("[current-carrier] rebuilds current bytes after lesser same-digest recarrier under the unchanged ID", async () => {
		const materialize = await requireHelper("materializeCurrentEquivocationProof");
		const stale = materialize({
			scope: scope(),
			vertices: structuredClone(recarrierCorpus.staleVertices),
			resolveAuthorPublicKey: resolver,
		});
		const current = materialize({
			scope: scope(),
			vertices: structuredClone(recarrierCorpus.currentVertices),
			resolveAuthorPublicKey: resolver,
		});
		expect(stale).toEqual(recarrierCorpus.staleProof);
		expect(current).toEqual(recarrierCorpus.currentProof);
		expect(current?.proofId).toBe(stale?.proofId);
		expect(current?.canonicalProofBytes).not.toEqual(stale?.canonicalProofBytes);
	});

	it("[authentication] rejects bad key, signature and carrier before producing proof output", async () => {
		const materialize = await requireHelper("materializeCurrentEquivocationProof");
		const badSignature = structuredClone(baseVertices) as [PersistedVertexWitness, PersistedVertexWitness];
		badSignature[0] = {
			...badSignature[0],
			witness: {
				...badSignature[0].witness,
				signature: new Uint8Array(badSignature[0].witness.signature).fill(0),
			},
		};
		const badCarrier = structuredClone(baseVertices) as [PersistedVertexWitness, PersistedVertexWitness];
		badCarrier[0] = {
			...badCarrier[0],
			witness: { ...badCarrier[0].witness, suiteId: "not-registered" },
		};
		expect(materialize({ scope: scope(), vertices: badSignature, resolveAuthorPublicKey: resolver })).toBeUndefined();
		expect(
			materialize({
				scope: scope(),
				vertices: structuredClone(baseVertices),
				resolveAuthorPublicKey: () => ({ bytes: new Uint8Array(32), format: "raw" }),
			})
		).toBeUndefined();
		expect(materialize({ scope: scope(), vertices: badCarrier, resolveAuthorPublicKey: resolver })).toBeUndefined();
	});

	it("[scope-digest-shape] rejects wrong scope, stored digest, equal pair and malformed inputs", async () => {
		const materialize = await requireHelper("materializeCurrentEquivocationProof");
		const wrongDigest = structuredClone(baseVertices) as [PersistedVertexWitness, PersistedVertexWitness];
		wrongDigest[0] = { ...wrongDigest[0], digest: new Uint8Array(32).fill(3) };
		const equalPair = [structuredClone(baseVertices[0]), structuredClone(baseVertices[0])] as [
			PersistedVertexWitness,
			PersistedVertexWitness,
		];
		expect(
			materialize({
				scope: { ...scope(), authorSequence: contract.authorSequence + 1 },
				vertices: structuredClone(baseVertices),
				resolveAuthorPublicKey: resolver,
			})
		).toBeUndefined();
		expect(materialize({ scope: scope(), vertices: wrongDigest, resolveAuthorPublicKey: resolver })).toBeUndefined();
		expect(materialize({ scope: scope(), vertices: equalPair, resolveAuthorPublicKey: resolver })).toBeUndefined();
		expect(
			materialize({
				scope: scope(),
				vertices: [baseVertices[0]] as unknown as [PersistedVertexWitness, PersistedVertexWitness],
				resolveAuthorPublicKey: resolver,
			})
		).toBeUndefined();
		expect(materialize(null as unknown as MaterializeCurrentEquivocationProofInput)).toBeUndefined();
	});

	it("[capture-detach] reads caller scope/array/witness/bytes once without caller Array dispatch", async () => {
		const materialize = await requireHelper("materializeCurrentEquivocationProof");
		const reads: Record<string, number> = {};
		const read = <Value>(name: string, value: Value): Value => {
			reads[name] = (reads[name] ?? 0) + 1;
			return value;
		};
		const hostileVertex = (original: PersistedVertexWitness, index: number): PersistedVertexWitness => {
			const digestCarrier = new Uint8Array(original.digest);
			const preimageCarrier = new Uint8Array(original.witness.receivedCanonicalPreimageBytes);
			const witness = Object.create(null) as PersistedVertexWitness["witness"];
			Object.defineProperties(witness, {
				domain: { get: () => read(`v${index}.domain`, original.witness.domain) },
				expectedAnchor: { get: () => read(`v${index}.anchor`, original.witness.expectedAnchor) },
				receivedCanonicalPreimageBytes: {
					get: () => read(`v${index}.preimage`, preimageCarrier),
				},
				signature: {
					get: () => {
						preimageCarrier.fill(0);
						return read(`v${index}.signature`, new Uint8Array(original.witness.signature));
					},
				},
				suiteId: { get: () => read(`v${index}.suite`, original.witness.suiteId) },
			});
			return Object.defineProperties(Object.create(null), {
				digest: {
					get: () => read(`v${index}.digest`, digestCarrier),
				},
				witness: {
					get: () => {
						digestCarrier.fill(255);
						return read(`v${index}.witness`, witness);
					},
				},
			}) as PersistedVertexWitness;
		};
		const hostileVertices = [] as unknown as [PersistedVertexWitness, PersistedVertexWitness];
		Object.defineProperties(hostileVertices, {
			0: { get: () => read("vertices.0", hostileVertex(baseVertices[0], 0)) },
			1: { get: () => read("vertices.1", hostileVertex(baseVertices[1], 1)) },
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
			[Symbol.iterator]: {
				value: () => {
					throw new Error("caller iterator dispatched");
				},
			},
		});
		const hostileScope = Object.defineProperties(Object.create(null), {
			author: { get: () => read("scope.author", contract.author) },
			authorSequence: { get: () => read("scope.sequence", contract.authorSequence) },
			objectId: { get: () => read("scope.object", contract.objectId) },
		}) as EquivocationScope;
		const hostileInput = Object.defineProperties(Object.create(null), {
			resolveAuthorPublicKey: { get: () => read("input.resolver", resolver) },
			scope: { get: () => read("input.scope", hostileScope) },
			vertices: { get: () => read("input.vertices", hostileVertices) },
		}) as MaterializeCurrentEquivocationProofInput;
		expect(materialize(hostileInput)).toEqual(baseProof);
		expect(Object.values(reads).every((count) => count === 1)).toBe(true);
	});

	it("[public-root] forbids both helpers at source, built declaration/package and runtime package roots", async () => {
		const symbols = ["deriveEquivocationProofId", "materializeCurrentEquivocationProof"];
		const publicSource = readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts"), "utf8");
		const builtDeclaration = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/protocol-v3/dist/src/public.d.ts"),
			"utf8"
		);
		const sourceAudit = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b1a-v3/public-entry-type-audit.ts"),
			"utf8"
		);
		const builtAudit = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b1a-v3/built-package-type-audit.ts"),
			"utf8"
		);
		const sourceRuntime = await import(pathToFileURL(PUBLIC_ENTRY).href);
		const packageRuntime = await import("@ts-drp/protocol-v3");
		for (const symbol of symbols) {
			expect(publicSource).not.toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
			expect(builtDeclaration).not.toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
			expect(sourceAudit).toContain(`import { ${symbol} }`);
			expect(builtAudit).toContain(`import { ${symbol} }`);
			expect(sourceRuntime).not.toHaveProperty(symbol);
			expect(packageRuntime).not.toHaveProperty(symbol);
		}
	});
});
