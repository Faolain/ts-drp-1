/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc -- Node executes this tooling directly. */
import { readFile, writeFile } from "node:fs/promises";

import {
	ACCEPTANCE_THRESHOLDS,
	deterministicRandom,
	median,
	parseArguments,
	quantile,
	requiredArgument,
} from "./sync-state-heap-common.mjs";

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function describe(values) {
	return {
		count: values.length,
		iqr: quantile(values, 0.75) - quantile(values, 0.25),
		maximum: Math.max(...values),
		mean: mean(values),
		median: median(values),
		minimum: Math.min(...values),
		p95: quantile(values, 0.95),
	};
}

function theilSen(points) {
	const slopes = [];
	for (let left = 0; left < points.length; left++) {
		for (let right = left + 1; right < points.length; right++) {
			const deltaX = points[right].x - points[left].x;
			if (deltaX !== 0) slopes.push((points[right].y - points[left].y) / deltaX);
		}
	}
	return median(slopes);
}

function ols(points) {
	const xMean = mean(points.map(({ x }) => x));
	const yMean = mean(points.map(({ y }) => y));
	const denominator = points.reduce((sum, { x }) => sum + (x - xMean) ** 2, 0);
	const slope = points.reduce((sum, { x, y }) => sum + (x - xMean) * (y - yMean), 0) / denominator;
	const intercept = yMean - slope * xMean;
	const residual = points.reduce((sum, { x, y }) => sum + (y - (intercept + slope * x)) ** 2, 0);
	const total = points.reduce((sum, { y }) => sum + (y - yMean) ** 2, 0);
	return { intercept, rSquared: total === 0 ? 1 : 1 - residual / total, slope };
}

function resampledMedian(values, random) {
	return median(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]));
}

function isPositiveFinite(value) {
	return Number.isFinite(value) && value > 0;
}

function bootstrapUpperBound(populations, field, seed, iterations) {
	const random = deterministicRandom(seed);
	const slopes = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const points = populations.map(({ population, samples }) => ({
			x: population,
			y: resampledMedian(
				samples.map((sample) => sample.heap.selected[field]),
				random
			),
		}));
		slopes.push(theilSen(points));
	}
	return quantile(slopes, 0.99);
}

function bootstrapFixedActivation(demandSamples, curvePopulations, seed, iterations) {
	const random = deterministicRandom(seed);
	const deltas = [];
	const baseline = curvePopulations.find(({ population }) => population === 0);
	if (demandSamples.length === 0 || baseline === undefined || curvePopulations.length < 2) return undefined;
	for (let iteration = 0; iteration < iterations; iteration++) {
		const demandMedian = resampledMedian(
			demandSamples.map((sample) => sample.heap.selected.heapUsed),
			random
		);
		deltas.push(resampledFixedActivation(demandMedian, curvePopulations, random));
	}
	return quantile(deltas, 0.99);
}

function resampledFixedActivation(demandMedian, curvePopulations, random) {
	const points = curvePopulations.map(({ population, samples }) => ({
		x: population,
		y: resampledMedian(
			samples.map((sample) => sample.heap.selected.heapUsed),
			random
		),
	}));
	const slope = theilSen(points);
	const baselineMedian = points.find(({ x }) => x === 0)?.y;
	return demandMedian - baselineMedian - slope * 280;
}

function bootstrapJointFixedActivation(demandSamples, placementPopulations, seed, iterations) {
	if (
		demandSamples.length === 0 ||
		placementPopulations.length === 0 ||
		placementPopulations.some(
			({ populations }) =>
				populations.length < 2 || populations.find(({ population }) => population === 0) === undefined
		)
	) {
		return undefined;
	}
	const random = deterministicRandom(seed);
	const maxima = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const demandMedian = resampledMedian(
			demandSamples.map((sample) => sample.heap.selected.heapUsed),
			random
		);
		const placementDeltas = placementPopulations.map(({ populations }) =>
			resampledFixedActivation(demandMedian, populations, random)
		);
		maxima.push(Math.max(...placementDeltas));
	}
	return quantile(maxima, 0.99);
}

function curveAnalysis(samples, runSeed, acceptanceEligible) {
	const byPopulation = Map.groupBy(samples, ({ population }) => population);
	const populations = [...byPopulation.entries()]
		.map(([population, grouped]) => ({ population, samples: grouped }))
		.sort((left, right) => left.population - right.population);
	const heapPoints = populations.map(({ population, samples: grouped }) => ({
		x: population,
		y: median(grouped.map((sample) => sample.heap.selected.heapUsed)),
	}));
	const v8Points = populations.map(({ population, samples: grouped }) => ({
		x: population,
		y: median(grouped.map((sample) => sample.heap.selected.usedHeapSize)),
	}));
	const heapSlope = theilSen(heapPoints);
	const v8Slope = theilSen(v8Points);
	const heapOls = ols(heapPoints);
	const intercept = median(heapPoints.map(({ x, y }) => y - heapSlope * x));
	const absoluteResiduals = heapPoints.map(({ x, y }) => Math.abs(y - (intercept + heapSlope * x)));
	const fittedDelta = heapSlope * (heapPoints.at(-1).x - heapPoints[0].x);
	const baselineSamples = populations[0].samples.toSorted((left, right) => left.launchOrdinal - right.launchOrdinal);
	const split = Math.floor(baselineSamples.length / 2);
	const baselineFirst = baselineSamples.slice(0, split).map((sample) => sample.heap.selected.heapUsed);
	const baselineLast = baselineSamples.slice(split).map((sample) => sample.heap.selected.heapUsed);
	const baselineDrift = Math.abs(median(baselineFirst) - median(baselineLast));
	const baselineMedian = heapPoints[0].y;
	const marginalSamples = populations
		.filter(({ population }) => population > 0)
		.flatMap(({ population, samples: grouped }) =>
			grouped.map((sample) => (sample.heap.selected.heapUsed - baselineMedian) / population)
		);
	const marginal = describe(marginalSamples);
	const bootstrapIterations = acceptanceEligible ? ACCEPTANCE_THRESHOLDS.bootstrapIterations : 100;
	const u99 = bootstrapUpperBound(populations, "heapUsed", `${runSeed}:heap-bootstrap`, bootstrapIterations);
	const nonMonotone = heapPoints.some((point, index) => index > 0 && point.y < heapPoints[index - 1].y);
	const heapV8Disagreement = Math.abs(heapSlope - v8Slope) / Math.max(Math.abs(heapSlope), 1);
	const medianAbsoluteResidualFraction = median(absoluteResiduals) / Math.max(Math.abs(fittedDelta), 1);
	const u99ToMedianRatio = u99 / marginal.median;
	const failures = [];
	const requiredEvidence = [heapSlope, v8Slope, intercept, marginal.median, marginal.p95, u99, heapOls.rSquared];
	if (requiredEvidence.some((value) => !Number.isFinite(value))) failures.push("missing or non-finite curve evidence");
	if (heapSlope <= 0 || marginal.median <= 0) failures.push("non-positive marginal cost");
	if (nonMonotone) failures.push("non-monotone population medians");
	if (medianAbsoluteResidualFraction > ACCEPTANCE_THRESHOLDS.maximumMedianAbsoluteResidualFraction) {
		failures.push("median absolute residual exceeds threshold");
	}
	if (u99ToMedianRatio > ACCEPTANCE_THRESHOLDS.maximumU99ToMedianRatio) failures.push("U99/median exceeds threshold");
	if (heapOls.rSquared < ACCEPTANCE_THRESHOLDS.minimumOlsRSquared) failures.push("OLS R-squared misses threshold");
	if (heapV8Disagreement > ACCEPTANCE_THRESHOLDS.heapV8MarginalDisagreementFraction) {
		failures.push("heap/V8 marginal disagreement exceeds threshold");
	}
	const baselineDriftLimit = Math.max(
		ACCEPTANCE_THRESHOLDS.baselineDriftFloorBytes,
		Math.abs(fittedDelta) * ACCEPTANCE_THRESHOLDS.baselineDriftFractionOfFittedDelta
	);
	if (baselineDrift > baselineDriftLimit) failures.push("baseline drift exceeds threshold");
	return {
		acceptance: { evaluated: acceptanceEligible, failures: acceptanceEligible ? failures : [] },
		baselineDrift: { bytes: baselineDrift, limitBytes: baselineDriftLimit },
		bootstrap: { iterations: bootstrapIterations, oneSided99UpperMarginalBytesPerPair: u99 },
		heapV8MarginalDisagreementFraction: heapV8Disagreement,
		marginalBytesPerPair: { ...marginal, theilSen: heapSlope, u99ToMedianRatio, v8TheilSen: v8Slope },
		medianAbsoluteResidualFraction,
		ols: heapOls,
		theilSenIntercept: intercept,
		populations: populations.map(({ population, samples: grouped }) => ({
			heapUsed: describe(grouped.map((sample) => sample.heap.selected.heapUsed)),
			population,
			usedHeapSize: describe(grouped.map((sample) => sample.heap.selected.usedHeapSize)),
		})),
	};
}

function expectedPerPair(shape) {
	if (shape === "minimal-dormant" || shape === "post-completion-dormant") {
		return { advertisedHeads: 0, attempts: 0, branchCuts: 0, cooldown: "undefined", outstanding: 0, sharedHeads: 0 };
	}
	if (shape === "maximum-dormant") {
		return { advertisedHeads: 32, attempts: 0, branchCuts: 32, cooldown: "undefined", outstanding: 0, sharedHeads: 32 };
	}
	if (shape === "active-cooldown") {
		return {
			advertisedHeads: 0,
			attempts: 3,
			branchCuts: 0,
			cooldown: "active-defined",
			outstanding: 64,
			sharedHeads: 0,
		};
	}
	if (shape === "expired-defined-cooldown") {
		return {
			advertisedHeads: 0,
			attempts: 3,
			branchCuts: 0,
			cooldown: "expired-defined",
			outstanding: 64,
			sharedHeads: 0,
		};
	}
	return {
		advertisedHeads: 0,
		attempts: Number(shape.at(-1)),
		branchCuts: 0,
		cooldown: "undefined",
		outstanding: 64,
		sharedHeads: 0,
	};
}

function expectedOperations(shape, population) {
	const perPair = {
		completePresentExactRequests: 0,
		prepareSyncSend: 0,
		queueExactRequests: 0,
		recordAdvertisedHeads: 0,
		recordBranchCuts: 0,
		recordSharedHeads: 0,
	};
	if (shape === "minimal-dormant") perPair.prepareSyncSend = 1;
	else if (shape === "maximum-dormant") {
		perPair.recordAdvertisedHeads = 1;
		perPair.recordBranchCuts = 1;
		perPair.recordSharedHeads = 1;
	} else {
		perPair.queueExactRequests = 1;
		if (shape === "post-completion-dormant") perPair.completePresentExactRequests = 1;
		else if (shape === "active-cooldown" || shape === "expired-defined-cooldown") perPair.prepareSyncSend = 4;
		else perPair.prepareSyncSend = Number(shape.at(-1));
	}
	return Object.fromEntries(Object.entries(perPair).map(([key, count]) => [key, count * population]));
}

function expectedOperationSequence(shape) {
	if (shape === "minimal-dormant") {
		return [{ effect: "allocate dormant pair", inputCount: 0, operation: "prepareSyncSend", repeat: 1 }];
	}
	if (shape === "maximum-dormant") {
		return [
			{ effect: "replace advertised heads", inputCount: 32, operation: "recordAdvertisedHeads", repeat: 1 },
			{ effect: "retain branch cuts", inputCount: 32, operation: "recordBranchCuts", repeat: 1 },
			{ effect: "replace shared heads", inputCount: 32, operation: "recordSharedHeads", repeat: 1 },
		];
	}
	const sequence = [
		{ effect: "allocate outstanding hashes", inputCount: 64, operation: "queueExactRequests", repeat: 1 },
	];
	if (shape === "post-completion-dormant") {
		sequence.push({
			effect: "deallocate 64 outstanding hashes",
			inputCount: 64,
			operation: "completePresentExactRequests",
			repeat: 1,
		});
		return sequence;
	}
	const repeat = shape.startsWith("outstanding-attempt-") ? Number(shape.at(-1)) : 4;
	if (repeat > 0) {
		sequence.push({
			effect: shape.includes("cooldown") ? "charge attempts then define cooldown" : `charge ${repeat} attempts`,
			inputCount: 0,
			operation: "prepareSyncSend",
			repeat,
		});
	}
	return sequence;
}

function expectedStructure(sample) {
	const objectCount =
		sample.population === 0 ? 0 : sample.placement === "one-hot-object" ? 1 : Math.min(20, sample.population);
	const minimum =
		sample.population === 0
			? 0
			: sample.placement === "one-hot-object"
				? sample.population
				: Math.floor(sample.population / 20);
	const maximum =
		sample.population === 0
			? 0
			: sample.placement === "one-hot-object"
				? sample.population
				: Math.ceil(sample.population / 20);
	return {
		objectCount,
		operationSequence: expectedOperationSequence(sample.shape),
		operationTotals: expectedOperations(sample.shape, sample.population),
		pairCount: sample.population,
		pairsPerObject: { maximum, minimum, sum: sample.population },
		perPair: expectedPerPair(sample.shape),
	};
}

function corpusFailures(samples, metadata) {
	const failures = [];
	const seenSeeds = new Set();
	const seenOrdinals = new Set();
	for (const sample of samples) {
		if (seenSeeds.has(sample.sampleSeed)) failures.push(`duplicate sample seed ${sample.sampleSeed}`);
		seenSeeds.add(sample.sampleSeed);
		if (seenOrdinals.has(sample.launchOrdinal)) failures.push(`duplicate launch ordinal ${sample.launchOrdinal}`);
		seenOrdinals.add(sample.launchOrdinal);
	}
	const expectedCells = [];
	for (const shape of metadata.schedule.shapes) {
		for (const placement of metadata.schedule.placements) {
			for (const population of metadata.schedule.populations) expectedCells.push({ placement, population, shape });
		}
		if (metadata.schedule.includeDemandPoint) expectedCells.push({ placement: "demand-20x14", population: 280, shape });
	}
	for (const cell of expectedCells) {
		for (const discardedWarmup of [true, false]) {
			const expectedCount = discardedWarmup ? metadata.schedule.warmups : metadata.schedule.replicates;
			const actual = samples.filter(
				(sample) =>
					sample.shape === cell.shape &&
					sample.placement === cell.placement &&
					sample.population === cell.population &&
					sample.discardedWarmup === discardedWarmup
			);
			if (actual.length !== expectedCount) {
				failures.push(
					`${cell.shape}/${cell.placement}/N=${cell.population}/${discardedWarmup ? "warmup" : "measured"}: expected ${expectedCount}, got ${actual.length}`
				);
			}
		}
	}
	const expectedTotal = expectedCells.length * (metadata.schedule.warmups + metadata.schedule.replicates);
	if (samples.length !== expectedTotal) failures.push(`expected ${expectedTotal} total samples, got ${samples.length}`);
	return failures;
}

export function analyze(samples, metadata) {
	const measured = samples.filter((sample) => !sample.discardedWarmup);
	const unstabilized = samples.filter((sample) => sample.error !== undefined || !sample.heap?.selected);
	const usable = measured.filter((sample) => sample.error === undefined && sample.heap?.selected !== undefined);
	const demand = usable.filter((sample) => sample.placement === "demand-20x14");
	const curves = usable.filter((sample) => sample.placement !== "demand-20x14");
	const grouped = Map.groupBy(curves, (sample) => `${sample.shape}:${sample.placement}`);
	const curveReports = [...grouped.entries()].map(([key, group]) => {
		const [shape, placement] = key.split(":");
		return {
			placement,
			report: curveAnalysis(group, `${metadata.runSeed}:${key}`, metadata.acceptanceEligible),
			shape,
		};
	});
	const demandByShape = [...Map.groupBy(demand, ({ shape }) => shape).entries()].map(([shape, group]) => {
		const placementCurves = metadata.schedule.placements.map((placement) => {
			const placementSamples = curves.filter((sample) => sample.shape === shape && sample.placement === placement);
			const populations = [...Map.groupBy(placementSamples, ({ population }) => population).entries()]
				.map(([population, populationSamples]) => ({ population, samples: populationSamples }))
				.sort((left, right) => left.population - right.population);
			return { placement, populations };
		});
		const bootstrapIterations = metadata.acceptanceEligible ? ACCEPTANCE_THRESHOLDS.bootstrapIterations : 100;
		const placementEstimates = placementCurves.map(({ placement, populations }) => {
			const baseline = populations.find(({ population }) => population === 0);
			const curve = curveReports.find((entry) => entry.shape === shape && entry.placement === placement)?.report;
			const baselineMedian =
				baseline === undefined ? undefined : median(baseline.samples.map((sample) => sample.heap.selected.heapUsed));
			const fixedDeltas =
				curve === undefined || baselineMedian === undefined
					? []
					: group.map(
							(sample) => sample.heap.selected.heapUsed - baselineMedian - curve.marginalBytesPerPair.theilSen * 280
						);
			return {
				descriptive: fixedDeltas.length === 0 ? undefined : describe(fixedDeltas),
				oneSided99UpperBound: bootstrapFixedActivation(
					group,
					populations,
					`${metadata.runSeed}:${shape}:${placement}:fixed-activation`,
					bootstrapIterations
				),
				placement,
			};
		});
		return {
			fixedOwnerContainerBytes: {
				byPlacement: placementEstimates,
				oneSided99UpperBound: bootstrapJointFixedActivation(
					group,
					placementCurves,
					`${metadata.runSeed}:${shape}:joint-fixed-activation`,
					bootstrapIterations
				),
			},
			heapUsed: describe(group.map((sample) => sample.heap.selected.heapUsed)),
			shape,
			usedHeapSize: describe(group.map((sample) => sample.heap.selected.usedHeapSize)),
		};
	});
	const missingDemandShapes = metadata.schedule.includeDemandPoint
		? metadata.schedule.shapes.filter((shape) => !demandByShape.some((entry) => entry.shape === shape))
		: [];
	const structuralFailures = usable.flatMap((sample) => {
		const expected = expectedStructure(sample);
		for (const [key, value] of Object.entries(expected)) {
			if (JSON.stringify(sample.structuralCensus?.[key]) !== JSON.stringify(value)) {
				return [`sample ${sample.launchOrdinal} structural ${key} mismatch`];
			}
		}
		if (
			sample.population > 0 &&
			(sample.structuralCensus.peerIdLength.minimum !== 53 || sample.structuralCensus.peerIdLength.maximum !== 53)
		) {
			return [`sample ${sample.launchOrdinal} did not use 53-character production-shaped peer-key strings`];
		}
		if (
			sample.structuralCensus.creatorPeerIdLength !== 53 ||
			(sample.population > 0 && sample.structuralCensus.objectIdLength !== 86)
		) {
			return [`sample ${sample.launchOrdinal} did not use production-length creator-bound object IDs`];
		}
		if (
			(sample.population === 0 && sample.structuralCensus.compositeJsonTupleKeyUtf16Length !== undefined) ||
			(sample.population > 0 && sample.structuralCensus.compositeJsonTupleKeyUtf16Length !== 146)
		) {
			return [`sample ${sample.launchOrdinal} retained composite JSON tuple key length mismatch`];
		}
		return [];
	});
	const runtimeFailures = usable.flatMap((sample) => {
		const runtime = sample.runtime;
		const expected = metadata.measurementRuntime;
		if (
			runtime.node !== expected.node ||
			runtime.v8 !== expected.v8 ||
			runtime.modules !== expected.modules ||
			runtime.platform !== expected.platform ||
			runtime.arch !== expected.arch ||
			JSON.stringify(runtime.execArgv) !== JSON.stringify(expected.workerExecArgv)
		) {
			return [`sample ${sample.launchOrdinal} runtime mismatch`];
		}
		return [];
	});
	const acceptanceFailures = [
		...corpusFailures(samples, metadata),
		...unstabilized.map(
			(sample) => `unstabilized sample ${sample.launchOrdinal}: ${sample.error ?? "missing reading"}`
		),
		...missingDemandShapes.map((shape) => `missing demand point for ${shape}`),
		...structuralFailures,
		...runtimeFailures,
		...demandByShape.flatMap(({ fixedOwnerContainerBytes, shape }) => {
			const estimates = fixedOwnerContainerBytes.byPlacement;
			if (
				estimates.length !== metadata.schedule.placements.length ||
				estimates.some(
					({ descriptive, oneSided99UpperBound }) =>
						descriptive === undefined || !isPositiveFinite(oneSided99UpperBound)
				) ||
				!isPositiveFinite(fixedOwnerContainerBytes.oneSided99UpperBound)
			) {
				return [`${shape}: missing, non-finite, or non-positive fixed activation evidence`];
			}
			return [];
		}),
		...curveReports.flatMap(({ placement, report, shape }) =>
			report.acceptance.failures.map((failure) => `${shape}/${placement}: ${failure}`)
		),
	];
	const marginalEnvelope = {
		fixedOwnerContainerOneSided99UpperBytes:
			demandByShape.length === 0
				? undefined
				: Math.max(
						...demandByShape.map(({ fixedOwnerContainerBytes }) => fixedOwnerContainerBytes.oneSided99UpperBound)
					),
		p95BytesPerPair:
			curveReports.length === 0
				? undefined
				: Math.max(...curveReports.map(({ report }) => report.marginalBytesPerPair.p95)),
		oneSided99UpperBytesPerPair:
			curveReports.length === 0
				? undefined
				: Math.max(...curveReports.map(({ report }) => report.bootstrap.oneSided99UpperMarginalBytesPerPair)),
	};
	return {
		acceptance: {
			accepted: metadata.acceptanceEligible && acceptanceFailures.length === 0,
			eligible: metadata.acceptanceEligible,
			failures: metadata.acceptanceEligible ? acceptanceFailures : [],
		},
		curves: curveReports,
		demandPoint: demandByShape,
		marginalEnvelope,
		metadata,
		sampleCounts: {
			measured: measured.length,
			total: samples.length,
			unstabilized: unstabilized.length,
			usable: usable.length,
		},
		thresholds: ACCEPTANCE_THRESHOLDS,
	};
}

export function runAnalyzerSelfChecks() {
	const makeSamples = (population, values) =>
		values.map((heapUsed, launchOrdinal) => ({ heap: { selected: { heapUsed } }, launchOrdinal, population }));
	const curvePopulations = [0, 512, 1024, 2048, 4096].map((population) => ({
		population,
		samples: makeSamples(
			population,
			Array.from({ length: 30 }, (_, replicate) => 1_000_000 + population * 100 + (replicate % 3) * 8)
		),
	}));
	const demandSamples = makeSamples(
		280,
		Array.from({ length: 30 }, (_, replicate) => 1_000_000 + 280 * 100 + 4096 + (replicate % 3) * 8)
	);
	const fixed = bootstrapFixedActivation(demandSamples, curvePopulations, "fixed-activation-self-check", 500);
	if (!Number.isFinite(fixed) || Math.abs(fixed - 4096) > 32) {
		throw new Error(`Joint F99 bootstrap self-check failed: ${fixed}`);
	}
	const largerDemandSamples = makeSamples(
		280,
		Array.from({ length: 30 }, (_, replicate) => 1_000_000 + 280 * 100 + 8192 + (replicate % 3) * 8)
	);
	const largerFixed = bootstrapFixedActivation(
		largerDemandSamples,
		curvePopulations,
		"larger-fixed-activation-self-check",
		500
	);
	const maxSeparate = Math.max(fixed, largerFixed);
	if (!Number.isFinite(largerFixed) || Math.abs(maxSeparate - 8192) > 32) {
		throw new Error(`Separate placement maximum self-check failed: ${maxSeparate}`);
	}
	const jointFixed = bootstrapJointFixedActivation(
		largerDemandSamples,
		[
			{ placement: "one-hot-object", populations: curvePopulations },
			{ placement: "round-robin-20", populations: curvePopulations },
		],
		"joint-fixed-activation-self-check",
		500
	);
	if (!Number.isFinite(jointFixed) || Math.abs(jointFixed - 8192) > 32) {
		throw new Error(`Joint fixed activation self-check failed: ${jointFixed}`);
	}
	const disjointTailPopulations = [
		{ population: 0, samples: makeSamples(0, Array(10).fill(1_000_000)) },
		{
			population: 512,
			samples: makeSamples(512, [...Array(8).fill(1_051_200), ...Array(2).fill(1_031_200)]),
		},
	];
	const disjointTailDemand = makeSamples(280, Array(10).fill(1_028_000));
	const separateTailUpperBounds = ["tail-placement-a", "tail-placement-b"].map((seed) =>
		bootstrapFixedActivation(disjointTailDemand, disjointTailPopulations, seed, 10_000)
	);
	const maxSeparateTailUpperBound = Math.max(...separateTailUpperBounds);
	const jointTailUpperBound = bootstrapJointFixedActivation(
		disjointTailDemand,
		[
			{ placement: "tail-placement-a", populations: disjointTailPopulations },
			{ placement: "tail-placement-b", populations: disjointTailPopulations },
		],
		"joint-disjoint-tail-self-check",
		10_000
	);
	if (
		!Number.isFinite(jointTailUpperBound) ||
		!Number.isFinite(maxSeparateTailUpperBound) ||
		jointTailUpperBound <= maxSeparateTailUpperBound
	) {
		throw new Error(
			`Joint q99-of-max did not exceed max-of-separate-q99s: ${jointTailUpperBound} <= ${maxSeparateTailUpperBound}`
		);
	}
	const negativeDemandSamples = makeSamples(
		280,
		Array.from({ length: 30 }, (_, replicate) => 1_000_000 + 280 * 100 - 4096 + (replicate % 3) * 8)
	);
	const negativeFixed = bootstrapFixedActivation(
		negativeDemandSamples,
		curvePopulations,
		"negative-fixed-activation-self-check",
		500
	);
	if (isPositiveFinite(negativeFixed)) {
		throw new Error(`Non-positive fixed activation evidence was accepted: ${negativeFixed}`);
	}
	const corruptMetadata = {
		acceptanceEligible: true,
		measurementRuntime: {},
		runSeed: "corrupted-corpus-self-check",
		schedule: {
			includeDemandPoint: false,
			placements: ["one-hot-object"],
			populations: [0],
			replicates: 1,
			shapes: ["minimal-dormant"],
			warmups: 1,
		},
	};
	const corrupt = [
		{
			discardedWarmup: false,
			launchOrdinal: 0,
			placement: "one-hot-object",
			population: 0,
			sampleSeed: "x",
			shape: "minimal-dormant",
		},
		{
			discardedWarmup: false,
			launchOrdinal: 0,
			placement: "one-hot-object",
			population: 0,
			sampleSeed: "x",
			shape: "minimal-dormant",
		},
	];
	const corruptReport = analyze(corrupt, corruptMetadata);
	if (corruptReport.acceptance.accepted || corruptReport.acceptance.failures.length < 3) {
		throw new Error("Corrupted-corpus self-check did not fail closed");
	}
	return {
		corruptedCorpus: "rejected",
		expectedFixedActivationBytes: 4096,
		jointDisjointTailU99Bytes: jointTailUpperBound,
		jointFixedActivationU99Bytes: jointFixed,
		maxSeparatePlacementU99Bytes: maxSeparate,
		maxSeparateDisjointTailU99Bytes: maxSeparateTailUpperBound,
		nonPositiveFixedActivation: "rejected",
		observedFixedActivationU99Bytes: fixed,
	};
}

async function main() {
	const argumentsMap = parseArguments(process.argv.slice(2));
	if (argumentsMap.get("self-check") === true) {
		process.stdout.write(`${JSON.stringify(runAnalyzerSelfChecks())}\n`);
		return;
	}
	const input = requiredArgument(argumentsMap, "input");
	const metadataPath = requiredArgument(argumentsMap, "metadata");
	const output = requiredArgument(argumentsMap, "output");
	const [raw, metadataRaw] = await Promise.all([readFile(input, "utf8"), readFile(metadataPath, "utf8")]);
	const samples = raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const report = analyze(samples, JSON.parse(metadataRaw));
	await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	process.stdout.write(`${JSON.stringify(report.acceptance)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
