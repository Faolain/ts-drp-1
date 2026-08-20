/**
 * Phase 1o-f(ii) RED: the final retained representation must be measured with
 * finite capacity for the complete authoritative population sweep. Production
 * defaults remain unchanged; this contract is only for the real heap worker.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

interface MeasurementCapacity {
	readonly perNode: number;
	readonly perObject: number;
}

interface WorkerOutput {
	readonly measurementCapacity: MeasurementCapacity | null;
	readonly placement: string;
	readonly population: number;
	readonly shape: string;
	readonly structuralCensus: {
		readonly creatorPeerIdLength: number;
		readonly objectCount: number;
		readonly objectIdLength?: number;
		readonly pairCount: number;
		readonly pairsPerObject: {
			readonly maximum: number;
			readonly minimum: number;
			readonly sum: number;
		};
		readonly perPair: {
			readonly outstanding: number;
		};
	};
}

interface CommonContractOutput {
	readonly acceptanceThresholds: Record<string, number>;
	readonly authoritativePopulations: readonly number[];
	readonly authoritativeReplicates: number;
	readonly authoritativeWarmups: number;
	readonly jobCount: number;
	readonly measurementCapacityPolicy: {
		readonly nonzeroPopulation: MeasurementCapacity;
		readonly zeroPopulation: null;
	};
	readonly shapes: readonly string[];
	readonly selected: {
		readonly acceptanceEligible: boolean;
		readonly includeDemandPoint: boolean;
		readonly placements: readonly string[];
		readonly populations: readonly number[];
		readonly replicates: number;
		readonly shapes: readonly string[];
		readonly warmups: number;
	};
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const COMMON_PATH = fileURLToPath(
	new URL("../../../scripts/production-hardening/sync-state-heap-common.mjs", import.meta.url)
);
const WORKER_PATH = fileURLToPath(
	new URL("../../../scripts/production-hardening/sync-state-heap-worker.mjs", import.meta.url)
);
const MEASUREMENT_CAPACITY = Object.freeze({ perNode: 4096, perObject: 4096 });

function commandFailure(command: string, result: ReturnType<typeof spawnSync>): Error {
	return new Error(
		[
			`${command} failed with status ${String(result.status)} and signal ${String(result.signal)}`,
			String(result.error?.message ?? ""),
			String(result.stdout ?? ""),
			String(result.stderr ?? ""),
		]
			.filter(Boolean)
			.join("\n")
	);
}

function buildProductionNode(): void {
	const result = spawnSync("pnpm", ["--dir", "packages/node", "run", "build"], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error !== undefined || result.status !== 0) throw commandFailure("production Node build", result);
}

function runWorker(shape: string, population: number): WorkerOutput {
	const environment = { ...process.env };
	delete environment.NODE_OPTIONS;
	delete environment.NODE_V8_COVERAGE;
	delete environment.VSCODE_INSPECTOR_OPTIONS;
	const sampleSeed = population.toString(16).padStart(64, "0");
	const result = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			WORKER_PATH,
			"--shape",
			shape,
			"--placement",
			"one-hot-object",
			"--population",
			String(population),
			"--sample-seed",
			sampleSeed,
		],
		{
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: environment,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 60_000,
		}
	);
	if (result.error !== undefined || result.status !== 0) {
		throw commandFailure(`heap worker ${shape}/one-hot-object/N=${population}`, result);
	}
	const lines = result.stdout.trim().split("\n").filter(Boolean);
	if (lines.length !== 1) throw new Error(`Heap worker emitted ${lines.length} stdout lines; expected one`);
	return JSON.parse(lines[0]) as WorkerOutput;
}

function readCommonContract(): CommonContractOutput {
	const probe = `
		const common = await import(${JSON.stringify(pathToFileURL(COMMON_PATH).href)});
		const { jobs, selected } = common.buildJobs("phase-1o-f-ii-recharacterization-contract", false);
		process.stdout.write(JSON.stringify({
			acceptanceThresholds: common.ACCEPTANCE_THRESHOLDS,
			authoritativePopulations: common.AUTHORITATIVE_POPULATIONS,
			authoritativeReplicates: common.AUTHORITATIVE_REPLICATES,
			authoritativeWarmups: common.AUTHORITATIVE_WARMUPS,
			jobCount: jobs.length,
			measurementCapacityPolicy: common.MEASUREMENT_CAPACITY_POLICY,
			shapes: common.SHAPES,
			selected,
		}));
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	});
	if (result.error !== undefined || result.status !== 0) throw commandFailure("heap common contract probe", result);
	return JSON.parse(result.stdout) as CommonContractOutput;
}

function expectCreatorBoundPopulation(output: WorkerOutput, population: number): void {
	expect(output).toMatchObject({
		placement: "one-hot-object",
		population,
		structuralCensus: {
			creatorPeerIdLength: 53,
			objectIdLength: 86,
			pairCount: population,
			pairsPerObject: { maximum: population, minimum: population, sum: population },
		},
	});
}

function expectExactMeasurementCapacity(output: WorkerOutput): void {
	expect(output.measurementCapacity).toEqual(MEASUREMENT_CAPACITY);
	expect(Object.keys(output.measurementCapacity ?? {})).toEqual(["perNode", "perObject"]);
	expect(Number.isSafeInteger(output.measurementCapacity?.perNode)).toBe(true);
	expect(Number.isSafeInteger(output.measurementCapacity?.perObject)).toBe(true);
}

describe("Phase 1o-f(ii) final-representation heap accommodation", () => {
	beforeAll(buildProductionNode, 30_000);

	test("installs finite measurement capacity before a one-hot outstanding sample crosses production perObject=37", () => {
		const output = runWorker("outstanding-attempt-0", 38);

		expectCreatorBoundPopulation(output, 38);
		expect(output.structuralCensus.perPair.outstanding).toBe(64);
		expectExactMeasurementCapacity(output);
	}, 60_000);

	test("retains the exact N=4096 one-hot outstanding population with no 4097 or unlimited mode", () => {
		const output = runWorker("outstanding-attempt-0", 4096);

		expectCreatorBoundPopulation(output, 4096);
		expect(output.structuralCensus.perPair.outstanding).toBe(64);
		expectExactMeasurementCapacity(output);
	}, 60_000);

	test("leaves N=0 uninstalled so the production-lazy fixed ledger cost stays outside the baseline", () => {
		const output = runWorker("minimal-dormant", 0);

		expect(output).toMatchObject({
			measurementCapacity: null,
			placement: "one-hot-object",
			population: 0,
			shape: "minimal-dormant",
			structuralCensus: {
				creatorPeerIdLength: 53,
				objectCount: 0,
				pairCount: 0,
				pairsPerObject: { maximum: 0, minimum: 0, sum: 0 },
			},
		});
	}, 60_000);

	test("preserves the ratified authoritative schedule, shapes, and statistical gates", () => {
		const common = readCommonContract();

		expect(common.authoritativePopulations).toEqual([0, 512, 1024, 2048, 4096]);
		expect(common.shapes).toEqual([
			"minimal-dormant",
			"maximum-dormant",
			"outstanding-attempt-0",
			"outstanding-attempt-1",
			"outstanding-attempt-2",
			"outstanding-attempt-3",
			"active-cooldown",
			"expired-defined-cooldown",
			"post-completion-dormant",
		]);
		expect(common.selected).toEqual({
			acceptanceEligible: true,
			includeDemandPoint: true,
			placements: ["one-hot-object", "round-robin-20"],
			populations: [0, 512, 1024, 2048, 4096],
			replicates: 30,
			shapes: common.shapes,
			warmups: 3,
		});
		expect(common.authoritativeReplicates).toBe(30);
		expect(common.authoritativeWarmups).toBe(3);
		expect(common.jobCount).toBe(3267);
		expect(common.acceptanceThresholds).toEqual({
			baselineDriftFractionOfFittedDelta: 0.05,
			baselineDriftFloorBytes: 256 * 1024,
			bootstrapIterations: 10_000,
			heapV8MarginalDisagreementFraction: 0.05,
			maximumMedianAbsoluteResidualFraction: 0.1,
			maximumU99ToMedianRatio: 1.1,
			minimumOlsRSquared: 0.98,
		});
	});

	test("exposes one shared finite accommodation policy for run-level metadata authentication", () => {
		const common = readCommonContract();

		expect(common.measurementCapacityPolicy).toEqual({
			nonzeroPopulation: MEASUREMENT_CAPACITY,
			zeroPopulation: null,
		});
		expect(Object.keys(common.measurementCapacityPolicy?.nonzeroPopulation ?? {})).toEqual(["perNode", "perObject"]);
	});
});
