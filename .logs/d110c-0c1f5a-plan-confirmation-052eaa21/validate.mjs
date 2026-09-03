import { readFileSync } from "node:fs";

const root = new URL("./", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const exactTopKeys = [
  "corrected_red_authorized",
  "corrected_red_causal",
  "diagnostic_classification_honest",
  "findings",
  "plan_sufficient",
  "scope_preserved",
  "summary",
  "verdict",
];
const exactFindingKeys = ["evidence", "impact", "required_action", "severity", "title"];
const summaries = [];

for (const reviewer of ["grok", "kimi", "opus"]) {
  const verdict = JSON.parse(read(`${reviewer}/verdict.json`));
  const keys = Object.keys(verdict).sort();
  if (JSON.stringify(keys) !== JSON.stringify(exactTopKeys)) {
    throw new TypeError(`${reviewer}:TOP_KEYS:${JSON.stringify(keys)}`);
  }
  if (
    verdict.verdict !== "APPROVED" ||
    verdict.plan_sufficient !== true ||
    verdict.diagnostic_classification_honest !== true ||
    verdict.corrected_red_causal !== true ||
    verdict.corrected_red_authorized !== true ||
    verdict.scope_preserved !== true
  ) {
    throw new TypeError(`${reviewer}:BLOCKING_VERDICT`);
  }
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const finding of verdict.findings) {
    const findingKeys = Object.keys(finding).sort();
    if (JSON.stringify(findingKeys) !== JSON.stringify(exactFindingKeys)) {
      throw new TypeError(`${reviewer}:FINDING_KEYS:${JSON.stringify(findingKeys)}`);
    }
    if (!(finding.severity in counts)) throw new TypeError(`${reviewer}:SEVERITY`);
    counts[finding.severity] += 1;
  }
  if (counts.P0 !== 0 || counts.P1 !== 0) throw new TypeError(`${reviewer}:BLOCKING_UNION`);
  summaries.push({ reviewer, ...counts });
}

for (const gate of ["diff-check", "format", "lint", "listing"]) {
  if (read(`${gate}.status.txt`).trim() !== "0") throw new TypeError(`${gate}:FAILED`);
}

const listing = read("listing.stdout.txt").trim().split("\n");
if (
  listing.length !== 1 ||
  listing[0] !==
    "tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts > D.110c-0c1f5 foreign-author close-liveness RED > requires foreign frontier anomalies to remain author-local while creator corruption stays fail closed"
) {
  throw new TypeError(`LISTING_INVALID:${JSON.stringify(listing)}`);
}

process.stdout.write(
  `${JSON.stringify({ blockingUnion: 0, listingFiles: 1, listingTests: 1, reviewers: summaries, valid: true }, null, 2)}\n`,
);
