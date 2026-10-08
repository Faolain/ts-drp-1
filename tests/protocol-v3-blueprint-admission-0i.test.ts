import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import contract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import protocolV3Package from "../packages/protocol-v3/package.json" with { type: "json" };

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

interface TransactionalVertexIssuer {
	issue(input: LocalVertexInput): Promise<IssueCommit>;
}

interface BlueprintPreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
}

interface TransactionalIssuerOptions {
	readonly author: string;
	readonly preparedBlueprintAdmission?: unknown;
	readonly privateKeySeed: Uint8Array;
	readonly publicKey: {
		readonly bytes: Uint8Array;
		readonly format: "raw";
	};
	readonly transactIssue: TransactIssue;
	isOperationAllowed?(operation: Readonly<Record<string, unknown>>): boolean;
	validateOperation?(operation: Readonly<Record<string, unknown>>): boolean;
}

interface AdmitReceivedVertexInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly preparedBlueprintAdmission?: unknown;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): { readonly bytes: Uint8Array; readonly format: "raw" } | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
	isOperationAllowed?(operation: Readonly<Record<string, unknown>>): boolean;
	readonly operation?: Readonly<Record<string, unknown>>;
	validateOperation?(operation: Readonly<Record<string, unknown>>): boolean;
}

interface ProtocolV3Surface {
	admitReceivedVertex?(input: AdmitReceivedVertexInput): {
		readonly admitted: boolean;
		readonly digest?: Uint8Array;
	};
	createAdmissionBoundTransactionalVertexIssuer?(options: TransactionalIssuerOptions): TransactionalVertexIssuer;
	prepareBlueprintAdmission?(input: BlueprintPreparationInput): unknown;
}

interface KeyMaterial {
	readonly privateKey: ReturnType<typeof createPrivateKey>;
	readonly publicKey: Uint8Array;
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

interface AdmissionDecision {
	readonly admitted: boolean;
	readonly digest?: Uint8Array;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const PROTOCOL_V3_DIRECTORY = resolve(REPOSITORY_ROOT, "packages/protocol-v3");
const packageRootImport = protocolV3Package.exports["."].import;
const packageRootTypes = protocolV3Package.exports["."].types;
const packageRootSourcePath = resolve(
	PROTOCOL_V3_DIRECTORY,
	packageRootImport.replace(/^\.\/dist\//u, "").replace(/\.js$/u, ".js")
);
const surfaceLoad = import(pathToFileURL(packageRootSourcePath).href).then(
	(loaded: unknown) => loaded as ProtocolV3Surface
);
const VERTEX_DOMAIN = "ts-drp/vertex/v3";
const VERTEX_SUITE = "ed25519-sha256-v3";
const EXPECTED_MANIFEST_HEX =
	"0803050a6f7065726174696f6e730703080205046e616d650506617070656e64050e617267756d656e74536368656d61080205046b696e64050d636c6f7365642d7265636f726405066669656c64730703080305046e616d6505066e6573746564050474797065051063616e6f6e6963616c2d6f626a6563740508726571756972656401080305046e616d65050e726571756573744f7264696e616c050474797065050c736166652d696e74656765720508726571756972656401080305046e616d65050576616c75650504747970650506737472696e670508726571756972656401080205046e616d650503736574050e617267756d656e74536368656d61080205046b696e64050d636c6f7365642d7265636f726405066669656c64730702080305046e616d6505036b65790504747970650506737472696e670508726571756972656402080305046e616d65050576616c75650504747970650506737472696e670508726571756972656402080205046e616d65050b7365745f6d657373616765050e617267756d656e74536368656d61080205046b696e64050d636c6f7365642d7265636f726405066669656c64730702080305046e616d6505036b65790504747970650506737472696e670508726571756972656402080305046e616d65050576616c75650504747970650506737472696e670508726571756972656402050d736368656d6156657273696f6e030205166f7065726174696f6e4469736372696d696e61746f720506616374696f6e";
const EXPECTED_PACKAGE_HEX =
	"080505046b696e64051f6472702d626c75657072696e742d61646d697373696f6e2d7061636b61676505086d616e69666573740803050a6f7065726174696f6e730703080205046e616d650506617070656e64050e617267756d656e74536368656d61080205046b696e64050d636c6f7365642d7265636f726405066669656c64730703080305046e616d6505066e6573746564050474797065051063616e6f6e6963616c2d6f626a6563740508726571756972656401080305046e616d65050e726571756573744f7264696e616c050474797065050c736166652d696e74656765720508726571756972656401080305046e616d65050576616c75650504747970650506737472696e670508726571756972656401080205046e616d650503736574050e617267756d656e74536368656d61080205046b696e64050d636c6f7365642d7265636f726405066669656c64730702080305046e616d6505036b65790504747970650506737472696e670508726571756972656402080305046e616d65050576616c75650504747970650506737472696e670508726571756972656402080205046e616d65050b7365745f6d657373616765050e617267756d656e74536368656d61080205046b696e64050d636c6f7365642d7265636f726405066669656c64730702080305046e616d6505036b65790504747970650506737472696e670508726571756972656402080305046e616d65050576616c75650504747970650506737472696e670508726571756972656402050d736368656d6156657273696f6e030205166f7065726174696f6e4469736372696d696e61746f720506616374696f6e050d70726f746f636f6c4d616a6f720306050d736368656d6156657273696f6e0302050e696d706c656d656e746174696f6e0803050a61727469666163744964051d406578616d706c652f636861742d626c75657072696e7440312e302e30050e6172746966616374446967657374054061306130613061306130613061306130613061306130613061306130613061306130613061306130613061306130613061306130613061306130613061306130050e72756e74696d6550726f66696c65051765636d617363726970742d323032342d73796e632d7631";
const EXPECTED_BLUEPRINT_DIGEST = "cabbcc65454211b2e258328632aba8b184c8abdb6fb9082b498714fad503b838";
const PKCS8_ED25519_SEED_PREFIX = fromHex("302e020100300506032b657004220420");
const SPKI_ED25519_PUBLIC_KEY_PREFIX_BYTES = 12;

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
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

function independentHashDomain(domain: string, bytes: Uint8Array): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	return new Uint8Array(
		createHash("sha256")
			.update(
				concatBytes([
					fromHex("44525000"),
					unsignedBigEndian(domainBytes.byteLength, 4),
					domainBytes,
					unsignedBigEndian(bytes.byteLength, 8),
					bytes,
				])
			)
			.digest()
	);
}

function keyMaterial(): KeyMaterial {
	const seed = fromHex(contract.privateKeySeedHex);
	const privateKey = createPrivateKey({
		key: concatBytes([PKCS8_ED25519_SEED_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const spki = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
	return {
		privateKey,
		publicKey: spki.slice(SPKI_ED25519_PUBLIC_KEY_PREFIX_BYTES),
	};
}

function vertexPreimage(
	operation: Readonly<Record<string, unknown>>,
	authorSequence = contract.vertex.authorSequence
): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: contract.vertex.objectId,
		epoch: contract.vertex.epoch,
		anchor: contract.vertex.anchor,
		author: contract.vertex.author,
		authorSequence,
		logicalTime: contract.vertex.logicalTime,
		dependencies: contract.vertex.dependencies,
		operation,
	};
}

function signedRemote(operation: Readonly<Record<string, unknown>>): RemoteCase {
	const bytes = encodeCanonical(vertexPreimage(operation));
	const digest = independentHashDomain(VERTEX_DOMAIN, bytes);
	return {
		bytes,
		digest,
		signature: new Uint8Array(nodeSign(null, digest, keyMaterial().privateKey)),
	};
}

function remoteInput(
	remote: RemoteCase,
	preparedBlueprintAdmission: unknown,
	overrides: Partial<AdmitReceivedVertexInput> = {}
): AdmitReceivedVertexInput {
	const { publicKey } = keyMaterial();
	return {
		domain: VERTEX_DOMAIN,
		expectedAnchor: contract.vertex.anchor,
		preparedBlueprintAdmission,
		receivedCanonicalPreimageBytes: remote.bytes,
		resolveAuthorPublicKey: (author) =>
			author === contract.vertex.author ? { bytes: publicKey, format: "raw" } : undefined,
		signature: remote.signature,
		suiteId: VERTEX_SUITE,
		...overrides,
	};
}

function localInput(operation: Readonly<Record<string, unknown>>): LocalVertexInput {
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

function sourceFiles(directory: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && ["coverage", "dist", "node_modules"].includes(entry.name)) continue;
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.isFile() && /\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) files.push(path);
	}
	return files;
}

async function requireSurfaceFunction<Key extends keyof ProtocolV3Surface>(
	name: Key
): Promise<NonNullable<ProtocolV3Surface[Key]>> {
	const surface = await surfaceLoad;
	const candidate = surface[name];
	if (typeof candidate !== "function") throw new Error(`PHASE_0I_V3_MISSING_EXPORT:${String(name)}`);
	return candidate as NonNullable<ProtocolV3Surface[Key]>;
}

function primaryPackageBytes(): Uint8Array {
	return encodeCanonical(contract.package);
}

function prepareInput(
	canonicalBlueprintPackageBytes = primaryPackageBytes(),
	expectedBlueprintDigest = EXPECTED_BLUEPRINT_DIGEST
): BlueprintPreparationInput {
	return { canonicalBlueprintPackageBytes, expectedBlueprintDigest };
}

async function preparedOrLegacyPlaceholder(): Promise<unknown> {
	const surface = await surfaceLoad;
	return typeof surface.prepareBlueprintAdmission === "function"
		? surface.prepareBlueprintAdmission(prepareInput())
		: { __brand: "PreparedBlueprintAdmission" };
}

function clonePackage(): Record<string, unknown> {
	return structuredClone(contract.package) as Record<string, unknown>;
}

function legacyDeclaredPackage(): Record<string, unknown> {
	const packageValue = clonePackage();
	const manifest = packageValue.manifest as {
		operations: {
			name: string;
			argumentSchema: {
				kind: string;
				fields: { name: string; required: boolean; type: string }[];
			};
		}[];
	};
	for (const name of contract.legacyLookingValues) {
		manifest.operations.push({
			name,
			argumentSchema: {
				kind: "closed-record",
				fields: [{ name: "payload", required: true, type: "string" }],
			},
		});
	}
	manifest.operations.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
	return packageValue;
}

function expectedDigestFor(packageValue: Readonly<Record<string, unknown>>): {
	bytes: Uint8Array;
	digestHex: string;
} {
	const bytes = encodeCanonical(packageValue);
	return {
		bytes,
		digestHex: toHex(independentHashDomain(contract.blueprintDigestDomain, bytes)),
	};
}

function forgePrepared(value: unknown): object {
	if (value === null || typeof value !== "object") return { __brand: "PreparedBlueprintAdmission" };
	const forged = Object.create(Object.getPrototypeOf(value)) as object;
	Object.defineProperties(forged, Object.getOwnPropertyDescriptors(value));
	return forged;
}

async function createIssuerAttempt(
	createAdmissionBoundTransactionalVertexIssuer: NonNullable<
		ProtocolV3Surface["createAdmissionBoundTransactionalVertexIssuer"]
	>,
	options: TransactionalIssuerOptions,
	input: LocalVertexInput
): Promise<{ error?: unknown; value?: IssueCommit }> {
	try {
		const issuer = createAdmissionBoundTransactionalVertexIssuer(options);
		return { value: await issuer.issue(input) };
	} catch (error) {
		return { error };
	}
}

describe("Phase 0i-v3 digest-bound blueprint ABI RED", () => {
	it("pins input-only manifest/package bytes and an independently framed single blueprint digest", () => {
		expect(Object.keys(contract)).toEqual([
			"blueprintDigestDomain",
			"privateKeySeedHex",
			"vertex",
			"package",
			"validOperation",
			"legacyLookingValues",
		]);
		expect(contract).not.toHaveProperty("expected");
		expect(contract).not.toHaveProperty("canonicalHex");
		expect(contract).not.toHaveProperty("digestHex");
		expect(contract.blueprintDigestDomain).toBe("ts-drp/blueprint-admission/v3");

		const manifestBytes = encodeCanonical(contract.package.manifest);
		const packageBytes = primaryPackageBytes();
		const packageDigest = independentHashDomain(contract.blueprintDigestDomain, packageBytes);

		expect(toHex(manifestBytes)).toBe(EXPECTED_MANIFEST_HEX);
		expect(toHex(packageBytes)).toBe(EXPECTED_PACKAGE_HEX);
		expect(toHex(packageDigest)).toBe(EXPECTED_BLUEPRINT_DIGEST);
		expect(decodeCanonical(packageBytes)).toEqual(contract.package);
		expect(keyMaterial().publicKey).toHaveLength(32);
		expect(signedRemote(contract.validOperation).signature).toHaveLength(64);
	});

	it("uses a distinct package-root application entry with no primitive values or repository imports", async () => {
		expect(packageRootImport).not.toBe("./dist/src/index.js");
		expect(packageRootTypes).not.toBe("./dist/src/index.d.ts");
		expect(packageRootImport.replace(/\.js$/u, "")).toBe(packageRootTypes.replace(/\.d\.ts$/u, ""));

		const surface = (await surfaceLoad) as ProtocolV3Surface & Record<string, unknown>;
		expect(surface.admitReceivedVertex).toBeTypeOf("function");
		expect(surface.createAdmissionBoundTransactionalVertexIssuer).toBeTypeOf("function");
		expect(surface.prepareBlueprintAdmission).toBeTypeOf("function");
		expect(surface).not.toHaveProperty("verifyReceivedVertex");
		expect(surface).not.toHaveProperty("createTransactionalVertexIssuer");

		const publicSource = readFileSync(packageRootSourcePath.replace(/\.js$/u, ".ts"), "utf8");
		expect(publicSource).not.toMatch(
			/export\s+(?:interface|type)\s+(?:VerifyReceivedVertexInput|TransactionalIssuerOptions)\b/u
		);
		expect(publicSource).not.toMatch(
			/export\s+(?:type\s+)?\{[^}]*\b(?:VerifyReceivedVertexInput|TransactionalIssuerOptions)\b/u
		);
		expect(publicSource).not.toMatch(/export\s+\*\s+from/u);

		const staticImport = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gu;
		const dynamicDeepImport = /import\(\s*["'][^"']*protocol-v3\/src\/index(?:\.js)?["']\s*\)/u;
		const primitiveName = /\b(?:verifyReceivedVertex|createTransactionalVertexIssuer)\b/u;
		const sourceRoots = ["packages", "examples", "site"].map((root) => resolve(REPOSITORY_ROOT, root));
		const violations = sourceRoots
			.flatMap((root) => sourceFiles(root))
			.filter((path) => path !== resolve(PROTOCOL_V3_DIRECTORY, "src/index.ts"))
			.filter((path) => {
				const source = readFileSync(path, "utf8");
				if (dynamicDeepImport.test(source)) return true;
				for (const match of source.matchAll(staticImport)) {
					const clause = match[1] ?? "";
					const specifier = match[2] ?? "";
					if (/protocol-v3\/src\/index(?:\.js)?$/u.test(specifier)) return true;
					if (specifier === "@ts-drp/protocol-v3" && (primitiveName.test(clause) || /\*\s+as\b/u.test(clause))) {
						return true;
					}
				}
				return false;
			})
			.map((path) => path.slice(REPOSITORY_ROOT.length + 1));
		expect(violations).toEqual([]);
	});

	it("behaviorally rejects an authenticated undeclared remote operation after author authentication", async () => {
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const operation = { action: "undeclared_remote", key: "message", value: "must reject" };
		const remote = signedRemote(operation);
		const preparedBlueprintAdmission = await preparedOrLegacyPlaceholder();
		const resolveAuthorPublicKey = vi.fn(remoteInput(remote, undefined).resolveAuthorPublicKey);
		instrumentation.encodeCalls = 0;
		instrumentation.verifyCalls = 0;

		const result = admitReceivedVertex({
			...remoteInput(remote, preparedBlueprintAdmission),
			operation: contract.validOperation,
			resolveAuthorPublicKey,
			validateOperation: () => true,
		});

		expect(instrumentation.verifyCalls).toBe(1);
		expect(resolveAuthorPublicKey).toHaveBeenCalledOnce();
		expect(resolveAuthorPublicKey).toHaveBeenCalledWith(contract.vertex.author);
		expect(instrumentation.encodeCalls).toBe(0);
		expect(result).toEqual({ admitted: false });
	});

	it("rejects invalid authentication with a genuine capability before digest admission", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const prepared = prepareBlueprintAdmission(prepareInput());
		const remote = signedRemote(contract.validOperation);
		const invalidSignature = new Uint8Array(remote.signature);
		invalidSignature[0] ^= 0x01;
		const resolveAuthorPublicKey = vi.fn(remoteInput(remote, undefined).resolveAuthorPublicKey);
		instrumentation.verifyCalls = 0;

		const decision = admitReceivedVertex(
			remoteInput(remote, prepared, {
				resolveAuthorPublicKey,
				signature: invalidSignature,
			})
		);

		expect(resolveAuthorPublicKey).toHaveBeenCalledOnce();
		expect(resolveAuthorPublicKey).toHaveBeenCalledWith(contract.vertex.author);
		expect(instrumentation.verifyCalls).toBe(1);
		expect(decision).toEqual({ admitted: false });
		expect(decision).not.toHaveProperty("digest");
	});

	it("behaviorally rejects an invalid local operation before transaction, signing, record, or outbox work", async () => {
		const createAdmissionBoundTransactionalVertexIssuer = await requireSurfaceFunction(
			"createAdmissionBoundTransactionalVertexIssuer"
		);
		const harness = transactionHarness();
		const { publicKey } = keyMaterial();
		const preparedBlueprintAdmission = await preparedOrLegacyPlaceholder();
		instrumentation.signCalls = 0;

		const outcome = await createIssuerAttempt(
			createAdmissionBoundTransactionalVertexIssuer,
			{
				author: contract.vertex.author,
				preparedBlueprintAdmission,
				privateKeySeed: fromHex(contract.privateKeySeedHex),
				publicKey: { bytes: publicKey, format: "raw" },
				transactIssue: harness.transactIssue,
				validateOperation: () => true,
			},
			localInput({ action: "undeclared_local", key: "message", value: "must reject" })
		);

		expect(harness.transactions).toBe(0);
		expect(harness.buildAndSignCalls).toBe(0);
		expect(instrumentation.signCalls).toBe(0);
		expect(harness.issuedRecordWrites).toBe(0);
		expect(harness.outboxWrites).toBe(0);
		expect(outcome.error).toBeDefined();
		expect(outcome.value).toBeUndefined();
	});

	it("prepares only a closed canonical package whose domain digest equals expectedBlueprintDigest", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const prepared = prepareBlueprintAdmission(prepareInput());
		expect(prepared).toBeTypeOf("object");

		const malformed = Uint8Array.of(0xff);
		const noncanonical = concatBytes([primaryPackageBytes(), Uint8Array.of(0)]);
		const digestMismatch = `${EXPECTED_BLUEPRINT_DIGEST.slice(0, -1)}e`;
		expect(() => prepareBlueprintAdmission(prepareInput(malformed))).toThrow();
		expect(() => prepareBlueprintAdmission(prepareInput(noncanonical))).toThrow();
		expect(() => prepareBlueprintAdmission(prepareInput(primaryPackageBytes(), digestMismatch))).toThrow();
		expect(() => prepareBlueprintAdmission(prepareInput(primaryPackageBytes(), "0".repeat(63)))).toThrow();
		expect(() =>
			prepareBlueprintAdmission({
				canonicalBlueprintPackageBytes: primaryPackageBytes(),
			} as BlueprintPreparationInput)
		).toThrow();

		const changedManifest = clonePackage();
		const changedOperations = (changedManifest.manifest as { operations: { name: string }[] }).operations;
		const changedOperation = changedOperations[0];
		if (changedOperation === undefined) throw new Error("fixture operation missing");
		changedOperation.name = "digest_binding_mutant";
		expect(() =>
			prepareBlueprintAdmission(prepareInput(encodeCanonical(changedManifest), EXPECTED_BLUEPRINT_DIGEST))
		).toThrow();

		const missingManifest = clonePackage();
		delete missingManifest.manifest;
		const missingManifestInput = expectedDigestFor(missingManifest);
		expect(() =>
			prepareBlueprintAdmission(prepareInput(missingManifestInput.bytes, missingManifestInput.digestHex))
		).toThrow();

		const unknownPackageField = { ...clonePackage(), unexpected: "fail closed" };
		const unknownPackageInput = expectedDigestFor(unknownPackageField);
		expect(() =>
			prepareBlueprintAdmission(prepareInput(unknownPackageInput.bytes, unknownPackageInput.digestHex))
		).toThrow();

		expect(() =>
			prepareBlueprintAdmission({
				...prepareInput(),
				validateOperation: () => true,
			} as BlueprintPreparationInput)
		).toThrow();
	});

	it("kills manifest, discriminator, argument-schema, and permissive-default mutations", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");

		const cases: readonly ((packageValue: Record<string, unknown>) => void)[] = [
			(packageValue: Record<string, unknown>): void => {
				const manifest = packageValue.manifest as Record<string, unknown>;
				manifest.unexpected = true;
			},
			(packageValue: Record<string, unknown>): void => {
				delete packageValue.implementation;
			},
			(packageValue: Record<string, unknown>): void => {
				const manifest = packageValue.manifest as { operationDiscriminator?: unknown };
				delete manifest.operationDiscriminator;
			},
			(packageValue: Record<string, unknown>): void => {
				const manifest = packageValue.manifest as { operations: unknown[] };
				manifest.operations = [];
			},
			(packageValue: Record<string, unknown>): void => {
				const manifest = packageValue.manifest as {
					operations: { argumentSchema: { kind: string } }[];
				};
				const operation = manifest.operations[0];
				if (operation === undefined) throw new Error("fixture operation missing");
				operation.argumentSchema.kind = "open-record";
			},
			(packageValue: Record<string, unknown>): void => {
				const manifest = packageValue.manifest as {
					operations: { name: string }[];
				};
				const operation = manifest.operations[0];
				if (operation === undefined) throw new Error("fixture operation missing");
				manifest.operations.push(structuredClone(operation));
			},
		];

		for (const mutate of cases) {
			const packageValue = clonePackage();
			mutate(packageValue);
			const candidate = expectedDigestFor(packageValue);
			expect(
				() => prepareBlueprintAdmission(prepareInput(candidate.bytes, candidate.digestHex)),
				toHex(candidate.bytes).slice(0, 32)
			).toThrow();
		}
	});

	it("uses the application-declared discriminator and closed per-operation argument schema", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const prepared = prepareBlueprintAdmission(prepareInput());

		const invalidOperations = [
			{ opType: "set_message", key: "message", value: "wrong discriminator" },
			{ action: "unknown", key: "message", value: "unknown" },
			{ action: "set_message", value: "missing key" },
			{ action: "set_message", key: 7, value: "wrong key type" },
			{ action: "set_message", key: "message", value: false },
			{ action: "set_message", key: "message", value: "extra", extra: true },
		];

		for (const operation of invalidOperations) {
			const remote = signedRemote(operation);
			expect(admitReceivedVertex(remoteInput(remote, prepared)), JSON.stringify(operation)).toEqual({
				admitted: false,
			});
		}

		const verbPackage = clonePackage();
		const verbManifest = verbPackage.manifest as { operationDiscriminator: string };
		verbManifest.operationDiscriminator = "verb";
		const verbInput = expectedDigestFor(verbPackage);
		const verbPrepared = prepareBlueprintAdmission(prepareInput(verbInput.bytes, verbInput.digestHex));
		const verbOperation = { verb: "set_message", key: "message", value: "declared discriminator" };
		const verbRemote = signedRemote(verbOperation);
		expect(admitReceivedVertex(remoteInput(verbRemote, verbPrepared))).toMatchObject({
			admitted: true,
			digest: verbRemote.digest,
		});
	});

	it("keeps invalid discriminator and arguments before every local issuance side effect", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const createAdmissionBoundTransactionalVertexIssuer = await requireSurfaceFunction(
			"createAdmissionBoundTransactionalVertexIssuer"
		);
		const prepared = prepareBlueprintAdmission(prepareInput());
		const { publicKey } = keyMaterial();
		const detachedCopyMutant: Record<string, unknown> = {
			key: "message",
			value: "non-enumerable discriminator must not survive canonical detachment",
		};
		Object.defineProperty(detachedCopyMutant, "action", {
			configurable: true,
			enumerable: false,
			value: "set_message",
		});
		const rawCheckMutant: Record<string, unknown> = {
			action: "set_message",
			key: "message",
			value: "non-enumerable extra must fail before canonical detachment",
		};
		Object.defineProperty(rawCheckMutant, "extra", {
			configurable: true,
			enumerable: false,
			value: true,
		});
		const invalidOperations: readonly Readonly<Record<string, unknown>>[] = [
			{ opType: "set_message", key: "message", value: "wrong discriminator" },
			{ action: "unknown", key: "message", value: "unknown" },
			{ action: "set_message", value: "missing key" },
			{ action: "set_message", key: 7, value: "wrong key type" },
			{ action: "set_message", key: "message", value: false },
			{ action: "set_message", key: "message", value: "extra", extra: true },
			detachedCopyMutant,
			rawCheckMutant,
		];

		for (const operation of invalidOperations) {
			const harness = transactionHarness();
			instrumentation.signCalls = 0;
			const outcome = await createIssuerAttempt(
				createAdmissionBoundTransactionalVertexIssuer,
				{
					author: contract.vertex.author,
					preparedBlueprintAdmission: prepared,
					privateKeySeed: fromHex(contract.privateKeySeedHex),
					publicKey: { bytes: publicKey, format: "raw" },
					transactIssue: harness.transactIssue,
				},
				localInput(operation)
			);

			expect(harness.transactions, JSON.stringify(operation)).toBe(0);
			expect(harness.buildAndSignCalls, JSON.stringify(operation)).toBe(0);
			expect(instrumentation.signCalls, JSON.stringify(operation)).toBe(0);
			expect(harness.issuedRecordWrites, JSON.stringify(operation)).toBe(0);
			expect(harness.outboxWrites, JSON.stringify(operation)).toBe(0);
			expect(outcome.error, JSON.stringify(operation)).toBeDefined();
		}
	});

	it("requires runtime-proven preparation and rejects missing, raw, branded, cloned, or callback substitutes", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const prepared = prepareBlueprintAdmission(prepareInput());
		const crossPackage = clonePackage();
		const crossManifest = crossPackage.manifest as { operationDiscriminator: string };
		crossManifest.operationDiscriminator = "verb";
		const crossInput = expectedDigestFor(crossPackage);
		const crossPrepared = prepareBlueprintAdmission(prepareInput(crossInput.bytes, crossInput.digestHex));
		const forgedValues = [
			undefined,
			contract.package,
			{ __brand: "PreparedBlueprintAdmission" },
			{ ...(prepared as object) },
			structuredClone(prepared),
			forgePrepared(prepared),
			crossPrepared,
		];

		for (const forged of forgedValues) {
			const remote = signedRemote(contract.validOperation);
			expect(
				admitReceivedVertex({
					...remoteInput(remote, forged),
					isOperationAllowed: () => true,
					validateOperation: () => true,
				})
			).toEqual({ admitted: false });
		}
	});

	it("keeps non-admitted bytes out of accepted state and causality, including primitive result substitution", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const prepared = prepareBlueprintAdmission(prepareInput());
		const acceptedState: string[] = [];
		const causalityIndex: string[] = [];
		const forensicRetention: { admitted: false; bytes: Uint8Array }[] = [];
		const consume = (decision: AdmissionDecision, remote: RemoteCase): void => {
			if (decision.admitted === true && decision.digest !== undefined) {
				const digestHex = toHex(decision.digest);
				acceptedState.push(digestHex);
				causalityIndex.push(digestHex);
				return;
			}
			forensicRetention.push({ admitted: false, bytes: new Uint8Array(remote.bytes) });
		};

		const invalidRemote = signedRemote({ action: "not_declared", key: "message", value: "retain only" });
		const invalidDecision = admitReceivedVertex(remoteInput(invalidRemote, prepared));
		expect(invalidDecision).toEqual({ admitted: false });
		consume(invalidDecision, invalidRemote);

		const primitiveDecision = { accepted: true, digest: invalidRemote.digest };
		consume(primitiveDecision as unknown as AdmissionDecision, invalidRemote);
		expect(acceptedState).toEqual([]);
		expect(causalityIndex).toEqual([]);
		expect(forensicRetention).toHaveLength(2);
		expect(forensicRetention.every(({ admitted }) => admitted === false)).toBe(true);

		const validRemote = signedRemote(contract.validOperation);
		const validDecision = admitReceivedVertex(remoteInput(validRemote, prepared));
		expect(validDecision).toEqual({ admitted: true, digest: validRemote.digest });
		expect(validDecision).not.toHaveProperty("accepted");
		consume(validDecision, validRemote);
		expect(acceptedState).toEqual([toHex(validRemote.digest)]);
		expect(causalityIndex).toEqual([toHex(validRemote.digest)]);
	});

	it("treats legacy-looking values as inert data: undeclared reject, exactly declared allow", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const primaryPrepared = prepareBlueprintAdmission(prepareInput());
		const declaredPackage = legacyDeclaredPackage();
		const declaredInput = expectedDigestFor(declaredPackage);
		const declaredPrepared = prepareBlueprintAdmission(prepareInput(declaredInput.bytes, declaredInput.digestHex));
		const createAdmissionBoundTransactionalVertexIssuer = await requireSurfaceFunction(
			"createAdmissionBoundTransactionalVertexIssuer"
		);
		const harness = transactionHarness();
		const { publicKey } = keyMaterial();
		const issuer = createAdmissionBoundTransactionalVertexIssuer({
			author: contract.vertex.author,
			preparedBlueprintAdmission: declaredPrepared,
			privateKeySeed: fromHex(contract.privateKeySeedHex),
			publicKey: { bytes: publicKey, format: "raw" },
			transactIssue: harness.transactIssue,
		});

		for (const value of contract.legacyLookingValues) {
			const operation = { action: value, payload: "inert application data" };
			const remote = signedRemote(operation);
			expect(admitReceivedVertex(remoteInput(remote, primaryPrepared)), `${value} undeclared`).toEqual({
				admitted: false,
			});
			expect(admitReceivedVertex(remoteInput(remote, declaredPrepared)), `${value} declared`).toMatchObject({
				admitted: true,
				digest: remote.digest,
			});
			await expect(issuer.issue(localInput(operation)), `${value} locally declared`).resolves.toMatchObject({
				authorSequence: contract.vertex.authorSequence,
			});
		}
		expect(harness.transactions).toBe(contract.legacyLookingValues.length);
	});

	it("accepts and issues declared operations while preserving exact received bytes", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const admitReceivedVertex = await requireSurfaceFunction("admitReceivedVertex");
		const createAdmissionBoundTransactionalVertexIssuer = await requireSurfaceFunction(
			"createAdmissionBoundTransactionalVertexIssuer"
		);
		const prepared = prepareBlueprintAdmission(prepareInput());
		const remote = signedRemote(contract.validOperation);
		instrumentation.encodeCalls = 0;
		expect(admitReceivedVertex(remoteInput(remote, prepared))).toEqual({
			admitted: true,
			digest: remote.digest,
		});
		expect(instrumentation.encodeCalls).toBe(0);

		const harness = transactionHarness();
		const { publicKey } = keyMaterial();
		const issuer = createAdmissionBoundTransactionalVertexIssuer({
			author: contract.vertex.author,
			preparedBlueprintAdmission: prepared,
			privateKeySeed: fromHex(contract.privateKeySeedHex),
			publicKey: { bytes: publicKey, format: "raw" },
			transactIssue: harness.transactIssue,
		});
		const commit = await issuer.issue(localInput(contract.validOperation));
		expect(commit.authorSequence).toBe(contract.vertex.authorSequence);
		expect(harness.transactions).toBe(1);
		expect(harness.buildAndSignCalls).toBe(1);
		expect(harness.issuedRecordWrites).toBe(1);
		expect(harness.outboxWrites).toBe(1);
	});

	it("keeps all forged local paths before transaction/sign/record/outbox work", async () => {
		const prepareBlueprintAdmission = await requireSurfaceFunction("prepareBlueprintAdmission");
		const createAdmissionBoundTransactionalVertexIssuer = await requireSurfaceFunction(
			"createAdmissionBoundTransactionalVertexIssuer"
		);
		const prepared = prepareBlueprintAdmission(prepareInput());
		const crossPackage = clonePackage();
		const crossManifest = crossPackage.manifest as { operationDiscriminator: string };
		crossManifest.operationDiscriminator = "verb";
		const crossInput = expectedDigestFor(crossPackage);
		const crossPrepared = prepareBlueprintAdmission(prepareInput(crossInput.bytes, crossInput.digestHex));
		const { publicKey } = keyMaterial();
		const forgedValues = [
			undefined,
			contract.package,
			{ __brand: "PreparedBlueprintAdmission" },
			{ ...(prepared as object) },
			structuredClone(prepared),
			forgePrepared(prepared),
			crossPrepared,
		];

		for (const forged of forgedValues) {
			const harness = transactionHarness();
			instrumentation.signCalls = 0;
			const outcome = await createIssuerAttempt(
				createAdmissionBoundTransactionalVertexIssuer,
				{
					author: contract.vertex.author,
					preparedBlueprintAdmission: forged,
					privateKeySeed: fromHex(contract.privateKeySeedHex),
					publicKey: { bytes: publicKey, format: "raw" },
					transactIssue: harness.transactIssue,
					isOperationAllowed: () => true,
					validateOperation: () => true,
				},
				localInput(contract.validOperation)
			);

			expect(outcome.error).toBeDefined();
			expect(harness.transactions).toBe(0);
			expect(harness.buildAndSignCalls).toBe(0);
			expect(instrumentation.signCalls).toBe(0);
			expect(harness.issuedRecordWrites).toBe(0);
			expect(harness.outboxWrites).toBe(0);
		}
	});
});
