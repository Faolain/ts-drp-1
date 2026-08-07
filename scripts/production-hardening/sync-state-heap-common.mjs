/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc -- Node executes this tooling directly. */
import { createHash } from "node:crypto";

export const AUTHORITATIVE_POPULATIONS = Object.freeze([0, 512, 1024, 2048, 4096]);
export const AUTHORITATIVE_REPLICATES = 30;
export const AUTHORITATIVE_WARMUPS = 3;
export const DEMAND_POPULATION = 20 * 14;

export const SHAPES = Object.freeze([
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

export const SWEEP_PLACEMENTS = Object.freeze(["one-hot-object", "round-robin-20"]);
export const DEMAND_PLACEMENT = "demand-20x14";

export const ACCEPTANCE_THRESHOLDS = Object.freeze({
	baselineDriftFractionOfFittedDelta: 0.05,
	baselineDriftFloorBytes: 256 * 1024,
	bootstrapIterations: 10_000,
	heapV8MarginalDisagreementFraction: 0.05,
	maximumMedianAbsoluteResidualFraction: 0.1,
	minimumOlsRSquared: 0.98,
	maximumU99ToMedianRatio: 1.1,
});

export function parseArguments(argv) {
	const parsed = new Map();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
		const name = token.slice(2);
		if (name === "smoke" || name === "skip-build" || name === "self-check") {
			parsed.set(name, true);
			continue;
		}
		const value = argv[++index];
		if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
		parsed.set(name, value);
	}
	return parsed;
}

export function requiredArgument(argumentsMap, name) {
	const value = argumentsMap.get(name);
	if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
	return value;
}

export function integerArgument(argumentsMap, name) {
	const raw = requiredArgument(argumentsMap, name);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
	return value;
}

export function sha256Hex(value) {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Frame every deterministic corpus input as a JSON tuple before hashing.
 * @param sampleSeed - Recorded seed that identifies the isolated sample.
 * @param domain - Semantic namespace for the generated corpus value.
 * @param counter - Monotonic value index within the sample.
 * @returns A deterministic canonical lowercase SHA-256 hex string.
 */
export function framedCorpusDigest(sampleSeed, domain, counter) {
	return sha256Hex(JSON.stringify(["sync-state-heap-corpus-v1", sampleSeed, domain, counter]));
}

export function deterministicRandom(seed) {
	let block = Buffer.alloc(0);
	let offset = 0;
	let counter = 0;
	return () => {
		if (offset + 4 > block.length) {
			block = createHash("sha256").update(seed).update(String(counter++)).digest();
			offset = 0;
		}
		const value = block.readUInt32BE(offset) / 0x1_0000_0000;
		offset += 4;
		return value;
	};
}

export function shuffle(values, seed) {
	const random = deterministicRandom(seed);
	for (let index = values.length - 1; index > 0; index--) {
		const target = Math.floor(random() * (index + 1));
		[values[index], values[target]] = [values[target], values[index]];
	}
	return values;
}

export function schedule(smoke) {
	if (smoke) {
		return {
			acceptanceEligible: false,
			includeDemandPoint: false,
			placements: SWEEP_PLACEMENTS,
			populations: [0, 8, 16],
			replicates: 2,
			shapes: ["minimal-dormant", "maximum-dormant"],
			warmups: 1,
		};
	}
	return {
		acceptanceEligible: true,
		includeDemandPoint: true,
		placements: SWEEP_PLACEMENTS,
		populations: AUTHORITATIVE_POPULATIONS,
		replicates: AUTHORITATIVE_REPLICATES,
		shapes: SHAPES,
		warmups: AUTHORITATIVE_WARMUPS,
	};
}

export function buildJobs(runSeed, smoke) {
	const selected = schedule(smoke);
	const cells = [];
	for (const shape of selected.shapes) {
		for (const placement of SWEEP_PLACEMENTS) {
			for (const population of selected.populations) cells.push({ placement, population, shape });
		}
		if (!smoke) cells.push({ placement: DEMAND_PLACEMENT, population: DEMAND_POPULATION, shape });
	}
	const warmups = [];
	const measured = [];
	for (const cell of cells) {
		const cellKey = `${cell.shape}:${cell.placement}:${cell.population}`;
		for (let index = 0; index < selected.warmups; index++) {
			warmups.push({
				...cell,
				discardedWarmup: true,
				replicate: index,
				sampleSeed: sha256Hex(`${runSeed}:w:${cellKey}:${index}`),
			});
		}
		for (let index = 0; index < selected.replicates; index++) {
			measured.push({
				...cell,
				discardedWarmup: false,
				replicate: index,
				sampleSeed: sha256Hex(`${runSeed}:m:${cellKey}:${index}`),
			});
		}
	}
	shuffle(warmups, `${runSeed}:warmups`);
	shuffle(measured, `${runSeed}:measured`);
	return { jobs: [...warmups, ...measured], selected };
}

export function assertCanonicalHash(hash) {
	if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`Non-canonical hash generated: ${hash}`);
}

export function quantile(values, probability) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const position = (sorted.length - 1) * probability;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values) {
	return quantile(values, 0.5);
}
