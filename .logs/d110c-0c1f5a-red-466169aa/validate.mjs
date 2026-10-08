import { readFileSync } from "node:fs";

const root = new URL("./", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const result = JSON.parse(read("result.json"));
const testResults = result.testResults ?? [];
const assertions = testResults.flatMap((entry) => entry.assertionResults ?? []);
const expectedTitle =
	"requires foreign frontier anomalies to remain author-local while creator corruption stays fail closed";
const expectedToken = "D110C_0C1F5_FOREIGN_AUTHOR_CLOSE_LIVENESS_REQUIRED";

if (read("status.txt").trim() !== "1") throw new TypeError("RUNNER_STATUS_INVALID");
if (
	result.success !== false ||
	result.numTotalTests !== 1 ||
	result.numPassedTests !== 0 ||
	result.numFailedTests !== 1 ||
	result.numPendingTests !== 0 ||
	result.numTodoTests !== 0 ||
	testResults.length !== 1 ||
	assertions.length !== 1
) {
	throw new TypeError("RESULT_COUNTS_INVALID");
}
if (
	!testResults[0].name.endsWith("/tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts") ||
	testResults[0].status !== "failed" ||
	assertions[0].title !== expectedTitle ||
	assertions[0].status !== "failed"
) {
	throw new TypeError("EXACT_SELECTION_INVALID");
}
const failures = assertions[0].failureMessages ?? [];
if (
	failures.length !== 1 ||
	!failures[0].startsWith(`TypeError: ${expectedToken}\n`) ||
	failures[0].split(expectedToken).length !== 2 ||
	failures[0].includes("NONCAUSAL_ERROR") ||
	failures[0].includes("UNEXPECTED_CLOSE_SUCCESS") ||
	failures[0].includes("ADMISSION_TIMEOUT")
) {
	throw new TypeError("CAUSAL_TERMINAL_INVALID");
}

process.stdout.write(
	`${JSON.stringify(
		{
			causal: true,
			failed: 1,
			passed: 0,
			pending: 0,
			selectedFiles: 1,
			selectedTests: 1,
			terminalToken: expectedToken,
			valid: true,
		},
		null,
		2
	)}\n`
);
