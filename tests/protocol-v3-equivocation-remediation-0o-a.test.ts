import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-v3/equivocation-contract.json" with { type: "json" };
import {
	createRemoteEquivocationObserver as productionFactory,
	verifyEquivocationProof,
	verifyReceivedVertex,
} from "../packages/protocol-v3/src/index.js";
import type {
	EquivocationScope,
	EquivocationTransactionDecision,
	PersistedEquivocationProof,
	PersistedEquivocationState,
	PersistedVertexWitness,
	RawEd25519PublicKey,
	RemoteEquivocationObserver,
	RemoteEquivocationObserverOptions,
	RemoteObservationResult,
	TransactObservation,
	VerifyReceivedVertexInput,
} from "../packages/protocol-v3/src/index.js";

type ObserverControl = "compliant" | "factory-toctou" | "hostile-state" | "input-toctou" | "production";

interface MaterializedVertex {
	readonly digest: Uint8Array;
	readonly preimage: Readonly<Record<string, unknown>>;
	readonly witness: VerifyReceivedVertexInput;
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

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const CHECKER_PATH = "packages/protocol-v3/supplements/equivocation-digest-identity-v1/check-freeze.mjs";
const WORKFLOW_PATH = ".github/workflows/protocol-v3-equivocation-digest-identity.yml";
const CONTROL = (process.env.PHASE_0O_REMEDIATION_CONTROL ?? "production") as ObserverControl;
const EXPECTED_QUINT_TESTS = [
	"testSameDigestRecarrierIsDuplicate",
	"testDependencyForkIsEquivocation",
	"testLogicalTimeForkIsEquivocation",
	"testExactlyThreeUnorderedProofPairs",
] as const;

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function clone<Value>(value: Value): Value {
	return structuredClone(value);
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

function materializeVertex(preimage: Readonly<Record<string, unknown>>): MaterializedVertex {
	const privateKeySeed = fromHex(contract.privateKeySeedHex);
	const publicKey = ed25519.getPublicKey(privateKeySeed);
	const receivedCanonicalPreimageBytes = encodeCanonical(preimage);
	const digest = hashDomain(contract.domain, receivedCanonicalPreimageBytes);
	return {
		digest,
		preimage,
		witness: {
			domain: contract.domain,
			expectedAnchor: contract.anchor,
			receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey(author): RawEd25519PublicKey | undefined {
				return author === contract.author ? { bytes: publicKey, format: "raw" } : undefined;
			},
			signature: ed25519.sign(digest, privateKeySeed),
			suiteId: contract.suiteId,
		},
	};
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

function copyVertex(vertex: PersistedVertexWitness): PersistedVertexWitness {
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

function proofForPair(
	scope: EquivocationScope,
	left: PersistedVertexWitness,
	right: PersistedVertexWitness
): PersistedEquivocationProof {
	const [first, second] = compareBytes(left.digest, right.digest) < 0 ? [left, right] : [right, left];
	return {
		canonicalProofBytes: encodeCanonical({
			kind: contract.proofKind,
			profile: contract.profileId,
			protocolMajor: 3,
			slot: scope,
			vertices: [first, second].map((vertex) => ({
				digest: vertex.digest,
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				preimage: vertex.witness.receivedCanonicalPreimageBytes,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			})),
		}),
		proofId: toHex(hashDomain(contract.proofDomain, first.digest, second.digest)),
	};
}

function observationDecision(
	scope: EquivocationScope,
	candidate: PersistedVertexWitness,
	limit: number,
	state: PersistedEquivocationState
): EquivocationTransactionDecision {
	const previousProofIds = new Set(state.proofs.map(({ proofId }) => proofId));
	const vertices = state.vertices.map(copyVertex);
	const existingIndex = vertices.findIndex(({ digest }) => compareBytes(digest, candidate.digest) === 0);
	const disposition = existingIndex === -1 ? (vertices.length === 0 ? "new" : "equivocation") : "duplicate";
	if (existingIndex === -1) vertices.push(copyVertex(candidate));
	vertices.sort((left, right) => compareBytes(left.digest, right.digest));

	const proofs: PersistedEquivocationProof[] = [];
	for (let leftIndex = 0; leftIndex < vertices.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < vertices.length; rightIndex++) {
			proofs.push(
				proofForPair(
					scope,
					vertices[leftIndex] as PersistedVertexWitness,
					vertices[rightIndex] as PersistedVertexWitness
				)
			);
		}
	}
	proofs.sort((left, right) => left.proofId.localeCompare(right.proofId));
	const withinAdvisoryLimitProofCount = Math.min(proofs.length, limit);
	const slotSignal = {
		author: scope.author,
		observedForkCount: Math.max(0, vertices.length - 1),
		advisoryLimitReached: proofs.length >= limit,
		withinAdvisoryLimitProofCount,
		overAdvisoryLimitProofCount: proofs.length - withinAdvisoryLimitProofCount,
	};
	const orderedDigests = vertices.map(({ digest }) => toHex(digest));
	const result: RemoteObservationResult = {
		admitted: true,
		digest: new Uint8Array(candidate.digest),
		disposition,
		newlyPersistedProofIds: proofs.map(({ proofId }) => proofId).filter((proofId) => !previousProofIds.has(proofId)),
		resolution: {
			orderedDigests,
			preferredDigest: orderedDigests[0] as string,
		},
		slotSignal,
	};
	return { result, state: { proofs, slotSignal, vertices } };
}

function assertPersistedState(
	scope: EquivocationScope,
	state: PersistedEquivocationState,
	resolveAuthorPublicKey: VerifyReceivedVertexInput["resolveAuthorPublicKey"]
): void {
	if (state === null || typeof state !== "object" || !Array.isArray(state.vertices) || !Array.isArray(state.proofs)) {
		throw new TypeError("persisted equivocation state is malformed");
	}
	for (const vertex of state.vertices) {
		if (
			vertex === null ||
			typeof vertex !== "object" ||
			!(vertex.digest instanceof Uint8Array) ||
			vertex.digest.byteLength !== 32 ||
			vertex.witness === null ||
			typeof vertex.witness !== "object"
		) {
			throw new TypeError("persisted equivocation vertex is malformed");
		}
		const verification = verifyReceivedVertex({
			...vertex.witness,
			resolveAuthorPublicKey,
		});
		if (
			!verification.accepted ||
			verification.digest === undefined ||
			compareBytes(verification.digest, vertex.digest) !== 0
		) {
			throw new TypeError("persisted equivocation vertex digest is unauthenticated");
		}
		const preimage = decodeCanonical(vertex.witness.receivedCanonicalPreimageBytes) as Readonly<
			Record<string, unknown>
		>;
		if (
			preimage.author !== scope.author ||
			preimage.authorSequence !== scope.authorSequence ||
			preimage.objectId !== scope.objectId
		) {
			throw new TypeError("persisted equivocation vertex is outside transaction scope");
		}
	}
}

function localFactory(options: RemoteEquivocationObserverOptions): RemoteEquivocationObserver {
	if (options === null || typeof options !== "object") throw new TypeError("observer options must be an object");

	let transactObservation: TransactObservation;
	let perSlotAdvisoryProofLimit: number;
	if (CONTROL === "factory-toctou") {
		if (typeof options.transactObservation !== "function") {
			throw new TypeError("transactObservation must be a function");
		}
		if (!Number.isSafeInteger(options.perSlotAdvisoryProofLimit) || options.perSlotAdvisoryProofLimit < 1) {
			throw new TypeError("perSlotAdvisoryProofLimit must be a positive safe integer");
		}
		transactObservation = options.transactObservation;
		perSlotAdvisoryProofLimit = options.perSlotAdvisoryProofLimit;
	} else {
		transactObservation = options.transactObservation;
		perSlotAdvisoryProofLimit = options.perSlotAdvisoryProofLimit;
		if (typeof transactObservation !== "function") throw new TypeError("transactObservation must be a function");
		if (!Number.isSafeInteger(perSlotAdvisoryProofLimit) || perSlotAdvisoryProofLimit < 1) {
			throw new TypeError("perSlotAdvisoryProofLimit must be a positive safe integer");
		}
	}

	return {
		async observe(input: VerifyReceivedVertexInput): Promise<RemoteObservationResult> {
			let snapshot: VerifyReceivedVertexInput;
			try {
				if (input === null || typeof input !== "object") throw new TypeError("received vertex input is malformed");
				const resolveAuthorPublicKey = input.resolveAuthorPublicKey.bind(input);
				if (CONTROL === "input-toctou") {
					if (
						!(input.receivedCanonicalPreimageBytes instanceof Uint8Array) ||
						!(input.signature instanceof Uint8Array) ||
						input.signature.byteLength !== 64 ||
						typeof input.resolveAuthorPublicKey !== "function"
					) {
						throw new TypeError("received vertex input is malformed");
					}
					snapshot = {
						domain: input.domain,
						expectedAnchor: input.expectedAnchor,
						receivedCanonicalPreimageBytes: new Uint8Array(input.receivedCanonicalPreimageBytes),
						resolveAuthorPublicKey,
						signature: new Uint8Array(input.signature),
						suiteId: input.suiteId,
					};
				} else {
					const receivedCanonicalPreimageBytes = input.receivedCanonicalPreimageBytes;
					const signature = input.signature;
					if (
						!(receivedCanonicalPreimageBytes instanceof Uint8Array) ||
						!(signature instanceof Uint8Array) ||
						signature.byteLength !== 64 ||
						typeof input.resolveAuthorPublicKey !== "function"
					) {
						throw new TypeError("received vertex input is malformed");
					}
					snapshot = {
						domain: input.domain,
						expectedAnchor: input.expectedAnchor,
						receivedCanonicalPreimageBytes: new Uint8Array(receivedCanonicalPreimageBytes),
						resolveAuthorPublicKey,
						signature: new Uint8Array(signature),
						suiteId: input.suiteId,
					};
				}
			} catch {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}

			const verification = verifyReceivedVertex(snapshot);
			if (!verification.accepted || verification.digest === undefined) {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}
			const preimage = decodeCanonical(snapshot.receivedCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
			const scope: EquivocationScope = {
				author: preimage.author as string,
				authorSequence: preimage.authorSequence as number,
				objectId: preimage.objectId as string,
			};
			const candidate: PersistedVertexWitness = {
				digest: new Uint8Array(verification.digest),
				witness: {
					domain: snapshot.domain,
					expectedAnchor: snapshot.expectedAnchor,
					receivedCanonicalPreimageBytes: new Uint8Array(snapshot.receivedCanonicalPreimageBytes),
					signature: new Uint8Array(snapshot.signature),
					suiteId: snapshot.suiteId,
				},
			};
			return transactObservation(scope, (state) => {
				if (CONTROL !== "hostile-state") {
					assertPersistedState(scope, state, snapshot.resolveAuthorPublicKey);
				}
				return observationDecision(scope, candidate, perSlotAdvisoryProofLimit, state);
			});
		},
	};
}

const createRemoteEquivocationObserver =
	CONTROL === "production" ? productionFactory : (localFactory as typeof productionFactory);

function storingTransaction(initialState?: PersistedEquivocationState): {
	getAttempts(): number;
	getState(): PersistedEquivocationState | undefined;
	readonly transactObservation: TransactObservation;
} {
	let attempts = 0;
	let state = initialState === undefined ? undefined : clone(initialState);
	return {
		getAttempts: () => attempts,
		getState: () => (state === undefined ? undefined : clone(state)),
		transactObservation: (scope, apply): Promise<RemoteObservationResult> => {
			attempts++;
			const decision = apply(clone(state ?? emptyState(scope.author)));
			state = clone(decision.state);
			return Promise.resolve(clone(decision.result));
		},
	};
}

async function hostileStateOutcome(state: PersistedEquivocationState): Promise<{
	readonly committed: boolean;
	readonly emitted: RemoteObservationResult | undefined;
	readonly emittedProofVerified: boolean | undefined;
	readonly rejected: boolean;
}> {
	let committed = false;
	let emitted: RemoteObservationResult | undefined;
	let emittedProofVerified: boolean | undefined;
	const observer = createRemoteEquivocationObserver({
		perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
		transactObservation: (_scope, apply): Promise<RemoteObservationResult> => {
			const decision = apply(clone(state));
			committed = true;
			emitted = clone(decision.result);
			const proof = decision.state.proofs[0];
			emittedProofVerified =
				proof === undefined
					? undefined
					: verifyEquivocationProof({
							canonicalProofBytes: proof.canonicalProofBytes,
							resolveAuthorPublicKey: authoritativeResolver,
						}).verified;
			return Promise.resolve(clone(decision.result));
		},
	});
	let rejected = false;
	try {
		await observer.observe(materializeVertex(basePreimage()).witness);
	} catch {
		rejected = true;
	}
	return { committed, emitted, emittedProofVerified, rejected };
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

async function validProofBytes(): Promise<Uint8Array> {
	const store = storingTransaction();
	const observer = createRemoteEquivocationObserver({
		perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
		transactObservation: store.transactObservation,
	});
	await observer.observe(materializeVertex(basePreimage()).witness);
	await observer.observe(
		materializeVertex(basePreimage({ dependencies: [...contract.alternateDependencies] })).witness
	);
	const proof = store.getState()?.proofs[0];
	if (proof === undefined) throw new Error("test setup did not persist an equivocation proof");
	return proof.canonicalProofBytes;
}

function authoritativeResolver(author: string): RawEd25519PublicKey | undefined {
	return author === contract.author
		? { bytes: ed25519.getPublicKey(fromHex(contract.privateKeySeedHex)), format: "raw" }
		: undefined;
}

const BUNDLE_COPY_PATHS = [
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/check-freeze.mjs",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/equivocation-digest-identity.qnt",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/freeze-policy.json",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/profile.json",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/spec.md",
	".github/workflows/protocol-v3-equivocation-digest-identity.yml",
	"tests/protocol-v3-equivocation-0o.test.ts",
	"tests/fixtures/phase-0o-v3/equivocation-contract.json",
	"packages/protocol-v3/formal/author-lineage-actions.qnt",
	"tests/protocol-v3-formal-action-model-n1prime-a.test.ts",
	"tests/fixtures/phase-n1prime-a/formal-action-contract.json",
	"packages/protocol-v3/formal/signed-field-derivation.json",
] as const;

function withTemporaryCheckerBundle<Result>(run: (temporaryRoot: string, fakeBin: string) => Result): Result {
	const temporaryRoot = mkdtempSync(resolve(tmpdir(), "phase-0o-a-checker-"));
	try {
		for (const path of BUNDLE_COPY_PATHS) {
			const target = resolve(temporaryRoot, path);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(resolve(REPOSITORY_ROOT, path), target);
		}
		const fakeBin = resolve(temporaryRoot, "fake-bin");
		mkdirSync(fakeBin);
		const fakePnpm = resolve(fakeBin, "pnpm");
		writeFileSync(
			fakePnpm,
			`#!/bin/sh
if [ "$FAKE_QUINT_MODE" = "empty" ]; then
  exit 0
fi
if [ "$FAKE_QUINT_MODE" = "extra" ]; then
  printf '%s\\n' '${EXPECTED_QUINT_TESTS.map((name) => `ok ${name} passed 1 test(s)`).join("\\n")}' 'ok testUnexpected passed 1 test(s)' '5 passing (1ms)'
  exit 0
fi
printf '%s\\n' '${EXPECTED_QUINT_TESTS.map((name) => `ok ${name} passed 1 test(s)`).join("\\n")}' '4 passing (1ms)'
`,
			{ encoding: "utf8", mode: 0o755 }
		);
		chmodSync(fakePnpm, 0o755);
		return run(temporaryRoot, fakeBin);
	} finally {
		rmSync(temporaryRoot, { force: true, recursive: true });
	}
}

function runTemporaryChecker(temporaryRoot: string, fakeBin: string, mode: "empty" | "exact" | "extra"): boolean {
	try {
		execFileSync(process.execPath, [resolve(temporaryRoot, CHECKER_PATH)], {
			cwd: temporaryRoot,
			env: {
				...process.env,
				FAKE_QUINT_MODE: mode,
				PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
				PROTOCOL_V3_EQUIVOCATION_DIGEST_IDENTITY_REPOSITORY_ROOT: temporaryRoot,
			},
			stdio: "pipe",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

function updateWorkflowHash(temporaryRoot: string): void {
	const policyPath = resolve(
		temporaryRoot,
		"packages/protocol-v3/supplements/equivocation-digest-identity-v1/freeze-policy.json"
	);
	const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
		artifactSha256: Record<string, string>;
	};
	policy.artifactSha256[WORKFLOW_PATH] = sha256(readFileSync(resolve(temporaryRoot, WORKFLOW_PATH)));
	writeFileSync(policyPath, `${JSON.stringify(policy, null, "\t")}\n`);
}

describe("Phase 0o-a causal observer remediation RED", () => {
	it("rejects an authenticated persisted vertex from a different structured slot before commit or emission", async () => {
		const foreign = materializeVertex(basePreimage({ objectId: `${contract.objectId}|foreign` }));
		const outcome = await hostileStateOutcome({
			...emptyState(contract.author),
			vertices: [persistedVertex(foreign)],
		});
		expect(outcome).toEqual({
			committed: false,
			emitted: undefined,
			emittedProofVerified: undefined,
			rejected: true,
		});
	});

	it("rejects a persisted digest/preimage inconsistency before commit or emission", async () => {
		const stored = persistedVertex(materializeVertex(basePreimage()));
		stored.digest[0] ^= 1;
		const outcome = await hostileStateOutcome({
			...emptyState(contract.author),
			vertices: [stored],
		});
		expect(outcome).toEqual({
			committed: false,
			emitted: undefined,
			emittedProofVerified: undefined,
			rejected: true,
		});
	});

	it("captures each factory option once, validates that capture, and uses the same function and limit", async () => {
		const store = storingTransaction();
		let transactionReads = 0;
		let limitReads = 0;
		const options = {
			get perSlotAdvisoryProofLimit(): number {
				limitReads++;
				if (limitReads > 1) throw new Error("perSlotAdvisoryProofLimit was read twice");
				return contract.perSlotAdvisoryProofLimit;
			},
			get transactObservation(): TransactObservation {
				transactionReads++;
				if (transactionReads > 1) throw new Error("transactObservation was read twice");
				return store.transactObservation;
			},
		};
		const observer = createRemoteEquivocationObserver(options);
		const result = await observer.observe(materializeVertex(basePreimage()).witness);
		expect({
			limitReads,
			transactionReads,
			attempts: store.getAttempts(),
			withinLimit: result.slotSignal?.withinAdvisoryLimitProofCount,
		}).toEqual({
			limitReads: 1,
			transactionReads: 1,
			attempts: 1,
			withinLimit: 0,
		});

		let invalidLimitReads = 0;
		expect(() =>
			createRemoteEquivocationObserver({
				get perSlotAdvisoryProofLimit(): number {
					invalidLimitReads++;
					return 0;
				},
				transactObservation: store.transactObservation,
			})
		).toThrow(/perSlotAdvisoryProofLimit/iu);
		expect(invalidLimitReads).toBe(1);
	});

	it("captures byte-array inputs once before validation and copying without a numeric allocation path", async () => {
		const vertex = materializeVertex(basePreimage());
		const store = storingTransaction();
		const observer = createRemoteEquivocationObserver({
			perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
			transactObservation: store.transactObservation,
		});
		let preimageReads = 0;
		let signatureReads = 0;
		let resolverCalls = 0;
		const accessorInput = {
			domain: vertex.witness.domain,
			expectedAnchor: vertex.witness.expectedAnchor,
			get receivedCanonicalPreimageBytes(): Uint8Array {
				preimageReads++;
				return preimageReads === 1
					? vertex.witness.receivedCanonicalPreimageBytes
					: (Number.MAX_SAFE_INTEGER as unknown as Uint8Array);
			},
			resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined {
				resolverCalls++;
				return vertex.witness.resolveAuthorPublicKey(author);
			},
			get signature(): Uint8Array {
				signatureReads++;
				return vertex.witness.signature;
			},
			suiteId: vertex.witness.suiteId,
		};
		const result = await observer.observe(accessorInput);
		expect({
			admitted: result.admitted,
			attempts: store.getAttempts(),
			preimageReads,
			resolverCalls,
			signatureReads,
		}).toEqual({
			admitted: true,
			attempts: 1,
			preimageReads: 1,
			resolverCalls: 1,
			signatureReads: 1,
		});
	});

	it("captures both invalid accessor values once and performs zero resolver/store calls", async () => {
		const vertex = materializeVertex(basePreimage());
		const store = storingTransaction();
		const observer = createRemoteEquivocationObserver({
			perSlotAdvisoryProofLimit: contract.perSlotAdvisoryProofLimit,
			transactObservation: store.transactObservation,
		});
		let preimageReads = 0;
		let signatureReads = 0;
		let resolverCalls = 0;
		const result = await observer.observe({
			domain: vertex.witness.domain,
			expectedAnchor: vertex.witness.expectedAnchor,
			get receivedCanonicalPreimageBytes(): Uint8Array {
				preimageReads++;
				return Number.MAX_SAFE_INTEGER as unknown as Uint8Array;
			},
			resolveAuthorPublicKey(): RawEd25519PublicKey | undefined {
				resolverCalls++;
				return undefined;
			},
			get signature(): Uint8Array {
				signatureReads++;
				return vertex.witness.signature;
			},
			suiteId: vertex.witness.suiteId,
		});
		expect({
			result,
			attempts: store.getAttempts(),
			preimageReads,
			resolverCalls,
			signatureReads,
		}).toEqual({
			result: { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] },
			attempts: 0,
			preimageReads: 1,
			resolverCalls: 0,
			signatureReads: 1,
		});
	});
});

describe("Phase 0o-a standalone proof closure negatives", () => {
	it("pins proof cardinality, distinct ordered digests, closed framing/schema, and resolver containment", async () => {
		const canonicalProofBytes = await validProofBytes();
		const decoded = decodeCanonical(canonicalProofBytes) as ProofEnvelope;
		const oneVertex = { ...clone(decoded), vertices: [clone(decoded.vertices[0])] };
		const threeVertices = {
			...clone(decoded),
			vertices: [...clone(decoded.vertices), clone(decoded.vertices[0])],
		};
		const equalDigestPair = {
			...clone(decoded),
			vertices: [clone(decoded.vertices[0]), clone(decoded.vertices[0])],
		};
		const unsortedPair = { ...clone(decoded), vertices: [...clone(decoded.vertices)].reverse() };
		const extraKey = { ...clone(decoded), unexpected: true };
		const trailingBytes = Uint8Array.from([...canonicalProofBytes, 0]);
		const malformed = [oneVertex, threeVertices, equalDigestPair, unsortedPair, extraKey].map((proof) =>
			verifyEquivocationProof({
				canonicalProofBytes: encodeCanonical(proof),
				resolveAuthorPublicKey: authoritativeResolver,
			})
		);
		malformed.push(
			verifyEquivocationProof({
				canonicalProofBytes: trailingBytes,
				resolveAuthorPublicKey: authoritativeResolver,
			})
		);
		expect(malformed.every(({ verified }) => !verified)).toBe(true);
		expect(() =>
			verifyEquivocationProof({
				canonicalProofBytes,
				resolveAuthorPublicKey(): RawEd25519PublicKey {
					throw new Error("resolver failure");
				},
			})
		).not.toThrow();
		expect(
			verifyEquivocationProof({
				canonicalProofBytes,
				resolveAuthorPublicKey(): RawEd25519PublicKey {
					throw new Error("resolver failure");
				},
			}).verified
		).toBe(false);
	});
});

describe("Phase 0o-a defense-in-depth remediation RED", () => {
	it("explicitly forbids both equivocation symbols at runtime and source/built-package type boundaries", () => {
		const packageJson = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/package.json"), "utf8")
		) as { scripts: { "smoke:public-package": string } };
		const sourceAudit = readFileSync(
			resolve(REPOSITORY_ROOT, "tests/fixtures/phase-0i-v3/public-entry-type-audit.ts"),
			"utf8"
		);
		const builtAudit = readFileSync(
			resolve(REPOSITORY_ROOT, "tests/fixtures/phase-0i-v3/built-package-type-audit.ts"),
			"utf8"
		);
		for (const symbol of ["createRemoteEquivocationObserver", "verifyEquivocationProof"]) {
			expect(packageJson.scripts["smoke:public-package"]).toMatch(
				new RegExp(`const forbidden\\s*=\\s*\\[[^\\]]*['"]${symbol}['"]`, "u")
			);
			const adjacentDirectImport = new RegExp(
				`// @ts-expect-error[^\\r\\n]*\\r?\\nimport\\s*\\{\\s*${symbol}\\s*\\}\\s*from\\s*["'][^"']+["'];`,
				"u"
			);
			expect(sourceAudit).toMatch(adjacentDirectImport);
			expect(builtAudit).toMatch(adjacentDirectImport);
		}
	});

	it("requires the exact nonzero Quint test set instead of trusting an exit-zero no-match", () => {
		withTemporaryCheckerBundle((temporaryRoot, fakeBin) => {
			const accepted = {
				empty: runTemporaryChecker(temporaryRoot, fakeBin, "empty"),
				exact: runTemporaryChecker(temporaryRoot, fakeBin, "exact"),
				extra: runTemporaryChecker(temporaryRoot, fakeBin, "extra"),
			};
			expect(accepted).toEqual({ empty: false, exact: true, extra: false });
		});
	});

	it("rejects top-level write-all and job-scoped write grants while retaining a clean-workflow control", () => {
		withTemporaryCheckerBundle((temporaryRoot, fakeBin) => {
			const cleanAccepted = runTemporaryChecker(temporaryRoot, fakeBin, "exact");
			const workflowPath = resolve(temporaryRoot, WORKFLOW_PATH);
			const cleanWorkflow = readFileSync(workflowPath, "utf8");
			const jobScopedWriteWorkflow = cleanWorkflow.replace(
				"    runs-on: ubuntu-latest",
				"    permissions:\n      contents: write\n    runs-on: ubuntu-latest"
			);
			writeFileSync(workflowPath, jobScopedWriteWorkflow);
			updateWorkflowHash(temporaryRoot);
			const jobScopedWriteAccepted = runTemporaryChecker(temporaryRoot, fakeBin, "exact");
			const hostileWorkflow = cleanWorkflow.replace("permissions:\n  contents: read", "permissions: write-all");
			writeFileSync(workflowPath, hostileWorkflow);
			updateWorkflowHash(temporaryRoot);
			const hostileAccepted = runTemporaryChecker(temporaryRoot, fakeBin, "exact");
			expect({ cleanAccepted, hostileAccepted, jobScopedWriteAccepted }).toEqual({
				cleanAccepted: true,
				hostileAccepted: false,
				jobScopedWriteAccepted: false,
			});
		});
	});
});
