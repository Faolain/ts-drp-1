import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { writeSyntheticReceipt } from "./fixtures/track-p2-e/build-synthetic-bundle.mjs";
import contract from "./fixtures/track-p2-e/integration-contract.json" with { type: "json" };
import catalogManifest from "../packages/blueprint-catalog/package.json" with { type: "json" };
import { openTrustedBlueprintCatalog, type TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";
import toolchainManifest from "../packages/blueprint-toolchain/package.json" with { type: "json" };
import { buildBlueprint, runBlueprintCli } from "../packages/blueprint-toolchain/src/index.js";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "../packages/protocol-v3/src/public.js";

type AdmissionInput = {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
};
type RuntimeInput = AdmissionInput & {
	readonly exactArtifactBytes: Uint8Array;
	readonly preparedBlueprintAdmission: unknown;
};

const preparationProbe = {
	admissionInputs: [] as AdmissionInput[],
	events: [] as string[],
	runtimeInputs: [] as RuntimeInput[],
};

type Bundle = {
	readonly artifactBytes: Buffer;
	readonly authoring: Record<string, unknown>;
	readonly blueprintDigest: string;
	readonly directory: string;
	readonly lintBytes: Buffer;
	readonly packageBytes: Buffer;
	readonly receiptBytes: Buffer;
};
type AuthoringCase = { readonly action: string; readonly id: string };
type AuthoringValue = {
	readonly artifactId: string;
	readonly conformance: {
		readonly corpusVersion: string;
		readonly initialState: unknown;
		readonly nightlyAdditionalCases: readonly AuthoringCase[];
		readonly prCases: readonly AuthoringCase[];
		readonly seed: string;
	};
	readonly operationDiscriminator: string;
	readonly operations: readonly { readonly name: string }[];
};
type WorkflowStep = {
	readonly "continue-on-error"?: boolean;
	readonly "env"?: Readonly<Record<string, string>>;
	readonly "if"?: string;
	readonly "run"?: string;
};
type WorkflowJob = {
	readonly "continue-on-error"?: boolean;
	readonly "if"?: string;
	readonly "needs"?: string | readonly string[];
	readonly "steps": readonly WorkflowStep[];
	readonly "uses"?: string;
	readonly "with"?: { readonly tier?: string };
};
type WorkflowValue = {
	readonly jobs: Readonly<Record<string, WorkflowJob>>;
	readonly on: {
		readonly pull_request: unknown;
		readonly schedule: readonly { readonly cron: string }[];
		readonly workflow_call: {
			readonly inputs: { readonly tier: { readonly required: boolean; readonly type: string } };
		};
	};
};

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const FIRST_FIXTURE = path.join(REPOSITORY_ROOT, "tests/fixtures/track-p2-a/forward-counter");
const SECOND_FIXTURE = path.join(REPOSITORY_ROOT, contract.secondFixtureDirectory);
const GOLDEN_NAMES = contract.secondFixtureGoldens;
const temporaryDirectories: string[] = [];
const P2E_EXACT_ARTIFACT = "tests/fixtures/track-p2-e/message-register/artifact.mjs";

function temporaryRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-e-${label}-`));
	temporaryDirectories.push(root);
	return root;
}

function copiedAuthoring(root: string, source: string): string {
	const authoring = path.join(root, "authoring");
	fs.mkdirSync(authoring);
	for (const filename of ["blueprint.json", "blueprint.ts"])
		fs.copyFileSync(path.join(source, filename), path.join(authoring, filename));
	return authoring;
}

function outputBytes(directory: string): Readonly<Record<string, Buffer>> {
	return Object.fromEntries(
		fs
			.readdirSync(directory)
			.sort()
			.map((filename) => [filename, fs.readFileSync(path.join(directory, filename))])
	);
}

function goldenBytes(): Readonly<Record<string, Buffer>> {
	return Object.fromEntries(
		GOLDEN_NAMES.map((filename) => [filename, fs.readFileSync(path.join(SECOND_FIXTURE, filename))])
	);
}

function commandOutput(command: string, arguments_: readonly string[], cwd = REPOSITORY_ROOT): string {
	return execFileSync(command, [...arguments_], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function declarationExportNames(declaration: string): readonly string[] {
	const sourceFile = ts.createSourceFile("index.d.ts", declaration, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const names: string[] = [];
	for (const statement of sourceFile.statements) {
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (ts.isExportDeclaration(statement)) {
			if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) names.push("*");
			else for (const element of statement.exportClause.elements) names.push(element.name.text);
			continue;
		}
		if (!modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (
			ts.isClassDeclaration(statement) ||
			ts.isFunctionDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
		) {
			if (statement.name) names.push(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations)
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
		}
	}
	return names;
}

function guardAllowedTiers(script: string): readonly string[] {
	const match = /^case "\$TRACK_P2_TIER" in\n {2}([a-z]+(?: \| [a-z]+)*)\) ;;\n {2}\*\) exit 1 ;;\nesac$/u.exec(script);
	if (match?.[1] === undefined) throw new TypeError("tier guard must be one exact validation-only case statement");
	return match[1].split(" | ");
}

function closedAuthoringWorkflowScript(tier: "pr" | "nightly"): string {
	const authoring = `$RUNNER_TEMP/track-p2-${tier}-authoring`;
	return [
		`authoring="${authoring}"`,
		'cleanup() { rm -rf "$authoring"; }',
		"trap cleanup EXIT",
		'mkdir "$authoring"',
		'cp tests/fixtures/track-p2-e/message-register/blueprint.json "$authoring/blueprint.json"',
		'cp tests/fixtures/track-p2-e/message-register/blueprint.ts "$authoring/blueprint.ts"',
		`node packages/blueprint-toolchain/bin/drp-blueprint.mjs build --dir "$authoring" --out "$RUNNER_TEMP/track-p2-${tier}" --tier ${tier}`,
		"cleanup",
		"trap - EXIT",
	].join("\n");
}

async function buildSyntheticNightly(label: string, source: string): Promise<Bundle> {
	const root = temporaryRoot(label);
	const authoringDirectory = copiedAuthoring(root, source);
	const directory = path.join(root, "bundle");
	// The integration fixture uses a clearly synthetic offline receipt. The
	// unchanged P2-c suite remains the sole owner of live four-engine evidence.
	await buildBlueprint(authoringDirectory, directory);
	return writeSyntheticReceipt(authoringDirectory, directory) as Bundle;
}

async function prepareInjectedProvenDigestSuffix(
	catalog: TrustedBlueprintCatalog,
	provenDigest: string,
	effects: { index: number; live: number },
	mutate?: (resolved: ReturnType<TrustedBlueprintCatalog["resolve"]>) => ReturnType<TrustedBlueprintCatalog["resolve"]>,
	preparers: {
		readonly admission: typeof prepareBlueprintAdmission;
		readonly runtime: typeof prepareBlueprintRuntime;
	} = { admission: prepareBlueprintAdmission, runtime: prepareBlueprintRuntime }
): Promise<Readonly<Record<string, string>>> {
	preparationProbe.events.push("catalog.resolve");
	let resolved = catalog.resolve(provenDigest);
	if (resolved.blueprintDigest !== provenDigest) throw new TypeError("resolved blueprint digest mismatch");
	resolved = mutate?.(resolved) ?? resolved;
	const preparedBlueprintAdmission = preparers.admission({
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: provenDigest,
	});
	await preparers.runtime({
		preparedBlueprintAdmission,
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: provenDigest,
		exactArtifactBytes: resolved.exactArtifactBytes,
	});
	effects.index++;
	preparationProbe.events.push("index:constructed");
	effects.live++;
	preparationProbe.events.push("live:enabled");
	return Object.freeze({
		artifactDigest: resolved.artifactDigest,
		blueprintDigest: resolved.blueprintDigest,
		catalogDigest: resolved.evidence.catalogDigest,
	});
}

beforeEach(() => {
	preparationProbe.admissionInputs.length = 0;
	preparationProbe.events.length = 0;
	preparationProbe.runtimeInputs.length = 0;
});

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe.sequential("Track P2-e authoring guide and injected-proven-digest integration RED", () => {
	it("uses an independently authored second v3 fixture with a distinct manifest, corpus, source and artifact", async () => {
		const firstJson = fs.readFileSync(path.join(FIRST_FIXTURE, "blueprint.json"));
		const secondJson = fs.readFileSync(path.join(SECOND_FIXTURE, "blueprint.json"));
		const firstSource = fs.readFileSync(path.join(FIRST_FIXTURE, "blueprint.ts"));
		const secondSource = fs.readFileSync(path.join(SECOND_FIXTURE, "blueprint.ts"));
		expect(secondJson).not.toEqual(firstJson);
		expect(secondSource).not.toEqual(firstSource);
		const first = JSON.parse(firstJson.toString("utf8")) as AuthoringValue;
		const second = JSON.parse(secondJson.toString("utf8")) as AuthoringValue;
		expect(second.artifactId).not.toBe(first.artifactId);
		expect(second.operationDiscriminator).not.toBe(first.operationDiscriminator);
		expect(second.operations.map(({ name }: { readonly name: string }) => name)).not.toEqual(
			first.operations.map(({ name }: { readonly name: string }) => name)
		);
		expect(second.conformance.corpusVersion).not.toBe(first.conformance.corpusVersion);
		expect(second.conformance.seed).not.toBe(first.conformance.seed);
		const bundle = await buildSyntheticNightly("independent", SECOND_FIXTURE);
		expect(bundle.artifactBytes).not.toEqual(fs.readFileSync(path.join(FIRST_FIXTURE, "artifact.mjs")));
		expect(outputBytes(bundle.directory)).toEqual(goldenBytes());
	});

	it("rebuilds two independent copies to the committed second-fixture goldens", async () => {
		const firstA = await buildSyntheticNightly("first-a", FIRST_FIXTURE);
		const firstB = await buildSyntheticNightly("first-b", FIRST_FIXTURE);
		const secondA = await buildSyntheticNightly("second-a", SECOND_FIXTURE);
		const secondB = await buildSyntheticNightly("second-b", SECOND_FIXTURE);
		expect(outputBytes(firstB.directory)).toEqual(outputBytes(firstA.directory));
		expect(outputBytes(secondB.directory)).toEqual(outputBytes(secondA.directory));
		expect(outputBytes(secondA.directory)).toEqual(goldenBytes());
	});

	it("rebuilds the committed second fixture in a genuine fresh process from a clean index worktree", () => {
		const root = temporaryRoot("clean-worktree");
		const index = path.join(root, "index");
		const tree = commandOutput("git", ["write-tree"]).trim();
		const commit = commandOutput("git", [
			"-c",
			"user.name=Track P2-e Fixture",
			"-c",
			"user.email=track-p2-e@example.invalid",
			"commit-tree",
			tree,
			"-p",
			"HEAD",
			"-m",
			"track-p2-e-clean-index",
		]).trim();
		commandOutput("git", ["worktree", "add", "--detach", index, commit]);
		try {
			commandOutput("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], index);
			commandOutput("pnpm", ["--filter", "@ts-drp/blueprint-toolchain...", "build"], index);
			const output = path.join(root, "bundle");
			const child = spawnSync(
				process.execPath,
				["tests/fixtures/track-p2-e/build-synthetic-bundle.mjs", contract.secondFixtureDirectory, output],
				{ cwd: index, encoding: "utf8" }
			);
			if (child.error) throw child.error;
			expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
			expect(outputBytes(output)).toEqual(goldenBytes());
		} finally {
			commandOutput("git", ["worktree", "remove", "--force", index]);
		}
	}, 60_000);

	it("resolves an exact sorted two-entry catalog with fresh bytes and rejects a cross-pair", async () => {
		const firstA = await buildSyntheticNightly("catalog-first", FIRST_FIXTURE);
		const secondA = await buildSyntheticNightly("catalog-second", SECOND_FIXTURE);

		const root = temporaryRoot("catalog");
		const directory = path.join(root, "catalog");
		await runBlueprintCli([
			"catalog",
			"--directory",
			directory,
			"--bundle",
			secondA.directory,
			"--bundle",
			firstA.directory,
		]);
		const catalog = openTrustedBlueprintCatalog({ catalogDirectory: directory });
		const expected = [firstA.blueprintDigest, secondA.blueprintDigest].sort();
		expect(catalog.blueprintDigests).toEqual(expected);
		const firstResolved = catalog.resolve(firstA.blueprintDigest);
		const secondResolved = catalog.resolve(secondA.blueprintDigest);
		expect(firstResolved.exactArtifactBytes).toEqual(firstA.artifactBytes);
		expect(secondResolved.exactArtifactBytes).toEqual(secondA.artifactBytes);
		expect(firstResolved.canonicalBlueprintPackageBytes).toEqual(firstA.packageBytes);
		expect(secondResolved.canonicalBlueprintPackageBytes).toEqual(secondA.packageBytes);
		firstResolved.exactArtifactBytes.fill(0);
		firstResolved.canonicalBlueprintPackageBytes.fill(0);
		expect(catalog.resolve(firstA.blueprintDigest).exactArtifactBytes).toEqual(firstA.artifactBytes);
		expect(catalog.resolve(firstA.blueprintDigest).canonicalBlueprintPackageBytes).toEqual(firstA.packageBytes);
		expect(() => catalog.resolve("00".repeat(32))).toThrowError(
			expect.objectContaining({ code: "BLUEPRINT_NOT_CATALOGUED" })
		);
		const crossed = temporaryRoot("cross-pair");
		fs.cpSync(directory, crossed, { recursive: true });
		fs.writeFileSync(
			path.join(crossed, `${firstA.blueprintDigest}.artifact.mjs`),
			fs.readFileSync(path.join(directory, `${secondA.blueprintDigest}.artifact.mjs`))
		);
		expect(() => openTrustedBlueprintCatalog({ catalogDirectory: crossed })).toThrowError(
			expect.objectContaining({ code: "BLUEPRINT_ARTIFACT_DIGEST_MISMATCH" })
		);
	});

	it("performs only D.93.9 steps 3–6 from an injected proven digest and discards both capabilities", async () => {
		const bundle = await buildSyntheticNightly("handoff", SECOND_FIXTURE);
		const root = temporaryRoot("handoff-catalog");
		const directory = path.join(root, "catalog");
		await runBlueprintCli(["catalog", "--directory", directory, "--bundle", bundle.directory]);
		const catalog = openTrustedBlueprintCatalog({ catalogDirectory: directory });
		preparationProbe.admissionInputs.length = 0;
		preparationProbe.events.length = 0;
		preparationProbe.runtimeInputs.length = 0;
		const effects = { index: 0, live: 0 };
		const result = await prepareInjectedProvenDigestSuffix(catalog, bundle.blueprintDigest, effects, undefined, {
			admission(input) {
				preparationProbe.events.push("prepareBlueprintAdmission");
				preparationProbe.admissionInputs.push({
					canonicalBlueprintPackageBytes: new Uint8Array(input.canonicalBlueprintPackageBytes),
					expectedBlueprintDigest: input.expectedBlueprintDigest,
				});
				return prepareBlueprintAdmission(input);
			},
			async runtime(input) {
				preparationProbe.events.push("prepareBlueprintRuntime:start");
				preparationProbe.runtimeInputs.push({
					...input,
					canonicalBlueprintPackageBytes: new Uint8Array(input.canonicalBlueprintPackageBytes),
					exactArtifactBytes: new Uint8Array(input.exactArtifactBytes),
				});
				const prepared = await prepareBlueprintRuntime(input);
				preparationProbe.events.push("prepareBlueprintRuntime:success");
				return prepared;
			},
		});
		expect(preparationProbe.events).toEqual([
			"catalog.resolve",
			"prepareBlueprintAdmission",
			"prepareBlueprintRuntime:start",
			"prepareBlueprintRuntime:success",
			"index:constructed",
			"live:enabled",
		]);
		expect(preparationProbe.admissionInputs).toEqual([
			{
				canonicalBlueprintPackageBytes: new Uint8Array(bundle.packageBytes),
				expectedBlueprintDigest: bundle.blueprintDigest,
			},
		]);
		expect(Reflect.ownKeys(preparationProbe.admissionInputs[0]).sort()).toEqual(
			["canonicalBlueprintPackageBytes", "expectedBlueprintDigest"].sort()
		);
		expect(preparationProbe.runtimeInputs).toHaveLength(1);
		expect(Reflect.ownKeys(preparationProbe.runtimeInputs[0]).sort()).toEqual(
			[
				"preparedBlueprintAdmission",
				"canonicalBlueprintPackageBytes",
				"expectedBlueprintDigest",
				"exactArtifactBytes",
			].sort()
		);
		expect(preparationProbe.runtimeInputs[0]).toMatchObject({ expectedBlueprintDigest: bundle.blueprintDigest });
		expect(Buffer.from(preparationProbe.runtimeInputs[0].canonicalBlueprintPackageBytes)).toEqual(bundle.packageBytes);
		expect(Buffer.from(preparationProbe.runtimeInputs[0].exactArtifactBytes)).toEqual(bundle.artifactBytes);
		expect(effects).toEqual({ index: 1, live: 1 });
		expect(Reflect.ownKeys(result).sort()).toEqual(["artifactDigest", "blueprintDigest", "catalogDigest"]);
		expect(JSON.stringify(result)).not.toMatch(/capabil|prepared|reducer|subscribe|append|issuance/iu);
	});

	it("rejects resolve, digest and runtime cross-pair mutants before index or live effects", async () => {
		const bundle = await buildSyntheticNightly("failures", SECOND_FIXTURE);
		const root = temporaryRoot("failure-catalog");
		const directory = path.join(root, "catalog");
		await runBlueprintCli(["catalog", "--directory", directory, "--bundle", bundle.directory]);
		const catalog = openTrustedBlueprintCatalog({ catalogDirectory: directory });
		for (const [label, digest, mutate] of [
			["not catalogued", "00".repeat(32), undefined],
			[
				"admission package bytes",
				bundle.blueprintDigest,
				(resolved: ReturnType<TrustedBlueprintCatalog["resolve"]>): ReturnType<TrustedBlueprintCatalog["resolve"]> => ({
					...resolved,
					canonicalBlueprintPackageBytes: new Uint8Array([...resolved.canonicalBlueprintPackageBytes, 0x00]),
				}),
			],
			[
				"runtime artifact cross-pair",
				bundle.blueprintDigest,
				(resolved: ReturnType<TrustedBlueprintCatalog["resolve"]>): ReturnType<TrustedBlueprintCatalog["resolve"]> => ({
					...resolved,
					exactArtifactBytes: new Uint8Array([...resolved.exactArtifactBytes, 0x0a]),
				}),
			],
		] as const) {
			const effects = { index: 0, live: 0 };
			await expect(prepareInjectedProvenDigestSuffix(catalog, digest, effects, mutate), label).rejects.toThrow();
			expect(effects, label).toEqual({ index: 0, live: 0 });
		}
		const lyingCatalog = {
			...catalog,
			resolve: (): ReturnType<TrustedBlueprintCatalog["resolve"]> => ({
				...catalog.resolve(bundle.blueprintDigest),
				blueprintDigest: "11".repeat(32),
			}),
		};
		const effects = { index: 0, live: 0 };
		await expect(prepareInjectedProvenDigestSuffix(lyingCatalog, bundle.blueprintDigest, effects)).rejects.toThrow(
			"resolved blueprint digest mismatch"
		);
		expect(effects).toEqual({ index: 0, live: 0 });
	});

	it("ships only the exact catalog declaration/runtime root with no P2 shipping activation", () => {
		expect(catalogManifest.files).toEqual(contract.catalogPackageFiles);
		expect(catalogManifest.exports).toEqual({
			".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" },
		});
		expect(catalogManifest.types).toBe("./dist/src/index.d.ts");
		expect(catalogManifest.dependencies).toEqual(contract.catalogPackageDependencies);
		expect(toolchainManifest.private).toBe(true);
		expect(Object.keys(toolchainManifest.exports)).toEqual(["."]);
		const shipping = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, contract.shippingManifestPath), "utf8")) as {
			readonly shippingTargets: readonly { readonly id: string; readonly state: string }[];
		};
		expect(shipping.shippingTargets).toEqual([expect.objectContaining({ id: "electron-desktop", state: "inactive" })]);
		expect(JSON.stringify(shipping)).not.toMatch(/blueprint|toolchain|catalog/iu);
	});

	it("governs the exact P2-e artifact as byte-frozen input outside Prettier ownership", () => {
		const ignored = fs
			.readFileSync(path.join(REPOSITORY_ROOT, ".prettierignore"), "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(ignored.filter((line) => line === P2E_EXACT_ARTIFACT)).toEqual([P2E_EXACT_ARTIFACT]);
	});

	it("runs the real workflow-owned format gate without rewriting the exact artifact", () => {
		const artifactPath = path.join(REPOSITORY_ROOT, P2E_EXACT_ARTIFACT);
		const before = sha256(fs.readFileSync(artifactPath));
		expect(before).toBe("bceecd68c745fd9aa01448d2531eb96096667c7a166850b96a0080cdd3956f13");
		commandOutput("pnpm", contract.ownedGateCommands.format.split(" ").slice(1));
		expect(sha256(fs.readFileSync(artifactPath))).toBe(before);
	});

	it("audits emitted declarations and consumes the exact packed runtime without exposing the private toolchain", () => {
		commandOutput("pnpm", ["--filter", "@ts-drp/blueprint-catalog", "build"]);
		const declarationPath = path.join(REPOSITORY_ROOT, "packages/blueprint-catalog/dist/src/index.d.ts");
		const declaration = fs.readFileSync(declarationPath, "utf8");
		const declarationExports = declarationExportNames(declaration);
		expect([...declarationExports].sort()).toEqual([...contract.catalogDeclarationExports].sort());
		expect(declaration).not.toMatch(/PreparedBlueprint|Capability|buildBlueprint|runBlueprintCli/u);

		const root = temporaryRoot("packed-consumer");
		const packJson = JSON.parse(
			commandOutput(
				"npm",
				["pack", "--json", "--ignore-scripts", "--pack-destination", root],
				path.join(REPOSITORY_ROOT, "packages/blueprint-catalog")
			)
		) as readonly [{ readonly filename: string }];
		const archive = path.join(root, packJson[0].filename);
		const packedFiles = commandOutput("tar", ["-tzf", archive]).trim().split("\n").sort();
		expect(packedFiles).toEqual([...contract.catalogPackedFiles].sort());
		expect(packedFiles.join("\n")).not.toMatch(/blueprint-toolchain|track-p2-e|fixtures/iu);

		const consumer = path.join(root, "consumer");
		const scope = path.join(consumer, "node_modules/@ts-drp");
		fs.mkdirSync(scope, { recursive: true });
		commandOutput("tar", ["-xzf", archive, "-C", scope]);
		fs.renameSync(path.join(scope, "package"), path.join(scope, "blueprint-catalog"));
		for (const dependency of ["canonical", "errors", "protocol-v3"])
			fs.symlinkSync(path.join(REPOSITORY_ROOT, "packages", dependency), path.join(scope, dependency), "dir");
		fs.symlinkSync(
			fs.realpathSync(path.join(REPOSITORY_ROOT, "packages/blueprint-catalog/node_modules/es-module-lexer")),
			path.join(consumer, "node_modules/es-module-lexer"),
			"dir"
		);
		fs.writeFileSync(
			path.join(consumer, "consumer.mjs"),
			'import * as catalog from "@ts-drp/blueprint-catalog";\nprocess.stdout.write(JSON.stringify(Object.keys(catalog).sort()));\n'
		);
		const runtimeExports = JSON.parse(commandOutput(process.execPath, ["consumer.mjs"], consumer)) as readonly string[];
		expect(runtimeExports).toEqual([...contract.catalogRuntimeExports].sort());
		fs.writeFileSync(
			path.join(consumer, "consumer.ts"),
			`import { BlueprintCatalogError, openTrustedBlueprintCatalog, type ResolvedBlueprintBytes, type TrustedBlueprintCatalog, type TrustedBlueprintCatalogOptions } from "@ts-drp/blueprint-catalog";\nconst options: TrustedBlueprintCatalogOptions = { catalogDirectory: "/trusted" };\nconst catalog: TrustedBlueprintCatalog = openTrustedBlueprintCatalog(options);\nconst resolved: ResolvedBlueprintBytes = catalog.resolve(catalog.blueprintDigests[0] ?? "");\nvoid BlueprintCatalogError; void resolved;\n// @ts-expect-error P2 exports no preparation or runtime authority.\nresolved.preparedBlueprintRuntime;\n`
		);
		fs.writeFileSync(
			path.join(consumer, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true },
			})
		);
		commandOutput("pnpm", ["exec", "tsc", "-p", path.join(consumer, "tsconfig.json")]);
	});

	it("provides a durable guide that points to owners and forbids live authority in the authoring path", () => {
		const guide = fs.readFileSync(path.join(REPOSITORY_ROOT, contract.guidePath), "utf8");
		expect(guide).toContain("@ts-drp/blueprint-toolchain");
		expect(guide).toContain("@ts-drp/blueprint-catalog");
		expect(guide).toContain("Phase 3a");
		expect(guide).toMatch(/reviewed.*local.*catalog/iu);
		expect(guide).toMatch(/network.*unsupported/iu);
		expect(guide).toContain("Controlled conformance executes reducers only inside the evidence harness.");
		expect(guide).toContain("The catalog does not execute reducers or fold application state.");
		expect(guide).toContain("Phase 3a executes zero reducers and completes preparation before any live effect.");
		expect(guide).toMatch(/exact bytes/iu);
		expect(guide).not.toMatch(/PreparedBlueprint[A-Za-z]+/u);
	});

	it("assigns exact PR and nightly jobs, reusable tier input and fail-closed owned gates", () => {
		const workflow = parseDocument(fs.readFileSync(path.join(REPOSITORY_ROOT, contract.workflowPath), "utf8"), {
			schema: "core",
		}).toJS() as WorkflowValue;
		expect(workflow.on.pull_request).toEqual({});
		expect(workflow.on.schedule.length).toBeGreaterThan(0);
		for (const schedule of workflow.on.schedule) expect(schedule.cron).toMatch(/\S/u);
		expect(workflow.on.workflow_call.inputs.tier).toEqual({ required: true, type: "string" });
		expect(Object.keys(workflow.jobs).sort()).toEqual(["track-p2-nightly", "track-p2-pr", "track-p2-tier-guard"]);
		const guard = workflow.jobs["track-p2-tier-guard"];
		expect(guard["continue-on-error"]).toBeUndefined();
		expect(guard.if).toBeUndefined();
		expect(guard.steps).toHaveLength(1);
		expect(guard.steps[0].if).toBeUndefined();
		expect(guard.steps[0].env).toEqual({
			TRACK_P2_TIER:
				"${{ github.event_name == 'pull_request' && 'pr' || github.event_name == 'schedule' && 'nightly' || inputs.tier }}",
		});
		const guardRun = guard.steps[0].run;
		expect(guardRun).toBeTypeOf("string");
		expect(guardAllowedTiers(guardRun as string)).toEqual(["pr", "nightly"]);
		for (const tier of ["pr", "nightly"]) {
			const result = spawnSync("bash", ["-eu", "-o", "pipefail", "-c", guardRun as string], {
				env: { ...process.env, TRACK_P2_TIER: tier },
			});
			expect(result.status, `${tier}: ${result.stderr.toString("utf8")}`).toBe(0);
		}
		for (const tier of ["", "ci", "PR", "nightly "]) {
			const result = spawnSync("bash", ["-eu", "-o", "pipefail", "-c", guardRun as string], {
				env: { ...process.env, TRACK_P2_TIER: tier },
			});
			expect(result.status, `unsupported tier ${JSON.stringify(tier)} must fail closed`).not.toBe(0);
		}
		expect(workflow.jobs["track-p2-pr"].needs).toBe("track-p2-tier-guard");
		expect(workflow.jobs["track-p2-nightly"].needs).toBe("track-p2-tier-guard");
		expect(workflow.jobs["track-p2-pr"].if).toBe("${{ github.event_name == 'pull_request' || inputs.tier == 'pr' }}");
		expect(workflow.jobs["track-p2-nightly"].if).toBe(
			"${{ github.event_name == 'schedule' || inputs.tier == 'nightly' }}"
		);
		const prRuns = workflow.jobs["track-p2-pr"].steps.flatMap((step) =>
			typeof step.run === "string" ? [step.run] : []
		);
		const nightlyRuns = workflow.jobs["track-p2-nightly"].steps.flatMap((step) =>
			typeof step.run === "string" ? [step.run] : []
		);
		const allRuns = Object.values(workflow.jobs)
			.flatMap((job) => job.steps)
			.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
		expect(prRuns).toContain(`pnpm exec vitest run ${contract.prTests.join(" ")} --coverage.enabled=false`);
		for (const [jobName, job] of Object.entries(workflow.jobs)) {
			if (jobName === "track-p2-nightly") continue;
			const runs = job.steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
			for (const test of contract.nightlyTests) expect(runs.every((run) => !run.includes(test))).toBe(true);
		}
		expect(nightlyRuns).toContain(`pnpm exec vitest run ${contract.nightlyTests.join(" ")} --coverage.enabled=false`);
		for (const [tier, runs] of [
			["pr", prRuns],
			["nightly", nightlyRuns],
		] as const) {
			const productionBuilds = runs.filter((run) =>
				run.includes("packages/blueprint-toolchain/bin/drp-blueprint.mjs build")
			);
			expect(productionBuilds).toEqual([closedAuthoringWorkflowScript(tier)]);
		}
		expect(prRuns.every((run) => !run.includes("--tier nightly"))).toBe(true);
		expect(nightlyRuns.every((run) => !run.includes("--tier pr"))).toBe(true);
		expect(guardRun).not.toMatch(/\b(?:pnpm|node|vitest|drp-blueprint|build|test)\b/u);
		for (const command of Object.values(contract.ownedGateCommands)) {
			expect(prRuns).toContain(command);
			expect(nightlyRuns).toContain(command);
		}
		for (const golden of contract.secondFixtureGoldens) expect(allRuns.join("\n")).toContain(golden);
		for (const job of Object.values(workflow.jobs)) {
			expect(job["continue-on-error"]).toBeUndefined();
			for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
		}
	});

	it("keeps both direct P2 and unchanged 0j-c conformance jobs as release publication dependencies", () => {
		const release = parseDocument(fs.readFileSync(path.join(REPOSITORY_ROOT, contract.releaseWorkflowPath), "utf8"), {
			schema: "core",
		}).toJS() as {
			readonly jobs: Readonly<
				Record<
					string,
					{ readonly needs?: readonly string[]; readonly uses?: string; readonly with?: { readonly tier: string } }
				>
			>;
		};
		expect(release.jobs["phase-0j-c-release-conformance"].uses).toBe(
			"./.github/workflows/protocol-v3-blueprint-conformance.yml"
		);
		expect(release.jobs["track-p2-release-conformance"]).toMatchObject({
			uses: "./.github/workflows/track-p2-blueprint-catalog.yml",
			with: { tier: "nightly" },
		});
		expect(release.jobs.npm_publish.needs).toEqual(
			expect.arrayContaining(["phase-0j-c-release-conformance", "track-p2-release-conformance"])
		);
	});
});
