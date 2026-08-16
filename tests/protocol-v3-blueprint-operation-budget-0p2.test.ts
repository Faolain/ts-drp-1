import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import contract from "./fixtures/phase-0p2-v3/blueprint-operation-budget-contract.json" with { type: "json" };
import { auditSuccessorWorkflowRouting } from "./fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.js";
import successorContract from "./fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json" with { type: "json" };

interface CanonicalModule {
	decodeCanonical(bytes: Uint8Array): unknown;
	encodeCanonical(value: unknown): Uint8Array;
}

interface Ed25519Module {
	ed25519: {
		getPublicKey(privateKey: Uint8Array): Uint8Array;
		sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
		verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options?: unknown): boolean;
	};
}

const instrumentation = vi.hoisted(() => ({
	encodeCalls: 0,
	signCalls: 0,
	verifyCalls: 0,
}));

vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const actual = await importOriginal<CanonicalModule>();
	return {
		...actual,
		encodeCanonical(value: unknown): Uint8Array {
			instrumentation.encodeCalls++;
			return actual.encodeCanonical(value);
		},
	};
});

vi.mock("../packages/protocol-v3/node_modules/@noble/curves/ed25519.js", async (importOriginal) => {
	const actual = await importOriginal<Ed25519Module>();
	return {
		...actual,
		ed25519: {
			...actual.ed25519,
			sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
				instrumentation.signCalls++;
				return actual.ed25519.sign(message, privateKey);
			},
			verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options?: unknown): boolean {
				instrumentation.verifyCalls++;
				return actual.ed25519.verify(signature, message, publicKey, options);
			},
		},
	};
});

const { decodeCanonical, encodeCanonical } = await import("@ts-drp/canonical");
const { ed25519 } = await import("../packages/protocol-v3/node_modules/@noble/curves/ed25519.js");

interface PreparedAdmission {
	readonly blueprintDigest: string;
}

interface RemoteInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly preparedBlueprintAdmission: PreparedAdmission;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): { readonly bytes: Uint8Array; readonly format: "raw" } | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

interface AdmissionDecision {
	readonly admitted: boolean;
	readonly digest?: Uint8Array;
}

interface LocalInput {
	readonly anchor: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
}

interface IssueScope {
	readonly author: string;
	readonly objectId: string;
}

interface Envelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface Commit {
	readonly authorSequence: number;
	readonly envelope: Envelope;
	readonly issuedRecord: { readonly authorSequence: number; readonly envelope: Envelope; readonly scope: IssueScope };
	readonly outboxEntry: { readonly authorSequence: number; readonly envelope: Envelope; readonly scope: IssueScope };
}

type TransactIssue = (scope: IssueScope, buildAndSign: (authorSequence: number) => Promise<Commit>) => Promise<Commit>;

interface Surface {
	admitReceivedVertex(input: RemoteInput): AdmissionDecision;
	createAdmissionBoundTransactionalVertexIssuer(options: {
		readonly author: string;
		readonly preparedBlueprintAdmission: PreparedAdmission;
		readonly privateKeySeed: Uint8Array;
		readonly publicKey: { readonly bytes: Uint8Array; readonly format: "raw" };
		readonly transactIssue: TransactIssue;
	}): { issue(input: LocalInput): Promise<Commit> };
	prepareBlueprintAdmission(input: {
		readonly canonicalBlueprintPackageBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
	}): PreparedAdmission;
	prepareBlueprintRuntime(...input: readonly unknown[]): unknown;
}

interface RemoteCase {
	readonly bytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface TransactionHarness {
	readonly transactIssue: TransactIssue;
	readonly transactions: number;
	readonly buildAndSignCalls: number;
	readonly issuedRecordWrites: number;
	readonly outboxWrites: number;
}

interface DownstreamWitnesses {
	folds: number;
	publications: number;
	reducers: number;
}

declare global {
	// eslint-disable-next-line no-var
	var __PHASE_0P2_CONSTRUCTION_WITNESSES__:
		| {
				issuedRecords: number;
				outboxEntries: number;
		  }
		| undefined;
}

type BlueprintPackage = typeof contract.budgetedPackage;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const IMPLEMENTATION =
	process.env.PHASE_0P2_IMPLEMENTATION_MODULE === undefined
		? resolve(HERE, contract.implementationModule)
		: resolve(ROOT, process.env.PHASE_0P2_IMPLEMENTATION_MODULE);
const surfaceLoad = import(pathToFileURL(IMPLEMENTATION).href) as Promise<Surface>;
const packageSurfaceLoad = import(pathToFileURL(resolve(HERE, contract.implementationModule)).href) as Promise<Surface>;
const encoder = new TextEncoder();
const VERTEX_DOMAIN = "ts-drp/vertex/v3";
const VERTEX_SUITE = "ed25519-sha256-v3";
const BLUEPRINT_DOMAIN = contract.blueprintDigestDomain;
const privateKeySeed = fromHex(contract.privateKeySeedHex);
const publicKey = ed25519.getPublicKey(privateKeySeed);

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsigned(value: number, width: 4 | 8): Uint8Array {
	const output = new Uint8Array(width);
	const view = new DataView(output.buffer);
	if (width === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

function independentDomainHash(domain: string, payload: Uint8Array): Uint8Array {
	const domainBytes = encoder.encode(domain);
	return new Uint8Array(
		createHash("sha256")
			.update(
				concat([
					Uint8Array.of(0x44, 0x52, 0x50, 0),
					unsigned(domainBytes.byteLength, 4),
					domainBytes,
					unsigned(payload.byteLength, 8),
					payload,
				])
			)
			.digest()
	);
}

function packageWithLimit(limit: number): BlueprintPackage {
	const value = structuredClone(contract.budgetedPackage);
	const operation = value.manifest.operations[0];
	if (operation === undefined) throw new Error("budget fixture operation is absent");
	operation.maxCanonicalOperationBytes = limit;
	return value;
}

function legacyPackage(): Record<string, unknown> {
	const value = structuredClone(contract.budgetedPackage) as unknown as Record<string, unknown>;
	const manifest = value.manifest as Record<string, unknown>;
	manifest.schemaVersion = 1;
	delete manifest.workBudgetProfile;
	for (const operation of manifest.operations as Array<Record<string, unknown>>) {
		delete operation.maxCanonicalOperationBytes;
	}
	return value;
}

async function surface(): Promise<Surface> {
	return surfaceLoad;
}

async function prepare(packageValue: unknown): Promise<PreparedAdmission> {
	const bytes = encodeCanonical(packageValue);
	const digest = Buffer.from(independentDomainHash(BLUEPRINT_DOMAIN, bytes)).toString("hex");
	return (await surface()).prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: bytes,
		expectedBlueprintDigest: digest,
	});
}

function operationAtSize(target: number, meterCase?: string): Readonly<Record<string, unknown>> {
	for (let padding = 0; padding < 512; padding++) {
		const operation = {
			action: "append",
			nested:
				meterCase === undefined
					? { emoji: "😀", layer: { flag: true } }
					: { case: meterCase, emoji: "😀", layer: { flag: true } },
			requestOrdinal: 7,
			value: "x".repeat(padding),
		};
		if (encodeCanonical(operation).byteLength === target) return operation;
	}
	throw new Error(`no canonical operation of ${target} bytes`);
}

function vertexPreimage(
	operation: Readonly<Record<string, unknown>>,
	objectId = contract.vertex.objectId
): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId,
		epoch: contract.vertex.epoch,
		anchor: contract.vertex.anchor,
		author: contract.vertex.author,
		authorSequence: contract.vertex.authorSequence,
		logicalTime: contract.vertex.logicalTime,
		dependencies: contract.vertex.dependencies,
		operation,
	};
}

function signedRemote(operation: Readonly<Record<string, unknown>>, objectId = contract.vertex.objectId): RemoteCase {
	const bytes = encodeCanonical(vertexPreimage(operation, objectId));
	const digest = independentDomainHash(VERTEX_DOMAIN, bytes);
	return {
		bytes,
		digest,
		signature: ed25519.sign(digest, privateKeySeed),
	};
}

function remoteInput(remote: RemoteCase, prepared: PreparedAdmission): RemoteInput {
	return {
		domain: VERTEX_DOMAIN,
		expectedAnchor: contract.vertex.anchor,
		preparedBlueprintAdmission: prepared,
		receivedCanonicalPreimageBytes: remote.bytes,
		resolveAuthorPublicKey: (author) =>
			author === contract.vertex.author ? { bytes: publicKey, format: "raw" } : undefined,
		signature: remote.signature,
		suiteId: VERTEX_SUITE,
	};
}

function localInput(operation: Readonly<Record<string, unknown>>): LocalInput {
	return {
		anchor: contract.vertex.anchor,
		dependencies: contract.vertex.dependencies,
		epoch: contract.vertex.epoch,
		logicalTime: contract.vertex.logicalTime,
		objectId: contract.vertex.objectId,
		operation,
	};
}

function transactionHarness(): TransactionHarness {
	let transactions = 0;
	let buildAndSignCalls = 0;
	let issuedRecordWrites = 0;
	let outboxWrites = 0;
	const transactIssue: TransactIssue = async (_scope, buildAndSign) => {
		transactions++;
		buildAndSignCalls++;
		const commit = await buildAndSign(contract.vertex.authorSequence);
		issuedRecordWrites++;
		outboxWrites++;
		return commit;
	};
	return {
		transactIssue,
		get transactions(): number {
			return transactions;
		},
		get buildAndSignCalls(): number {
			return buildAndSignCalls;
		},
		get issuedRecordWrites(): number {
			return issuedRecordWrites;
		},
		get outboxWrites(): number {
			return outboxWrites;
		},
	};
}

async function issuer(
	prepared: PreparedAdmission,
	harness: TransactionHarness
): Promise<{ issue(input: LocalInput): Promise<Commit> }> {
	return (await surface()).createAdmissionBoundTransactionalVertexIssuer({
		author: contract.vertex.author,
		preparedBlueprintAdmission: prepared,
		privateKeySeed,
		publicKey: { bytes: publicKey, format: "raw" },
		transactIssue: harness.transactIssue,
	});
}

async function attemptLocal(
	prepared: PreparedAdmission,
	operation: Readonly<Record<string, unknown>>,
	harness = transactionHarness()
): Promise<{ error?: unknown; harness: TransactionHarness; value?: Commit }> {
	try {
		return { harness, value: await (await issuer(prepared, harness)).issue(localInput(operation)) };
	} catch (error) {
		return { error, harness };
	}
}

function consume(decision: AdmissionDecision, stage: keyof DownstreamWitnesses, witnesses: DownstreamWitnesses): void {
	if (decision.admitted) witnesses[stage]++;
}

function emptyDownstream(): DownstreamWitnesses {
	return { folds: 0, publications: 0, reducers: 0 };
}

function resetInstrumentation(): void {
	instrumentation.encodeCalls = 0;
	instrumentation.signCalls = 0;
	instrumentation.verifyCalls = 0;
	globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__ = { issuedRecords: 0, outboxEntries: 0 };
}

describe("Phase 0p-2 authenticated whole-operation canonical byte budget causal RED", () => {
	it("[governance] freezes the exact meter/order contract and bounded CI predecessor set", () => {
		const directory = resolve(HERE, contract.conformanceDirectory);
		expect(readdirSync(directory).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(directory, "profile.json"), "utf8")) as Record<string, unknown>;
		expect(profile).toMatchObject({
			profileId: "blueprint-operation-budget-v1",
			meter: {
				preimage: "encodeCanonical(canonicalDetachedOperation)",
				byteCount: "Uint8Array.byteLength",
				includesDiscriminator: true,
			},
			remoteOrder: ["exact-received-byte-authentication", "abi-match", "operation-byte-budget", "consumer"],
			localOrder: ["canonical-detach", "operation-byte-budget", "transaction-sign-record-outbox"],
			legacyManifestSchema1: "unbudgeted",
		});
		const workflow = readFileSync(resolve(ROOT, contract.workflow), "utf8");
		for (const phrase of [
			"permissions:\n  contents: read",
			"PHASE_0P2_IMPLEMENTATION_MODULE",
			"PHASE_0P2_MUTANT",
			"protocol-v3-blueprint-runtime-0j-b.test.ts",
			"--no-coverage --maxWorkers=1 --minWorkers=1",
		]) {
			expect(workflow).toContain(phrase);
		}
		const workflowIdentity = successorContract.workflowIdentities.find(({ path }) => path === contract.workflow);
		expect(workflowIdentity).toBeDefined();
		if (workflowIdentity === undefined) throw new Error("operation workflow identity is absent");
		expect(
			auditSuccessorWorkflowRouting(
				workflow,
				workflowIdentity,
				successorContract.predecessors.map(({ checker }) => checker)
			)
		).toEqual([]);
	});

	it("[unsupported-manifest-version] rejects a representable v1-shaped unsupported manifest version", async () => {
		const unsupported = legacyPackage();
		(unsupported.manifest as Record<string, unknown>).schemaVersion = 3;
		await expect(prepare(unsupported)).rejects.toThrow();
	});

	it("[max-safe-integer] accepts Number.MAX_SAFE_INTEGER as a representable schema-2 limit", async () => {
		await expect(prepare(packageWithLimit(Number.MAX_SAFE_INTEGER))).resolves.toMatchObject({
			blueprintDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
		});
	});

	it("[public-surface] preserves exactly the ten package-root runtime exports", async () => {
		expect(Object.keys(await packageSurfaceLoad).sort()).toEqual([
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
	});

	it("[protected-predecessors] preserves v3/v2 registries, vectors, references and freeze policies", () => {
		for (const [path, expected] of Object.entries(contract.protectedArtifactSha256)) {
			const actual = createHash("sha256")
				.update(readFileSync(resolve(ROOT, path)))
				.digest("hex");
			expect(actual, path).toBe(expected);
		}
	});

	for (const [label, delta, accepted] of [
		["limit-minus-one", -1, true],
		["limit", 0, true],
		["limit-plus-one", 1, false],
	] as const) {
		it(`[remote-${label}] applies the exact ${label} whole-operation canonical-byte boundary`, async () => {
			const operation = operationAtSize(contract.operationLimit + delta);
			const prepared = await prepare(packageWithLimit(contract.operationLimit));
			const remote = signedRemote(operation);
			const decision = (await surface()).admitReceivedVertex(remoteInput(remote, prepared));
			expect(encodeCanonical(operation).byteLength).toBe(contract.operationLimit + delta);
			expect(decision.admitted).toBe(accepted);
			expect(decision.digest).toEqual(accepted ? remote.digest : undefined);
		});

		it(`[local-${label}] applies the exact ${label} detached-operation canonical-byte boundary`, async () => {
			const operation = operationAtSize(contract.operationLimit + delta);
			const prepared = await prepare(packageWithLimit(contract.operationLimit));
			const outcome = await attemptLocal(prepared, operation);
			expect(encodeCanonical(operation).byteLength).toBe(contract.operationLimit + delta);
			if (accepted) {
				expect(outcome.error).toBeUndefined();
				expect(outcome.value).toBeDefined();
			} else {
				expect(outcome.error).toBeDefined();
				expect(outcome.value).toBeUndefined();
				expect(outcome.harness.transactions).toBe(0);
			}
		});
	}

	it("[json-stringify-meter] admits canonical-limit bytes even when JSON UTF-8 bytes exceed the limit on both paths", async () => {
		const operation = operationAtSize(contract.operationLimit, "j");
		expect(Buffer.byteLength(JSON.stringify(operation))).toBeGreaterThan(contract.operationLimit);
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const remote = signedRemote(operation);
		const remoteDecision = (await surface()).admitReceivedVertex(remoteInput(remote, prepared));
		const localOutcome = await attemptLocal(prepared, operation);
		expect(remoteDecision.admitted).toBe(true);
		expect(localOutcome.error).toBeUndefined();
		expect(localOutcome.value).toBeDefined();
	});

	it("[utf16-meter] rejects a non-BMP operation whose UTF-16 count fits but canonical bytes exceed the limit", async () => {
		const operation = { action: "append", nested: { case: "u" }, value: "😀".repeat(10) };
		const canonicalLength = encodeCanonical(operation).byteLength;
		const utf16Length = JSON.stringify(operation).length;
		expect(utf16Length).toBeLessThan(canonicalLength);
		const prepared = await prepare(packageWithLimit(utf16Length));
		const remote = signedRemote(operation);
		const outcome = await attemptLocal(prepared, operation);
		expect((await surface()).admitReceivedVertex(remoteInput(remote, prepared))).toEqual({ admitted: false });
		expect(outcome.error).toBeDefined();
		expect(outcome.harness.transactions).toBe(0);
	});

	it("[raw-frame-meter] keeps the operation decision invariant when only enclosing received-frame bytes change", async () => {
		const operation = operationAtSize(contract.operationLimit, "r");
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const short = signedRemote(operation, "o");
		const long = signedRemote(operation, `o-${"frame-only".repeat(64)}`);
		expect(short.bytes.byteLength).toBeLessThan(long.bytes.byteLength);
		expect(encodeCanonical(operation).byteLength).toBe(contract.operationLimit);
		expect((await surface()).admitReceivedVertex(remoteInput(short, prepared)).admitted).toBe(true);
		expect((await surface()).admitReceivedVertex(remoteInput(long, prepared)).admitted).toBe(true);
	});

	it("[discriminator-included-meter] rejects when only discriminator-inclusive canonical bytes cross the limit on both paths", async () => {
		const operation = { action: "append", nested: { case: "d" }, value: "😀".repeat(10) };
		const withoutDiscriminator = { nested: operation.nested, value: operation.value };
		const limit = encodeCanonical(withoutDiscriminator).byteLength;
		expect(encodeCanonical(operation).byteLength).toBeGreaterThan(limit);
		const prepared = await prepare(packageWithLimit(limit));
		const remote = signedRemote(operation);
		const outcome = await attemptLocal(prepared, operation);
		expect((await surface()).admitReceivedVertex(remoteInput(remote, prepared))).toEqual({ admitted: false });
		expect(outcome.error).toBeDefined();
		expect(outcome.harness.transactions).toBe(0);
	});

	it("[injected-counter-meter] ignores a cooperative nested counter and meters the whole record on both paths", async () => {
		const operation = {
			action: "append",
			nested: { payload: "x".repeat(256), workUnits: 1 },
			value: "counter is inert application data",
		};
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		expect(encodeCanonical(operation).byteLength).toBeGreaterThan(contract.operationLimit);
		const remote = signedRemote(operation);
		const outcome = await attemptLocal(prepared, operation);
		expect((await surface()).admitReceivedVertex(remoteInput(remote, prepared))).toEqual({ admitted: false });
		expect(outcome.error).toBeDefined();
		expect(outcome.harness.transactions).toBe(0);
	});

	it("[remote-auth-before-budget] authenticates invalid exact received bytes before any operation meter work", async () => {
		const operation = operationAtSize(contract.operationLimit + 1);
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const remote = signedRemote(operation);
		const signature = new Uint8Array(remote.signature);
		signature[0] ^= 1;
		resetInstrumentation();
		const decision = (await surface()).admitReceivedVertex(remoteInput({ ...remote, signature }, prepared));
		expect(decision).toEqual({ admitted: false });
		expect(instrumentation.verifyCalls).toBe(1);
		expect(instrumentation.encodeCalls).toBe(0);
	});

	it("[remote-abi-before-budget] rejects an authenticated ABI mismatch before any operation meter work", async () => {
		const operation = { action: "append", value: "x".repeat(256), unexpected: true };
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const remote = signedRemote(operation);
		resetInstrumentation();
		expect((await surface()).admitReceivedVertex(remoteInput(remote, prepared))).toEqual({ admitted: false });
		expect(instrumentation.verifyCalls).toBe(1);
		expect(instrumentation.encodeCalls).toBe(0);
	});

	for (const [label, witnessStage, meterCase] of [
		["publication", "publications", "p"],
		["reducer", "reducers", "q"],
		["fold", "folds", "f"],
	] as const) {
		it(`[remote-pre-${label}] refuses over-budget admission before a decision-gated ${label} consumer`, async () => {
			const prepared = await prepare(packageWithLimit(contract.operationLimit));
			const remote = signedRemote(operationAtSize(contract.operationLimit + 1, meterCase));
			const witnesses = emptyDownstream();
			const decision = (await surface()).admitReceivedVertex(remoteInput(remote, prepared));
			consume(decision, witnessStage, witnesses);
			expect(decision).toEqual({ admitted: false });
			expect(witnesses).toEqual(emptyDownstream());
		});
	}

	it("[local-detach-before-budget] meters the captured detached operation that is actually issued", async () => {
		const small = operationAtSize(contract.operationLimit);
		const large = operationAtSize(contract.operationLimit + 1);
		let valueDescriptorReads = 0;
		const operation = new Proxy(
			{ ...small },
			{
				getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
					if (property === "value") {
						valueDescriptorReads++;
						return {
							configurable: true,
							enumerable: true,
							value: valueDescriptorReads <= 2 ? small.value : large.value,
							writable: true,
						};
					}
					return Reflect.getOwnPropertyDescriptor(target, property);
				},
			}
		);
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const outcome = await attemptLocal(prepared, operation);
		expect(outcome.error).toBeUndefined();
		expect(outcome.value).toBeDefined();
		const issued = decodeCanonical(outcome.value?.envelope.canonicalPreimageBytes ?? new Uint8Array()) as {
			operation: unknown;
		};
		expect(encodeCanonical(issued.operation).byteLength).toBeLessThanOrEqual(contract.operationLimit);
	});

	it("[local-pre-transaction] rejects before transaction creation", async () => {
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const outcome = await attemptLocal(prepared, operationAtSize(contract.operationLimit + 1, "t"));
		expect(outcome.error).toBeDefined();
		expect(outcome.harness.transactions).toBe(0);
		expect(outcome.harness.buildAndSignCalls).toBe(0);
	});

	it("[local-pre-signing] rejects before signing", async () => {
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const harness = transactionHarness();
		resetInstrumentation();
		const outcome = await attemptLocal(prepared, operationAtSize(contract.operationLimit + 1, "s"), harness);
		expect(outcome.error).toBeDefined();
		expect(instrumentation.signCalls).toBe(0);
	});

	it("[local-pre-issued-record] rejects before issued-record construction or persistence", async () => {
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const harness = transactionHarness();
		resetInstrumentation();
		const outcome = await attemptLocal(prepared, operationAtSize(contract.operationLimit + 1, "i"), harness);
		expect(outcome.error).toBeDefined();
		expect(globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__?.issuedRecords).toBe(0);
		expect(harness.issuedRecordWrites).toBe(0);
	});

	it("[local-pre-outbox] rejects before outbox construction or persistence", async () => {
		const prepared = await prepare(packageWithLimit(contract.operationLimit));
		const harness = transactionHarness();
		resetInstrumentation();
		const outcome = await attemptLocal(prepared, operationAtSize(contract.operationLimit + 1, "o"), harness);
		expect(outcome.error).toBeDefined();
		expect(globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__?.outboxEntries).toBe(0);
		expect(harness.outboxWrites).toBe(0);
	});

	it("[legacy-schema1-remote] preserves unbudgeted remote admission for a large schema-1 operation", async () => {
		const prepared = await prepare(legacyPackage());
		const remote = signedRemote(operationAtSize(contract.operationLimit + 1));
		expect((await surface()).admitReceivedVertex(remoteInput(remote, prepared))).toEqual({
			admitted: true,
			digest: remote.digest,
		});
	});

	it("[legacy-schema1-local] preserves unbudgeted local issuance for a large schema-1 operation", async () => {
		const prepared = await prepare(legacyPackage());
		const outcome = await attemptLocal(prepared, operationAtSize(contract.operationLimit + 1));
		expect(outcome.error).toBeUndefined();
		expect(outcome.value).toBeDefined();
		expect(outcome.harness.transactions).toBe(1);
	});
});
