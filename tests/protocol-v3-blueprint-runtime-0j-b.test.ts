import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import phase0iContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import contract from "./fixtures/phase-0j-b-v3/blueprint-runtime-contract.json" with { type: "json" };
import protocolV3Package from "../packages/protocol-v3/package.json" with { type: "json" };

interface PreparedBlueprintAdmission {
	readonly blueprintDigest: string;
}

interface PreparedBlueprintRuntime {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly reducers: Readonly<Record<string, (...arguments_: readonly unknown[]) => unknown>>;
	readonly runtimeProfile: string;
}

interface RuntimePreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
	readonly preparedBlueprintAdmission: unknown;
}

interface ProtocolV3Surface {
	prepareBlueprintAdmission?(input: {
		readonly canonicalBlueprintPackageBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
	}): PreparedBlueprintAdmission;
	prepareBlueprintRuntime?(input: RuntimePreparationInput): Promise<PreparedBlueprintRuntime>;
}

interface ArtifactProfileFreezeEvaluation {
	readonly accepted: boolean;
	readonly errors: readonly string[];
}

interface ArtifactProfileFreezeChecker {
	evaluateBlueprintArtifactProfileFreeze?(input: {
		readonly base: Readonly<Record<string, string>>;
		readonly head: Readonly<Record<string, string>>;
		readonly protectedArtifacts: readonly string[];
	}): ArtifactProfileFreezeEvaluation;
}

interface BlueprintPackage {
	readonly implementation: {
		artifactDigest: string;
		artifactId: string;
		runtimeProfile: string;
	};
	readonly kind: string;
	readonly manifest: {
		readonly operationDiscriminator: string;
		readonly operations: readonly {
			readonly argumentSchema: {
				readonly fields: readonly {
					readonly name: string;
					readonly required: boolean;
					readonly type: string;
				}[];
				readonly kind: string;
			};
			readonly name: string;
		}[];
		readonly schemaVersion: number;
	};
	readonly protocolMajor: number;
	readonly schemaVersion: number;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const ARTIFACT_PATH = resolve(CURRENT_DIRECTORY, "fixtures/phase-0j-b-v3", contract.artifactFile);
const PROTOCOL_V3_DIRECTORY = resolve(REPOSITORY_ROOT, "packages/protocol-v3");
const packageRootSourcePath = resolve(
	PROTOCOL_V3_DIRECTORY,
	protocolV3Package.exports["."].import.replace(/^\.\/dist\//u, "").replace(/\.js$/u, ".js")
);
const surface = (await import(pathToFileURL(packageRootSourcePath).href)) as ProtocolV3Surface;
const encoder = new TextEncoder();
const genuineArtifactBytes = new Uint8Array(readFileSync(ARTIFACT_PATH));
const TYPE_AUDIT_CONFIG = resolve(CURRENT_DIRECTORY, "fixtures/phase-0j-b-v3/tsconfig.public-entry-audit.json");
const PROFILE_PATH = "packages/protocol-v3/supplements/blueprint-artifact-profile-v1/profile.json";
const PROFILE_POLICY_PATH = "packages/protocol-v3/conformance/freeze-policy-blueprint-artifact-profile-v1.json";
const PROFILE_CHECKER_PATH = "packages/protocol-v3/scripts/check-blueprint-artifact-profile-freeze.mjs";
const PROFILE_WORKFLOW_PATH = ".github/workflows/protocol-v3-blueprint-artifact-profile.yml";
const governanceSurfaceExists = contract.governance.protectedArtifacts.every((path) =>
	existsSync(resolve(REPOSITORY_ROOT, path))
);

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function clonePackage(value: unknown = contract.package): BlueprintPackage {
	return JSON.parse(JSON.stringify(value)) as BlueprintPackage;
}

function artifactDigest(bytes: Uint8Array): string {
	return toHex(hashDomain(contract.artifactDigestDomain, bytes));
}

function blueprintDigest(bytes: Uint8Array): string {
	return toHex(hashDomain(phase0iContract.blueprintDigestDomain, bytes));
}

function canonicalPackageBytes(package_: BlueprintPackage): Uint8Array {
	return encodeCanonical(package_);
}

function packageForArtifact(
	exactArtifactBytes: Uint8Array,
	implementation: Partial<BlueprintPackage["implementation"]> = {}
): BlueprintPackage {
	const package_ = clonePackage();
	package_.implementation.artifactDigest = artifactDigest(exactArtifactBytes);
	Object.assign(package_.implementation, implementation);
	return package_;
}

function admissionForSurface(
	surface_: ProtocolV3Surface,
	package_: BlueprintPackage
): {
	readonly bytes: Uint8Array;
	readonly capability: PreparedBlueprintAdmission;
	readonly digest: string;
} {
	const bytes = canonicalPackageBytes(package_);
	const digest = blueprintDigest(bytes);
	const preparer = surface_.prepareBlueprintAdmission;
	if (preparer === undefined) throw new Error("Phase 0i prepareBlueprintAdmission is missing");
	return {
		bytes,
		capability: preparer({ canonicalBlueprintPackageBytes: bytes, expectedBlueprintDigest: digest }),
		digest,
	};
}

function admissionFor(package_: BlueprintPackage): {
	readonly bytes: Uint8Array;
	readonly capability: PreparedBlueprintAdmission;
	readonly digest: string;
} {
	return admissionForSurface(surface, package_);
}

function runtimeInputForSurface(
	surface_: ProtocolV3Surface,
	package_: BlueprintPackage = clonePackage(),
	exactArtifactBytes: Uint8Array = genuineArtifactBytes
): RuntimePreparationInput {
	const prepared = admissionForSurface(surface_, package_);
	return {
		canonicalBlueprintPackageBytes: prepared.bytes,
		exactArtifactBytes,
		expectedBlueprintDigest: prepared.digest,
		preparedBlueprintAdmission: prepared.capability,
	};
}

function runtimeInput(
	package_: BlueprintPackage = clonePackage(),
	exactArtifactBytes: Uint8Array = genuineArtifactBytes
): RuntimePreparationInput {
	return runtimeInputForSurface(surface, package_, exactArtifactBytes);
}

function prepareRuntimeFromSurface(
	surface_: ProtocolV3Surface,
	input: RuntimePreparationInput
): Promise<PreparedBlueprintRuntime> {
	const preparer = surface_.prepareBlueprintRuntime;
	if (preparer === undefined) throw new Error("prepareBlueprintRuntime public production surface is missing");
	return preparer(input);
}

function prepareRuntime(input: RuntimePreparationInput): Promise<PreparedBlueprintRuntime> {
	return prepareRuntimeFromSurface(surface, input);
}

function sourceBytes(source: string): Uint8Array {
	return encoder.encode(source);
}

function envelopeSource(
	envelope: string,
	prefix = "",
	exportStatement = `export const blueprint = ${envelope};`
): Uint8Array {
	return sourceBytes(`${prefix}${exportStatement}\n`);
}

function plainEnvelope(
	overrides: {
		readonly artifactId?: string;
		readonly exportSchemaVersion?: string;
		readonly reducers?: string;
		readonly runtimeProfile?: string;
	} = {}
): string {
	return `{
		exportSchemaVersion: ${overrides.exportSchemaVersion ?? "1"},
		artifactId: ${JSON.stringify(overrides.artifactId ?? contract.package.implementation.artifactId)},
		runtimeProfile: ${JSON.stringify(overrides.runtimeProfile ?? contract.package.implementation.runtimeProfile)},
		reducers: ${overrides.reducers ?? "{ append: unchanged, set: unchanged, set_message: unchanged }"}
	}`;
}

function validPrefix(): string {
	return "const unchanged = ({ state }) => ({ state, output: null });\n";
}

function matchingRuntimeInput(
	exactArtifactBytes: Uint8Array,
	implementation: Partial<BlueprintPackage["implementation"]> = {}
): RuntimePreparationInput {
	return runtimeInput(packageForArtifact(exactArtifactBytes, implementation), exactArtifactBytes);
}

function runtimeSource(
	overrides: {
		readonly artifactId?: string;
		readonly exportSchemaVersion?: string;
		readonly reducers?: string;
		readonly runtimeProfile?: string;
	} = {},
	prefix = "",
	exportStatement?: string
): Uint8Array {
	const envelope = plainEnvelope(overrides);
	return envelopeSource(envelope, `${prefix}${validPrefix()}`, exportStatement);
}

async function rejectsWithoutSideEffect(
	exactArtifactBytes: Uint8Array,
	package_: BlueprintPackage,
	marker: string
): Promise<void> {
	delete (globalThis as Record<string, unknown>)[marker];
	await expect(prepareRuntime(runtimeInput(package_, exactArtifactBytes))).rejects.toThrow();
	expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
}

describe("Phase 0j-b exact blueprint artifact/runtime preparation RED", () => {
	it("publishes the fixed four-input asynchronous package-owned runtime preparer", () => {
		expect(
			surface.prepareBlueprintRuntime,
			"public prepareBlueprintRuntime({preparedBlueprintAdmission, canonicalBlueprintPackageBytes, expectedBlueprintDigest, exactArtifactBytes}) is required"
		).toBeTypeOf("function");
	});

	it("publishes the runtime preparer and capability types only through the application public entry", () => {
		const tscPath = resolve(REPOSITORY_ROOT, "node_modules/typescript/bin/tsc");
		const result = spawnSync(process.execPath, [tscPath, "-p", TYPE_AUDIT_CONFIG, "--pretty", "false"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		const diagnostics = `${result.stdout}${result.stderr}`.trim();
		expect(result.status, diagnostics).toBe(0);
	});

	it("recomputes the real fixture's exact-byte artifact and canonical package digests", () => {
		expect(artifactDigest(genuineArtifactBytes)).toBe(contract.artifactDigest);
		const packageBytes = canonicalPackageBytes(clonePackage());
		expect(blueprintDigest(packageBytes)).toBe(contract.expectedBlueprintDigest);
		expect(new TextDecoder("utf-8", { fatal: true }).decode(genuineArtifactBytes)).not.toContain("blueprintDigest");
	});
});

describe.runIf(surface.prepareBlueprintRuntime !== undefined)(
	"Phase 0j-b runtime contract once the public preparer exists",
	() => {
		it("binds genuine 0i capability, re-derived package digest, exact artifact bytes, and runtime metadata", async () => {
			const input = runtimeInput();
			const admission = input.preparedBlueprintAdmission as PreparedBlueprintAdmission;
			expect(admission.blueprintDigest).toBe(input.expectedBlueprintDigest);
			const runtime = await prepareRuntime(input);
			expect(runtime).toMatchObject({
				artifactDigest: contract.artifactDigest,
				artifactId: contract.package.implementation.artifactId,
				blueprintDigest: contract.expectedBlueprintDigest,
				runtimeProfile: contract.package.implementation.runtimeProfile,
			});
			expect(Object.keys(runtime.reducers)).toEqual(["append", "set", "set_message"]);
			expect(runtime).not.toBe(admission);
		});

		it("copies canonical package and exact artifact bytes synchronously before asynchronous work", async () => {
			const initialArtifact = new Uint8Array(genuineArtifactBytes);
			const input = runtimeInput(clonePackage(), initialArtifact);
			const initialPackage = new Uint8Array(input.canonicalBlueprintPackageBytes);
			const preparation = prepareRuntime(input);
			expect(preparation).toBeInstanceOf(Promise);
			input.exactArtifactBytes.fill(0x20);
			input.canonicalBlueprintPackageBytes.fill(0xff);
			const runtime = await preparation;
			expect(runtime.artifactDigest).toBe(artifactDigest(genuineArtifactBytes));
			expect(runtime.blueprintDigest).toBe(blueprintDigest(initialPackage));
		});

		it("rejects the structurally valid synthetic Phase-0i a0 artifact digest as runtime-inadmissible", async () => {
			const syntheticPackage = clonePackage(phase0iContract.package);
			expect(syntheticPackage.implementation.artifactDigest).toBe("a0".repeat(32));
			const synthetic = admissionFor(syntheticPackage);
			expect(synthetic.capability.blueprintDigest).toBe(synthetic.digest);
			await expect(
				prepareRuntime({
					canonicalBlueprintPackageBytes: synthetic.bytes,
					exactArtifactBytes: genuineArtifactBytes,
					expectedBlueprintDigest: synthetic.digest,
					preparedBlueprintAdmission: synthetic.capability,
				})
			).rejects.toThrow();
		});

		it("rejects package-A/capability-B and wrong caller digest cross-pairs", async () => {
			const packageA = clonePackage();
			const packageB = clonePackage();
			packageB.implementation.artifactId = "@example/other-blueprint@1.0.0";
			const a = admissionFor(packageA);
			const b = admissionFor(packageB);
			await expect(
				prepareRuntime({
					canonicalBlueprintPackageBytes: a.bytes,
					exactArtifactBytes: genuineArtifactBytes,
					expectedBlueprintDigest: a.digest,
					preparedBlueprintAdmission: b.capability,
				})
			).rejects.toThrow();
			await expect(
				prepareRuntime({
					canonicalBlueprintPackageBytes: a.bytes,
					exactArtifactBytes: genuineArtifactBytes,
					expectedBlueprintDigest: "f0".repeat(32),
					preparedBlueprintAdmission: a.capability,
				})
			).rejects.toThrow();
		});

		it.each(["evaluator", "namespace", "handle", "loaderHandle"] as const)(
			"pins the closed four-key input and rejects caller-supplied %s authority",
			async (extraKey) => {
				const input = runtimeInput();
				const widened = { ...input, [extraKey]: {} } as RuntimePreparationInput;
				await expect(prepareRuntime(widened)).rejects.toThrow();
			}
		);

		it("rejects copied, forged, branded, and cross-kind admission/runtime capabilities", async () => {
			const input = runtimeInput();
			const genuineAdmission = input.preparedBlueprintAdmission as PreparedBlueprintAdmission;
			const copiedAdmission = { ...genuineAdmission };
			const brandedAdmission = Object.defineProperty({ ...genuineAdmission }, Symbol.toStringTag, {
				value: "PreparedBlueprintAdmission",
			});
			for (const invalidAdmission of [
				{ blueprintDigest: contract.expectedBlueprintDigest },
				copiedAdmission,
				brandedAdmission,
			]) {
				await expect(prepareRuntime({ ...input, preparedBlueprintAdmission: invalidAdmission })).rejects.toThrow();
			}

			const genuineRuntime = await prepareRuntime(input);
			const copiedRuntime = { ...genuineRuntime };
			const brandedRuntime = Object.create(genuineRuntime) as PreparedBlueprintRuntime;
			for (const invalidAdmission of [genuineRuntime, copiedRuntime, brandedRuntime]) {
				await expect(
					prepareRuntime({ ...runtimeInput(), preparedBlueprintAdmission: invalidAdmission })
				).rejects.toThrow();
			}
		});

		it("rejects wrong artifact digest and unsupported profile before artifact evaluation", async () => {
			const marker = "__phase0jb_pre_evaluation_marker__";
			const effectful = runtimeSource({}, `globalThis[${JSON.stringify(marker)}] = true;\n`);
			const wrongDigestPackage = clonePackage();
			await rejectsWithoutSideEffect(effectful, wrongDigestPackage, marker);

			const unknownProfilePackage = packageForArtifact(effectful, {
				runtimeProfile: "ecmascript-2099-unknown-v1",
			});
			await rejectsWithoutSideEffect(effectful, unknownProfilePackage, marker);
		});

		it.each([
			["artifactId", runtimeSource({ artifactId: "@example/wrong@1.0.0" })],
			["runtimeProfile", runtimeSource({ runtimeProfile: "ecmascript-2099-unknown-v1" })],
			["exportSchemaVersion", runtimeSource({ exportSchemaVersion: "2" })],
		] as const)("rejects artifact/package %s metadata mismatch", async (_label, exactArtifactBytes) => {
			await expect(prepareRuntime(matchingRuntimeInput(exactArtifactBytes))).rejects.toThrow();
		});

		it("rejects malformed UTF-8 and a leading UTF-8 BOM", async () => {
			const malformed = Uint8Array.from([0xc3, 0x28]);
			const bom = new Uint8Array(genuineArtifactBytes.byteLength + 3);
			bom.set([0xef, 0xbb, 0xbf]);
			bom.set(genuineArtifactBytes, 3);
			for (const bytes of [malformed, bom]) {
				await expect(prepareRuntime(matchingRuntimeInput(bytes))).rejects.toThrow();
			}
		});

		it("denies static and dynamic module resolution and does not infer safety from byte substrings", async () => {
			const staticMarker = "__phase0jb_static_import_marker__";
			const dynamicMarker = "__phase0jb_dynamic_import_marker__";
			const staticDependency = `data:text/javascript,globalThis[${JSON.stringify(staticMarker)}]=true`;
			const dynamicDependency = `data:text/javascript,globalThis[${JSON.stringify(dynamicMarker)}]=true`;
			const staticImport = runtimeSource({}, `import ${JSON.stringify(staticDependency)};\n`);
			const dynamicImport = runtimeSource(
				{},
				`const unresolvedDependency = import(${JSON.stringify(dynamicDependency)});\nvoid unresolvedDependency;\n`
			);
			const harmlessSubstring = runtimeSource(
				{},
				'const harmlessText = "import(\\"not syntax\\") and export from";\nvoid harmlessText;\n'
			);

			for (const [bytes, marker] of [
				[staticImport, staticMarker],
				[dynamicImport, dynamicMarker],
			] as const) {
				delete (globalThis as Record<string, unknown>)[marker];
				await expect(prepareRuntime(matchingRuntimeInput(bytes))).rejects.toThrow();
				expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
			}
			await expect(prepareRuntime(matchingRuntimeInput(harmlessSubstring))).resolves.toMatchObject({
				artifactDigest: artifactDigest(harmlessSubstring),
			});
		});

		it.each([
			["missing blueprint", runtimeSource({}, "", "export const other = 1;")],
			[
				"extra named export",
				runtimeSource({}, "", `export const blueprint = ${plainEnvelope()};\nexport const extra = 1;`),
			],
			["default export", runtimeSource({}, "", `const blueprint = ${plainEnvelope()};\nexport default blueprint;`)],
		] as const)("requires the sole closed blueprint export: %s", async (_label, bytes) => {
			await expect(prepareRuntime(matchingRuntimeInput(bytes))).rejects.toThrow();
		});

		it("accepts Object.prototype and null-prototype envelopes and reducer tables", async () => {
			await expect(prepareRuntime(runtimeInput())).resolves.toMatchObject({
				artifactDigest: contract.artifactDigest,
			});
			const nullPrototype = envelopeSource(
				`{
					__proto__: null,
					exportSchemaVersion: 1,
					artifactId: ${JSON.stringify(contract.package.implementation.artifactId)},
					runtimeProfile: ${JSON.stringify(contract.package.implementation.runtimeProfile)},
					reducers: {
						__proto__: null,
						append: unchanged,
						set: unchanged,
						set_message: unchanged
					}
				}`,
				validPrefix()
			);
			await expect(prepareRuntime(matchingRuntimeInput(nullPrototype))).resolves.toMatchObject({
				artifactDigest: artifactDigest(nullPrototype),
			});
		});

		it.each([
			[
				"envelope accessor",
				`{
					exportSchemaVersion: 1,
					get artifactId() { return ${JSON.stringify(contract.package.implementation.artifactId)}; },
					runtimeProfile: ${JSON.stringify(contract.package.implementation.runtimeProfile)},
					reducers: { append: unchanged, set: unchanged, set_message: unchanged }
				}`,
			],
			[
				"envelope symbol",
				`{
					exportSchemaVersion: 1,
					artifactId: ${JSON.stringify(contract.package.implementation.artifactId)},
					runtimeProfile: ${JSON.stringify(contract.package.implementation.runtimeProfile)},
					reducers: { append: unchanged, set: unchanged, set_message: unchanged },
					[Symbol("extra")]: true
				}`,
			],
			[
				"envelope inherited key",
				`{
					__proto__: { inherited: true },
					exportSchemaVersion: 1,
					artifactId: ${JSON.stringify(contract.package.implementation.artifactId)},
					runtimeProfile: ${JSON.stringify(contract.package.implementation.runtimeProfile)},
					reducers: { append: unchanged, set: unchanged, set_message: unchanged }
				}`,
			],
			["envelope extra key", plainEnvelope().replace(/\n\t}$/, ",\n\t\textra: true\n\t}")],
			[
				"envelope exotic prototype",
				`new (class Envelope {
					exportSchemaVersion = 1;
					artifactId = ${JSON.stringify(contract.package.implementation.artifactId)};
					runtimeProfile = ${JSON.stringify(contract.package.implementation.runtimeProfile)};
					reducers = { append: unchanged, set: unchanged, set_message: unchanged };
				})()`,
			],
			[
				"reducer accessor",
				plainEnvelope({
					reducers: `{
						get append() { return unchanged; },
						set: unchanged,
						set_message: unchanged
					}`,
				}),
			],
			[
				"reducer symbol",
				plainEnvelope({
					reducers: `{
						append: unchanged,
						set: unchanged,
						set_message: unchanged,
						[Symbol("extra")]: unchanged
					}`,
				}),
			],
			[
				"reducer inherited key",
				plainEnvelope({
					reducers: `{
						__proto__: { inherited: unchanged },
						append: unchanged,
						set: unchanged,
						set_message: unchanged
					}`,
				}),
			],
			[
				"reducer exotic prototype",
				plainEnvelope({
					reducers: `new (class Reducers {
						append = unchanged;
						set = unchanged;
						set_message = unchanged;
					})()`,
				}),
			],
		] as const)("rejects non-closed/non-own-data export structure: %s", async (_label, envelope) => {
			const bytes = envelopeSource(envelope, validPrefix());
			await expect(prepareRuntime(matchingRuntimeInput(bytes))).rejects.toThrow();
		});

		it.each([
			["missing reducer", "{ append: unchanged, set: unchanged }"],
			["extra reducer", "{ append: unchanged, set: unchanged, set_message: unchanged, z: unchanged }"],
			[
				"async reducer",
				"{ append: async function (input) { return unchanged(input); }, set: unchanged, set_message: unchanged }",
			],
			[
				"generator reducer",
				"{ append: function* (input) { yield unchanged(input); }, set: unchanged, set_message: unchanged }",
			],
			[
				"async generator reducer",
				"{ append: async function* (input) { yield unchanged(input); }, set: unchanged, set_message: unchanged }",
			],
			["non-function reducer", "{ append: 1, set: unchanged, set_message: unchanged }"],
		] as const)("rejects reducer-map mutant: %s", async (_label, reducers) => {
			const bytes = runtimeSource({ reducers });
			await expect(prepareRuntime(matchingRuntimeInput(bytes))).rejects.toThrow();
		});

		it("preserves synchronous-reducer acceptance and async/generator rejection in the built public package", async () => {
			// The source module is intentionally checked first: this regression guards parity, not
			// the already-covered source contract.
			await expect(prepareRuntime(runtimeInput())).resolves.toMatchObject({
				artifactDigest: contract.artifactDigest,
			});

			const build = spawnSync("pnpm", ["--filter", "@ts-drp/protocol-v3", "build"], {
				cwd: REPOSITORY_ROOT,
				encoding: "utf8",
			});
			const buildDiagnostics = `${build.stdout}${build.stderr}`.trim();
			expect(build.status, buildDiagnostics).toBe(0);

			const builtPublicPath = resolve(PROTOCOL_V3_DIRECTORY, "dist/src/public.js");
			expect(existsSync(builtPublicPath), "protocol-v3 build must emit the public entry").toBe(true);
			const builtSurface = (await import(
				`${pathToFileURL(builtPublicPath).href}?phase0jbBuiltRuntimeAudit=${Date.now()}`
			)) as ProtocolV3Surface;
			expect(builtSurface.prepareBlueprintRuntime).toBeTypeOf("function");

			await expect(
				prepareRuntimeFromSurface(builtSurface, runtimeInputForSurface(builtSurface))
			).resolves.toMatchObject({
				artifactDigest: contract.artifactDigest,
			});

			for (const [label, reducers] of [
				[
					"async reducer",
					"{ append: async function (input) { return unchanged(input); }, set: unchanged, set_message: unchanged }",
				],
				[
					"generator reducer",
					"{ append: function* (input) { yield unchanged(input); }, set: unchanged, set_message: unchanged }",
				],
				[
					"async generator reducer",
					"{ append: async function* (input) { yield unchanged(input); }, set: unchanged, set_message: unchanged }",
				],
			] as const) {
				const bytes = runtimeSource({ reducers });
				await expect(
					prepareRuntimeFromSurface(
						builtSurface,
						runtimeInputForSurface(builtSurface, packageForArtifact(bytes), bytes)
					),
					`built public package must reject ${label}`
				).rejects.toThrow();
			}
		});
	}
);

describe("Phase 0j-b additive artifact-profile governance RED", () => {
	it("requires a closed additive supplement without modifying either existing frozen surface", () => {
		const errors: string[] = [];
		const governance = contract.governance;
		for (const path of governance.protectedArtifacts) {
			if (!existsSync(resolve(REPOSITORY_ROOT, path))) errors.push(`missing governed artifact: ${path}`);
		}
		if (existsSync(resolve(REPOSITORY_ROOT, PROFILE_PATH))) {
			const profile = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, PROFILE_PATH), "utf8")) as {
				readonly artifactDigestDomain?: unknown;
				readonly frozenTuple?: unknown;
				readonly profileId?: unknown;
				readonly pureAllowlist?: unknown;
				readonly runtimeProfiles?: unknown;
			};
			if (profile.profileId !== governance.profileId) errors.push("supplement profileId differs");
			if (profile.artifactDigestDomain !== contract.artifactDigestDomain) errors.push("artifact domain differs");
			if (JSON.stringify(profile.runtimeProfiles) !== JSON.stringify([governance.runtimeProfile])) {
				errors.push("runtime profile set is not the closed sole profile");
			}
			if (JSON.stringify(profile.pureAllowlist) !== JSON.stringify(governance.pureAllowlist)) {
				errors.push("pure allowlist is not exhaustively enumerated");
			}
			if (JSON.stringify(profile.frozenTuple) !== JSON.stringify(governance.frozenTuple)) {
				errors.push("supplement does not pin the existing frozen tuple");
			}
		}
		for (const [path, expected] of Object.entries(governance.immutableArtifactSha256)) {
			const absolute = resolve(REPOSITORY_ROOT, path);
			if (!existsSync(absolute) || sha256(readFileSync(absolute)) !== expected) {
				errors.push(`pre-existing frozen artifact changed: ${path}`);
			}
		}
		const frozenPolicyBytes = readFileSync(resolve(REPOSITORY_ROOT, governance.frozenTuple.freezePolicyPath));
		const frozenPolicy = JSON.parse(frozenPolicyBytes.toString("utf8")) as {
			readonly protectedPaths?: readonly string[];
		};
		const frozenPaths = frozenPolicy.protectedPaths;
		if (
			sha256(frozenPolicyBytes) !== governance.frozenTuple.freezePolicySha256 ||
			frozenPaths?.length !== governance.frozenTuple.protectedPathCount
		) {
			errors.push("existing base frozen policy tuple differs");
		} else {
			const rows = frozenPaths.map((path) => {
				const absolute = resolve(REPOSITORY_ROOT, path);
				return `${path}\0${existsSync(absolute) ? sha256(readFileSync(absolute)) : "ABSENT"}\n`;
			});
			if (sha256(rows.join("")) !== governance.frozenTuple.protectedPathStatesSha256) {
				errors.push("existing base protected artifact state differs");
			}
		}
		const ed25519Policy = JSON.parse(
			readFileSync(
				resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/freeze-policy-ed25519-profile-v1.json"),
				"utf8"
			)
		) as { readonly artifactSha256?: Readonly<Record<string, string>> };
		for (const [path, expected] of Object.entries(ed25519Policy.artifactSha256 ?? {})) {
			const absolute = resolve(REPOSITORY_ROOT, path);
			if (!existsSync(absolute) || sha256(readFileSync(absolute)) !== expected) {
				errors.push(`existing Ed25519 protected artifact changed: ${path}`);
			}
		}
		expect(errors, errors.join("\n")).toEqual([]);
	});
});

describe.runIf(governanceSurfaceExists)("Phase 0j-b additive artifact-profile governance closure", () => {
	it("binds profile, policy, documentation, workflow, and hashes as one exact additive closure", () => {
		const governance = contract.governance;
		const profile = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, PROFILE_PATH), "utf8")) as Record<string, unknown>;
		const amendmentPath = "docs/protocol/blueprint-artifact-profile-v3.json";
		const amendment = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, amendmentPath), "utf8")) as Record<
			string,
			unknown
		>;
		const addendum = readFileSync(resolve(REPOSITORY_ROOT, "docs/protocol/blueprint-artifact-profile-v3.md"), "utf8");
		const policy = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, PROFILE_POLICY_PATH), "utf8")) as Record<
			string,
			unknown
		>;
		const workflow = readFileSync(resolve(REPOSITORY_ROOT, PROFILE_WORKFLOW_PATH), "utf8");
		const errors: string[] = [];

		for (const [label, record] of [
			["profile", profile],
			["amendment", amendment],
		] as const) {
			if (record.profileId !== governance.profileId) errors.push(`${label} profileId differs`);
			if (record.artifactDigestDomain !== contract.artifactDigestDomain) {
				errors.push(`${label} artifact domain differs`);
			}
			if (JSON.stringify(record.runtimeProfiles) !== JSON.stringify([governance.runtimeProfile])) {
				errors.push(`${label} runtimeProfiles is not the closed sole profile`);
			}
			if (JSON.stringify(record.pureAllowlist) !== JSON.stringify(governance.pureAllowlist)) {
				errors.push(`${label} pure allowlist differs`);
			}
			if (JSON.stringify(record.frozenTuple) !== JSON.stringify(governance.frozenTuple)) {
				errors.push(`${label} frozen tuple differs`);
			}
		}
		for (const requiredText of [
			governance.profileId,
			contract.artifactDigestDomain,
			governance.runtimeProfile,
			...governance.pureAllowlist.identifiers,
			...governance.pureAllowlist.mathMembers,
		]) {
			if (!addendum.includes(requiredText)) errors.push(`addendum omits ${requiredText}`);
		}

		if (policy.profileId !== governance.profileId) errors.push("policy profileId differs");
		if (JSON.stringify(policy.frozenTuple) !== JSON.stringify(governance.frozenTuple)) {
			errors.push("policy frozen tuple differs");
		}
		if (JSON.stringify(policy.protectedArtifacts) !== JSON.stringify(governance.protectedArtifacts)) {
			errors.push("policy protectedArtifacts differs");
		}
		const expectedHashPaths = governance.protectedArtifacts.filter((path) => path !== PROFILE_POLICY_PATH);
		const artifactSha256 = policy.artifactSha256 as Record<string, unknown> | undefined;
		if (
			artifactSha256 === undefined ||
			JSON.stringify(Object.keys(artifactSha256).sort()) !== JSON.stringify([...expectedHashPaths].sort())
		) {
			errors.push("policy artifactSha256 does not close every non-policy artifact");
		} else {
			for (const path of expectedHashPaths) {
				if (artifactSha256[path] !== sha256(readFileSync(resolve(REPOSITORY_ROOT, path)))) {
					errors.push(`policy digest differs for ${path}`);
				}
			}
		}
		const checkerDigest = sha256(readFileSync(resolve(REPOSITORY_ROOT, PROFILE_CHECKER_PATH)));
		if (policy.checkerSha256 !== checkerDigest || artifactSha256?.[PROFILE_CHECKER_PATH] !== checkerDigest) {
			errors.push("policy checker self-pin differs");
		}

		for (const requiredWorkflowText of [
			"pull_request:",
			"fetch-depth: 0",
			"BASE_SHA: ${{ github.event.pull_request.base.sha }}",
			`CHECKER: ${PROFILE_CHECKER_PATH}`,
			'git show "$BASE_SHA:$CHECKER"',
			'node "$RUNNER_TEMP/check-blueprint-artifact-profile-freeze.mjs" "$BASE_SHA"',
			`node ${PROFILE_CHECKER_PATH} "$BASE_SHA"`,
		]) {
			if (!workflow.includes(requiredWorkflowText)) errors.push(`workflow omits ${requiredWorkflowText}`);
		}
		for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /^\s+[A-Za-z-]+:\s+write\s*$/mu]) {
			if (forbidden.test(workflow)) errors.push(`workflow contains forbidden ${forbidden}`);
		}
		expect(errors, errors.join("\n")).toEqual([]);
	});

	it("provides a pure exact-map evaluator and a current-tree CLI that fail closed", async () => {
		const checker = (await import(
			`${pathToFileURL(resolve(REPOSITORY_ROOT, PROFILE_CHECKER_PATH)).href}?phase0jb=${Date.now()}`
		)) as ArtifactProfileFreezeChecker;
		const evaluate = checker.evaluateBlueprintArtifactProfileFreeze;
		expect(evaluate).toBeTypeOf("function");
		if (evaluate === undefined) return;

		const protectedArtifacts = contract.governance.protectedArtifacts;
		const exact = Object.fromEntries(
			protectedArtifacts.map((path) => [path, sha256(readFileSync(resolve(REPOSITORY_ROOT, path)))])
		);
		expect(evaluate({ base: exact, head: exact, protectedArtifacts })).toEqual({
			accepted: true,
			errors: [],
		});

		const drifted = { ...exact, [protectedArtifacts[0]]: "00".repeat(32) };
		const missing = { ...exact };
		delete missing[protectedArtifacts[1]];
		const extra = { ...exact, "not-governed": "11".repeat(32) };
		for (const head of [drifted, missing, extra]) {
			expect(evaluate({ base: exact, head, protectedArtifacts }).accepted).toBe(false);
		}
		expect(evaluate({ base: exact, head: exact, protectedArtifacts: protectedArtifacts.slice(1) }).accepted).toBe(
			false
		);

		const result = spawnSync(process.execPath, [resolve(REPOSITORY_ROOT, PROFILE_CHECKER_PATH)], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(result.status, `${result.stdout}${result.stderr}`.trim()).toBe(0);
	});
});
