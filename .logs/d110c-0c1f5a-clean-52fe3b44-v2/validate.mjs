import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const json = (name) => JSON.parse(read(name));
const invariant = (value, message) => {
	if (!value) throw new TypeError(message);
};
for (const name of [
	"checkout.status",
	"verify-commit.status",
	"install.status",
	"f5a.status",
	"fixture-boundary.status",
	"listing.status",
	"playwright.status",
]) {
	invariant(read(name).trim() === "0", `${name}:STATUS_INVALID`);
}
invariant(read("pre-checkout-status.txt") === "", "PRE_CHECKOUT_DIRTY");
invariant(read("post-vitest-status.txt") === "", "POST_VITEST_DIRTY");
invariant(read("final-worktree-status.txt") === "", "FINAL_WORKTREE_DIRTY");
invariant(
	read("source-identity.txt") ===
		"52fe3b44a40ab025102cad7637bbd10fae6edaac\na174b6717d26ff2a1a41dd5e8b398efcaf996bd4\n",
	"SOURCE_IDENTITY_INVALID"
);
const f5a = json("f5a.json");
invariant(
	f5a.testResults.length === 1 &&
		f5a.numTotalTests === 1 &&
		f5a.numPassedTests === 1 &&
		f5a.numFailedTests === 0 &&
		f5a.numPendingTests === 0 &&
		f5a.success === true,
	"F5A_REPORT_INVALID"
);
const boundary = json("fixture-boundary.json");
invariant(
	boundary.testResults.length === 2 &&
		boundary.numTotalTests === 14 &&
		boundary.numPassedTests === 2 &&
		boundary.numFailedTests === 0 &&
		boundary.numPendingTests === 12 &&
		boundary.success === true,
	"FIXTURE_BOUNDARY_REPORT_INVALID"
);
const playwright = json("playwright.json");
invariant(playwright.errors.length === 0, "PLAYWRIGHT_TOP_LEVEL_ERROR");
invariant(playwright.stats.expected === 2, "PLAYWRIGHT_EXPECTED_INVALID");
invariant(playwright.stats.skipped === 0, "PLAYWRIGHT_SKIPPED_INVALID");
invariant(playwright.stats.unexpected === 0, "PLAYWRIGHT_UNEXPECTED_INVALID");
invariant(playwright.stats.flaky === 0, "PLAYWRIGHT_FLAKY_INVALID");
invariant(
	read("listing.txt").trim() ===
		"tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts > D.110c-0c1f5 foreign-author close liveness > keeps foreign frontier anomalies author-local while creator corruption stays fail closed",
	"LISTING_INVALID"
);
process.stdout.write(JSON.stringify({ browser: 2, f5a: 1, fixtureBoundary: 2, status: "VALID" }) + "\n");
