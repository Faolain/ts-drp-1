/**
 * Calculates the average of an array of numbers
 * @param values Array of numbers
 * @returns Average
 */
function calculateAverage(values: number[]): number {
	return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Calculates standard deviation of an array of numbers
 * @param values Array of numbers
 * @returns Standard deviation
 */
function calculateStdDev(values: number[]): number {
	const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
	const squareDiffs = values.map((value) => Math.pow(value - avg, 2));
	const avgSquareDiff = squareDiffs.reduce((sum, val) => sum + val, 0) / squareDiffs.length;
	return Math.sqrt(avgSquareDiff);
}

/**
 * Format a number with its standard deviation as percentage
 * @param avg Average value
 * @param unit Unit of the value
 * @param stdDev Standard deviation
 * @returns Formatted string with value and percentage deviation
 */
function formatWithPercentageStdDev(avg: number, unit: string, stdDev: number): string {
	// Calculate std dev as percentage of the mean
	if (avg === 0) {
		return `${avg.toFixed(2)} ${unit} ±0.00%`;
	}
	const percentStdDev = (stdDev / Math.abs(avg)) * 100;
	return `${avg.toFixed(2)} ${unit} ±${percentStdDev.toFixed(2)}%`;
}

export interface MemoryBenchmarkResult {
	name: string;
	value: number;
	unit: string;
	range: string;
	extra: string;
}

/**
 * Creates a benchmark result compatible with github-action-benchmark's
 * customSmallerIsBetter input.
 * @param name Name of the benchmark
 * @param observations Array of observations
 * @param unit Unit of the value
 * @param normalizingFactor Factor to normalize (divide) the value by
 * @returns Structured smaller-is-better benchmark result
 */
export function createMemoryBenchmarkResult(
	name: string,
	observations: number[],
	unit: string,
	normalizingFactor: number = 1
): MemoryBenchmarkResult {
	if (observations.length === 0) {
		throw new Error(`Memory benchmark "${name}" produced no observations`);
	}

	const value = calculateAverage(observations) / normalizingFactor;
	const stdDev = calculateStdDev(observations) / normalizingFactor;
	const percentStdDev = value === 0 ? 0 : (stdDev / Math.abs(value)) * 100;
	return {
		name,
		value,
		unit,
		range: `±${percentStdDev.toFixed(2)}%`,
		extra: `${observations.length} runs sampled`,
	};
}

/**
 * Format the output of a memory benchmark in Benchmark.js format
 * @param name Name of the benchmark
 * @param observations Array of observations
 * @param unit Unit of the value
 * @param normalizingFactor Factor to normalize (divide) the value by
 * @returns Formatted string with value and percentage deviation
 */
export function formatOutput(
	name: string,
	observations: number[],
	unit: string,
	normalizingFactor: number = 1
): string {
	const result = createMemoryBenchmarkResult(name, observations, unit, normalizingFactor);
	const stdDev = calculateStdDev(observations) / normalizingFactor;
	return `${result.name} x ${formatWithPercentageStdDev(result.value, result.unit, stdDev)} (${result.extra})`;
}
