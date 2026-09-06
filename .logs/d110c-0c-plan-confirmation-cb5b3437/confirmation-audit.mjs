import { readFileSync } from "node:fs";

const root = ".logs/d110c-0c-plan-confirmation-cb5b3437";
const planPath = "docs/production-hardening/production-hardening-tdd-plan-v2.md";

function json(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function blockingFindings(result) {
	return result.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1");
}

const grokStatus = json(`${root}/grok/status.json`);
const grokResume = json(`${root}/grok-resume.raw.json`);
const grok = grokResume.structuredOutput;

const kimiEvents = readFileSync(`${root}/kimi.stream.jsonl`, "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
const kimiAssistantResults = kimiEvents.flatMap((event) => {
	if (event.role !== "assistant" || typeof event.content !== "string") return [];
	try {
		return [JSON.parse(event.content)];
	} catch {
		return [];
	}
});
const kimi = kimiAssistantResults.at(-1);
const kimiResume = kimiEvents.findLast((event) => event.type === "session.resume_hint");
if (kimi === undefined || kimiResume === undefined) throw new TypeError("Kimi terminal evidence is unavailable");

const opusRaw = json(`${root}/opus.raw.json`);
const opus = JSON.parse(opusRaw.result);

const plan = readFileSync(planPath, "utf8");
const start = plan.indexOf("##### D.110c-0c durable pending-adoption resume plan");
const end = plan.indexOf("##### Retained long-horizon and golden-path acceptance", start);
if (start < 0 || end <= start) throw new TypeError("D.110c-0c plan slice is unavailable");
const slice = plan.slice(start, end);

const checks = Object.freeze({
	blockingUnionEmpty:
		blockingFindings(grok).length === 0 && blockingFindings(kimi).length === 0 && blockingFindings(opus).length === 0,
	grokApproved: grok.verdict === "APPROVED" && grok.blocking_union_closed === true,
	grokOriginalClassificationPreserved:
		grokStatus.classification === "NO_VERDICT" && grokStatus.exit_code === 0 && grokStatus.timed_out === false,
	grokP2Count: grok.findings.filter((finding) => finding.severity === "P2").length === 1,
	grokResumeIdentity:
		grokResume.sessionId === "01a0642c-d006-7963-871a-6f66b7bd9f39" &&
		grokResume.requestId === "6f3eaa04-5742-43cf-9ee4-d2dae05d129b",
	kimiApproved: kimi.verdict === "APPROVED" && kimi.blocking_union_closed === true,
	kimiP2Count: kimi.findings.filter((finding) => finding.severity === "P2").length === 0,
	kimiSessionIdentity: kimiResume.session_id === "session_39586ca5-3b3c-42d3-84a4-e0acf8444bcc",
	opusApproved: opus.verdict === "APPROVED" && opus.blocking_union_closed === true,
	opusNoSubagents: opusRaw.subagent_stats?.spawned === 0,
	opusP2Count: opus.findings.filter((finding) => finding.severity === "P2").length === 3,
	opusSessionIdentity: opusRaw.session_id === "50d4644a-2a5a-4b53-921c-33b59cb18c13",
	planAuthorizesRed:
		slice.includes("blocking union empty; deterministic RED authorized") &&
		slice.includes("The blocking union is empty and no further plan round is allowed."),
	planDispositionsComplete:
		slice.includes('`initialization: {kind: "reopen"}`') &&
		slice.includes("zero recovery-CAS count") &&
		slice.includes("exact epoch-3 verified scope") &&
		slice.includes("configured and consumed before process death"),
});

if (Object.values(checks).some((value) => value !== true)) {
	throw new TypeError(`D.110c-0c confirmation audit failed: ${JSON.stringify(checks)}`);
}

process.stdout.write(`${JSON.stringify({ checks, ok: true }, null, 2)}\n`);
