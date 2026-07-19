import { createMemoryBenchmarkResult, type MemoryBenchmarkResult } from "@ts-drp/utils/memory-benchmark";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const DIR_NAME = path.dirname(new URL(import.meta.url).pathname);
const TEST_FILE_DIR = "memory-tests";

const TEST_FILES = fs
	.readdirSync(path.join(DIR_NAME, TEST_FILE_DIR))
	.map((file) => path.join(DIR_NAME, TEST_FILE_DIR, file))
	.filter((file) => fs.statSync(file).isFile() && file.endsWith(".ts"));

const ITERATIONS_PER_TEST: Map<string, number> = new Map([["default", 5]]);
const TEST_SIZES: Map<string, number[]> = new Map([["default", [100, 1000]]]);

/**
 * Set the test sizes for a given test file from just the file name
 * @param testFile - The name of the test file
 * @param sizes - The sizes to test
 */
function setTestSizes(testFile: string, sizes: number[]): void {
	const testFilePath = path.join(DIR_NAME, TEST_FILE_DIR, testFile).concat(".ts");
	TEST_SIZES.set(testFilePath, sizes);
}

/**
 * Trim the test file path to just the file name
 * @param testFilePath - The path to the test file
 * @returns The file name of the test file
 */
function trimTestFilePath(testFilePath: string): string {
	return testFilePath.replace(path.join(DIR_NAME, TEST_FILE_DIR), "").replace(".ts", "").replace("/", "");
}

/**
 * Run the process memory script and return the memory usage results
 * @param numTests - The number of tests to run
 * @param programName - The name of the program to run
 * @param size - The number of vertices in the hashgraph
 * @returns The memory usage results
 */
async function runProcessMemoryScript(numTests: number, programName: string, size: number): Promise<number[]> {
	const memoryResults: number[] = [];
	for (let i = 0; i < numTests; i++) {
		memoryResults.push(
			await new Promise((resolve, reject) => {
				const test = spawn("tsx", [programName, size.toString()], {
					stdio: "pipe",
				});
				let stdout = "";
				let stderr = "";
				test.stdout.on("data", (data) => {
					stdout += data.toString();
				});
				test.stderr.on("data", (data) => {
					stderr += data.toString();
				});

				test.on("close", (code) => {
					if (code !== 0) {
						reject(new Error(`Program ${programName} exited with code ${code}: ${stderr.trim()}`));
						return;
					}
					const match = stdout.match(/MAX_RSS_KB=(\d+)/);
					if (!match) {
						reject(new Error(`Program ${programName} did not report MAX_RSS_KB`));
						return;
					}
					resolve(Number.parseInt(match[1], 10));
				});
			})
		);
	}
	return memoryResults;
}

async function main(): Promise<void> {
	const benchmarkResults: MemoryBenchmarkResult[] = [];
	setTestSizes("SetDRP-object", [100, 1000, 3000]);
	setTestSizes("grid-object", [100, 1000, 3000]);

	for (const testFile of TEST_FILES) {
		for (const testSize of TEST_SIZES.get(testFile) || TEST_SIZES.get("default") || []) {
			const memoryResults = await runProcessMemoryScript(
				ITERATIONS_PER_TEST.get(testFile) || ITERATIONS_PER_TEST.get("default") || 5,
				testFile,
				testSize
			);

			if (memoryResults.length > 0) {
				benchmarkResults.push(
					createMemoryBenchmarkResult(
						`${trimTestFilePath(testFile)} with ${testSize} vertices memory usage`,
						memoryResults,
						"MB",
						1024
					)
				);
			} else {
				throw new Error(`No memory results received for ${trimTestFilePath(testFile)} at size ${testSize}`);
			}
		}
	}

	process.stdout.write(`${JSON.stringify(benchmarkResults)}\n`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
