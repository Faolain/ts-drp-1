/* eslint-disable @typescript-eslint/require-await -- immediate async signer outcomes are part of the callback contract */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import blueprintContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import budgetContract from "./fixtures/phase-0p2-v3/blueprint-operation-budget-contract.json" with { type: "json" };
import budgetVectors from "./fixtures/phase-3a1b-p5/protocol-operation-budget-vectors.json" with { type: "json" };
import { VertexValidationError } from "../packages/protocol-v3/src/index.js";

interface IssueScope {
	readonly author: string;
	readonly objectId: string;
}

interface LocalVertexInput {
	readonly anchor: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
}

interface SignedVertexEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface IssueCommit {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly issuedRecord: {
		readonly authorSequence: number;
		readonly envelope: SignedVertexEnvelope;
		readonly scope: IssueScope;
	};
	readonly outboxEntry: {
		readonly authorSequence: number;
		readonly envelope: SignedVertexEnvelope;
		readonly scope: IssueScope;
	};
}

type BuildAndSign = (authorSequence: number) => Promise<IssueCommit>;
type TransactIssue = (scope: IssueScope, buildAndSign: BuildAndSign) => Promise<IssueCommit>;
type SignRegisteredVertexDigest = (registeredDigest: Uint8Array) => Promise<Uint8Array>;

interface TransactionalVertexIssuer {
	issue(input: LocalVertexInput): Promise<IssueCommit>;
}

interface CallbackIssuerOptions {
	readonly author: string;
	readonly preparedBlueprintAdmission: unknown;
	readonly privateKeySeed?: never;
	readonly publicKey: { readonly bytes: Uint8Array; readonly format: "raw" };
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
	readonly transactIssue: TransactIssue;
}

interface SeedIssuerOptions {
	readonly author: string;
	readonly preparedBlueprintAdmission: unknown;
	readonly privateKeySeed: Uint8Array;
	readonly publicKey: { readonly bytes: Uint8Array; readonly format: "raw" };
	readonly signRegisteredVertexDigest?: never;
	readonly transactIssue: TransactIssue;
}

interface ProtocolSurface {
	createAdmissionBoundTransactionalVertexIssuer(
		options: CallbackIssuerOptions | SeedIssuerOptions
	): TransactionalVertexIssuer;
	prepareBlueprintAdmission(input: {
		readonly canonicalBlueprintPackageBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
	}): unknown;
	readonly [name: string]: unknown;
}

interface StoredState {
	readonly commits: readonly IssueCommit[];
	readonly next: number;
}

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "..");
const PUBLIC_ENTRY = path.resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts");
const FIXTURE_DIRECTORY = path.resolve(TEST_DIRECTORY, "fixtures/phase-3a1b-p5");
const surfaceLoad = import(pathToFileURL(PUBLIC_ENTRY).href) as Promise<ProtocolSurface>;
const VERTEX_DOMAIN = "ts-drp/vertex/v3";
const BLUEPRINT_DOMAIN = "ts-drp/blueprint-admission/v3";
const EXPECTED_RUNTIME_EXPORTS = Object.freeze([
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
] as const);
const EXPECTED_RESULT_ERROR = "signRegisteredVertexDigest must return a 64-byte Uint8Array";
const PRIVATE_KEY_SEED = fromHex(blueprintContract.privateKeySeedHex);
const PUBLIC_KEY = ed25519.getPublicKey(PRIVATE_KEY_SEED);
const AUTHOR = bytesHex(PUBLIC_KEY);

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function bytesHex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsignedBigEndian(value: number, bytes: 4 | 8): Uint8Array {
	const output = new Uint8Array(bytes);
	const view = new DataView(output.buffer);
	if (bytes === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

function independentHashDomain(domain: string, exactBytes: Uint8Array): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	return new Uint8Array(
		createHash("sha256")
			.update(
				concatenate([
					fromHex("44525000"),
					unsignedBigEndian(domainBytes.byteLength, 4),
					domainBytes,
					unsignedBigEndian(exactBytes.byteLength, 8),
					exactBytes,
				])
			)
			.digest()
	);
}

async function genuinePreparedAdmission(packageValue: unknown = blueprintContract.package): Promise<unknown> {
	const surface = await surfaceLoad;
	const canonicalBlueprintPackageBytes = encodeCanonical(packageValue);
	return surface.prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: bytesHex(independentHashDomain(BLUEPRINT_DOMAIN, canonicalBlueprintPackageBytes)),
	});
}

function localInput(requestOrdinal = 0): LocalVertexInput {
	return {
		anchor: blueprintContract.vertex.anchor,
		dependencies: [...blueprintContract.vertex.dependencies],
		epoch: blueprintContract.vertex.epoch,
		logicalTime: blueprintContract.vertex.logicalTime + requestOrdinal,
		objectId: blueprintContract.vertex.objectId,
		operation: { ...blueprintContract.validOperation },
	};
}

function cloneEnvelope(envelope: SignedVertexEnvelope): SignedVertexEnvelope {
	return {
		canonicalPreimageBytes: new Uint8Array(envelope.canonicalPreimageBytes),
		digest: new Uint8Array(envelope.digest),
		signature: new Uint8Array(envelope.signature),
	};
}

function cloneCommit(commit: IssueCommit): IssueCommit {
	const envelope = cloneEnvelope(commit.envelope);
	return {
		authorSequence: commit.authorSequence,
		envelope,
		issuedRecord: { ...commit.issuedRecord, envelope, scope: { ...commit.issuedRecord.scope } },
		outboxEntry: { ...commit.outboxEntry, envelope, scope: { ...commit.outboxEntry.scope } },
	};
}

/** Models only the injected transaction closure; it makes no durability or crash-recovery claim. */
class EphemeralIssueCoordinator {
	readonly events: string[] = [];
	private commits: IssueCommit[] = [];
	private next = blueprintContract.vertex.authorSequence;
	private rejectAfterBuild = false;

	failNextCommitAfterBuild(): void {
		this.rejectAfterBuild = true;
	}

	snapshot(): StoredState {
		return { commits: this.commits.map(cloneCommit), next: this.next };
	}

	readonly transactIssue: TransactIssue = async (_scope, buildAndSign) => {
		this.events.push("transaction.enter", "build.enter");
		const commit = await buildAndSign(this.next);
		this.events.push("build.return");
		if (this.rejectAfterBuild) {
			this.rejectAfterBuild = false;
			throw new Error("injected post-build commit failure");
		}
		this.commits.push(cloneCommit(commit));
		this.next++;
		this.events.push("store.mutate");
		return commit;
	};
}

function callbackOptions(
	preparedBlueprintAdmission: unknown,
	coordinator: EphemeralIssueCoordinator,
	signRegisteredVertexDigest: SignRegisteredVertexDigest,
	overrides: Partial<CallbackIssuerOptions> = {}
): CallbackIssuerOptions {
	return {
		author: AUTHOR,
		preparedBlueprintAdmission,
		publicKey: { bytes: new Uint8Array(PUBLIC_KEY), format: "raw" },
		signRegisteredVertexDigest,
		transactIssue: coordinator.transactIssue,
		...overrides,
	};
}

function seedOptions(preparedBlueprintAdmission: unknown, coordinator: EphemeralIssueCoordinator): SeedIssuerOptions {
	return {
		author: AUTHOR,
		preparedBlueprintAdmission,
		privateKeySeed: new Uint8Array(PRIVATE_KEY_SEED),
		publicKey: { bytes: new Uint8Array(PUBLIC_KEY), format: "raw" },
		transactIssue: coordinator.transactIssue,
	};
}

function captureSync(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new TypeError("expected synchronous rejection");
}

function diagnostics(result: ReturnType<typeof spawnSync>): string {
	return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

function runTsc(config: string): ReturnType<typeof spawnSync> {
	return spawnSync("pnpm", ["exec", "tsc", "-p", config], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
	});
}

describe("D.93.35 p5 protocol-v3 callback-arm causal RED", () => {
	it("keeps SignRegisteredVertexDigest type-only and the package runtime root at exact ten", async () => {
		const surface = await surfaceLoad;
		expect(Object.keys(surface).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS]);
		expect(surface).not.toHaveProperty("SignRegisteredVertexDigest");
		expect(surface).not.toHaveProperty("signRegisteredVertexDigest");
	});

	it("proves genuine prepared capability precedence before hostile arm inspection", async () => {
		const surface = await surfaceLoad;
		const forgedPrepared = Object.freeze({ blueprintDigest: "f".repeat(64) });
		let armAccesses = 0;
		const hostile = {
			author: AUTHOR,
			preparedBlueprintAdmission: forgedPrepared,
			publicKey: { bytes: new Uint8Array(PUBLIC_KEY), format: "raw" },
			transactIssue: new EphemeralIssueCoordinator().transactIssue,
		} as Record<string, unknown>;
		for (const name of ["privateKeySeed", "signRegisteredVertexDigest"]) {
			Object.defineProperty(hostile, name, {
				enumerable: true,
				get() {
					armAccesses++;
					throw new Error("hostile arm getter executed");
				},
			});
		}

		const error = captureSync(() =>
			surface.createAdmissionBoundTransactionalVertexIssuer(
				hostile as unknown as CallbackIssuerOptions | SeedIssuerOptions
			)
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(armAccesses).toBe(0);

		let callbackCalls = 0;
		const forgedCommon = {
			author: AUTHOR,
			preparedBlueprintAdmission: forgedPrepared,
			publicKey: { bytes: new Uint8Array(PUBLIC_KEY), format: "raw" as const },
			transactIssue: new EphemeralIssueCoordinator().transactIssue,
		};
		for (const arm of [
			{
				...forgedCommon,
				privateKeySeed: new Uint8Array(PRIVATE_KEY_SEED),
			},
			{
				...forgedCommon,
				signRegisteredVertexDigest: async (digest: Uint8Array): Promise<Uint8Array> => {
					callbackCalls++;
					return ed25519.sign(digest, PRIVATE_KEY_SEED);
				},
			},
		]) {
			expect(
				captureSync(() =>
					surface.createAdmissionBoundTransactionalVertexIssuer(
						arm as unknown as CallbackIssuerOptions | SeedIssuerOptions
					)
				)
			).toBeInstanceOf(TypeError);
		}
		expect(callbackCalls).toBe(0);
	});

	it("selects one own data arm without prototypes or accessors and rejects both or neither", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const coordinator = new EphemeralIssueCoordinator();
		const signer: SignRegisteredVertexDigest = async (digest) => ed25519.sign(digest, PRIVATE_KEY_SEED);
		const common = {
			author: AUTHOR,
			preparedBlueprintAdmission: prepared,
			publicKey: { bytes: new Uint8Array(PUBLIC_KEY), format: "raw" as const },
			transactIssue: coordinator.transactIssue,
		};

		expect(
			captureSync(() =>
				surface.createAdmissionBoundTransactionalVertexIssuer({
					...common,
					privateKeySeed: new Uint8Array(PRIVATE_KEY_SEED),
					signRegisteredVertexDigest: signer,
				} as unknown as CallbackIssuerOptions)
			)
		).toBeInstanceOf(TypeError);
		expect(
			captureSync(() =>
				surface.createAdmissionBoundTransactionalVertexIssuer(common as unknown as CallbackIssuerOptions)
			)
		).toBeInstanceOf(TypeError);

		let inheritedCalls = 0;
		const inherited = Object.assign(
			Object.create({
				signRegisteredVertexDigest: async (digest: Uint8Array) => {
					inheritedCalls++;
					return ed25519.sign(digest, PRIVATE_KEY_SEED);
				},
			}),
			common
		) as CallbackIssuerOptions;
		expect(captureSync(() => surface.createAdmissionBoundTransactionalVertexIssuer(inherited))).toBeInstanceOf(
			TypeError
		);
		expect(inheritedCalls).toBe(0);

		let getterCalls = 0;
		const callbackWithSeedAccessor = { ...common, signRegisteredVertexDigest: signer } as Record<string, unknown>;
		Object.defineProperty(callbackWithSeedAccessor, "privateKeySeed", {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error("seed getter executed");
			},
		});
		expect(() =>
			surface.createAdmissionBoundTransactionalVertexIssuer(
				callbackWithSeedAccessor as unknown as CallbackIssuerOptions
			)
		).not.toThrow();

		const seedWithCallbackAccessor = { ...common, privateKeySeed: new Uint8Array(PRIVATE_KEY_SEED) } as Record<
			string,
			unknown
		>;
		Object.defineProperty(seedWithCallbackAccessor, "signRegisteredVertexDigest", {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error("callback getter executed");
			},
		});
		expect(() =>
			surface.createAdmissionBoundTransactionalVertexIssuer(seedWithCallbackAccessor as unknown as SeedIssuerOptions)
		).not.toThrow();
		expect(getterCalls).toBe(0);

		let ownCallbackCalls = 0;
		const inheritedSeed = Object.assign(Object.create({ privateKeySeed: new Uint8Array(PRIVATE_KEY_SEED) }), {
			...common,
			signRegisteredVertexDigest: async (digest: Uint8Array): Promise<Uint8Array> => {
				ownCallbackCalls++;
				return ed25519.sign(digest, PRIVATE_KEY_SEED);
			},
		}) as CallbackIssuerOptions;
		const inheritedSeedIssuer = surface.createAdmissionBoundTransactionalVertexIssuer(inheritedSeed);
		await inheritedSeedIssuer.issue(localInput());
		expect(ownCallbackCalls).toBe(1);
	});

	it("binds callback author/public key, captures copies once, and invokes zero times at construction", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const coordinator = new EphemeralIssueCoordinator();
		let originalCalls = 0;
		let replacementCalls = 0;
		const original: SignRegisteredVertexDigest = async (digest) => {
			originalCalls++;
			return ed25519.sign(digest, PRIVATE_KEY_SEED);
		};
		const options = callbackOptions(prepared, coordinator, original) as CallbackIssuerOptions & {
			signRegisteredVertexDigest: SignRegisteredVertexDigest;
		};
		const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(options);
		expect(originalCalls).toBe(0);

		options.signRegisteredVertexDigest = async (): Promise<Uint8Array> => {
			replacementCalls++;
			throw new Error("replacement callback must stay detached");
		};
		options.publicKey.bytes.fill(0x5a);
		await expect(issuer.issue(localInput())).resolves.toMatchObject({
			authorSequence: blueprintContract.vertex.authorSequence,
		});
		expect(originalCalls).toBe(1);
		expect(replacementCalls).toBe(0);

		const mismatched = callbackOptions(prepared, new EphemeralIssueCoordinator(), original, {
			author: "0".repeat(64),
		});
		expect(() => surface.createAdmissionBoundTransactionalVertexIssuer(mismatched)).toThrow(TypeError);
		expect(() =>
			surface.createAdmissionBoundTransactionalVertexIssuer(
				callbackOptions(prepared, new EphemeralIssueCoordinator(), original, { author: AUTHOR.toUpperCase() })
			)
		).toThrow(TypeError);
	});

	it("keeps an invalid ABI operation before transaction entry or signing", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const coordinator = new EphemeralIssueCoordinator();
		let signerCalls = 0;
		const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, coordinator, async (digest) => {
				signerCalls++;
				return ed25519.sign(digest, PRIVATE_KEY_SEED);
			})
		);
		await expect(issuer.issue({ ...localInput(), operation: { action: "not_registered" } })).rejects.toBeInstanceOf(
			VertexValidationError
		);
		expect(signerCalls).toBe(0);
		expect(coordinator.events).toEqual([]);
		expect(coordinator.snapshot().commits).toEqual([]);
	});

	it("accepts exact 100 and rejects exact 101 under a genuine schema-v2 work-budget capability", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission(budgetContract.budgetedPackage);
		const [exact100, exact101] = budgetVectors.budgeted;
		expect(exact100).toBeDefined();
		expect(exact101).toBeDefined();
		const exact100Bytes = fromHex(exact100?.canonicalHex ?? "");
		const exact101Bytes = fromHex(exact101?.canonicalHex ?? "");
		expect(exact100Bytes).toHaveLength(100);
		expect(exact101Bytes).toHaveLength(101);
		expect(decodeCanonical(exact100Bytes)).toEqual(exact100?.operation);
		expect(decodeCanonical(exact101Bytes)).toEqual(exact101?.operation);

		const acceptedCoordinator = new EphemeralIssueCoordinator();
		let acceptedSignerCalls = 0;
		const acceptedIssuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, acceptedCoordinator, async (digest) => {
				acceptedSignerCalls++;
				return ed25519.sign(digest, PRIVATE_KEY_SEED);
			})
		);
		await expect(
			acceptedIssuer.issue({ ...localInput(), operation: exact100?.operation ?? {} })
		).resolves.toMatchObject({ authorSequence: blueprintContract.vertex.authorSequence });
		expect(acceptedSignerCalls).toBe(1);
		expect(acceptedCoordinator.events).toContain("transaction.enter");
		expect(acceptedCoordinator.snapshot().commits).toHaveLength(1);

		const rejectedCoordinator = new EphemeralIssueCoordinator();
		let rejectedSignerCalls = 0;
		const rejectedIssuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, rejectedCoordinator, async (digest) => {
				rejectedSignerCalls++;
				return ed25519.sign(digest, PRIVATE_KEY_SEED);
			})
		);
		await expect(
			rejectedIssuer.issue({ ...localInput(), operation: exact101?.operation ?? {} })
		).rejects.toBeInstanceOf(RangeError);
		expect(rejectedSignerCalls).toBe(0);
		expect(rejectedCoordinator.events).toEqual([]);
		expect(rejectedCoordinator.snapshot().commits).toEqual([]);
	});

	it("keeps a schema-valid Phase 0i operation above 100 bytes unbudgeted", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const unbudgetedOperation = {
			action: budgetVectors.unbudgeted.operation.action,
			key: budgetVectors.unbudgeted.operation.key,
			value: "x".repeat(budgetVectors.unbudgeted.operation.valueLength),
		};
		const exactBytes = fromHex(budgetVectors.unbudgeted.canonicalHex);
		expect(exactBytes.byteLength).toBeGreaterThan(100);
		expect(decodeCanonical(exactBytes)).toEqual(unbudgetedOperation);

		const coordinator = new EphemeralIssueCoordinator();
		let signerCalls = 0;
		const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, coordinator, async (digest) => {
				signerCalls++;
				return ed25519.sign(digest, PRIVATE_KEY_SEED);
			})
		);
		await expect(issuer.issue({ ...localInput(), operation: unbudgetedOperation })).resolves.toMatchObject({
			authorSequence: blueprintContract.vertex.authorSequence,
		});
		expect(signerCalls).toBe(1);
		expect(coordinator.events).toContain("transaction.enter");
		expect(coordinator.snapshot().commits).toHaveLength(1);
	});

	it("calls once inside transaction after digest, retains a distinct digest, and copies returned signature", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const coordinator = new EphemeralIssueCoordinator();
		let callbackArgument: Uint8Array | undefined;
		let digestBeforeMutation: Uint8Array | undefined;
		let returnedSignature: Uint8Array | undefined;
		let calls = 0;
		const signer: SignRegisteredVertexDigest = async (registeredDigest) => {
			coordinator.events.push("callback.invoke");
			calls++;
			callbackArgument = registeredDigest;
			digestBeforeMutation = new Uint8Array(registeredDigest);
			registeredDigest.fill(0xa5);
			await Promise.resolve();
			returnedSignature = ed25519.sign(digestBeforeMutation, PRIVATE_KEY_SEED);
			return returnedSignature;
		};
		const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, coordinator, signer)
		);
		const commit = await issuer.issue(localInput());
		const exactDigest = independentHashDomain(VERTEX_DOMAIN, commit.envelope.canonicalPreimageBytes);

		expect(calls).toBe(1);
		expect(coordinator.events).toEqual([
			"transaction.enter",
			"build.enter",
			"callback.invoke",
			"build.return",
			"store.mutate",
		]);
		expect(digestBeforeMutation).toEqual(exactDigest);
		expect(commit.envelope.digest).toEqual(exactDigest);
		expect(callbackArgument).not.toBe(commit.envelope.digest);
		expect(callbackArgument).toEqual(new Uint8Array(32).fill(0xa5));
		expect(ed25519.verify(commit.envelope.signature, exactDigest, PUBLIC_KEY, { zip215: false })).toBe(true);

		const committedSignature = new Uint8Array(commit.envelope.signature);
		returnedSignature?.fill(0x3c);
		callbackArgument?.fill(0x7d);
		expect(commit.envelope.signature).toEqual(committedSignature);
		expect(coordinator.snapshot().commits[0]?.envelope.signature).toEqual(committedSignature);
	});

	it("maps every hostile callback result shape to one TypeError before commit mutation", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		class SignatureSubclass extends Uint8Array {}
		const partial = new Uint8Array(new ArrayBuffer(65), 1, 64);
		const detached = new Uint8Array(64);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		const hostileResults: [string, () => unknown][] = [
			["wrong type", (): unknown => "signature"],
			["wrong length", (): Uint8Array => new Uint8Array(63)],
			["subclass", (): Uint8Array => new SignatureSubclass(64)],
			["partial view", (): Uint8Array => partial],
			["detached", (): Uint8Array => detached],
			[
				"proxy",
				(): Uint8Array =>
					new Proxy(new Uint8Array(64), {
						getPrototypeOf(): never {
							throw new Error("hostile reflection");
						},
					}),
			],
		];
		if (typeof SharedArrayBuffer !== "undefined") {
			hostileResults.push(["shared backing", (): Uint8Array => new Uint8Array(new SharedArrayBuffer(64))]);
		}

		for (const [label, result] of hostileResults) {
			const coordinator = new EphemeralIssueCoordinator();
			let calls = 0;
			const signer = (async () => {
				calls++;
				return result();
			}) as SignRegisteredVertexDigest;
			const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
				callbackOptions(prepared, coordinator, signer)
			);
			let error: unknown;
			try {
				await issuer.issue(localInput());
			} catch (caught) {
				error = caught;
			}
			expect(error, label).toEqual(new TypeError(EXPECTED_RESULT_ERROR));
			expect(calls, label).toBe(1);
			expect(coordinator.snapshot().commits, label).toEqual([]);
		}
	});

	it("strictly rejects a ZIP-215-only signature before IssueCommit or store mutation", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const coordinator = new EphemeralIssueCoordinator();
		const smallOrderPublicKey = Uint8Array.of(1, ...new Uint8Array(31));
		const smallOrderSignature = Uint8Array.of(1, ...new Uint8Array(63));
		let callbackDigest: Uint8Array | undefined;
		const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(
				prepared,
				coordinator,
				async (digest) => {
					callbackDigest = new Uint8Array(digest);
					return new Uint8Array(smallOrderSignature);
				},
				{
					author: bytesHex(smallOrderPublicKey),
					publicKey: { bytes: smallOrderPublicKey, format: "raw" },
				}
			)
		);
		let error: unknown;
		try {
			await issuer.issue(localInput());
		} catch (caught) {
			error = caught;
		}
		expect(callbackDigest).toBeDefined();
		expect(
			ed25519.verify(smallOrderSignature, callbackDigest as Uint8Array, smallOrderPublicKey, { zip215: true })
		).toBe(true);
		expect(
			ed25519.verify(smallOrderSignature, callbackDigest as Uint8Array, smallOrderPublicKey, { zip215: false })
		).toBe(false);
		expect(error).toBeInstanceOf(VertexValidationError);
		expect(coordinator.events).not.toContain("build.return");
		expect(coordinator.events).not.toContain("store.mutate");
		expect(coordinator.snapshot().commits).toEqual([]);
	});

	it("propagates callback throw and rejection without retry or seed fallback and leaves no commit", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		for (const mode of ["throw", "reject"] as const) {
			const coordinator = new EphemeralIssueCoordinator();
			const sentinel = Object.freeze({ mode, reason: "custody unavailable" });
			let calls = 0;
			const signer = (() => {
				calls++;
				if (mode === "throw") throw sentinel;
				return Promise.reject(sentinel);
			}) as SignRegisteredVertexDigest;
			const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
				callbackOptions(prepared, coordinator, signer)
			);
			let error: unknown;
			try {
				await issuer.issue(localInput());
			} catch (caught) {
				error = caught;
			}
			expect(error, mode).toBe(sentinel);
			expect(calls, mode).toBe(1);
			expect(coordinator.snapshot().commits, mode).toEqual([]);
			expect(coordinator.events, mode).not.toContain("build.return");
		}
	});

	it("recomputes and re-signs a genuine retry after transaction-owned post-build failure", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const coordinator = new EphemeralIssueCoordinator();
		coordinator.failNextCommitAfterBuild();
		const callbackArguments: Uint8Array[] = [];
		const callbackResults: Uint8Array[] = [];
		const issuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, coordinator, async (digest) => {
				callbackArguments.push(digest);
				const signature = new Uint8Array(ed25519.sign(new Uint8Array(digest), PRIVATE_KEY_SEED));
				callbackResults.push(signature);
				return signature;
			})
		);

		await expect(issuer.issue(localInput())).rejects.toThrow("injected post-build commit failure");
		expect(coordinator.snapshot()).toEqual({ commits: [], next: blueprintContract.vertex.authorSequence });
		const committed = await issuer.issue(localInput());

		expect(callbackArguments).toHaveLength(2);
		expect(callbackResults).toHaveLength(2);
		expect(callbackArguments[0]).not.toBe(callbackArguments[1]);
		expect(callbackResults[0]).not.toBe(callbackResults[1]);
		expect(callbackArguments[0]).toEqual(callbackArguments[1]);
		expect(committed.authorSequence).toBe(blueprintContract.vertex.authorSequence);
		expect(coordinator.snapshot().commits).toHaveLength(1);
	});

	it("preserves raw-seed issuance bytes while the callback arm produces the same registered commit", async () => {
		const surface = await surfaceLoad;
		const prepared = await genuinePreparedAdmission();
		const seedCoordinator = new EphemeralIssueCoordinator();
		const callbackCoordinator = new EphemeralIssueCoordinator();
		const seedIssuer = surface.createAdmissionBoundTransactionalVertexIssuer(seedOptions(prepared, seedCoordinator));
		const callbackIssuer = surface.createAdmissionBoundTransactionalVertexIssuer(
			callbackOptions(prepared, callbackCoordinator, async (digest) => ed25519.sign(digest, PRIVATE_KEY_SEED))
		);
		const [seedCommit, callbackCommit] = await Promise.all([
			seedIssuer.issue(localInput()),
			callbackIssuer.issue(localInput()),
		]);

		expect(callbackCommit.envelope.canonicalPreimageBytes).toEqual(seedCommit.envelope.canonicalPreimageBytes);
		expect(callbackCommit.envelope.digest).toEqual(seedCommit.envelope.digest);
		expect(callbackCommit.envelope.signature).toEqual(seedCommit.envelope.signature);
		expect(decodeCanonical(seedCommit.envelope.canonicalPreimageBytes)).toMatchObject({ author: AUTHOR });
	});

	it("compiles exact source/built unions and consumes the emitted type-only signer from a real pack", () => {
		const sourceAudit = runTsc(path.resolve(FIXTURE_DIRECTORY, "protocol-tsconfig-source.json"));
		expect(sourceAudit.status, diagnostics(sourceAudit)).toBe(0);

		const build = spawnSync("pnpm", ["--filter", "@ts-drp/protocol-v3", "build"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(build.status, diagnostics(build)).toBe(0);
		const builtAudit = runTsc(path.resolve(FIXTURE_DIRECTORY, "protocol-tsconfig-built.json"));
		expect(builtAudit.status, diagnostics(builtAudit)).toBe(0);

		const temporary = mkdtempSync(path.join(tmpdir(), "ts-drp-p5-protocol-pack-"));
		try {
			const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
				cwd: path.resolve(REPOSITORY_ROOT, "packages/protocol-v3"),
				encoding: "utf8",
			});
			expect(packed.status, diagnostics(packed)).toBe(0);
			const result = JSON.parse(String(packed.stdout)) as readonly [
				{ readonly filename: string; readonly files: readonly { readonly path: string }[] },
			];
			expect(result[0].files.map(({ path: file }) => file)).toEqual(
				expect.arrayContaining(["dist/src/public.d.ts", "dist/src/public.js"])
			);

			const consumer = path.join(temporary, "consumer");
			const scope = path.join(consumer, "node_modules/@ts-drp");
			mkdirSync(scope, { recursive: true });
			const archive = path.join(temporary, result[0].filename);
			const extraction = spawnSync("tar", ["-xzf", archive, "-C", scope], { encoding: "utf8" });
			expect(extraction.status, diagnostics(extraction)).toBe(0);
			renameSync(path.join(scope, "package"), path.join(scope, "protocol-v3"));
			for (const dependency of ["canonical"]) {
				symlinkSync(path.join(REPOSITORY_ROOT, "packages", dependency), path.join(scope, dependency), "dir");
			}
			mkdirSync(path.join(consumer, "node_modules/@noble"), { recursive: true });
			symlinkSync(
				realpathSync(path.join(REPOSITORY_ROOT, "packages/protocol-v3/node_modules/@noble/curves")),
				path.join(consumer, "node_modules/@noble/curves"),
				"dir"
			);
			symlinkSync(
				realpathSync(path.join(REPOSITORY_ROOT, "packages/protocol-v3/node_modules/es-module-lexer")),
				path.join(consumer, "node_modules/es-module-lexer"),
				"dir"
			);
			cpSync(path.resolve(FIXTURE_DIRECTORY, "protocol-package-type-audit.ts"), path.join(consumer, "consumer.ts"));
			writeFileSync(
				path.join(consumer, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						exactOptionalPropertyTypes: true,
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						strict: true,
					},
					files: ["consumer.ts"],
				})
			);
			const packedTypes = runTsc(path.join(consumer, "tsconfig.json"));
			expect(packedTypes.status, diagnostics(packedTypes)).toBe(0);

			writeFileSync(
				path.join(consumer, "consumer.mjs"),
				'import * as protocol from "@ts-drp/protocol-v3";\nprocess.stdout.write(JSON.stringify(Object.keys(protocol).sort()));\n'
			);
			const packedRuntime = spawnSync(process.execPath, ["consumer.mjs"], { cwd: consumer, encoding: "utf8" });
			expect(packedRuntime.status, diagnostics(packedRuntime)).toBe(0);
			expect(JSON.parse(String(packedRuntime.stdout))).toEqual([...EXPECTED_RUNTIME_EXPORTS]);
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { force: true, recursive: true });
		}
	});
});
