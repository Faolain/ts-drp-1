import { createMemoryBenchmarkResult, type MemoryBenchmarkResult } from "@ts-drp/utils/memory-benchmark";
import { spawn } from "child_process";
import path from "path";

const DIR_NAME = path.dirname(new URL(import.meta.url).pathname);
const TEST_FILE_DIR = "memory-tests";

const ITERATIONS_PER_TEST = 2; // each test gives 2 results from 2 nodes
const NUM_MESSAGES = [5];

async function runBootstrapNode(): Promise<void> {
	return new Promise((resolve, reject) => {
		const bootstrap = spawn("tsx", [
			path.resolve(DIR_NAME, TEST_FILE_DIR, "bootstrap.ts"),
			"--seed",
			"bootstrap",
			"--stop",
			"20000",
		]);

		let bootstrapStarted = false;

		bootstrap.stdout.on("data", (data) => {
			const output = data.toString();
			if (output.includes("INFO: drp::network ::start: Successfuly started DRP network")) {
				bootstrapStarted = true;
				// Give additional time for the node to fully initialize and start listening
				setTimeout(() => resolve(), 5000);
			}
		});

		bootstrap.on("close", (code) => {
			if (code !== 0 && !bootstrapStarted) {
				reject(new Error(`Bootstrap process exited with code ${code}`));
			}
		});

		// Set a timeout in case the bootstrap node doesn't start
		setTimeout(() => {
			if (!bootstrapStarted) {
				reject(new Error("Bootstrap node failed to start within timeout"));
				bootstrap.kill();
			}
		}, 30000);
	});
}

async function runNodeProcess(seed: string, numMessages: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const node = spawn("tsx", [
			path.resolve(DIR_NAME, TEST_FILE_DIR, "node.ts"),
			"--seed",
			seed,
			"--topic",
			"test",
			"--stop",
			"20000",
			"--messages",
			numMessages.toString(),
		]);

		let stdout = "";
		let stderr = "";
		node.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		node.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		node.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`Node ${seed} process exited with code ${code}: ${stderr.trim()}`));
				return;
			}
			const match = stdout.match(/MAX_RSS_KB=(\d+)/);
			if (!match) {
				reject(new Error(`Node ${seed} did not report MAX_RSS_KB`));
				return;
			}
			resolve(Number.parseInt(match[1], 10));
		});
	});
}

async function runProcessMemoryScript(numTests: number, numMessages: number): Promise<number[]> {
	const results = [];
	for (let i = 0; i < numTests; i++) {
		// Start bootstrap node and wait for it to be ready
		await runBootstrapNode();

		// Run both nodes in parallel
		const [node1Result, node2Result] = await Promise.all([
			runNodeProcess("peer1", numMessages),
			runNodeProcess("peer2", numMessages),
		]);

		results.push(node1Result, node2Result);
	}
	return results;
}

async function main(): Promise<void> {
	const benchmarkResults: MemoryBenchmarkResult[] = [];
	for (const numMessages of NUM_MESSAGES) {
		const memoryResults = await runProcessMemoryScript(ITERATIONS_PER_TEST, numMessages);

		if (memoryResults.length > 0) {
			benchmarkResults.push(
				createMemoryBenchmarkResult(
					`DRPNode sending ${numMessages} messages per second memory usage`,
					memoryResults,
					"MB",
					1024
				)
			);
		} else {
			throw new Error(`No node memory results received for ${numMessages} messages per second`);
		}
	}

	process.stdout.write(`${JSON.stringify(benchmarkResults)}\n`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
