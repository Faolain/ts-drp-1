import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShadowCloseObservation, ShadowComparisonModule } from "./fixtures/phase-4d-v3/shadow-contract.js";
import { buildShadowRun } from "./fixtures/phase-4d-v3/shadow-driver.js";
import {
	SHADOW_CLOSES_PER_SHARD,
	SHADOW_PROFILES,
	SHADOW_REFERENCE_SAMPLES_PER_SHARD,
	SHADOW_RUN_SCHEMA_VERSION,
	SHADOW_SEED_VECTOR,
	type ShadowRunnerModule,
	type ShadowRunReport,
	type ShadowShardInput,
} from "./fixtures/phase-4d-v3/shadow-runner-contract.js";
import {
	assertIndependentContract,
	cloneShardWithSeed,
	emitRequestedWorkflowArtifacts,
	genuineShard,
	independentSeed,
	independentShardSeeds,
	ledgerExists,
	parsedWorkflow,
	reportIsComplete,
} from "./fixtures/phase-4d-v3/shadow-runner-driver.js";

const { compareSpy } = vi.hoisted(() => ({ compareSpy: vi.fn() }));
vi.mock("@ts-drp/test-utils/shadow-comparison", async (importOriginal) => {
	const actual = await importOriginal<ShadowComparisonModule>();
	compareSpy.mockImplementation(actual.compareShadowRun);
	return { ...actual, compareShadowRun: compareSpy };
});

const OWNER_SPECIFIER = "@ts-drp/test-utils/shadow-runner";
let owner: ShadowRunnerModule | undefined;
try {
	owner = await vi.importActual<ShadowRunnerModule>(OWNER_SPECIFIER);
} catch {
	owner = undefined;
}

const ownerReady =
	owner !== undefined &&
	typeof owner.appendShadowLedger === "function" &&
	typeof owner.deriveShadowSeed === "function" &&
	typeof owner.runShadowTier === "function";
const defaultObservations = await buildShadowRun();
const originalEnvironment = Object.freeze({
	SHADOW_DATE: process.env.SHADOW_DATE,
	SHADOW_LEDGER_OUTPUT: process.env.SHADOW_LEDGER_OUTPUT,
	SHADOW_OUTPUT: process.env.SHADOW_OUTPUT,
	SHADOW_SHA: process.env.SHADOW_SHA,
	SHADOW_TIER: process.env.SHADOW_TIER,
});

afterEach(() => {
	for (const [name, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	compareSpy.mockClear();
});

function requireOwner(): ShadowRunnerModule {
	if (owner === undefined) throw new TypeError("shadow runner owner is absent");
	return owner;
}

function completeNightlyCandidate(
	selected: ShadowRunnerModule,
	calls: number[] = [],
	produced: Array<readonly ShadowCloseObservation[]> = []
): Promise<ShadowRunReport> {
	return selected.runShadowTier({
		browsers: [],
		date: SHADOW_SEED_VECTOR.date,
		produceShard: ({ seed }) => {
			calls.push(seed);
			const observations = cloneShardWithSeed(defaultObservations, seed);
			produced.push(observations);
			return Promise.resolve(observations);
		},
		runtimes: ["node-22"],
		sha: SHADOW_SEED_VECTOR.sha,
		tier: "nightly",
	});
}

describe("Phase 4d-b bounded recurring shadow runner RED", () => {
	it("pins independent profile arithmetic, seed derivation, and injective shard seeds", () => {
		expect(assertIndependentContract()).toBeUndefined();
		expect(independentSeed(SHADOW_SEED_VECTOR)).toBe(SHADOW_SEED_VECTOR.seed);
		expect(independentShardSeeds(SHADOW_SEED_VECTOR.seed, 100)).toHaveLength(100);
		expect(new Set(independentShardSeeds(SHADOW_SEED_VECTOR.seed, 100)).size).toBe(100);
	});

	it("has exactly one missing semantic runner readiness failure", () => {
		expect(ownerReady).toBe(true);
	});

	it.skipIf(!ownerReady)("runs the exact PR profile and binds the runner seed into every observation", async () => {
		const selected = requireOwner();
		const calls: Array<Readonly<{ closes: number; seed: number }>> = [];
		const produced: Array<readonly ShadowCloseObservation[]> = [];
		expect(selected.deriveShadowSeed(SHADOW_SEED_VECTOR)).toBe(SHADOW_SEED_VECTOR.seed);
		const report = await selected.runShadowTier({
			browsers: [],
			date: SHADOW_SEED_VECTOR.date,
			produceShard: (input) => {
				calls.push(input);
				const observations = cloneShardWithSeed(defaultObservations, input.seed);
				produced.push(observations);
				return Promise.resolve(observations);
			},
			runtimes: ["node-22"],
			sha: SHADOW_SEED_VECTOR.sha,
			tier: "pr",
		});
		expect(Object.isFrozen(report)).toBe(true);
		expect(Reflect.ownKeys(report).sort()).toEqual(
			[
				"appliedVertices",
				"browsers",
				"completedEpochs",
				"completedShards",
				"date",
				"epochs",
				"mismatches",
				"nonemptyStates",
				"referenceSamples",
				"runtimes",
				"schemaVersion",
				"seed",
				"sha",
				"shards",
				"tier",
			].sort()
		);
		expect(calls).toEqual([{ closes: SHADOW_CLOSES_PER_SHARD, seed: SHADOW_SEED_VECTOR.seed }]);
		expect(compareSpy).toHaveBeenCalledTimes(1);
		expect(compareSpy.mock.calls[0]?.[0]).toEqual({
			expectedCloses: SHADOW_CLOSES_PER_SHARD,
			expectedReferenceSamples: SHADOW_REFERENCE_SAMPLES_PER_SHARD,
			observations: produced[0],
		});
		expect(compareSpy.mock.calls[0]?.[0].observations).toBe(produced[0]);
		expect(report).toMatchObject({
			appliedVertices: SHADOW_PROFILES.pr.epochs * 3,
			completedEpochs: SHADOW_PROFILES.pr.epochs,
			completedShards: SHADOW_PROFILES.pr.shards,
			epochs: SHADOW_PROFILES.pr.epochs,
			mismatches: [],
			nonemptyStates: SHADOW_PROFILES.pr.epochs,
			referenceSamples: SHADOW_PROFILES.pr.referenceSamples,
			schemaVersion: SHADOW_RUN_SCHEMA_VERSION,
			seed: SHADOW_SEED_VECTOR.seed,
			shards: SHADOW_PROFILES.pr.shards,
			tier: "pr",
		});
		expect(reportIsComplete(report)).toBe(true);
	});

	it.skipIf(!ownerReady)("aggregates every exact shard and preserves mismatch and partial evidence", async () => {
		const selected = requireOwner();
		const seeds: number[] = [];
		const nightlySeeds: number[] = [];
		const nightlyProduced: Array<readonly ShadowCloseObservation[]> = [];
		const nightly = await completeNightlyCandidate(selected, nightlySeeds, nightlyProduced);
		expect(nightlySeeds).toEqual(independentShardSeeds(SHADOW_SEED_VECTOR.seed, SHADOW_PROFILES.nightly.shards));
		expect(new Set(nightlyProduced).size).toBe(SHADOW_PROFILES.nightly.shards);
		expect(compareSpy).toHaveBeenCalledTimes(SHADOW_PROFILES.nightly.shards);
		for (const [index, call] of compareSpy.mock.calls.entries()) {
			expect(call[0]).toEqual({
				expectedCloses: SHADOW_CLOSES_PER_SHARD,
				expectedReferenceSamples: SHADOW_REFERENCE_SAMPLES_PER_SHARD,
				observations: nightlyProduced[index],
			});
			expect(call[0].observations).toBe(nightlyProduced[index]);
		}
		expect(nightly).toMatchObject({
			appliedVertices: SHADOW_PROFILES.nightly.epochs * 3,
			completedEpochs: SHADOW_PROFILES.nightly.epochs,
			completedShards: SHADOW_PROFILES.nightly.shards,
			epochs: SHADOW_PROFILES.nightly.epochs,
			mismatches: [],
			nonemptyStates: SHADOW_PROFILES.nightly.epochs,
			referenceSamples: SHADOW_PROFILES.nightly.referenceSamples,
			shards: SHADOW_PROFILES.nightly.shards,
		});

		compareSpy.mockClear();
		const mismatch = await selected.runShadowTier({
			browsers: [],
			date: SHADOW_SEED_VECTOR.date,
			produceShard: (input) => {
				seeds.push(input.seed);
				const shard = cloneShardWithSeed(defaultObservations, input.seed);
				if (seeds.length !== 2) return Promise.resolve(shard);
				const first = shard[0];
				if (first === undefined) throw new TypeError("shadow fixture is empty");
				return Promise.resolve([
					{ ...first, archival: { ...first.archival, stateDigest: "00".repeat(32) } },
					...shard.slice(1),
				]);
			},
			runtimes: ["node-22"],
			sha: SHADOW_SEED_VECTOR.sha,
			tier: "nightly",
		});
		expect(seeds).toEqual(independentShardSeeds(SHADOW_SEED_VECTOR.seed, 2));
		expect(compareSpy).toHaveBeenCalledTimes(2);
		expect(mismatch.completedShards).toBe(1);
		expect(mismatch.completedEpochs).toBe(SHADOW_CLOSES_PER_SHARD);
		expect(mismatch.mismatches).toEqual([expect.objectContaining({ kind: "state-mismatch" })]);
		expect(reportIsComplete(mismatch)).toBe(false);
	});

	it.skipIf(!ownerReady)(
		"rejects short shards, wrong observation seeds, and caller-selected expectations",
		async () => {
			const selected = requireOwner();
			const first = defaultObservations[0];
			if (first === undefined) throw new TypeError("shadow fixture is empty");
			const producers: ReadonlyArray<Parameters<ShadowRunnerModule["runShadowTier"]>[0]["produceShard"]> = [
				({ seed }: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> =>
					Promise.resolve(cloneShardWithSeed(defaultObservations.slice(0, -1), seed)),
				({ seed }: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> =>
					Promise.resolve(cloneShardWithSeed([...defaultObservations, first], seed)),
				(_input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> =>
					Promise.resolve(cloneShardWithSeed(defaultObservations, SHADOW_SEED_VECTOR.seed ^ 1)),
				({ seed }: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> =>
					Promise.resolve(
						cloneShardWithSeed(
							defaultObservations.map((entry) => ({ ...entry, appliedVertices: 0 })),
							seed
						)
					),
				({ seed }: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> =>
					Promise.resolve(
						cloneShardWithSeed(
							defaultObservations.map((entry) => ({
								...entry,
								archival: { ...entry.archival, exactCanonicalStateBytes: new Uint8Array() },
								engineA: { ...entry.engineA, exactCanonicalStateBytes: new Uint8Array() },
								engineB: { ...entry.engineB, exactCanonicalStateBytes: new Uint8Array() },
								reference:
									entry.reference.kind === "observed"
										? {
												kind: "observed" as const,
												value: {
													...entry.reference.value,
													exactCanonicalStateBytes: new Uint8Array(),
												},
											}
										: entry.reference,
							})),
							seed
						)
					),
			];
			for (const producer of producers) {
				const report = await selected.runShadowTier({
					browsers: [],
					date: SHADOW_SEED_VECTOR.date,
					produceShard: producer,
					runtimes: ["node-22"],
					sha: SHADOW_SEED_VECTOR.sha,
					tier: "pr",
				});
				expect(reportIsComplete(report)).toBe(false);
				expect(report.mismatches).toHaveLength(1);
			}
			expect(SHADOW_REFERENCE_SAMPLES_PER_SHARD).toBe(10);
		}
	);

	it.skipIf(!ownerReady)(
		"derives genuinely seed-sensitive operations without weakening the default owner",
		async () => {
			const first = await genuineShard({ closes: SHADOW_CLOSES_PER_SHARD, seed: 11 });
			const second = await genuineShard({ closes: SHADOW_CLOSES_PER_SHARD, seed: 12 });
			expect(first).toHaveLength(SHADOW_CLOSES_PER_SHARD);
			expect(second).toHaveLength(SHADOW_CLOSES_PER_SHARD);
			expect(first[0]?.seed).toBe(11);
			expect(second[0]?.seed).toBe(12);
			expect(first.at(-1)?.engineA.exactCanonicalStateBytes).not.toEqual(
				second.at(-1)?.engineA.exactCanonicalStateBytes
			);
		}
	);

	it.skipIf(!ownerReady)("validates exact append-only nightly ledger candidates", async () => {
		const selected = requireOwner();
		const candidate = await completeNightlyCandidate(selected);
		const appended = selected.appendShadowLedger({ candidate, ledger: [] });
		expect(appended).toEqual([candidate]);
		expect(Object.isFrozen(appended)).toBe(true);
		expect(() => selected.appendShadowLedger({ candidate, ledger: appended })).toThrow(/duplicate|date|order/u);
		expect(() => selected.appendShadowLedger({ candidate: { ...candidate, tier: "pr" }, ledger: [] })).toThrow(
			/nightly|tier/u
		);
		expect(() =>
			selected.appendShadowLedger({ candidate: { ...candidate, runtimes: ["node-22", "node-22"] }, ledger: [] })
		).toThrow(/duplicate|roster|runtime/u);
		expect(() =>
			selected.appendShadowLedger({
				candidate: { ...candidate, completedEpochs: candidate.epochs - 1 },
				ledger: [],
			})
		).toThrow(/count|epoch|incomplete/u);
		expect(() =>
			selected.appendShadowLedger({
				candidate: { ...candidate, extra: true } as ShadowRunReport,
				ledger: [],
			})
		).toThrow(/key|schema|unknown/u);
		expect(ledgerExists()).toBe(true);
	});

	it.skipIf(!ownerReady)("pins a read-only bounded workflow and emits only explicit artifacts", async () => {
		const workflow = parsedWorkflow();
		expect(workflow).toBeDefined();
		expect(workflow?.permissions).toEqual({ contents: "read" });
		const triggers = workflow?.on as Record<string, unknown> | undefined;
		expect(Object.keys(triggers ?? {}).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
		expect(triggers?.schedule).toEqual([expect.objectContaining({ cron: expect.any(String) })]);
		expect(triggers?.workflow_dispatch).toMatchObject({
			inputs: { tier: { options: ["pr", "nightly"], required: true, type: "choice" } },
		});
		const source = JSON.stringify(workflow);
		expect(source).toContain("fetch-depth");
		expect(source).toContain("--frozen-lockfile");
		expect(source).toContain(".logs/**");
		expect(source).toContain("phase-4d-shadow-runner-red.test.ts");
		expect(source).toContain("SHADOW_LEDGER_OUTPUT");
		expect(source).toContain("SHADOW_OUTPUT");
		expect(source).toContain("upload-artifact");
		expect(source).toContain("always()");
		expect(source).not.toContain("continue-on-error");
		expect(source).not.toMatch(/git (?:commit|push)|contents[^\n]*write/u);
		const viteConfig = (await import("../vite.config.mts")).default;
		expect(viteConfig.test?.exclude).toContain("**/.logs/**");
		await expect(emitRequestedWorkflowArtifacts(requireOwner())).resolves.toBeUndefined();

		const selected = requireOwner();
		const complete = await completeNightlyCandidate(selected);
		const failed = Object.freeze({
			...complete,
			completedEpochs: SHADOW_CLOSES_PER_SHARD,
			completedShards: 1,
			mismatches: Object.freeze([
				Object.freeze({ epoch: 1, kind: "state-mismatch" as const, seed: SHADOW_SEED_VECTOR.seed }),
			]),
		});
		const append = vi.fn(selected.appendShadowLedger);
		const fakeOwner: ShadowRunnerModule = {
			...selected,
			appendShadowLedger: append,
			runShadowTier: () => Promise.resolve(failed),
		};
		const temporary = mkdtempSync(path.join(tmpdir(), "phase4d-shadow-"));
		const reportPath = path.join(temporary, "report.json");
		const ledgerPath = path.join(temporary, "ledger.json");
		try {
			process.env.SHADOW_DATE = SHADOW_SEED_VECTOR.date;
			process.env.SHADOW_LEDGER_OUTPUT = ledgerPath;
			process.env.SHADOW_OUTPUT = reportPath;
			process.env.SHADOW_SHA = SHADOW_SEED_VECTOR.sha;
			process.env.SHADOW_TIER = "nightly";
			await expect(emitRequestedWorkflowArtifacts(fakeOwner)).rejects.toThrow(/incomplete/u);
			expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
				completedShards: 1,
				mismatches: [{ kind: "state-mismatch" }],
			});
			expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual([]);
			expect(append).not.toHaveBeenCalled();
		} finally {
			rmSync(temporary, { force: true, recursive: true });
		}
	});
});
