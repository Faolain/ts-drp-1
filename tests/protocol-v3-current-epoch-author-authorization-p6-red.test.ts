import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import blueprintContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import { bytesHex, independentHashDomain } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import {
	anchorContract,
	AUTHOR,
	AUTHORIZATION_DOMAIN,
	AUTHORIZATION_MAX_BYTES,
	type AuthorizationCreatorMaterial,
	authorizationDigest,
	canonicalCarrierBytes,
	installInput,
	makeAuthorizationCreatorMaterial,
	makeCarrier,
	PRIVATE_KEY,
} from "./fixtures/phase-3a1b-p6/author-authorization-contract.js";
import { runBootstrapFreezeScenario } from "./fixtures/phase-3a1b-p6/author-authorization-freeze-harness.js";
import {
	auditAuthorizationFreezePolicy,
	auditAuthorizationManifestTransition,
	auditAuthorizationWorkflow,
} from "./fixtures/phase-3a1b-p6/author-authorization-governance-analyzer.js";
import {
	ANALYZER_POSITIVE_CONTROL,
	auditAuthorAuthorizationSourceGraph,
	auditAuthorAuthorizationSubpathSurface,
} from "./fixtures/phase-3a1b-p6/author-authorization-source-analyzer.js";
import vectors from "../packages/protocol-v3/supplements/author-authorization-v1/vectors.json" with { type: "json" };

interface Failure {
	readonly cause?: string;
	readonly ok: false;
	readonly reason: string;
}
interface Trust {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: string;
}
interface Authorization {
	readonly aclDigest: string;
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly profileId: string;
}
interface AuthorizationSurface {
	openCurrentEpochAuthorAuthorization(
		input: unknown
	): Failure | Readonly<{ authorization: Authorization; ok: true; provenance: Readonly<Record<string, unknown>> }>;
	resolveCurrentEpochAuthorizedAuthor(
		input: unknown
	): Failure | Readonly<{ ok: true; publicKey: Readonly<{ bytes: Uint8Array; format: "raw" }> }>;
	readonly [name: string]: unknown;
}
interface RootSurface {
	createAdmissionBoundTransactionalVertexIssuer(options: unknown): {
		issue(input: unknown): Promise<Readonly<Record<string, unknown>>>;
	};
	extractAdmittedReceivedVertex(input: unknown): Readonly<Record<string, unknown>>;
	installCreatorAnchorTrustRoot(
		input: unknown
	): Failure | Readonly<{ exactCanonicalTrustStateRecordBytes: Uint8Array; ok: true; trust: Trust }>;
	prepareBlueprintAdmission(input: unknown): unknown;
	readonly [name: string]: unknown;
}
interface InternalSurface {
	createAnchorTrustApi(): AuthorizationSurface & RootSurface;
}

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "..");
const PUBLIC_ENTRY = resolve(ROOT, "packages/protocol-v3/src/public.ts");
const INDEX_ENTRY = resolve(ROOT, "packages/protocol-v3/src/index.ts");
const SINGLETON_ENTRY = resolve(ROOT, "packages/protocol-v3/src/anchor-trust-singleton.ts");
const AUTHORIZATION_ENTRY = resolve(ROOT, "packages/protocol-v3/src/author-authorization.ts");
const CHECKER = resolve(ROOT, "packages/protocol-v3/supplements/author-authorization-v1/check-freeze.mjs");
const EXPECTED_ROOT_RUNTIME = [
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
const EXPECTED_SUBPATH_RUNTIME = [
	"openCurrentEpochAuthorAuthorization",
	"resolveCurrentEpochAuthorizedAuthor",
] as const;

async function rootSurface(): Promise<RootSurface> {
	return import(pathToFileURL(PUBLIC_ENTRY).href) as Promise<RootSurface>;
}

async function authorizationSurface(): Promise<AuthorizationSurface> {
	if (!existsSync(AUTHORIZATION_ENTRY)) throw new Error("P6_MISSING_AUTHOR_AUTHORIZATION_SUBPATH");
	return import(pathToFileURL(AUTHORIZATION_ENTRY).href) as Promise<AuthorizationSurface>;
}

async function internalSurface(): Promise<InternalSurface> {
	return import(pathToFileURL(INDEX_ENTRY).href) as Promise<InternalSurface>;
}

function openInput(
	material: AuthorizationCreatorMaterial,
	trust: Trust,
	carrier: Uint8Array,
	overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
	return {
		detachedAnchorSignature: new Uint8Array(material.signature),
		exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalAuthorAuthorizationBytes: new Uint8Array(carrier),
		trust,
		...overrides,
	};
}

async function genuineTrust(material: AuthorizationCreatorMaterial): Promise<Trust> {
	const root = await rootSurface();
	const installed = root.installCreatorAnchorTrustRoot(installInput(material));
	expect(installed).toMatchObject({ ok: true });
	if (!installed.ok) throw new Error(`trust installation failed: ${installed.reason}`);
	return installed.trust;
}

async function openGenuine(
	options: {
		readonly carrierBytes?: Uint8Array;
		readonly material?: AuthorizationCreatorMaterial;
		readonly overrides?: Readonly<Record<string, unknown>>;
	} = {}
): Promise<{
	readonly authorization: Authorization;
	readonly material: AuthorizationCreatorMaterial;
	readonly surface: AuthorizationSurface;
	readonly trust: Trust;
}> {
	const carrier = options.carrierBytes ?? canonicalCarrierBytes();
	const material = options.material ?? makeAuthorizationCreatorMaterial({ aclDigest: authorizationDigest(carrier) });
	const trust = await genuineTrust(material);
	const surface = await authorizationSurface();
	const opened = surface.openCurrentEpochAuthorAuthorization(openInput(material, trust, carrier, options.overrides));
	expect(opened).toMatchObject({ ok: true });
	if (!opened.ok) throw new Error(`authorization open failed: ${opened.reason}`);
	return { authorization: opened.authorization, material, surface, trust };
}

function viewVariant(
	kind: "buffer" | "hostile-subclass" | "ordinary" | "partial" | "subclass",
	bytes: Uint8Array
): Uint8Array {
	if (kind === "buffer") return Buffer.from(bytes);
	if (kind === "hostile-subclass") {
		class HostileBytes extends Uint8Array {
			static get [Symbol.species](): Uint8ArrayConstructor {
				throw new Error("source species consulted");
			}
			override [Symbol.iterator](): ArrayIterator<number> {
				throw new Error("source iterator consulted");
			}
			override slice(): Uint8Array {
				throw new Error("source slice consulted");
			}
			override subarray(): Uint8Array {
				throw new Error("source subarray consulted");
			}
		}
		const view = new HostileBytes(bytes);
		Object.defineProperty(view, "constructor", {
			configurable: true,
			get() {
				throw new Error("source constructor consulted");
			},
		});
		Object.defineProperty(view, "set", {
			configurable: true,
			value() {
				throw new Error("source set consulted");
			},
		});
		return view;
	}
	if (kind === "subclass") {
		class BytesSubclass extends Uint8Array {}
		return new BytesSubclass(bytes);
	}
	if (kind === "partial") {
		const backing = new ArrayBuffer(bytes.byteLength + 7);
		const view = new Uint8Array(backing, 3, bytes.byteLength);
		view.set(bytes);
		new Uint8Array(backing, 0, 3).fill(0xa5);
		new Uint8Array(backing, 3 + bytes.byteLength).fill(0x5a);
		return view;
	}
	return new Uint8Array(bytes);
}

describe("D.93.35.3 p6 author authorization independent controls", () => {
	it("pins independent canonical bytes, domain framing and the repository vector", () => {
		const bytes = canonicalCarrierBytes();
		expect(bytesHex(bytes)).toBe(vectors.positive.canonicalBytesHex);
		expect(bytes.byteLength).toBe(vectors.positive.byteLength);
		expect(authorizationDigest(bytes)).toBe(vectors.positive.aclDigest);
		expect(bytesHex(independentHashDomain(AUTHORIZATION_DOMAIN, bytes))).toBe(vectors.positive.aclDigest);
		expect(bytes.byteLength).toBeLessThan(AUTHORIZATION_MAX_BYTES);
	});

	it("keeps the package root at exact runtime ten before and after the subpath", async () => {
		expect(Object.keys(await rootSurface()).sort()).toEqual([...EXPECTED_ROOT_RUNTIME]);
	});

	it("self-tests the semantic one-owner analyzer against equivalent syntax and causal mutants", () => {
		expect(auditAuthorAuthorizationSourceGraph(ANALYZER_POSITIVE_CONTROL)).toEqual([]);
		for (const [label, mutant] of [
			[
				"second-owner",
				{ ...ANALYZER_POSITIVE_CONTROL, singleton: `${ANALYZER_POSITIVE_CONTROL.singleton}\ncreateAnchorTrustApi();` },
			],
			[
				"root-factory",
				{
					...ANALYZER_POSITIVE_CONTROL,
					publicEntry: `${ANALYZER_POSITIVE_CONTROL.publicEntry}\ncreateAnchorTrustApi();`,
				},
			],
			[
				"third-subpath-value",
				{ ...ANALYZER_POSITIVE_CONTROL, subpath: `${ANALYZER_POSITIVE_CONTROL.subpath}\nexport const leaked = 1;` },
			],
		] as const) {
			expect(auditAuthorAuthorizationSourceGraph(mutant), label).not.toEqual([]);
		}
		const equivalentSurface = `
			export { openCurrentEpochAuthorAuthorization as openCurrentEpochAuthorAuthorization,
				resolveCurrentEpochAuthorizedAuthor } from "./anchor-trust-singleton.js";
			export type { AuthenticateCurrentEpochAnchorFailureReason,
				AuthenticateCurrentEpochAnchorSuccessProvenance, CurrentEpochAuthorAuthorization,
				OpenCurrentEpochAuthorAuthorizationInput, OpenCurrentEpochAuthorAuthorizationResult,
				ResolveCurrentEpochAuthorizedAuthorInput, ResolveCurrentEpochAuthorizedAuthorResult } from "./index.js";
		`;
		expect(auditAuthorAuthorizationSubpathSurface(equivalentSurface)).toEqual([]);
		expect(auditAuthorAuthorizationSubpathSurface(`${equivalentSurface}\nexport const third = 1;`)).not.toEqual([]);
		expect(
			auditAuthorAuthorizationSubpathSurface(
				equivalentSurface.replace("ResolveCurrentEpochAuthorizedAuthorResult", "UnrelatedType")
			)
		).not.toEqual([]);
	});

	it("self-tests parsed manifest, workflow and freeze-policy governance analyzers", () => {
		const base = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol-v3/package.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const candidate = structuredClone(base);
		candidate.exports = {
			".": { types: "./dist/src/public.d.ts", import: "./dist/src/public.js" },
			"./author-authorization": {
				types: "./dist/src/author-authorization.d.ts",
				import: "./dist/src/author-authorization.js",
			},
			"./registry/registry-v1.json": "./registry/registry-v1.json",
		};
		expect(auditAuthorizationManifestTransition(base, candidate)).toEqual([]);
		expect(auditAuthorizationManifestTransition(base, { ...candidate, version: "99.0.0" })).not.toEqual([]);
		const workflow = readFileSync(resolve(ROOT, ".github/workflows/protocol-v3-author-authorization.yml"), "utf8");
		expect(auditAuthorizationWorkflow(workflow)).toEqual([]);
		expect(auditAuthorizationWorkflow(workflow.replace("contents: read", "contents: write"))).not.toEqual([]);
		const policy = JSON.parse(
			readFileSync(resolve(ROOT, "packages/protocol-v3/supplements/author-authorization-v1/freeze-policy.json"), "utf8")
		);
		expect(auditAuthorizationFreezePolicy(policy)).toEqual([]);
		expect(
			auditAuthorizationFreezePolicy({ ...policy, protectedArtifacts: policy.protectedArtifacts.slice(1) })
		).not.toEqual([]);
	});

	it("executes the bootstrap-atomic checker against complete, partial and drifted histories", () => {
		const accepted = runBootstrapFreezeScenario(ROOT, { base: "absent", mutation: "none" });
		expect(accepted.status, accepted.output).toBe(0);
		for (const [base, mutation] of [
			["partial", "none"],
			["absent", "drift-schema"],
			["absent", "extra-file"],
			["absent", "missing-vector"],
			["absent", "extra-policy-exception"],
			["complete", "drift-schema"],
		] as const) {
			const result = runBootstrapFreezeScenario(ROOT, { base, mutation });
			expect(result.status, `${base}:${mutation}\n${result.output}`).not.toBe(0);
		}
	});
});

describe("D.93.35.3 p6 public authority causal RED", () => {
	it("publishes exactly two subpath values from the shared singleton owner", async () => {
		const surface = await authorizationSurface();
		expect(Object.keys(surface).sort()).toEqual([...EXPECTED_SUBPATH_RUNTIME]);
		const graph = {
			index: readFileSync(INDEX_ENTRY, "utf8"),
			publicEntry: readFileSync(PUBLIC_ENTRY, "utf8"),
			singleton: readFileSync(SINGLETON_ENTRY, "utf8"),
			subpath: readFileSync(AUTHORIZATION_ENTRY, "utf8"),
		};
		expect(auditAuthorAuthorizationSourceGraph(graph)).toEqual([]);
		expect(auditAuthorAuthorizationSubpathSurface(graph.subpath)).toEqual([]);
	});

	it("opens one genuine current-epoch capability and returns fresh exact author keys", async () => {
		const { authorization, surface } = await openGenuine();
		expect(Object.keys(authorization).sort()).toEqual([
			"aclDigest",
			"currentAnchorDigest",
			"epoch",
			"objectId",
			"profileId",
		]);
		const first = surface.resolveCurrentEpochAuthorizedAuthor({ authorization, author: AUTHOR });
		const second = surface.resolveCurrentEpochAuthorizedAuthor({ authorization, author: AUTHOR });
		expect(first).toMatchObject({ ok: true, publicKey: { format: "raw" } });
		expect(second).toMatchObject({ ok: true, publicKey: { format: "raw" } });
		if (!first.ok || !second.ok) return;
		expect(bytesHex(first.publicKey.bytes)).toBe(AUTHOR);
		expect(first.publicKey.bytes).not.toBe(second.publicKey.bytes);
		expect(Object.getPrototypeOf(first.publicKey.bytes)).toBe(Uint8Array.prototype);
		expect(first.publicKey.bytes.byteOffset).toBe(0);
		expect(first.publicKey.bytes.buffer.byteLength).toBe(32);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.publicKey)).toBe(true);
	});

	it("rejects forged, cloned, serialized, foreign and absent capabilities without fallback", async () => {
		const { authorization, surface } = await openGenuine();
		const internal = await internalSurface();
		const foreign = internal.createAnchorTrustApi();
		const forgeries = [
			{ ...authorization },
			structuredClone(authorization),
			JSON.parse(JSON.stringify(authorization)),
			new Proxy(authorization, {}),
		];
		for (const forged of forgeries) {
			expect(surface.resolveCurrentEpochAuthorizedAuthor({ authorization: forged, author: AUTHOR })).toEqual({
				ok: false,
				reason: "untrusted-context",
			});
		}
		expect(foreign.resolveCurrentEpochAuthorizedAuthor({ authorization, author: AUTHOR })).toEqual({
			ok: false,
			reason: "untrusted-context",
		});
		expect(surface.resolveCurrentEpochAuthorizedAuthor({ authorization, author: "11".repeat(32) })).toEqual({
			ok: false,
			reason: "author-not-authorized",
		});
		expect(surface.resolveCurrentEpochAuthorizedAuthor({ authorization, author: anchorContract.signerId })).toEqual({
			ok: false,
			reason: "malformed-input",
		});
	});

	it("freezes the full carrier taxonomy and precedence", async () => {
		const valid = makeCarrier();
		const without = (key: keyof typeof valid): Record<string, unknown> => {
			const copy = { ...valid } as Record<string, unknown>;
			delete copy[key];
			return copy;
		};
		const rows = [
			["decode", Uint8Array.of(0xff), "acl-decode-failed"],
			["noncanonical", new Uint8Array([...canonicalCarrierBytes(), 0]), "noncanonical-acl"],
			["missing-key", encodeCanonical(without("authors")), "acl-schema-invalid"],
			["extra-key", encodeCanonical({ ...valid, role: "writer" }), "acl-schema-invalid"],
			["empty", makeCarrier({ authors: [] }), "acl-schema-invalid"],
			[
				"sixty-five",
				makeCarrier({ authors: Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, "0")) }),
				"acl-schema-invalid",
			],
			["duplicate", makeCarrier({ authors: [AUTHOR, AUTHOR] }), "acl-schema-invalid"],
			["unsorted", makeCarrier({ authors: ["f".repeat(64), "1".repeat(64)] }), "acl-schema-invalid"],
			["uppercase", makeCarrier({ authors: [AUTHOR.toUpperCase()] }), "acl-schema-invalid"],
			["nonhex", makeCarrier({ authors: ["g".repeat(64)] }), "acl-schema-invalid"],
			["kind", makeCarrier({ kind: "other" }), "acl-schema-invalid"],
			["protocol", makeCarrier({ protocolMajor: 4 }), "acl-schema-invalid"],
			["negative-epoch", makeCarrier({ epoch: -1 }), "acl-schema-invalid"],
			["fractional-epoch", makeCarrier({ epoch: 0.5 }), "acl-schema-invalid"],
			["invalid-object", makeCarrier({ objectId: "invalid" }), "acl-schema-invalid"],
			["version", makeCarrier({ version: 2 }), "unsupported-acl-version"],
			["profile", makeCarrier({ profileId: "other" }), "unsupported-acl-profile"],
			["object", makeCarrier({ objectId: "other:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), "object-id-mismatch"],
			["epoch", makeCarrier({ epoch: 1 }), "epoch-mismatch"],
		] as const;
		const surface = await authorizationSurface();
		for (const [label, carrier, reason] of rows) {
			const bytes = carrier instanceof Uint8Array ? carrier : canonicalCarrierBytes(carrier);
			const material = makeAuthorizationCreatorMaterial({ aclDigest: authorizationDigest(bytes) });
			const trust = await genuineTrust(material);
			expect(surface.openCurrentEpochAuthorAuthorization(openInput(material, trust, bytes)), label).toEqual({
				ok: false,
				reason,
			});
		}
		const authors = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(64, "0"));
		const carrier64 = canonicalCarrierBytes(makeCarrier({ authors }));
		const material64 = makeAuthorizationCreatorMaterial({ aclDigest: authorizationDigest(carrier64) });
		const trust64 = await genuineTrust(material64);
		expect(surface.openCurrentEpochAuthorAuthorization(openInput(material64, trust64, carrier64))).toMatchObject({
			ok: true,
		});
	});

	it("keeps resolver precedence closed, hostile-safe and authority-first", async () => {
		const { authorization, surface } = await openGenuine();
		const accessor = { authorization, author: AUTHOR };
		Object.defineProperty(accessor, "author", { enumerable: true, get: () => AUTHOR });
		for (const input of [
			null,
			{},
			{ authorization, author: AUTHOR, extra: true },
			accessor,
			{ authorization, author: 7 },
			{ authorization, author: AUTHOR.toUpperCase() },
			{ authorization, author: "f".repeat(63) },
		]) {
			let result: unknown;
			expect(() => {
				result = surface.resolveCurrentEpochAuthorizedAuthor(input);
			}).not.toThrow();
			expect(result).toEqual({ ok: false, reason: "malformed-input" });
		}
		expect(
			surface.resolveCurrentEpochAuthorizedAuthor({ authorization: { ...authorization }, author: "not-an-author" })
		).toEqual({ ok: false, reason: "untrusted-context" });
	});

	it("authenticates the anchor before carrier semantics and binds the exact digest domain", async () => {
		const surface = await authorizationSurface();
		const carrier = canonicalCarrierBytes();
		const material = makeAuthorizationCreatorMaterial({ aclDigest: "0".repeat(64) });
		const trust = await genuineTrust(material);
		expect(surface.openCurrentEpochAuthorAuthorization(openInput(material, trust, carrier))).toEqual({
			ok: false,
			reason: "acl-digest-mismatch",
		});
		const badSignature = new Uint8Array(material.signature);
		badSignature[0] ^= 1;
		expect(
			surface.openCurrentEpochAuthorAuthorization(
				openInput(material, trust, Uint8Array.of(0xff), { detachedAnchorSignature: badSignature })
			)
		).toEqual({ ok: false, reason: "anchor-rejected", cause: "invalid-signature" });
	});

	it("accepts every settled genuine Uint8Array view for all three byte fields", async () => {
		const carrier = canonicalCarrierBytes();
		const material = makeAuthorizationCreatorMaterial();
		const trust = await genuineTrust(material);
		const surface = await authorizationSurface();
		const sources = {
			detachedAnchorSignature: material.signature,
			exactCanonicalAnchorPreimageBytes: material.anchorBytes,
			exactCanonicalAuthorAuthorizationBytes: carrier,
		};
		for (const field of Object.keys(sources) as (keyof typeof sources)[]) {
			for (const kind of ["ordinary", "buffer", "subclass", "hostile-subclass", "partial"] as const) {
				const view = viewVariant(kind, sources[field]);
				const input = openInput(material, trust, carrier, { [field]: view });
				const result = surface.openCurrentEpochAuthorAuthorization(input);
				expect(result, `${field}:${kind}`).toMatchObject({ ok: true });
				view.fill(0xa5);
				if (result.ok) {
					expect(
						surface.resolveCurrentEpochAuthorizedAuthor({ authorization: result.authorization, author: AUTHOR })
					).toMatchObject({ ok: true });
				}
			}
		}
	});

	it("rejects hostile or nonordinary byte views before anchor work and never throws", async () => {
		const carrier = canonicalCarrierBytes();
		const material = makeAuthorizationCreatorMaterial();
		const trust = await genuineTrust(material);
		const surface = await authorizationSurface();
		const detached = new Uint8Array(64);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		const crossRealm = runInNewContext("new Uint8Array(64)") as Uint8Array;
		const fields = {
			detachedAnchorSignature: material.signature,
			exactCanonicalAnchorPreimageBytes: material.anchorBytes,
			exactCanonicalAuthorAuthorizationBytes: carrier,
		};
		for (const [field, valid] of Object.entries(fields)) {
			const invalid: unknown[] = [
				new Proxy(new Uint8Array(valid), {}),
				new Uint16Array(valid.byteLength),
				new DataView(new ArrayBuffer(valid.byteLength)),
				{ byteLength: valid.byteLength },
				detached,
				crossRealm,
			];
			if (typeof SharedArrayBuffer !== "undefined") {
				invalid.push(new Uint8Array(new SharedArrayBuffer(valid.byteLength)));
			}
			const ResizableArrayBuffer = ArrayBuffer as typeof ArrayBuffer & {
				new (byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
			};
			try {
				const resizable = new ResizableArrayBuffer(valid.byteLength, { maxByteLength: valid.byteLength * 2 });
				if ((resizable as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
					invalid.push(new Uint8Array(resizable));
				}
			} catch {
				// The runtime does not implement resizable ArrayBuffer; browser engines cover it when present.
			}
			for (const value of invalid) {
				let result: unknown;
				expect(() => {
					result = surface.openCurrentEpochAuthorAuthorization(openInput(material, trust, carrier, { [field]: value }));
				}).not.toThrow();
				expect(result, field).toEqual({ ok: false, reason: "malformed-input" });
			}
		}
	});

	it("copies all byte views before exact length gates and honors the inclusive 8192 bound", async () => {
		const surface = await authorizationSurface();
		const carrier8192 = new Uint8Array(8192);
		const material8192 = makeAuthorizationCreatorMaterial({ aclDigest: authorizationDigest(carrier8192) });
		const trust8192 = await genuineTrust(material8192);
		expect(surface.openCurrentEpochAuthorAuthorization(openInput(material8192, trust8192, carrier8192))).toEqual({
			ok: false,
			reason: "acl-decode-failed",
		});
		expect(
			surface.openCurrentEpochAuthorAuthorization(
				openInput(material8192, trust8192, carrier8192, {
					exactCanonicalAnchorPreimageBytes: Uint8Array.of(0xff),
				})
			)
		).toEqual({ ok: false, reason: "anchor-rejected", cause: "anchor-decode-failed" });
		expect(
			surface.openCurrentEpochAuthorAuthorization(
				openInput(material8192, trust8192, carrier8192, {
					exactCanonicalAuthorAuthorizationBytes: Uint8Array.of(0xff),
				})
			)
		).toEqual({ ok: false, reason: "acl-decode-failed" });
		for (const [field, value] of [
			["detachedAnchorSignature", new Uint8Array(63)],
			["detachedAnchorSignature", new Uint8Array(65)],
			["exactCanonicalAnchorPreimageBytes", new Uint8Array(0)],
			["exactCanonicalAuthorAuthorizationBytes", new Uint8Array(0)],
			["exactCanonicalAuthorAuthorizationBytes", new Uint8Array(8193)],
		] as const) {
			expect(
				surface.openCurrentEpochAuthorAuthorization(openInput(material8192, trust8192, carrier8192, { [field]: value }))
			).toEqual({ ok: false, reason: "malformed-input" });
		}
	});

	it("uses one genuine capability for local callback issuance and remote extraction", async () => {
		const { authorization, surface } = await openGenuine();
		const root = await rootSurface();
		const packageBytes = encodeCanonical(blueprintContract.package);
		const prepared = root.prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes: packageBytes,
			expectedBlueprintDigest: bytesHex(independentHashDomain("ts-drp/blueprint-admission/v3", packageBytes)),
		});
		const resolved = surface.resolveCurrentEpochAuthorizedAuthor({ authorization, author: AUTHOR });
		expect(resolved).toMatchObject({ ok: true });
		if (!resolved.ok) return;
		const issuer = root.createAdmissionBoundTransactionalVertexIssuer({
			author: AUTHOR,
			preparedBlueprintAdmission: prepared,
			publicKey: resolved.publicKey,
			signRegisteredVertexDigest: (digest: Uint8Array) => Promise.resolve(ed25519.sign(digest, PRIVATE_KEY)),
			transactIssue: async (_scope: unknown, build: (sequence: number) => Promise<unknown>) => build(0),
		});
		const commit = await issuer.issue({
			anchor: blueprintContract.vertex.anchor,
			dependencies: [...blueprintContract.vertex.dependencies],
			epoch: blueprintContract.vertex.epoch,
			logicalTime: blueprintContract.vertex.logicalTime,
			objectId: blueprintContract.vertex.objectId,
			operation: { ...blueprintContract.validOperation },
		});
		const envelope = commit.envelope as Readonly<{
			canonicalPreimageBytes: Uint8Array;
			signature: Uint8Array;
		}>;
		const extracted = root.extractAdmittedReceivedVertex({
			domain: "ts-drp/vertex/v3",
			expectedAnchor: blueprintContract.vertex.anchor,
			preparedBlueprintAdmission: prepared,
			receivedCanonicalPreimageBytes: envelope.canonicalPreimageBytes,
			resolveAuthorPublicKey(author: string) {
				const result = surface.resolveCurrentEpochAuthorizedAuthor({ authorization, author });
				return result.ok ? result.publicKey : undefined;
			},
			signature: envelope.signature,
			suiteId: anchorContract.cryptoSuiteId,
		});
		expect(extracted).toMatchObject({ ok: true, vertex: { author: AUTHOR } });
	});

	it("runs the atomic governance checker and exact source/built type audits", () => {
		const checker = spawnSync(process.execPath, [CHECKER, "dcac6b5cfb9fb74e704f997c16634a34c8d93ea9"], {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(`${checker.stdout}\n${checker.stderr}`).toContain("protocol-v3 author authorization freeze: PASS");
		expect(checker.status).toBe(0);
		for (const config of ["tsconfig.source.json", "tsconfig.built.json"] as const) {
			const result = spawnSync("pnpm", ["exec", "tsc", "-p", resolve(ROOT, "tests/fixtures/phase-3a1b-p6", config)], {
				cwd: ROOT,
				encoding: "utf8",
			});
			expect(result.stdout, config).toBe("");
			expect(result.stderr, config).toBe("");
			expect(result.status, config).toBe(0);
		}
	}, 30_000);
});
