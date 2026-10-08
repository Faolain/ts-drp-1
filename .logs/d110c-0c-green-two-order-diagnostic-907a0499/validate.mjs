import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = ".logs/d110c-0c-green-two-order-diagnostic-907a0499";
const reporter = JSON.parse(readFileSync(`${root}/playwright.json`, "utf8"));
const expectedTitle =
	"D.110c-0c resumes a genuine epoch-3 pending adoption after both process-death orderings";
const expectedDetail =
	"v3 room successor reopen failed: recovery-rejected: creator predecessor recovery failed: admission-rejected";
const token = "D110C_0C_EPOCH3_COLD_REOPEN_BLOCKED";

assert.deepEqual(reporter.errors, []);
assert.deepEqual(
	{
		expected: reporter.stats.expected,
		flaky: reporter.stats.flaky,
		skipped: reporter.stats.skipped,
		unexpected: reporter.stats.unexpected,
	},
	{ expected: 0, flaky: 0, skipped: 0, unexpected: 1 }
);
assert.equal(reporter.suites.length, 1);
const suite = reporter.suites[0];
assert.equal(suite.file, "phase-6a-creator-successor-product.pw.ts");
assert.equal(suite.specs.length, 1);
const spec = suite.specs[0];
assert.equal(spec.title, expectedTitle);
assert.equal(spec.ok, false);
assert.equal(spec.tests.length, 1);
const test = spec.tests[0];
assert.equal(test.status, "unexpected");
assert.equal(test.expectedStatus, "passed");
assert.equal(test.results.length, 1);
const result = test.results[0];
assert.equal(result.status, "failed");
assert.equal(result.errors.length, 2);
for (const error of result.errors) {
	assert.equal(error.message.match(new RegExp(token, "g"))?.length, 1);
	const plainMessage = error.message.replaceAll(/\u001b\[[0-9;]*m/g, "");
	assert.match(plainMessage, /Expected: "fulfilled"/);
	assert.match(plainMessage, /Received: ".*admission-rejected"/);
}

const bodies = new Map(
	result.attachments
		.filter(({ name }) => name.startsWith("d110c-0c-causal-evidence"))
		.map(({ body, contentType, name }) => {
			assert.equal(contentType, "application/json");
			assert.equal(typeof body, "string");
			return [name, JSON.parse(Buffer.from(body, "base64").toString("utf8"))];
		})
);
assert.deepEqual(
	[...bodies.keys()].sort(),
	[
		"d110c-0c-causal-evidence",
		"d110c-0c-causal-evidence-new-ahe",
		"d110c-0c-causal-evidence-old-ahe",
	]
);
const oldAhe = bodies.get("d110c-0c-causal-evidence-old-ahe");
const newAhe = bodies.get("d110c-0c-causal-evidence-new-ahe");
assert.deepEqual(bodies.get("d110c-0c-causal-evidence"), [oldAhe, newAhe]);

for (const [ordering, row, interrupted, swapHeadCount] of [
	["old-ahe", oldAhe, "D110C controlled pre-publication process death", 1],
	["new-ahe", newAhe, "D110C_FLOOR_UNAVAILABLE", 0],
]) {
	assert.equal(row.ordering, ordering);
	assert.equal(row.staged.ordering, ordering);
	assert.equal(row.staged.interrupted, interrupted);
	assert.equal(row.recovered.detail, expectedDetail);
	assert.deepEqual(row.recovered.recovery, {
		callCount: 1,
		resultKind: "active-new",
		swapHeadCount,
	});
	assert.equal(row.recovered.snapshotScope.epoch, 2);
	const before = row.recovered.floorBefore.state;
	const after = row.recovered.floorAfter.state;
	assert.equal(before.stable.epoch, 2);
	assert.equal(before.pending.previous.epoch, 2);
	assert.equal(before.pending.next.epoch, 3);
	assert.equal(after.stable.epoch, 3);
	assert.equal(after.pending, null);
	assert.equal(before.stable.objectId, after.stable.objectId);
	assert.equal(before.pending.next.currentAnchorDigest, after.stable.currentAnchorDigest);
}

const oldBefore = oldAhe.recovered.aheBefore;
const oldAfter = oldAhe.recovered.aheAfter;
assert.equal(oldAfter.activeHead.revision, oldBefore.activeHead.revision + 1);
const expectedOldGenerations = oldBefore.generations.map((generation) => {
	if (generation.generationId === oldBefore.activeHead.generationId) {
		return { ...generation, state: "Superseded" };
	}
	if (generation.generationId === oldAfter.activeHead.generationId) {
		return { ...generation, state: "Adopted" };
	}
	return generation;
});
assert.deepEqual(oldAfter, {
	...oldBefore,
	activeHead: oldAfter.activeHead,
	generations: expectedOldGenerations,
});
assert.deepEqual(newAhe.recovered.aheAfter, newAhe.recovered.aheBefore);

process.stdout.write(
	`${JSON.stringify(
		{
			attachments: [...bodies.keys()].sort(),
			causalTokenCount: result.errors.length,
			orderings: [oldAhe.ordering, newAhe.ordering],
			playwright: { files: 1, tests: 1, status: "failed-as-diagnostic" },
			postCommitDetail: expectedDetail,
			valid: true,
		},
		null,
		2
	)}\n`
);
