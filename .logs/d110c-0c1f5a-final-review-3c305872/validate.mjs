import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const root = new URL("./", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const parse = (name) => JSON.parse(read(name));
const exactTopKeys = [
	"evidence_sufficient",
	"f5a_closable",
	"findings",
	"green_closes_red",
	"red_causal",
	"retained_behavior_preserved",
	"scope_preserved",
	"summary",
	"verdict",
];
const exactFindingKeys = ["evidence", "impact", "required_action", "severity", "title"];
const summaries = [];

for (const reviewer of ["grok", "kimi", "opus"]) {
	const verdict = parse(`${reviewer}-verdict.json`);
	if (JSON.stringify(Object.keys(verdict).sort()) !== JSON.stringify(exactTopKeys)) {
		throw new TypeError(`${reviewer}:TOP_KEYS`);
	}
	if (
		verdict.verdict !== "APPROVED" ||
		verdict.red_causal !== true ||
		verdict.green_closes_red !== true ||
		verdict.scope_preserved !== true ||
		verdict.retained_behavior_preserved !== true ||
		verdict.evidence_sufficient !== true ||
		verdict.f5a_closable !== true
	) {
		throw new TypeError(`${reviewer}:BLOCKING_VERDICT`);
	}
	const counts = { P0: 0, P1: 0, P2: 0 };
	for (const finding of verdict.findings) {
		if (JSON.stringify(Object.keys(finding).sort()) !== JSON.stringify(exactFindingKeys)) {
			throw new TypeError(`${reviewer}:FINDING_KEYS`);
		}
		if (!(finding.severity in counts)) throw new TypeError(`${reviewer}:SEVERITY`);
		counts[finding.severity] += 1;
	}
	if (counts.P0 !== 0 || counts.P1 !== 0) throw new TypeError(`${reviewer}:BLOCKING_UNION`);
	summaries.push({ reviewer, ...counts });
}

const grokInitial = parse("grok/status.json");
if (
	grokInitial.classification !== "NO_VERDICT" ||
	grokInitial.exit_code !== 0 ||
	grokInitial.stop_reason !== "end_turn" ||
	grokInitial.timed_out !== false
) {
	throw new TypeError("GROK_INITIAL_CLASSIFICATION");
}
const grokReemit = parse("grok-schema-reemit.json");
if (
	grokReemit.sessionId !== "01a0694a-8769-7e92-9c14-10a40505a473" ||
	grokReemit.stopReason !== "end_turn" ||
	!isDeepStrictEqual(grokReemit.structuredOutput, parse("grok-verdict.json"))
) {
	throw new TypeError("GROK_REEMIT_INVALID");
}

if (read("kimi.status").trim() !== "0" || read("kimi-reemit.status").trim() !== "0") {
	throw new TypeError("KIMI_STATUS");
}
if (!read("kimi-reemit.stream.jsonl").includes("session_96c604b1-fd7b-4149-af66-1c18ca71ab02")) {
	throw new TypeError("KIMI_SESSION");
}

const opus = parse("opus.json");
if (
	read("opus.status").trim() !== "0" ||
	opus.is_error !== false ||
	opus.terminal_reason !== "completed" ||
	opus.session_id !== "a1430b93-04b9-4d22-acca-633fffbe1637" ||
	!isDeepStrictEqual(opus.structured_output, parse("opus-verdict.json"))
) {
	throw new TypeError("OPUS_INVALID");
}

const plan = read("../../docs/production-hardening/production-hardening-tdd-plan-v2.md");
for (const token of [
	"**Status: CLOSED. The first execution from `eeaaaca8` remains a noncausal",
	"`3c305872fbee759b1b6386c10a1d1ebbde3dd6e6` closed with an empty P0/P1",
	"the claimed issuance range remains exactly the",
	"The same audit owns\nthe `priorIdentity === undefined` genesis-close branch",
]) {
	if (!plan.includes(token)) throw new TypeError(`PLAN_TOKEN:${token}`);
}

const manifest = read("SHA256SUMS").trim().split("\n");
const listedPaths = [];
for (const line of manifest) {
	const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
	if (!match) throw new TypeError(`MANIFEST_LINE:${line}`);
	const [, expected, path] = match;
	if (path.endsWith("/SHA256SUMS") || path.endsWith("/manifest.sha256") || path.endsWith("/validation.txt")) {
		throw new TypeError(`MANIFEST_NOT_SELF_EXCLUDING:${path}`);
	}
	listedPaths.push(path);
	const actual = createHash("sha256")
		.update(readFileSync(new URL(`../../${path}`, root)))
		.digest("hex");
	if (actual !== expected) throw new TypeError(`HASH_MISMATCH:${path}`);
}

const evidencePrefix = ".logs/d110c-0c1f5a-final-review-3c305872/";
const actualPaths = readdirSync(root, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => {
		const relativeParent = entry.parentPath.slice(new URL(root).pathname.length);
		return `${evidencePrefix}${relativeParent ? `${relativeParent}/` : ""}${entry.name}`;
	})
	.filter(
		(path) => !path.endsWith("/SHA256SUMS") && !path.endsWith("/manifest.sha256") && !path.endsWith("/validation.txt")
	)
	.sort();
if (JSON.stringify(listedPaths.sort()) !== JSON.stringify(actualPaths)) {
	throw new TypeError("MANIFEST_INCOMPLETE");
}

process.stdout.write(
	`${JSON.stringify({ blockingUnion: 0, manifestEntries: manifest.length, reviewers: summaries, valid: true }, null, 2)}\n`
);
