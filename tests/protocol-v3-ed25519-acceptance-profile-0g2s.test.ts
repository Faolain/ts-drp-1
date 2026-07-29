import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import contract from "./fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json" with { type: "json" };
import blueprintContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };

interface RawPublicKey {
	readonly bytes: Uint8Array;
	readonly format: "raw";
}

interface VerificationInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly preparedBlueprintAdmission?: unknown;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawPublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

interface VerificationResult {
	readonly accepted: boolean;
	readonly digest?: Uint8Array;
}

interface IssueCommit {
	readonly authorSequence: number;
	readonly envelope: {
		readonly canonicalPreimageBytes: Uint8Array;
		readonly digest: Uint8Array;
		readonly signature: Uint8Array;
	};
}

interface ProtocolSurface {
	createTransactionalVertexIssuer?(options: {
		readonly author: string;
		readonly preparedBlueprintAdmission?: unknown;
		readonly privateKeySeed: Uint8Array;
		readonly publicKey: RawPublicKey;
		transactIssue(
			scope: Readonly<{ author: string; objectId: string }>,
			buildAndSign: (authorSequence: number) => Promise<IssueCommit>
		): Promise<IssueCommit>;
	}): {
		issue(input: {
			readonly anchor: string;
			readonly dependencies: readonly string[];
			readonly epoch: number;
			readonly logicalTime: number;
			readonly objectId: string;
			readonly operation: Readonly<Record<string, unknown>>;
		}): Promise<IssueCommit>;
	};
	prepareBlueprintAdmission?(input: {
		readonly canonicalBlueprintPackageBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
	}): unknown;
	verifyEd25519RegisteredDigest?(
		signature: Uint8Array,
		rawRegisteredDigest: Uint8Array,
		publicKey: Uint8Array
	): boolean;
	verifyReceivedVertex?(input: VerificationInput): VerificationResult;
}

interface FreezeEvaluation {
	readonly accepted: boolean;
	readonly errors: readonly string[];
}

interface FreezeChecker {
	evaluateEd25519ProfileFreeze?(input: {
		readonly base: Readonly<Record<string, string>>;
		readonly head: Readonly<Record<string, string>>;
		readonly protectedArtifacts: readonly string[];
	}): FreezeEvaluation;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const implementationOverride = process.env.PHASE_0G2S_IMPLEMENTATION_MODULE;
const artifactRootOverride = process.env.PHASE_0G2S_ARTIFACT_ROOT;
const amendmentOverride = process.env.PHASE_0G2S_AMENDMENT_FILE;
const checkerOverride = process.env.PHASE_0G2S_CHECKER_MODULE;
if ((implementationOverride === undefined) !== (artifactRootOverride === undefined)) {
	throw new Error("Phase 0g(ii-S) scratch overrides must be set or unset as one pair");
}
const IMPLEMENTATION_PATH =
	implementationOverride === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(REPOSITORY_ROOT, implementationOverride);
const ARTIFACT_ROOT =
	artifactRootOverride === undefined ? REPOSITORY_ROOT : resolve(REPOSITORY_ROOT, artifactRootOverride);
const surfaceLoad = import(pathToFileURL(IMPLEMENTATION_PATH).href)
	.then((loaded: unknown) => loaded as ProtocolSurface)
	.catch(() => ({}) as ProtocolSurface);
const EXPECTED_BLUEPRINT_DIGEST = "cabbcc65454211b2e258328632aba8b184c8abdb6fb9082b498714fad503b838";
const preparedConsumerAudit = { issuerCalls: 0, verifierCalls: 0 };

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function loadText(relativePath: string): string {
	const absolutePath =
		relativePath === contract.artifactPaths.amendment && amendmentOverride !== undefined
			? resolve(REPOSITORY_ROOT, amendmentOverride)
			: resolve(ARTIFACT_ROOT, relativePath);
	return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

function loadJson(relativePath: string): Readonly<Record<string, unknown>> {
	const text = loadText(relativePath);
	if (text === "") return {};
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: {};
	} catch {
		return {};
	}
}

function protectedStateDigest(): { count: number; digest: string } {
	const policyText = readFileSync(resolve(REPOSITORY_ROOT, contract.frozenTuple.freezePolicyPath), "utf8");
	expect(sha256(policyText)).toBe(contract.frozenTuple.freezePolicySha256);
	const policy = JSON.parse(policyText) as { protectedPaths: string[] };
	const rows = policy.protectedPaths.map((path) => {
		const absolutePath = resolve(REPOSITORY_ROOT, path);
		const digest = existsSync(absolutePath) ? sha256(readFileSync(absolutePath)) : "ABSENT";
		return `${path}\0${digest}\n`;
	});
	return { count: rows.length, digest: sha256(rows.join("")) };
}

async function preparedConsumerSurface(): Promise<ProtocolSurface> {
	const surface = await surfaceLoad;
	const prepareBlueprintAdmission = surface.prepareBlueprintAdmission;
	if (typeof prepareBlueprintAdmission !== "function") {
		throw new Error("PHASE_0G2S_MISSING_EXPORT:prepareBlueprintAdmission");
	}
	const preparedBlueprintAdmission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: encodeCanonical(blueprintContract.package),
		expectedBlueprintDigest: EXPECTED_BLUEPRINT_DIGEST,
	});
	const verifyReceivedVertexUnprepared = surface.verifyReceivedVertex;
	const createTransactionalVertexIssuerUnprepared = surface.createTransactionalVertexIssuer;
	return {
		...surface,
		createTransactionalVertexIssuer:
			createTransactionalVertexIssuerUnprepared === undefined
				? undefined
				: (options): NonNullable<ReturnType<typeof createTransactionalVertexIssuerUnprepared>> => {
						preparedConsumerAudit.issuerCalls++;
						return createTransactionalVertexIssuerUnprepared({ ...options, preparedBlueprintAdmission });
					},
		verifyReceivedVertex:
			verifyReceivedVertexUnprepared === undefined
				? undefined
				: (input): VerificationResult => {
						preparedConsumerAudit.verifierCalls++;
						return verifyReceivedVertexUnprepared({ ...input, preparedBlueprintAdmission });
					},
	};
}

function liveCall(
	verifyReceivedVertex: NonNullable<ProtocolSurface["verifyReceivedVertex"]>,
	signatureHex: string,
	publicKeyHex: string,
	resolveAuthorPublicKey = vi.fn(() => ({ bytes: fromHex(publicKeyHex), format: "raw" as const }))
): { accepted: boolean; resolverCalls: number } {
	const result = verifyReceivedVertex({
		domain: contract.live.domain,
		expectedAnchor: contract.live.preimage.anchor,
		receivedCanonicalPreimageBytes: fromHex(contract.live.canonicalPreimageHex),
		resolveAuthorPublicKey,
		signature: fromHex(signatureHex),
		suiteId: contract.live.suiteId,
	});
	return { accepted: result.accepted, resolverCalls: resolveAuthorPublicKey.mock.calls.length };
}

describe("Phase 0g(ii-S) post-freeze Ed25519 acceptance-profile RED", () => {
	it("authenticates every protected Phase -1-prime path before evaluating the additive supplement", () => {
		const state = protectedStateDigest();
		expect(state).toEqual({
			count: contract.frozenTuple.protectedPathCount,
			digest: contract.frozenTuple.protectedPathStatesSha256,
		});
		const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
		expect(source.match(/verifyReceivedVertexUnprepared\s*\(/gu)).toHaveLength(1);
		expect(source.match(/createTransactionalVertexIssuerUnprepared\s*\(/gu)).toHaveLength(1);
		expect(source).toMatch(/verifyReceivedVertexUnprepared\(\{\s*\.\.\.input,\s*preparedBlueprintAdmission\s*\}\)/u);
		expect(source).toMatch(
			/createTransactionalVertexIssuerUnprepared\(\{\s*\.\.\.options,\s*preparedBlueprintAdmission\s*\}\)/u
		);
	});

	it("binds a normative and machine-readable profile to the untouched frozen tuple", () => {
		const addendum = loadText(contract.artifactPaths.addendum);
		const amendment = loadJson(contract.artifactPaths.amendment);
		const vectors = loadJson(contract.artifactPaths.vectors);
		const policy = loadJson(contract.artifactPaths.policy);
		const checker = loadText(contract.artifactPaths.checker);
		const workflow = loadText(contract.artifactPaths.workflow);
		const errors: string[] = [];
		const requiredStatements = [
			contract.profile.id,
			contract.profile.message,
			contract.profile.publicKeyEncoding,
			contract.profile.signaturePointEncoding,
			contract.profile.scalarRule,
			contract.profile.publicKeyRule,
			contract.profile.equation,
			contract.profile.challenge,
			contract.profile.nobleCall,
			contract.profile.referenceRole,
		];
		for (const statement of requiredStatements) {
			if (!addendum.includes(statement)) errors.push(`addendum omits ${statement}`);
		}
		if (amendment.profileId !== contract.profile.id) errors.push("machine record has the wrong profileId");
		if (amendment.protocolMajor !== contract.profile.protocolMajor) {
			errors.push("machine record has the wrong protocolMajor");
		}
		if (amendment.suiteId !== contract.profile.suiteId) errors.push("machine record has the wrong suiteId");
		if (JSON.stringify(amendment.frozenTuple) !== JSON.stringify(contract.frozenTuple)) {
			errors.push("machine record does not hash-bind the exact frozen tuple");
		}
		if (amendment.addendumSha256 !== sha256(addendum)) errors.push("machine record does not hash-bind addendum");
		const vectorText = loadText(contract.artifactPaths.vectors);
		if (amendment.vectorsSha256 !== sha256(vectorText)) errors.push("machine record does not hash-bind vectors");
		if (vectors.schemaVersion !== "ts-drp-ed25519-acceptance-v1") {
			errors.push("vector document has the wrong schemaVersion");
		}
		if (JSON.stringify(vectors.frozenTuple) !== JSON.stringify(contract.frozenTuple)) {
			errors.push("vector document does not hash-bind the exact frozen tuple");
		}
		const fixturePath = "tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json";
		if (vectors.contractFixturePath !== fixturePath) errors.push("vector document does not name its governed fixture");
		if (vectors.contractFixtureSha256 !== sha256(readFileSync(resolve(REPOSITORY_ROOT, fixturePath)))) {
			errors.push("vector document does not hash-bind its permanent vector fixture");
		}
		const expectedLiveIds = [
			"valid",
			"mixed-order",
			"small-order-identity",
			"s-plus-l",
			"noncanonical-r",
			"hex-text-message",
			"json-wrapper-message",
		];
		if (JSON.stringify(vectors.liveVectorIds) !== JSON.stringify(expectedLiveIds)) {
			errors.push("vector manifest does not close every live adversarial case");
		}
		if (JSON.stringify(vectors.speccheckVectorIds) !== JSON.stringify(contract.speccheck.vectors.map(({ id }) => id))) {
			errors.push("vector manifest does not close every independent provenance case");
		}
		if (JSON.stringify(policy.protectedArtifacts) !== JSON.stringify(contract.governance.protectedArtifacts)) {
			errors.push("supplement freeze policy has the wrong protected surface");
		}
		if (policy.checkerSha256 !== sha256(checker)) errors.push("supplement freeze policy does not pin its checker");
		if (!workflow.includes("fetch-depth: 0") || !workflow.includes(contract.artifactPaths.checker)) {
			errors.push("supplement workflow does not execute the authenticated freeze checker");
		}
		expect(errors).toEqual([]);
	});

	it("matches permanent independent vectors, including canonical mixed-order acceptance", async () => {
		const surface = await surfaceLoad;
		const verifyStrict =
			surface.verifyEd25519RegisteredDigest ??
			((): boolean => {
				return false;
			});
		const actual = contract.speccheck.vectors.map((vector) => ({
			id: vector.id,
			accepted: verifyStrict(fromHex(vector.signatureHex), fromHex(vector.messageHex), fromHex(vector.publicKeyHex)),
		}));
		expect(actual).toEqual(
			contract.speccheck.vectors.map((vector) => ({
				id: vector.id,
				accepted: vector.strictAccept,
			}))
		);
	});

	it("signs and verifies only the raw 32-byte registered digest", async () => {
		const surface = await surfaceLoad;
		const verifyStrict =
			surface.verifyEd25519RegisteredDigest ??
			((): boolean => {
				return false;
			});
		const digest = fromHex(contract.live.digestHex);
		const publicKey = fromHex(contract.live.publicKeyHex);
		expect(digest).toHaveLength(32);
		expect([
			verifyStrict(fromHex(contract.live.validSignatureHex), digest, publicKey),
			verifyStrict(fromHex(contract.live.signatureOverHexTextHex), digest, publicKey),
			verifyStrict(fromHex(contract.live.signatureOverJsonWrapperHex), digest, publicKey),
		]).toEqual([true, false, false]);
	});

	it("executes the same strict profile through the live verifyReceivedVertex path", async () => {
		const surface = await preparedConsumerSurface();
		const verifyReceivedVertex = surface.verifyReceivedVertex;
		expect(verifyReceivedVertex).toBeTypeOf("function");
		if (verifyReceivedVertex === undefined) return;
		const cases = [
			["valid", contract.live.validSignatureHex, contract.live.publicKeyHex, true],
			["mixed-order", contract.live.mixedOrder.signatureHex, contract.live.mixedOrder.publicKeyHex, true],
			["small-order-identity", contract.live.identity.signatureHex, contract.live.identity.publicKeyHex, false],
			["s-plus-l", contract.live.sPlusLSignatureHex, contract.live.publicKeyHex, false],
			["noncanonical-r", contract.live.noncanonicalR.signatureHex, contract.live.noncanonicalR.publicKeyHex, false],
			["hex-text-message", contract.live.signatureOverHexTextHex, contract.live.publicKeyHex, false],
			["json-wrapper-message", contract.live.signatureOverJsonWrapperHex, contract.live.publicKeyHex, false],
		] as const;
		preparedConsumerAudit.verifierCalls = 0;
		expect(
			cases.map(([id, signature, publicKey, expected]) => ({
				id,
				expected,
				...liveCall(verifyReceivedVertex, signature, publicKey),
			}))
		).toEqual(
			cases.map(([id, , , expected]) => ({
				id,
				expected,
				accepted: expected,
				resolverCalls: 1,
			}))
		);
		expect(preparedConsumerAudit.verifierCalls).toBe(cases.length);
	});

	it("keeps Node/OpenSSL as a divergence diagnostic, never the desired admission oracle", async () => {
		const surface = await preparedConsumerSurface();
		const verifyReceivedVertex = surface.verifyReceivedVertex;
		expect(verifyReceivedVertex).toBeTypeOf("function");
		if (verifyReceivedVertex === undefined) return;
		const publicKeyDer = Buffer.concat([
			Buffer.from("302a300506032b6570032100", "hex"),
			Buffer.from(contract.live.identity.publicKeyHex, "hex"),
		]);
		const nodeKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
		expect(
			nodeVerify(
				null,
				Buffer.from(contract.live.digestHex, "hex"),
				nodeKey,
				Buffer.from(contract.live.identity.signatureHex, "hex")
			)
		).toBe(true);
		expect(
			liveCall(verifyReceivedVertex, contract.live.identity.signatureHex, contract.live.identity.publicKeyHex).accepted
		).toBe(false);
	});

	it("rejects malformed, noncanonical, and unregistered inputs before resolver or crypto work", async () => {
		const surface = await preparedConsumerSurface();
		const verifyReceivedVertex = surface.verifyReceivedVertex;
		expect(verifyReceivedVertex).toBeTypeOf("function");
		if (verifyReceivedVertex === undefined) return;
		const resolver = vi.fn(() => ({
			bytes: fromHex(contract.live.publicKeyHex),
			format: "raw" as const,
		}));
		const registered = contract.live.preimage;
		const unknownBytes = encodeCanonical({ ...registered, unsignedEscape: true });
		const unknownDigest = hashDomain(contract.live.domain, unknownBytes);
		const privateKey = createPrivateKey({
			key: Buffer.concat([
				Buffer.from("302e020100300506032b657004220420", "hex"),
				Buffer.from(contract.live.privateKeySeedHex, "hex"),
			]),
			format: "der",
			type: "pkcs8",
		});
		const unknownSignature = new Uint8Array(nodeSign(null, unknownDigest, privateKey));
		const calls: VerificationInput[] = [
			{
				domain: contract.live.domain,
				expectedAnchor: contract.live.preimage.anchor.slice(2),
				receivedCanonicalPreimageBytes: fromHex(contract.live.canonicalPreimageHex),
				resolveAuthorPublicKey: resolver,
				signature: fromHex(contract.live.validSignatureHex),
				suiteId: contract.live.suiteId,
			},
			{
				domain: contract.live.domain,
				expectedAnchor: contract.live.preimage.anchor,
				receivedCanonicalPreimageBytes: Uint8Array.from([...fromHex(contract.live.canonicalPreimageHex), 0]),
				resolveAuthorPublicKey: resolver,
				signature: fromHex(contract.live.validSignatureHex),
				suiteId: contract.live.suiteId,
			},
			{
				domain: contract.live.domain,
				expectedAnchor: contract.live.preimage.anchor,
				receivedCanonicalPreimageBytes: unknownBytes,
				resolveAuthorPublicKey: resolver,
				signature: unknownSignature,
				suiteId: contract.live.suiteId,
			},
		];
		expect(calls.map((input) => verifyReceivedVertex(input).accepted)).toEqual([false, false, false]);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("closes issuance with deliberately unsorted caller dependencies into live strict admission", async () => {
		const surface = await preparedConsumerSurface();
		const createIssuer = surface.createTransactionalVertexIssuer;
		const verifyReceivedVertex = surface.verifyReceivedVertex;
		expect(createIssuer).toBeTypeOf("function");
		expect(verifyReceivedVertex).toBeTypeOf("function");
		if (createIssuer === undefined || verifyReceivedVertex === undefined) return;
		preparedConsumerAudit.issuerCalls = 0;
		preparedConsumerAudit.verifierCalls = 0;
		const issuer = createIssuer({
			author: contract.live.preimage.author,
			privateKeySeed: fromHex(contract.live.privateKeySeedHex),
			publicKey: { bytes: fromHex(contract.live.publicKeyHex), format: "raw" },
			transactIssue: async (_scope, buildAndSign) => buildAndSign(contract.live.preimage.authorSequence),
		});
		const commit = await issuer.issue({
			anchor: contract.live.preimage.anchor,
			dependencies: contract.live.unsortedDependencies,
			epoch: contract.live.preimage.epoch,
			logicalTime: contract.live.preimage.logicalTime,
			objectId: contract.live.preimage.objectId,
			operation: contract.live.preimage.operation,
		});
		expect(commit.envelope.canonicalPreimageBytes).toEqual(fromHex(contract.live.canonicalPreimageHex));
		expect(commit.envelope.digest).toEqual(fromHex(contract.live.digestHex));
		expect(
			(decodeCanonical(commit.envelope.canonicalPreimageBytes) as { dependencies: string[] }).dependencies
		).toEqual(contract.live.preimage.dependencies);
		const resolver = vi.fn(() => ({
			bytes: fromHex(contract.live.publicKeyHex),
			format: "raw" as const,
		}));
		expect(
			verifyReceivedVertex({
				domain: contract.live.domain,
				expectedAnchor: contract.live.preimage.anchor,
				receivedCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
				resolveAuthorPublicKey: resolver,
				signature: commit.envelope.signature,
				suiteId: contract.live.suiteId,
			})
		).toMatchObject({ accepted: true, digest: fromHex(contract.live.digestHex) });
		expect(resolver).toHaveBeenCalledOnce();
		expect(preparedConsumerAudit).toEqual({ issuerCalls: 1, verifierCalls: 1 });
	});

	it("freezes supplement, vectors, policy, and checker while allowing unrelated additive work", async () => {
		const checkerPath =
			checkerOverride === undefined
				? resolve(ARTIFACT_ROOT, contract.artifactPaths.checker)
				: resolve(REPOSITORY_ROOT, checkerOverride);
		const checker = existsSync(checkerPath)
			? ((await import(pathToFileURL(checkerPath).href)) as FreezeChecker)
			: ({} as FreezeChecker);
		const evaluate =
			checker.evaluateEd25519ProfileFreeze ??
			((): FreezeEvaluation => ({
				accepted: false,
				errors: ["supplement governance checker unavailable"],
			}));
		const base = Object.fromEntries(
			contract.governance.protectedArtifacts.map((path) => [
				path,
				sha256(path.startsWith("tests/") ? readFileSync(resolve(REPOSITORY_ROOT, path)) : loadText(path)),
			])
		);
		const unchanged = evaluate({ base, head: { ...base }, protectedArtifacts: contract.governance.protectedArtifacts });
		expect(unchanged).toEqual({ accepted: true, errors: [] });
		for (const path of contract.governance.protectedArtifacts) {
			const drifted = { ...base, [path]: sha256(`${base[path]}:drift`) };
			expect(
				evaluate({ base, head: drifted, protectedArtifacts: contract.governance.protectedArtifacts }),
				path
			).toMatchObject({ accepted: false });
		}
		expect(
			evaluate({
				base,
				head: { ...base, [contract.governance.unrelatedPath]: sha256("unrelated") },
				protectedArtifacts: contract.governance.protectedArtifacts,
			})
		).toEqual({ accepted: true, errors: [] });
	});

	it("keeps scratch overrides unset in ordinary production and CI", () => {
		expect(implementationOverride === undefined).toBe(artifactRootOverride === undefined);
		if (implementationOverride === undefined) {
			expect(process.env.PHASE_0G2S_IMPLEMENTATION_MODULE).toBeUndefined();
			expect(process.env.PHASE_0G2S_ARTIFACT_ROOT).toBeUndefined();
		}
	});
});
