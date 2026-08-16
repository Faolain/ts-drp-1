import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { digestBlob, parseStorageObjectId } from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
	bytesHex,
	contract,
	independentHashDomain,
	makeCreatorMaterial,
	makeTrustStateRecord,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import {
	AUTHOR,
	installInput as authorizationInstallInput,
	canonicalCarrierBytes,
	makeAuthorizationCreatorMaterial,
} from "./fixtures/phase-3a1b-p6/author-authorization-contract.js";
import { auditAuthorAuthorizationSourceGraph } from "./fixtures/phase-3a1b-p6/author-authorization-source-analyzer.js";

interface Failure {
	readonly ok: false;
	readonly reason: string;
}

interface Trust {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: "creator-trusted-v1";
}

interface InstallSuccess {
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly ok: true;
	readonly trust: Trust;
}

interface OpenSuccess {
	readonly ok: true;
	readonly trust: Trust;
}

interface AuthenticateSuccess {
	readonly ok: true;
	readonly provenance: Readonly<Record<string, unknown>>;
}

interface AnchorTrustSurface {
	readonly ANCHOR_TRUST_STATE_MAX_RECORD_BYTES?: unknown;
	readonly admitReceivedVertex?: unknown;
	authenticateCurrentEpochAnchor?(input: unknown): AuthenticateSuccess | Failure;
	readonly createAdmissionBoundTransactionalVertexIssuer?: unknown;
	installCreatorAnchorTrustRoot?(input: unknown): InstallSuccess | Failure;
	isAnchorTrustStateRecordBytes?(bytes: unknown): boolean;
	openCurrentAnchorTrust?(input: unknown): OpenSuccess | Failure;
	readonly prepareBlueprintAdmission?: unknown;
	readonly prepareBlueprintRuntime?: unknown;
	readonly [name: string]: unknown;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const PUBLIC_ENTRY = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts");
const surfaceLoad = import(pathToFileURL(PUBLIC_ENTRY).href) as Promise<AnchorTrustSurface>;
const REGISTRY_V3 = resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const REGISTRY_V2 = resolve(REPOSITORY_ROOT, "packages/protocol-v2/registry/field-registry.json");
const FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures/phase-3a0-v3");
const PROTOCOL_V3_PACKAGE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/package.json");
const PROTOCOL_V3_INDEX = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/index.ts");
const ANCHOR_TRUST_SINGLETON = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/anchor-trust-singleton.ts");
const AUTHOR_AUTHORIZATION_ENTRY = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/author-authorization.ts");
const EXPECTED_RUNTIME_EXPORTS = [
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
] as const;
const FORBIDDEN_RUNTIME_EXPORTS = [
	"authenticateCertifiedCurrentEpochAnchor",
	"createCurrentAnchorTrustStore",
	"inspectTrustClosure",
	"installCertifiedAnchorTrustRoot",
	"openCertifiedAnchorTrust",
	"prepareAnchorTrustAdvance",
	"verifyReceivedVertex",
	"verifyTrustRecord",
] as const;
const ANCHOR_KEYS = [
	"aclDigest",
	"archiveIndexRoot",
	"blueprintDigest",
	"cryptoSuiteId",
	"cutDigest",
	"epoch",
	"historyRoot",
	"historySize",
	"kind",
	"objectId",
	"parametersDigest",
	"previousAnchor",
	"profileDigest",
	"protocolMajor",
	"signerSetDigest",
	"stateDigest",
].sort();

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isClosedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return (
		Reflect.ownKeys(value).every((key) => typeof key === "string") &&
		Object.values(descriptors).every((descriptor) => "value" in descriptor && descriptor.enumerable) &&
		JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
	);
}

function hasSharedBacking(value: Uint8Array): boolean {
	return typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer;
}

function referenceClassifier(value: unknown): boolean {
	if (!(value instanceof Uint8Array) || hasSharedBacking(value) || value.byteLength === 0 || value.byteLength > 8192) {
		return false;
	}
	try {
		const decoded = decodeCanonical(new Uint8Array(value));
		if (
			!isClosedRecord(decoded, [
				"currentAnchorDigest",
				"currentEpoch",
				"detachedCurrentAnchorSignature",
				"exactCanonicalCurrentAnchorPreimageBytes",
				"exactCanonicalProfileBytes",
				"exactCanonicalSignerSetBytes",
				"genesisAnchorDigest",
				"kind",
				"objectId",
				"profileId",
				"quorum",
				"version",
			])
		)
			return false;
		return decoded.kind === "drp-anchor-trust-state" && bytesHex(encodeCanonical(decoded)) === bytesHex(value);
	} catch {
		return false;
	}
}

function installInput(material = makeCreatorMaterial()): Record<string, unknown> {
	return {
		detachedGenesisSignature: new Uint8Array(material.signature),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

function openInput(bytes: Uint8Array, material = makeCreatorMaterial()): Record<string, unknown> {
	return {
		exactCanonicalTrustStateRecordBytes: new Uint8Array(bytes),
		expectedObjectId: contract.objectId,
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

function authenticateInput(trust: Trust, material = makeCreatorMaterial()): Record<string, unknown> {
	return {
		detachedSignature: new Uint8Array(material.signature),
		exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		trust,
	};
}

async function requireFunction<Name extends keyof AnchorTrustSurface>(
	name: Name
): Promise<NonNullable<AnchorTrustSurface[Name]>> {
	const surface = await surfaceLoad;
	if (typeof surface[name] !== "function") throw new Error(`PHASE_3A0_MISSING_EXPORT:${String(name)}`);
	return surface[name] as NonNullable<AnchorTrustSurface[Name]>;
}

function expectFailure(result: Failure | { readonly ok: true }, reason: string): void {
	expect(result).toEqual({ ok: false, reason });
	expect(Object.isFrozen(result)).toBe(true);
}

function mutateCanonical(bytes: Uint8Array, changes: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({ ...(decodeCanonical(bytes) as Record<string, unknown>), ...changes });
}

function runTsc(config: string): ReturnType<typeof spawnSync> {
	return spawnSync(
		process.execPath,
		[resolve(REPOSITORY_ROOT, "node_modules/typescript/bin/tsc"), "-p", config, "--pretty", "false"],
		{
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		}
	);
}

function diagnostics(result: ReturnType<typeof spawnSync>): string {
	return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function sharedCopy(bytes: Uint8Array): Uint8Array {
	const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
	shared.set(bytes);
	return shared;
}

function authorityViolations(entry: string, sources: ReadonlyMap<string, string>): readonly string[] {
	const violations: string[] = [];
	const visited = new Set<string>();
	const visit = (path: string): void => {
		if (visited.has(path)) return;
		visited.add(path);
		const source = sources.get(path);
		if (source === undefined) {
			violations.push(`missing:${path}`);
			return;
		}
		if (
			/\b(?:globalThis|fetch|setTimeout|setInterval|Date\.now|Math\.random|Worker|WebSocket|indexedDB)\b/u.test(source)
		) {
			violations.push(`ambient:${path}`);
		}
		for (const match of source.matchAll(/(?:from\s+|import\s*\(?)["']([^"']+)/gu)) {
			const dependency = match[1] as string;
			if (/^(?:node:|@ts-drp\/(?:storage|control-plane|blueprint-catalog))/u.test(dependency)) {
				violations.push(`authority-import:${dependency}`);
			} else if (dependency.startsWith(".")) {
				if (!dependency.endsWith(".json")) visit(resolve(dirname(path), dependency.replace(/\.js$/u, ".ts")));
			}
		}
	};
	visit(entry);
	return violations;
}

describe("Phase 3a-0-A creator trust independent controls", () => {
	it("[control-1] preserves the existing four public APIs and eight forbidden authority exports", async () => {
		const surface = await surfaceLoad;
		for (const name of EXPECTED_RUNTIME_EXPORTS.slice(1).filter((name) =>
			[
				"admitReceivedVertex",
				"createAdmissionBoundTransactionalVertexIssuer",
				"prepareBlueprintAdmission",
				"prepareBlueprintRuntime",
			].includes(name)
		))
			expect(surface[name], name).toBeTypeOf("function");
		for (const name of FORBIDDEN_RUNTIME_EXPORTS) expect(surface, name).not.toHaveProperty(name);
	});

	it("[control-2] independently hashes the exact epoch-anchor bytes to the pinned digest", () => {
		const material = makeCreatorMaterial();
		expect(material.anchorDigest).toBe(contract.expectedAnchorDigest);
		expect(bytesHex(independentHashDomain(contract.anchorDigestDomain, material.anchorBytes))).toBe(
			material.anchorDigest
		);
		expect(bytesHex(material.signature)).toBe(contract.signatureHex);
	});

	it("[control-3] keeps the local trust-state domain absent from both consensus registries", () => {
		expect(readFileSync(REGISTRY_V3, "utf8")).not.toContain(contract.anchorTrustStateDomain);
		expect(readFileSync(REGISTRY_V2, "utf8")).not.toContain(contract.anchorTrustStateDomain);
		expect(sha256File(REGISTRY_V3)).toBe("2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9");
		expect(sha256File(REGISTRY_V2)).toBe("d073c5b01dc31c121de5fcd0925697a8a3f0839bf9fcf2c7ddde15489b49f724");
	});

	it("[control-4] pins the frozen sixteen-field anchor and active identity suite", () => {
		const registry = JSON.parse(readFileSync(REGISTRY_V3, "utf8")) as {
			cryptoSuites: { active: readonly { domainKinds: readonly string[]; suiteId: string }[] };
			kinds: { epochAnchor: { fields: readonly { name: string }[] } };
		};
		expect(registry.kinds.epochAnchor.fields.map(({ name }) => name).sort()).toEqual(ANCHOR_KEYS);
		expect(registry.cryptoSuites.active).toContainEqual(
			expect.objectContaining({
				domainKinds: expect.arrayContaining(["epochAnchor"]),
				suiteId: contract.cryptoSuiteId,
			})
		);
		expect(makeCreatorMaterial().anchor).not.toHaveProperty("availabilityPolicyDigest");
	});

	it("[control-5] accepts only the greenfield storage object-id fixture", () => {
		expect(parseStorageObjectId(contract.objectId)).toMatchObject({ ok: true });
		expect(parseStorageObjectId("creator")).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
	});

	it("[control-6] binds different creator keys to different genesis pins", () => {
		const first = makeCreatorMaterial();
		const second = makeCreatorMaterial("20".repeat(32));
		expect(second.anchor.objectId).toBe(first.anchor.objectId);
		expect(second.anchorDigest).not.toBe(first.anchorDigest);
		expect(second.anchor.signerSetDigest).not.toBe(first.anchor.signerSetDigest);
	});

	it("[control-7] proves exact bytes, byteLength and digestBlob association", () => {
		const bytes = makeTrustStateRecord();
		const digest = digestBlob(bytes);
		expect(digest).toMatchObject({ ok: true });
		expect(bytes.byteLength).toBeGreaterThan(0);
		const changed = new Uint8Array(bytes);
		changed[changed.byteLength - 1] ^= 1;
		expect(digestBlob(changed)).not.toEqual(digest);
	});

	it("[control-8] independently covers all ten classifier rows without granting authority", () => {
		const material = makeCreatorMaterial();
		const valid = makeTrustStateRecord(material);
		const futureVersion = makeTrustStateRecord(material, 2);
		const oversized = new Uint8Array(contract.maxRecordBytes + 1);
		const noncanonical = new Uint8Array([...valid, 0]);
		const nonRecord = encodeCanonical(["drp-anchor-trust-state"]);
		const nonClosed = mutateCanonical(valid, { extra: true });
		const wrongKind = mutateCanonical(valid, { kind: "drp-other" });
		const shared = new Uint8Array(new SharedArrayBuffer(valid.byteLength));
		shared.set(valid);
		for (const [value, expected] of [
			[valid, true],
			[futureVersion, true],
			["bytes", false],
			[shared, false],
			[new Uint8Array(), false],
			[oversized, false],
			[noncanonical, false],
			[nonRecord, false],
			[nonClosed, false],
			[wrongKind, false],
		] as const)
			expect(referenceClassifier(value)).toBe(expected);
		expect(Object.keys(material.anchor).sort()).toEqual(ANCHOR_KEYS);
		expect(material.anchor).toMatchObject({
			cryptoSuiteId: contract.cryptoSuiteId,
			cutDigest: contract.zeroDigest,
			epoch: 0,
			historySize: 0,
			kind: "drp-epoch-anchor",
			objectId: contract.objectId,
			previousAnchor: contract.zeroDigest,
			profileDigest: contract.expectedProfileDigest,
			protocolMajor: 3,
			signerSetDigest: contract.expectedSignerSetDigest,
		});
		expect(material.signerSet).toEqual([{ publicKey: contract.publicKeyHex, signerId: contract.signerId }]);
		expect(material.profile).toEqual({
			cryptoSuiteId: contract.cryptoSuiteId,
			profileId: contract.profileId,
			quorum: 1,
			signers: material.signerSet,
		});
		expect(bytesHex(independentHashDomain(contract.signerSetDigestDomain, material.signerSetBytes))).toBe(
			contract.expectedSignerSetDigest
		);
		expect(bytesHex(independentHashDomain(contract.profileDigestDomain, material.profileBytes))).toBe(
			contract.expectedProfileDigest
		);
	});
});

describe("Phase 3a-0-A creator trust causal RED", () => {
	it("[surface] exposes exactly ten runtime names and the literal 8192 cutoff", async () => {
		const surface = await surfaceLoad;
		expect(Object.keys(surface).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS]);
		expect(surface.ANCHOR_TRUST_STATE_MAX_RECORD_BYTES).toBe(8192);
	});

	it("[public-audits] executes source/built declaration and exact runtime export guards", () => {
		const sourceAudit = runTsc(resolve(FIXTURE_DIRECTORY, "tsconfig.public-entry-audit.json"));
		expect(sourceAudit.status, diagnostics(sourceAudit)).toBe(0);
		const build = spawnSync("pnpm", ["--filter", "@ts-drp/protocol-v3", "build"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(build.status, diagnostics(build)).toBe(0);
		const builtAudit = runTsc(resolve(FIXTURE_DIRECTORY, "tsconfig.built-package-audit.json"));
		expect(builtAudit.status, diagnostics(builtAudit)).toBe(0);
		const builtPublic = resolve(REPOSITORY_ROOT, "packages/protocol-v3/dist/src/public.js");
		expect(existsSync(builtPublic)).toBe(true);
		const runtimeGuard = spawnSync(process.execPath, [resolve(FIXTURE_DIRECTORY, "public-export-contract.mjs")], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: { ...process.env, PHASE_3A0_PUBLIC_ENTRY: pathToFileURL(builtPublic).href },
		});
		expect(runtimeGuard.status, diagnostics(runtimeGuard)).toBe(0);
		const packageJson = JSON.parse(readFileSync(PROTOCOL_V3_PACKAGE, "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(packageJson.scripts["smoke:public-package"]).toContain("ANCHOR_TRUST_STATE_MAX_RECORD_BYTES");
		expect(packageJson.scripts["smoke:public-package"]).toContain("phase-3a0-v3/tsconfig.built-package-audit.json");
		expect(packageJson.scripts["typecheck:public-entry-audit"]).toContain(
			"phase-3a0-v3/tsconfig.public-entry-audit.json"
		);
	});

	it("[classifier] is total, version agnostic, bounded and non-authoritative", async () => {
		const isAnchorTrustStateRecordBytes = await requireFunction("isAnchorTrustStateRecordBytes");
		const shared = new Uint8Array(new SharedArrayBuffer(1));
		const valid = makeTrustStateRecord();
		for (const value of [
			undefined,
			null,
			"x",
			{},
			[],
			shared,
			new Uint8Array(),
			new Uint8Array(8193),
			Uint8Array.of(0xff),
			new Uint8Array([...valid, 0]),
			encodeCanonical(["drp-anchor-trust-state"]),
			mutateCanonical(valid, { extra: 1 }),
			mutateCanonical(valid, { kind: "wrong" }),
		]) {
			expect(() => isAnchorTrustStateRecordBytes(value)).not.toThrow();
			expect(isAnchorTrustStateRecordBytes(value)).toBe(false);
		}
		expect(isAnchorTrustStateRecordBytes(valid)).toBe(true);
		expect(isAnchorTrustStateRecordBytes(makeTrustStateRecord(makeCreatorMaterial(), 77))).toBe(true);
		expect(isAnchorTrustStateRecordBytes(mutateCanonical(makeTrustStateRecord(), { extra: 1 }))).toBe(false);
	});

	it("[install-success] verifies the pin/carriers/signature and emits exact detached frozen state", async () => {
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		const isAnchorTrustStateRecordBytes = await requireFunction("isAnchorTrustStateRecordBytes");
		const material = makeCreatorMaterial();
		const input = installInput(material);
		const result = installCreatorAnchorTrustRoot(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.trust).toEqual({
			currentAnchorDigest: material.anchorDigest,
			currentEpoch: 0,
			genesisAnchorDigest: material.anchorDigest,
			objectId: contract.objectId,
			profileId: contract.profileId,
		});
		expect(isAnchorTrustStateRecordBytes(result.exactCanonicalTrustStateRecordBytes)).toBe(true);
		expect(result.exactCanonicalTrustStateRecordBytes).toEqual(makeTrustStateRecord(material));
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.trust)).toBe(true);
		const record = decodeCanonical(result.exactCanonicalTrustStateRecordBytes) as Record<string, unknown>;
		expect(Object.keys(record).sort()).toEqual(
			[
				"currentAnchorDigest",
				"currentEpoch",
				"detachedCurrentAnchorSignature",
				"exactCanonicalCurrentAnchorPreimageBytes",
				"exactCanonicalProfileBytes",
				"exactCanonicalSignerSetBytes",
				"genesisAnchorDigest",
				"kind",
				"objectId",
				"profileId",
				"quorum",
				"version",
			].sort()
		);
		expect(record).toEqual(decodeCanonical(makeTrustStateRecord(material)));
		expect(record).toMatchObject({
			currentAnchorDigest: material.anchorDigest,
			currentEpoch: 0,
			detachedCurrentAnchorSignature: material.signature,
			exactCanonicalCurrentAnchorPreimageBytes: material.anchorBytes,
			exactCanonicalProfileBytes: material.profileBytes,
			exactCanonicalSignerSetBytes: material.signerSetBytes,
			genesisAnchorDigest: material.anchorDigest,
			kind: "drp-anchor-trust-state",
			objectId: contract.objectId,
			profileId: contract.profileId,
			quorum: 1,
			version: 1,
		});
		expect(result.exactCanonicalTrustStateRecordBytes).not.toBe(input.exactCanonicalGenesisAnchorPreimageBytes);
	});

	it("[install-precedence] freezes malformed/decode/canonical/schema/suite/genesis/id/pin precedence", async () => {
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		const material = makeCreatorMaterial();
		const base = installInput(material);
		const accessorInput = { ...base };
		Object.defineProperty(accessorInput, "pinnedGenesisAnchorDigest", {
			enumerable: true,
			get: () => material.anchorDigest,
		});
		const symbolInput = { ...base, [Symbol("authority")]: true };
		const cases: readonly [unknown, string][] = [
			[null, "malformed-input"],
			[accessorInput, "malformed-input"],
			[symbolInput, "malformed-input"],
			[{ ...base, extra: true }, "malformed-input"],
			[{ ...base, exactCanonicalGenesisAnchorPreimageBytes: Uint8Array.of(0xff) }, "anchor-decode-failed"],
			[
				{ ...base, exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array([...material.anchorBytes, 0]) },
				"noncanonical-anchor",
			],
			[
				{ ...base, exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { extra: true }) },
				"anchor-schema-invalid",
			],
			[
				{
					...base,
					exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, {
						cryptoSuiteId: "ed25519-seal-v3",
					}),
				},
				"inactive-crypto-suite",
			],
			[
				{ ...base, exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { epoch: 1 }) },
				"not-genesis-anchor",
			],
			[
				{
					...base,
					exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { objectId: "plain" }),
				},
				"object-id-invalid",
			],
			[{ ...base, pinnedGenesisAnchorDigest: "f".repeat(64) }, "genesis-pin-mismatch"],
		];
		for (const [input, reason] of cases) expectFailure(installCreatorAnchorTrustRoot(input), reason);
	});

	it("[install-carriers] rejects cross-pair digests, certified profiles, non-1-of-1 and bad signatures", async () => {
		const material = makeCreatorMaterial();
		const base = installInput(material);
		const wrong = makeCreatorMaterial("20".repeat(32));
		const delegated = makeCreatorMaterial({ profileId: "delegated-trusted-v1" });
		const secondSigner = {
			publicKey: (makeCreatorMaterial("30".repeat(32)).signerSet[0] as Record<string, unknown>).publicKey,
			signerId: "second",
		};
		const mismatched = makeCreatorMaterial({ profileSigners: [secondSigner] });
		const nonOne = makeCreatorMaterial({
			profileQuorum: 2,
			profileSigners: [...material.signerSet, secondSigner],
			signerSet: [...material.signerSet, secondSigner],
		});
		const maximumSigner = {
			...(material.signerSet[0] as Readonly<Record<string, unknown>>),
			signerId: "\u0800".repeat(512),
		};
		const oversized = makeCreatorMaterial({
			objectId: `${"\u0800".repeat(990)}:${"a".repeat(32)}`,
			profileSigners: [maximumSigner],
			signerSet: [maximumSigner],
		});
		expect(String(oversized.anchor.objectId)).toHaveLength(1023);
		expect(maximumSigner.signerId).toHaveLength(512);
		expect(makeTrustStateRecord(oversized).byteLength).toBeGreaterThan(contract.maxRecordBytes);
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		for (const [input, reason] of [
			[{ ...base, exactCanonicalSignerSetBytes: wrong.signerSetBytes }, "signer-set-digest-mismatch"],
			[installInput(delegated), "unsupported-trust-profile"],
			[installInput(mismatched), "signer-set-profile-mismatch"],
			[installInput(nonOne), "signer-set-profile-mismatch"],
			[installInput(oversized), "trust-state-too-large"],
			[{ ...base, detachedGenesisSignature: new Uint8Array(64) }, "invalid-signature"],
		] as const)
			expectFailure(installCreatorAnchorTrustRoot(input), reason);
		expectFailure(
			installCreatorAnchorTrustRoot({
				...installInput(delegated),
				detachedGenesisSignature: new Uint8Array(64),
				pinnedGenesisAnchorDigest: "f".repeat(64),
			}),
			"genesis-pin-mismatch"
		);
	});

	it("[open] re-verifies a canonical record and mints a new opaque detached capability", async () => {
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		const openCurrentAnchorTrust = await requireFunction("openCurrentAnchorTrust");
		const installed = installCreatorAnchorTrustRoot(installInput());
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const opened = openCurrentAnchorTrust(openInput(installed.exactCanonicalTrustStateRecordBytes));
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.trust).toEqual(installed.trust);
		expect(opened.trust).not.toBe(installed.trust);
		expect(Object.isFrozen(opened)).toBe(true);
		expect(Object.isFrozen(opened.trust)).toBe(true);
		const authenticateCurrentEpochAnchor = await requireFunction("authenticateCurrentEpochAnchor");
		expect(authenticateCurrentEpochAnchor(authenticateInput(opened.trust))).toMatchObject({ ok: true });
	});

	it("[open-precedence] owns record version, identity, pin, profile, consistency and signature failures", async () => {
		const openCurrentAnchorTrust = await requireFunction("openCurrentAnchorTrust");
		const bytes = makeTrustStateRecord();
		for (const [input, reason] of [
			[{ ...openInput(bytes), extra: true }, "malformed-input"],
			[openInput(Uint8Array.of(0xff)), "record-decode-failed"],
			[openInput(new Uint8Array([...bytes, 0])), "noncanonical-record"],
			[openInput(mutateCanonical(bytes, { extra: true })), "record-schema-invalid"],
			[openInput(mutateCanonical(bytes, { version: 2 })), "unsupported-trust-state-version"],
			[{ ...openInput(bytes), expectedObjectId: `other:${"b".repeat(32)}` }, "object-id-mismatch"],
			[{ ...openInput(bytes), pinnedGenesisAnchorDigest: "f".repeat(64) }, "genesis-pin-mismatch"],
			[openInput(mutateCanonical(bytes, { profileId: "delegated-trusted-v1" })), "unsupported-trust-profile"],
			[openInput(mutateCanonical(bytes, { currentAnchorDigest: "e".repeat(64) })), "trust-state-inconsistent"],
			[openInput(mutateCanonical(bytes, { currentEpoch: 1 })), "trust-state-inconsistent"],
			[openInput(mutateCanonical(bytes, { quorum: 2 })), "trust-state-inconsistent"],
			[
				openInput(
					mutateCanonical(bytes, {
						exactCanonicalCurrentAnchorPreimageBytes: mutateCanonical(makeCreatorMaterial().anchorBytes, {
							stateDigest: "8".repeat(64),
						}),
					})
				),
				"trust-state-inconsistent",
			],
			[
				openInput(
					mutateCanonical(bytes, { exactCanonicalSignerSetBytes: makeCreatorMaterial("20".repeat(32)).signerSetBytes })
				),
				"trust-state-inconsistent",
			],
			[
				openInput(
					mutateCanonical(bytes, {
						exactCanonicalProfileBytes: makeCreatorMaterial({ profileId: "delegated-trusted-v1" }).profileBytes,
					})
				),
				"unsupported-trust-profile",
			],
			[openInput(mutateCanonical(bytes, { detachedCurrentAnchorSignature: new Uint8Array(64) })), "invalid-signature"],
		] as const)
			expectFailure(openCurrentAnchorTrust(input), reason);
	});

	it("[authenticate] proves exactly seven current-anchor fields after authority verification", async () => {
		const authenticateCurrentEpochAnchor = await requireFunction("authenticateCurrentEpochAnchor");
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		const material = makeCreatorMaterial();
		const installed = installCreatorAnchorTrustRoot(installInput(material));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const authenticated = authenticateCurrentEpochAnchor(authenticateInput(installed.trust, material));
		expect(authenticated).toEqual({
			ok: true,
			provenance: {
				anchorDigest: material.anchorDigest,
				blueprintDigest: contract.blueprintDigest,
				epoch: 0,
				objectId: contract.objectId,
				parametersDigest: contract.parametersDigest,
				profileDigest: contract.expectedProfileDigest,
				signerSetDigest: contract.expectedSignerSetDigest,
			},
		});
		expect(Object.isFrozen(authenticated)).toBe(true);
		if (authenticated.ok) expect(Object.isFrozen(authenticated.provenance)).toBe(true);
	});

	it("[opaque-capability] rejects structural counterfeits and preserves singleton authority across entry reloads", async () => {
		const authenticateCurrentEpochAnchor = await requireFunction("authenticateCurrentEpochAnchor");
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		const installed = installCreatorAnchorTrustRoot(installInput());
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const counterfeits = [
			{ ...installed.trust },
			JSON.parse(JSON.stringify(installed.trust)),
			Object.assign(Object.create(Object.getPrototypeOf(installed.trust)), installed.trust),
		];
		for (const trust of counterfeits)
			expectFailure(authenticateCurrentEpochAnchor(authenticateInput(trust)), "untrusted-context");
		const second = (await import(`${pathToFileURL(PUBLIC_ENTRY).href}?phase3a0-second-instance`)) as AnchorTrustSurface;
		expect(second.authenticateCurrentEpochAnchor).toBeTypeOf("function");
		expect(second.authenticateCurrentEpochAnchor?.(authenticateInput(installed.trust))).toMatchObject({ ok: true });
	});

	it("[authenticate-precedence] rejects malformed/counterfeit/decode/canonical/schema/suite/bindings/current/signature", async () => {
		const authenticateCurrentEpochAnchor = await requireFunction("authenticateCurrentEpochAnchor");
		const installCreatorAnchorTrustRoot = await requireFunction("installCreatorAnchorTrustRoot");
		const material = makeCreatorMaterial();
		const installed = installCreatorAnchorTrustRoot(installInput(material));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const base = authenticateInput(installed.trust, material);
		const alteredCurrent = mutateCanonical(material.anchorBytes, { stateDigest: "8".repeat(64) });
		for (const [input, reason] of [
			[{ ...base, extra: true }, "malformed-input"],
			[{ ...base, trust: { ...installed.trust } }, "untrusted-context"],
			[{ ...base, exactCanonicalAnchorPreimageBytes: Uint8Array.of(0xff) }, "anchor-decode-failed"],
			[
				{ ...base, exactCanonicalAnchorPreimageBytes: new Uint8Array([...material.anchorBytes, 0]) },
				"noncanonical-anchor",
			],
			[
				{ ...base, exactCanonicalAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { extra: true }) },
				"anchor-schema-invalid",
			],
			[
				{
					...base,
					exactCanonicalAnchorPreimageBytes: mutateCanonical(material.anchorBytes, {
						cryptoSuiteId: "ed25519-seal-v3",
					}),
				},
				"inactive-crypto-suite",
			],
			[
				{
					...base,
					exactCanonicalAnchorPreimageBytes: mutateCanonical(material.anchorBytes, {
						objectId: `other:${"b".repeat(32)}`,
					}),
				},
				"object-id-mismatch",
			],
			[
				{ ...base, exactCanonicalAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { epoch: 1 }) },
				"epoch-mismatch",
			],
			[
				{
					...base,
					exactCanonicalAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { profileDigest: "a".repeat(64) }),
				},
				"profile-digest-mismatch",
			],
			[
				{
					...base,
					exactCanonicalAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { signerSetDigest: "b".repeat(64) }),
				},
				"signer-set-digest-mismatch",
			],
			[{ ...base, exactCanonicalAnchorPreimageBytes: alteredCurrent }, "anchor-not-current"],
			[{ ...base, detachedSignature: new Uint8Array(64) }, "invalid-signature"],
		] as const)
			expectFailure(authenticateCurrentEpochAnchor(input), reason);
	});

	it("[closed-total-inputs] rejects wrong types, shared bytes, accessors and symbols without throwing", async () => {
		const install = await requireFunction("installCreatorAnchorTrustRoot");
		const open = await requireFunction("openCurrentAnchorTrust");
		const authenticate = await requireFunction("authenticateCurrentEpochAnchor");
		const material = makeCreatorMaterial();
		const installed = install(installInput(material));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const accessor = { ...installInput(material) };
		Object.defineProperty(accessor, "detachedGenesisSignature", {
			enumerable: true,
			get: () => material.signature,
		});
		for (const input of [
			undefined,
			null,
			[],
			accessor,
			{ ...installInput(material), detachedGenesisSignature: sharedCopy(material.signature) },
			{ ...installInput(material), [Symbol("authority")]: true },
		])
			expectFailure(install(input), "malformed-input");
		for (const input of [
			undefined,
			{
				...openInput(installed.exactCanonicalTrustStateRecordBytes),
				exactCanonicalTrustStateRecordBytes: sharedCopy(installed.exactCanonicalTrustStateRecordBytes),
			},
		])
			expectFailure(open(input), "malformed-input");
		for (const input of [
			undefined,
			{ ...authenticateInput(installed.trust), detachedSignature: sharedCopy(material.signature) },
		])
			expectFailure(authenticate(input), "malformed-input");
	});

	it("[snapshot-detach] snapshots byte inputs once and returns nonshared detached output", async () => {
		const install = await requireFunction("installCreatorAnchorTrustRoot");
		const open = await requireFunction("openCurrentAnchorTrust");
		const authenticate = await requireFunction("authenticateCurrentEpochAnchor");
		const material = makeCreatorMaterial();
		const input = installInput(material);
		const original = structuredClone(input) as Record<string, unknown>;
		const installed = install(input);
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		for (const value of Object.values(input)) if (value instanceof Uint8Array) value.fill(0xff);
		expect(installed.exactCanonicalTrustStateRecordBytes).toEqual(makeTrustStateRecord(material));
		expect(installed.exactCanonicalTrustStateRecordBytes.buffer).not.toBe(
			(original.exactCanonicalGenesisAnchorPreimageBytes as Uint8Array).buffer
		);
		const recordInput = new Uint8Array(installed.exactCanonicalTrustStateRecordBytes);
		const opened = open(openInput(recordInput, material));
		recordInput.fill(0xff);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const anchorInput = new Uint8Array(material.anchorBytes);
		const signatureInput = new Uint8Array(material.signature);
		const authenticated = authenticate({
			detachedSignature: signatureInput,
			exactCanonicalAnchorPreimageBytes: anchorInput,
			trust: opened.trust,
		});
		anchorInput.fill(0xff);
		signatureInput.fill(0xff);
		expect(authenticated).toMatchObject({ ok: true });
	});

	it("[snapshot-before-use] copies every byte input before any later property can mutate its source", async () => {
		const install = await requireFunction("installCreatorAnchorTrustRoot");
		const authenticate = await requireFunction("authenticateCurrentEpochAnchor");
		const material = makeCreatorMaterial();
		const installBytes = {
			anchor: new Uint8Array(material.anchorBytes),
			profile: new Uint8Array(material.profileBytes),
			signature: new Uint8Array(material.signature),
			signerSet: new Uint8Array(material.signerSetBytes),
		};
		let copiedAllInstallBytes = false;
		const hostileInstall = new Proxy(
			{
				detachedGenesisSignature: installBytes.signature,
				exactCanonicalGenesisAnchorPreimageBytes: installBytes.anchor,
				exactCanonicalProfileBytes: installBytes.profile,
				exactCanonicalSignerSetBytes: installBytes.signerSet,
				pinnedGenesisAnchorDigest: material.anchorDigest,
			},
			{
				get(target, key, receiver): unknown {
					if (key === "pinnedGenesisAnchorDigest" && !copiedAllInstallBytes) {
						copiedAllInstallBytes = true;
						for (const bytes of Object.values(installBytes)) bytes.fill(0xff);
					}
					return Reflect.get(target, key, receiver);
				},
			}
		);
		const installed = install(hostileInstall);
		expect(copiedAllInstallBytes).toBe(true);
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const anchor = new Uint8Array(material.anchorBytes);
		const signature = new Uint8Array(material.signature);
		let copiedAuthBytes = false;
		const hostileAuth = new Proxy(
			{ detachedSignature: signature, exactCanonicalAnchorPreimageBytes: anchor, trust: installed.trust },
			{
				get(target, key, receiver): unknown {
					if (key === "trust" && !copiedAuthBytes) {
						copiedAuthBytes = true;
						anchor.fill(0xff);
						signature.fill(0xff);
					}
					return Reflect.get(target, key, receiver);
				},
			}
		);
		expect(authenticate(hostileAuth)).toMatchObject({ ok: true });
		expect(copiedAuthBytes).toBe(true);
	});

	it("[read-once] reads each closed input property exactly once before validation or crypto", async () => {
		const install = await requireFunction("installCreatorAnchorTrustRoot");
		const open = await requireFunction("openCurrentAnchorTrust");
		const authenticate = await requireFunction("authenticateCurrentEpochAnchor");
		const material = makeCreatorMaterial();
		const assertOnce = (input: Record<string, unknown>, invoke: (candidate: unknown) => unknown): unknown => {
			const reads = new Map<string, number>();
			const proxied = new Proxy(input, {
				get(target, key, receiver): unknown {
					if (typeof key === "string") reads.set(key, (reads.get(key) ?? 0) + 1);
					return Reflect.get(target, key, receiver);
				},
			});
			const result = invoke(proxied);
			expect([...reads.values()]).toEqual(Array.from({ length: Object.keys(input).length }, () => 1));
			return result;
		};
		const installed = assertOnce(installInput(material), install) as InstallSuccess | Failure;
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const opened = assertOnce(openInput(installed.exactCanonicalTrustStateRecordBytes), open) as OpenSuccess | Failure;
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const authenticated = assertOnce(authenticateInput(opened.trust), authenticate) as AuthenticateSuccess | Failure;
		expect(authenticated.ok).toBe(true);
	});

	it("[zero-effects] governs the full implementation import graph and rejects ambient-authority mutants", () => {
		const publicSource = readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts"), "utf8");
		const indexSource = readFileSync(PROTOCOL_V3_INDEX, "utf8");
		const singletonSource = existsSync(ANCHOR_TRUST_SINGLETON) ? readFileSync(ANCHOR_TRUST_SINGLETON, "utf8") : "";
		const authorizationSource = existsSync(AUTHOR_AUTHORIZATION_ENTRY)
			? readFileSync(AUTHOR_AUTHORIZATION_ENTRY, "utf8")
			: "";
		const source = `${publicSource}\n${indexSource}\n${singletonSource}\n${authorizationSource}`;
		for (const forbidden of [
			"AheDurableStore",
			"catalog.resolve",
			"createCurrentAnchorTrustStore",
			"inspectTrustClosure",
			"append",
			"subscribe",
			"setTimeout",
			"fetch(",
			"installCertifiedAnchorTrustRoot",
		])
			expect(source).not.toContain(forbidden);
		const publicPath = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts");
		const cleanGraph = new Map([
			[publicPath, publicSource],
			[PROTOCOL_V3_INDEX, indexSource],
			[ANCHOR_TRUST_SINGLETON, singletonSource],
			[AUTHOR_AUTHORIZATION_ENTRY, authorizationSource],
		]);
		expect(authorityViolations(publicPath, cleanGraph)).toEqual([]);
		expect(
			auditAuthorAuthorizationSourceGraph({
				index: indexSource,
				publicEntry: publicSource,
				singleton: singletonSource,
				subpath: authorizationSource,
			})
		).toEqual([]);
		for (const mutant of [
			new Map(cleanGraph).set(PROTOCOL_V3_INDEX, `${indexSource}\nimport "node:fs";`),
			new Map(cleanGraph).set(PROTOCOL_V3_INDEX, `${indexSource}\nglobalThis["anchorAuthority"];`),
			new Map(cleanGraph)
				.set(publicPath, `${publicSource}\nexport { authority } from "./authority.js";`)
				.set(resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/authority.ts"), 'import "@ts-drp/control-plane";'),
		])
			expect(authorityViolations(publicPath, mutant)).not.toEqual([]);
	});

	it("[one-owner-cross-entry] accepts root-opened trust only through the shared authorization singleton", async () => {
		if (!existsSync(ANCHOR_TRUST_SINGLETON) || !existsSync(AUTHOR_AUTHORIZATION_ENTRY)) {
			throw new Error("PHASE_3A1B_P6_MISSING_SHARED_ANCHOR_TRUST_OWNER");
		}
		const root = await surfaceLoad;
		const authorization = (await import(pathToFileURL(AUTHOR_AUTHORIZATION_ENTRY).href)) as {
			openCurrentEpochAuthorAuthorization(
				input: unknown
			): Failure | { readonly authorization: unknown; readonly ok: true };
			resolveCurrentEpochAuthorizedAuthor(input: unknown): Failure | { readonly ok: true };
		};
		const material = makeAuthorizationCreatorMaterial();
		const installed = root.installCreatorAnchorTrustRoot?.(authorizationInstallInput(material));
		expect(installed).toMatchObject({ ok: true });
		if (installed === undefined || !installed.ok) return;
		const opened = authorization.openCurrentEpochAuthorAuthorization({
			detachedAnchorSignature: material.signature,
			exactCanonicalAnchorPreimageBytes: material.anchorBytes,
			exactCanonicalAuthorAuthorizationBytes: canonicalCarrierBytes(),
			trust: installed.trust,
		});
		expect(opened).toMatchObject({ ok: true });
		if (!opened.ok) return;
		expect(
			authorization.resolveCurrentEpochAuthorizedAuthor({ authorization: opened.authorization, author: AUTHOR })
		).toMatchObject({ ok: true });
	});
});
