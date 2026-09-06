import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import { createMemoryAheDurableStore } from "@ts-drp/storage";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { bytesHex, makeCreatorMaterial } from "../../../tests/fixtures/phase-3a0-v3/controlled-anchor-trust.js";

type MutationOperation = "beginGeneration" | "completeGeneration" | "promoteReference" | "putCachedBlob" | "swapHead";

type CrashCheckpoint =
	| Readonly<{
			edge: "after-statement";
			occurrence: number;
			operation: MutationOperation;
			statement:
				| "blob-insert"
				| "generation-insert"
				| "generation-update"
				| "head-upsert"
				| "object-ensure"
				| "promotion-insert";
	  }>
	| Readonly<{ edge: "after-commit" | "before-commit"; operation: MutationOperation }>;

type Scenario = Readonly<{ checkpoints: readonly CrashCheckpoint[]; name: "combined" | "creator" }>;
type ChildMessage = Readonly<{
	checkpoint?: CrashCheckpoint;
	kind: string;
	message?: string;
	result?: Readonly<{ ok: boolean; reason?: string }>;
	state?: unknown;
}>;
type ChildRun = Readonly<{
	exitCode: number | null;
	messages: readonly ChildMessage[];
	signal: NodeJS.Signals | null;
	stderr: string;
}>;
type ExpectedAuthority = Readonly<{
	anchorDigest: string;
	blueprintDigest: string;
	epoch: number;
	objectId: string;
	parametersDigest: string;
	profileDigest: string;
	signerSetDigest: string;
}>;

const commitEdges = (operation: MutationOperation): readonly CrashCheckpoint[] => [
	{ edge: "before-commit", operation },
	{ edge: "after-commit", operation },
];
const statement = (
	operation: MutationOperation,
	name: Extract<CrashCheckpoint, { edge: "after-statement" }>["statement"],
	occurrence = 1
): CrashCheckpoint => ({ edge: "after-statement", occurrence, operation, statement: name });
const INSTALL_CHECKPOINTS: readonly CrashCheckpoint[] = [
	statement("beginGeneration", "object-ensure"),
	statement("beginGeneration", "generation-insert"),
	...commitEdges("beginGeneration"),
	statement("putCachedBlob", "blob-insert"),
	...commitEdges("putCachedBlob"),
	statement("promoteReference", "promotion-insert"),
	...commitEdges("promoteReference"),
	statement("completeGeneration", "object-ensure"),
	statement("completeGeneration", "generation-update"),
	...commitEdges("completeGeneration"),
	statement("swapHead", "object-ensure", 1),
	statement("swapHead", "generation-update", 1),
	statement("swapHead", "head-upsert"),
	...commitEdges("swapHead"),
];
const COMBINED_CHECKPOINTS: readonly CrashCheckpoint[] = [
	statement("swapHead", "object-ensure", 1),
	statement("swapHead", "generation-update", 1),
	statement("swapHead", "object-ensure", 2),
	statement("swapHead", "generation-update", 2),
	statement("swapHead", "head-upsert"),
	...commitEdges("swapHead"),
];
const SCENARIOS: readonly Scenario[] = [
	{ checkpoints: INSTALL_CHECKPOINTS, name: "creator" },
	{ checkpoints: COMBINED_CHECKPOINTS, name: "combined" },
];
const RUN_LONG = process.env.TS_DRP_PHASE_3A0_C_LONG_SIGKILL === "1";
const FAST_REPETITIONS = 1;
const LONG_REPETITIONS = 5;
const fixture = new URL("./fixtures/phase-3a0-c-anchor-trust-sigkill-child.mjs", import.meta.url);
const contractUrl = new URL("../../../tests/fixtures/phase-3a0-c-v3/contract.json", import.meta.url);
const packageTsconfigUrl = new URL("../tsconfig.json", import.meta.url);
const dedicatedTsconfigUrl = new URL("../../../tests/fixtures/phase-3a0-c-v3/tsconfig.test.json", import.meta.url);
const exactPackageExcludedTest = "tests/phase-3a0-c-anchor-trust-sigkill-red.test.ts";
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];
const execFileAsync = promisify(execFile);
const creatorMaterial = makeCreatorMaterial();
const expectedAuthority: ExpectedAuthority = Object.freeze({
	anchorDigest: creatorMaterial.anchorDigest,
	blueprintDigest: String(creatorMaterial.anchor.blueprintDigest),
	epoch: Number(creatorMaterial.anchor.epoch),
	objectId: String(creatorMaterial.anchor.objectId),
	parametersDigest: String(creatorMaterial.anchor.parametersDigest),
	profileDigest: String(creatorMaterial.anchor.profileDigest),
	signerSetDigest: String(creatorMaterial.anchor.signerSetDigest),
});

async function directory(label: string): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), `ts-drp-phase-3a0-c-${label}-`));
	temporaryDirectories.push(value);
	return value;
}

async function materialFile(directory_: string): Promise<string> {
	const material = creatorMaterial;
	const filename = join(directory_, "material.json");
	await writeFile(
		filename,
		JSON.stringify({
			anchorBytesHex: bytesHex(material.anchorBytes),
			anchorDigest: material.anchorDigest,
			objectId: material.anchor.objectId,
			profileBytesHex: bytesHex(material.profileBytes),
			signatureHex: bytesHex(material.signature),
			signerSetBytesHex: bytesHex(material.signerSetBytes),
			expectedAuthority,
		})
	);
	return filename;
}

function checkpointMatches(actual: CrashCheckpoint | undefined, expected: CrashCheckpoint): boolean {
	return (
		actual !== undefined &&
		Object.entries(expected).every(([key, value]) => actual[key as keyof CrashCheckpoint] === value)
	);
}

function runChild(
	filename: string,
	scenario: Scenario["name"],
	mode: "crash" | "inspect" | "new-initial" | "new-retry" | "old" | "retry",
	materialFilename: string,
	target?: CrashCheckpoint
): Promise<ChildRun> {
	return new Promise((resolve, reject) => {
		const arguments_ = [fixture.pathname, filename, scenario, mode, materialFilename];
		if (target !== undefined) arguments_.push(JSON.stringify(target));
		const child = spawn(process.execPath, arguments_, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
		const messages: ChildMessage[] = [];
		let stderr = "";
		let killedAtTarget = false;
		if (child.stderr === null) {
			reject(new Error("Phase3a0-C child has no stderr pipe"));
			return;
		}
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Phase3a0-C child timeout: ${scenario}:${JSON.stringify(target)}`));
		}, 15_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("message", (message: ChildMessage) => {
			messages.push(message);
			if (
				mode === "crash" &&
				target !== undefined &&
				message.kind === "checkpoint" &&
				checkpointMatches(message.checkpoint, target)
			) {
				killedAtTarget = true;
				child.kill("SIGKILL");
			}
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (exitCode, signal) => {
			clearTimeout(timeout);
			if (mode === "crash" && killedAtTarget && signal !== "SIGKILL") {
				reject(new Error(`targeted child exited without SIGKILL: ${signal ?? String(exitCode)}`));
				return;
			}
			resolve({ exitCode, messages, signal, stderr });
		});
	});
}

function stateOf(run: ChildRun): unknown {
	const error = run.messages.find(({ kind }) => kind === "fixture-error");
	if (error !== undefined) throw new Error(error.message ?? "fixture-error");
	const state = run.messages.find(({ kind }) => kind === "state")?.state;
	if (state === undefined) throw new Error(`missing state: ${JSON.stringify(run)}`);
	return state;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactAuthority(state: unknown): boolean {
	if (
		!isRecord(state) ||
		!isRecord(state.authorityContext) ||
		!isRecord(state.open) ||
		!isRecord(state.authentication) ||
		!isRecord(state.head)
	)
		return false;
	if (
		state.authorityContext.expectedObjectId !== expectedAuthority.objectId ||
		state.authorityContext.pinnedGenesisAnchorDigest !== expectedAuthority.anchorDigest
	)
		return false;
	if (state.open.ok !== true || state.authentication.ok !== true || !isRecord(state.authentication.provenance))
		return false;
	if (!isRecord(state.open.head) || state.open.head.objectId !== expectedAuthority.objectId) return false;
	if (state.head.kind !== "present" || state.head.objectId !== expectedAuthority.objectId) return false;
	for (const key of ["closureDigest", "generationId", "kind", "objectId", "revision"] as const) {
		if (state.open.head[key] !== state.head[key]) return false;
	}
	return JSON.stringify(state.authentication.provenance) === JSON.stringify(expectedAuthority);
}

function isExactAbsentAuthority(state: unknown): boolean {
	return (
		isRecord(state) &&
		isRecord(state.authorityContext) &&
		state.authorityContext.expectedObjectId === expectedAuthority.objectId &&
		state.authorityContext.pinnedGenesisAnchorDigest === expectedAuthority.anchorDigest &&
		isRecord(state.head) &&
		state.head.kind === "none" &&
		state.head.objectId === expectedAuthority.objectId &&
		isRecord(state.open) &&
		state.open.ok === false &&
		state.open.reason === "not-installed" &&
		state.authentication === null
	);
}

function hasExpectedAuthority(state: unknown, expectation: "absent" | "present"): boolean {
	return expectation === "present" ? hasExactAuthority(state) : isExactAbsentAuthority(state);
}

async function controlState(scenario: Scenario["name"], mode: "new-initial" | "new-retry" | "old"): Promise<unknown> {
	const directory_ = await directory(`${scenario}-${mode}`);
	const filename = join(directory_, "store.sqlite");
	const run = await runChild(filename, scenario, mode, await materialFile(directory_));
	expect.soft(run.exitCode).toBe(0);
	expect.soft(run.signal).toBeNull();
	expect.soft(run.stderr).not.toContain("fixture-error");
	const state = stateOf(run);
	const expectation = scenario === "creator" && mode === "old" ? "absent" : "present";
	expect(hasExpectedAuthority(state, expectation), `${scenario}:${mode}:authority`).toBe(true);
	return state;
}

function expectedInitialGeneration(scenario: Scenario["name"]): string {
	return (scenario === "creator" ? "1" : "3").repeat(64);
}

function expectedRetryGeneration(scenario: Scenario["name"]): string {
	return (scenario === "creator" ? "2" : "4").repeat(64);
}

function classifyAuthoritativeState(
	recovered: unknown,
	controls: Readonly<{ newInitial: unknown; old: unknown }>,
	oldExpectation: "absent" | "present"
): "new" | "old" | undefined {
	if (!hasExactAuthority(controls.newInitial) || !hasExpectedAuthority(controls.old, oldExpectation)) return undefined;
	const recoveredOld = hasExpectedAuthority(recovered, oldExpectation);
	const recoveredNew = hasExactAuthority(recovered);
	if (oldExpectation === "absent" ? recoveredOld === recoveredNew : !recoveredNew) return undefined;
	const encoded = JSON.stringify(recovered);
	const old = encoded === JSON.stringify(controls.old);
	const newState = encoded === JSON.stringify(controls.newInitial);
	return old === newState ? undefined : old && recoveredOld ? "old" : newState && recoveredNew ? "new" : undefined;
}

async function assertCheckpoint(
	scenario: Scenario,
	target: CrashCheckpoint,
	controls: Readonly<{ newInitial: unknown; newRetry: unknown; old: unknown }>,
	repetition: number
): Promise<string | undefined> {
	const directory_ = await directory(`${scenario.name}-${target.operation}-${target.edge}-${repetition}`);
	const filename = join(directory_, "store.sqlite");
	const materialFilename = await materialFile(directory_);
	const killed = await runChild(filename, scenario.name, "crash", materialFilename, target);
	if (!killed.messages.some(({ checkpoint, kind }) => kind === "checkpoint" && checkpointMatches(checkpoint, target))) {
		return `${scenario.name}:${JSON.stringify(target)} checkpoint absent`;
	}
	if (killed.messages.some(({ kind }) => kind === "result")) {
		return `${scenario.name}:${JSON.stringify(target)} published authority before SIGKILL`;
	}
	if (killed.signal !== "SIGKILL" || killed.exitCode !== null) {
		return `${scenario.name}:${JSON.stringify(target)} did not prove SIGKILL`;
	}
	if (!(await readdir(directory_)).includes("store.sqlite-wal")) {
		return `${scenario.name}:${JSON.stringify(target)} lost WAL custody`;
	}
	const recovered = stateOf(await runChild(filename, scenario.name, "inspect", materialFilename));
	const classification = classifyAuthoritativeState(
		recovered,
		controls,
		scenario.name === "creator" ? "absent" : "present"
	);
	if (classification === undefined) return `${scenario.name}:${JSON.stringify(target)} recovered mixed/neither state`;
	const retry = await runChild(filename, scenario.name, "retry", materialFilename);
	if (retry.exitCode !== 0 || retry.signal !== null) return `${scenario.name}:${JSON.stringify(target)} retry failed`;
	const converged = stateOf(retry);
	if (!hasExactAuthority(converged)) return `${scenario.name}:${JSON.stringify(target)} retry lost authority`;
	const expected = classification === "old" ? controls.newRetry : controls.newInitial;
	if (JSON.stringify(converged) !== JSON.stringify(expected)) {
		return `${scenario.name}:${JSON.stringify(target)} retry did not converge to exact new`;
	}
	const head = (converged as { readonly head?: { readonly generationId?: string } }).head;
	if (classification === "old" && head?.generationId !== expectedRetryGeneration(scenario.name)) {
		return `${scenario.name}:${JSON.stringify(target)} retry did not use fresh GenerationId`;
	}
	if (classification === "old" && head?.generationId === expectedInitialGeneration(scenario.name)) {
		return `${scenario.name}:${JSON.stringify(target)} retry reused failed GenerationId`;
	}
	return undefined;
}

async function runMatrix(repetitions: number): Promise<readonly string[]> {
	const failures: string[] = [];
	for (const scenario of SCENARIOS) {
		const controls = {
			newInitial: await controlState(scenario.name, "new-initial"),
			newRetry: await controlState(scenario.name, "new-retry"),
			old: await controlState(scenario.name, "old"),
		};
		expect(hasExactAuthority(controls.newInitial), `${scenario.name}:new-initial authority`).toBe(true);
		expect(hasExactAuthority(controls.newRetry), `${scenario.name}:new-retry authority`).toBe(true);
		expect(
			hasExpectedAuthority(controls.old, scenario.name === "creator" ? "absent" : "present"),
			`${scenario.name}:old authority`
		).toBe(true);
		expect.soft(controls.old, `${scenario.name}:old/new`).not.toEqual(controls.newInitial);
		for (let repetition = 0; repetition < repetitions; repetition += 1) {
			for (const checkpoint of scenario.checkpoints) {
				const failure = await assertCheckpoint(scenario, checkpoint, controls, repetition);
				if (failure !== undefined) failures.push(failure);
			}
		}
	}
	return failures;
}

afterEach(async () => {
	for (const directory_ of temporaryDirectories.splice(0)) await rm(directory_, { force: true, recursive: true });
	for (const filename of temporaryFiles.splice(0)) await rm(filename, { force: true });
});

describe("Phase 3a-0-C storage-node creator-trust process death RED", () => {
	it("freezes the exact 19 creator-install plus seven combined-swap checkpoints and bounded claims", async () => {
		const contract = JSON.parse(await readFile(contractUrl, "utf8")) as Record<string, unknown>;
		expect({
			combined: COMBINED_CHECKPOINTS.length,
			creator: INSTALL_CHECKPOINTS.length,
			operations: [...new Set(INSTALL_CHECKPOINTS.map(({ operation }) => operation))],
			total: SCENARIOS.reduce((count, scenario) => count + scenario.checkpoints.length, 0),
		}).toEqual({
			combined: 7,
			creator: 19,
			operations: ["beginGeneration", "putCachedBlob", "promoteReference", "completeGeneration", "swapHead"],
			total: 26,
		});
		expect(contract).toMatchObject({
			fastRepetitions: 1,
			kind: "phase-3a0-c-storage-node-process-death-contract",
			longRepetitions: 5,
			version: 1,
			withheldClaims: [
				"browser-process-death",
				"browser-reload-parity",
				"physical-debris-absence",
				"live-state-construction",
				"trust-advancement",
				"certified-profile-or-qc",
			],
		});
	});

	it("proves the old-or-new oracle rejects a mixed-state mutant and the retry ids differ", () => {
		const head = { generationId: "1".repeat(64), kind: "present", objectId: expectedAuthority.objectId, revision: 1 };
		const authoritative = {
			authentication: { ok: true, provenance: expectedAuthority },
			authorityContext: {
				expectedObjectId: expectedAuthority.objectId,
				pinnedGenesisAnchorDigest: expectedAuthority.anchorDigest,
			},
			head,
			open: { head, ok: true },
		};
		const controls = {
			newInitial: { ...authoritative, refs: ["trust", "state"] },
			old: { ...authoritative, refs: ["trust"] },
		};
		expect(classifyAuthoritativeState(controls.old, controls, "present")).toBe("old");
		expect(classifyAuthoritativeState(controls.newInitial, controls, "present")).toBe("new");
		expect(classifyAuthoritativeState({ ...authoritative, refs: ["state"] }, controls, "present")).toBeUndefined();
		expect(
			classifyAuthoritativeState(
				{ ...controls.newInitial, authentication: { ok: false, reason: "invalid-signature" } },
				controls,
				"present"
			)
		).toBeUndefined();
		expect(
			classifyAuthoritativeState(
				controls.newInitial,
				{
					newInitial: { ...controls.newInitial, open: { ok: false, reason: "trust-state-unreadable" } },
					old: controls.old,
				},
				"present"
			)
		).toBeUndefined();
		for (const scenario of SCENARIOS) {
			expect(expectedRetryGeneration(scenario.name)).not.toBe(expectedInitialGeneration(scenario.name));
		}
	});

	it("rejects the non-durable memory AHE before any creator-trust installation can succeed", async () => {
		const material = makeCreatorMaterial();
		const memory = createMemoryAheDurableStore();
		const durable = createCurrentAnchorTrustStore({
			objectId: material.anchor.objectId as never,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: memory,
		});
		expect(
			await durable.install({
				detachedGenesisSignature: material.signature,
				exactCanonicalGenesisAnchorPreimageBytes: material.anchorBytes,
				exactCanonicalProfileBytes: material.profileBytes,
				exactCanonicalSignerSetBytes: material.signerSetBytes,
				pinnedGenesisAnchorDigest: material.anchorDigest,
			})
		).toEqual({ ok: false, reason: "store-failed" });
		await memory.close();
	});

	it("keeps the process-death fixture under its dedicated compiler without breaking the package typecheck", async () => {
		const packageTsconfig = JSON.parse(await readFile(packageTsconfigUrl, "utf8")) as {
			exclude?: readonly string[];
		};
		const dedicatedTsconfig = JSON.parse(await readFile(dedicatedTsconfigUrl, "utf8")) as {
			files?: readonly string[];
		};
		expect(dedicatedTsconfig.files).toContain(
			"../../../packages/storage-node/tests/phase-3a0-c-anchor-trust-sigkill-red.test.ts"
		);
		await expect(
			execFileAsync("pnpm", ["exec", "tsc", "--noEmit", "--project", fileURLToPath(dedicatedTsconfigUrl)], {
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			})
		).resolves.toMatchObject({ stderr: "" });

		const mutantUrl = new URL(`../tsconfig.phase-3a0-c-mutant-${process.pid}.json`, import.meta.url);
		temporaryFiles.push(fileURLToPath(mutantUrl));
		await writeFile(
			mutantUrl,
			`${JSON.stringify(
				{
					...packageTsconfig,
					exclude: (packageTsconfig.exclude ?? []).filter((entry) => entry !== exactPackageExcludedTest),
				},
				null,
				"\t"
			)}\n`
		);
		let mutantDiagnostics = "";
		try {
			await execFileAsync("pnpm", ["exec", "tsc", "--noEmit", "--project", fileURLToPath(mutantUrl)], {
				cwd: fileURLToPath(new URL("../", import.meta.url)),
			});
		} catch (error) {
			const failure = error as Readonly<{ stderr?: string; stdout?: string }>;
			mutantDiagnostics = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
		}
		expect(mutantDiagnostics).toContain("TS2307");
		expect(mutantDiagnostics).toContain("TS6059");
		expect(mutantDiagnostics).toContain("TS6307");
		expect(mutantDiagnostics).toContain(exactPackageExcludedTest);
		expect(packageTsconfig.exclude).toEqual(["dist", "./*.d.ts", exactPackageExcludedTest]);
	});

	it.skipIf(RUN_LONG)("keeps the repeated real-death campaign explicitly nightly-only", () => {
		expect(process.env.TS_DRP_PHASE_3A0_C_LONG_SIGKILL).not.toBe("1");
		expect({ fast: FAST_REPETITIONS, long: LONG_REPETITIONS }).toEqual({ fast: 1, long: 5 });
	});

	it("recovers authoritative old XOR exact new and retries with a fresh generation at all fast checkpoints", async () => {
		expect(await runMatrix(FAST_REPETITIONS)).toEqual([]);
	}, 180_000);
});

describe.skipIf(!RUN_LONG)("Phase 3a-0-C repeated storage-node SIGKILL campaign", () => {
	it("repeats the same 26-checkpoint matrix without widening its claim", async () => {
		expect(await runMatrix(LONG_REPETITIONS)).toEqual([]);
	}, 900_000);
});
