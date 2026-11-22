import fs from "node:fs";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const baseline = ".logs/d110c-grid-authority/grid100-diagnostic-terminal-lifecycle-repaired";
const after = ".logs/grid-memory-attribution/grid100-assertion-released";
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const hash = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
function ols(values) {
	const center = (values.length - 1) / 2;
	const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
	return (
		values.reduce((sum, n, i) => sum + (i - center) * (n - mean), 0) /
		values.reduce((sum, _, i) => sum + (i - center) ** 2, 0)
	);
}
function collect(directory) {
	const status = read(`${directory}/status.json`);
	assert.equal(status.code, 0);
	assert.equal(status.timedOut, false);
	assert.equal(status.sourceCustodyExact, true);
	assert.deepEqual(status.remaining, []);
	const records = fs
		.readFileSync(`${directory}/stdout.log`, "utf8")
		.split("\n")
		.filter((line) => line.startsWith('{"kind":"GRID100_DIAGNOSTIC"'))
		.map(JSON.parse);
	const samples = records.filter((row) => row.phase === "epoch-complete");
	const diagnostic = records.find((row) => row.phase === "memory-diagnostic");
	const settled = records.find((row) => row.phase === "settled");
	assert.equal(samples.length, 101);
	assert.equal(settled.completed, true);
	assert.equal(settled.transitions, 100);
	assert.equal(settled.contributions, 6464);
	assert.equal(settled.recoveredSources, 200);
	assert.equal(samples.at(-1).creatorRestarts, 10);
	assert.ok(samples.every((row) => row.memory.postGc));
	for (const row of samples) assert.equal(row.memory.ownedBytes, row.memory.heapUsed + row.memory.arrayBuffers);
	for (const [field, key] of [
		["heapUsed", "heapUsedSlope"],
		["arrayBuffers", "arrayBuffersSlope"],
		["ownedBytes", "ownedBytesSlope"],
	]) {
		assert.ok(Math.abs(ols(samples.slice(-32).map((row) => row.memory[field])) - diagnostic[key]) < 0.0001);
	}
	return {
		directory,
		status,
		diagnostic,
		settled,
		sampleCount: samples.length,
		peakBytes: Object.fromEntries(
			["heapUsed", "arrayBuffers", "external", "ownedBytes", "rss"].map((key) => [
				key,
				Math.max(...samples.map((row) => row.memory[key])),
			])
		),
		finalMemory: samples.at(-1).memory,
		sourceEvidenceHashes: Object.fromEntries(
			["command.json", "status.json", "stdout.log"].map((name) => [name, hash(`${directory}/${name}`)])
		),
		samples,
	};
}
const before = collect(baseline),
	green = collect(after);
const fields = [
	"epoch",
	"transitions",
	"contributions",
	"recoveredSources",
	"creatorRestarts",
	"objectId",
	"worldDigest",
	"worldBytes",
	"durableRows",
	"maxDurableRows",
	"pruningReceipts",
	"evidenceRecordsReleased",
	"retainedRecoverySources",
	"retainedObserverCommits",
	"activeRoomOwners",
];
for (let i = 0; i < 101; i++)
	for (const key of fields) assert.deepEqual(green.samples[i][key], before.samples[i][key], `epoch ${i}: ${key}`);
assert.ok(green.samples.every((row) => row.observerDurationMs === 0));
delete before.samples;
delete green.samples;
const report = {
	scope: "Paired unprofiled 64-writer, 100-transition diagnostics; not memory acceptance",
	before,
	after: green,
	equivalence: {
		matchedEpochSamples: 101,
		matchedFields: fields,
		observerDurationZero: true,
		finalColdReopen:
			"Passed exact world/authority and no duplicate issue/publication assertions before memory-diagnostic record",
	},
	slopeComparison: {
		definition:
			"OLS over last32 post-GC samples, indexed by sample; ownedBytes = heapUsed + arrayBuffers, not heapUsed + external + arrayBuffers",
		beforeBytesPerSample: before.diagnostic.ownedBytesSlope,
		afterBytesPerSample: green.diagnostic.ownedBytesSlope,
		reductionPercent: 100 * (1 - green.diagnostic.ownedBytesSlope / before.diagnostic.ownedBytesSlope),
		afterReferenceMultiple: green.diagnostic.ownedBytesSlope / green.diagnostic.referenceSlopeLimit,
	},
	limitations: [
		"The aggregate metric includes fake IndexedDB persisted data and harness/runtime memory; it is not product-retained heap.",
		"Shared runEpoch frame extraction and bounded diagnostic startup lookup also changed since original100; numeric before/after differences are not exclusively attributed to one fix.",
		"Matching all epoch digests/counters establishes observed deterministic workload equivalence, not byte-identical DAG scheduling.",
		"Profiled30 retaining-path and graph-partition evidence is separate; serialized payload bytes are never subtracted from process heap.",
	],
};
fs.writeFileSync(`${after}/comparison.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
