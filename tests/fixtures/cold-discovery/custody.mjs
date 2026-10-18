import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const evidence = ".logs/bounded-storage-lifecycle/cold-discovery-red-01";
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Plain Node JavaScript custody runner cannot contain TypeScript syntax.
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(evidence, { recursive: true });
const [mode, label, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/u.test(label ?? "")) throw new Error("INVALID_EVIDENCE_LABEL");
const claim = join(evidence, `${mode}-${label}.claim`);
if (
	existsSync(join(evidence, `${label}.log`)) ||
	existsSync(join(evidence, `${label}.json`)) ||
	existsSync(join(evidence, `preservation-${label}.json`))
)
	throw new Error("EVIDENCE_LABEL_ALREADY_EXISTS");
writeFileSync(claim, new Date().toISOString(), { flag: "wx" });
if (mode === "preserve") {
	const allocation = JSON.parse(
		readFileSync(".logs/bounded-storage-lifecycle/cold-discovery-plan-02/allocation.json", "utf8")
	);
	const rows = allocation.entries.map((entry) => ({
		path: entry.path,
		role: entry.role,
		expected: entry.sha256,
		actual: hash(readFileSync(entry.path)),
		preimage: hash(readFileSync(entry.preimage)),
	}));
	const failed = rows.filter(
		(row) =>
			row.preimage !== row.expected ||
			(row.actual !== row.expected && (label === "before" || row.role !== "RED_EVOLUTION"))
	);
	const inventory = JSON.parse(
		readFileSync(".logs/bounded-storage-lifecycle/cold-discovery-plan-02/scan-inventory.json", "utf8")
	);
	const allowed = new Set(
		allocation.entries.filter((entry) => entry.role === "RED_EVOLUTION").map((entry) => entry.path)
	);
	const scan = inventory.map((entry) => ({
		path: entry.path,
		expected: entry.sha256,
		actual: hash(readFileSync(entry.path)),
		allowedEvolution: allowed.has(entry.path),
	}));
	const unexpected = scan.filter((entry) => entry.expected !== entry.actual && !entry.allowedEvolution);
	const diffs = allocation.entries
		.filter((entry) => entry.role === "RED_EVOLUTION")
		.map((entry, index) => {
			const result = spawnSync("git", ["diff", "--no-index", "--", entry.preimage, entry.path], { encoding: "utf8" });
			if (result.status !== 0 && result.status !== 1) throw new Error(`PREIMAGE_DIFF_FAILED:${entry.path}`);
			const path = join(evidence, `evolution-${label}-${index}.patch`);
			writeFileSync(path, result.stdout, { flag: "wx" });
			return {
				source: entry.path,
				preimage: entry.preimage,
				preimageSha256: hash(readFileSync(entry.preimage)),
				currentSha256: hash(readFileSync(entry.path)),
				diff: path,
				diffSha256: hash(result.stdout),
			};
		});
	writeFileSync(
		join(evidence, `preservation-${label}.json`),
		JSON.stringify({ rows, failed, scan, unexpected, diffs }, null, 2) + "\n",
		{
			flag: "wx",
		}
	);
	console.log(JSON.stringify({ count: rows.length, scanCount: scan.length, failed, unexpected }));
	process.exitCode = failed.length === 0 && unexpected.length === 0 ? 0 : 1;
} else if (mode === "run") {
	const runnerBytes = readFileSync(import.meta.filename);
	const runnerPath = join(evidence, `${label}.runner.mjs`);
	writeFileSync(runnerPath, runnerBytes, { flag: "wx" });
	if (process.env.COLD_EVIDENCE !== undefined && existsSync(process.env.COLD_EVIDENCE))
		throw new Error("NATIVE_EVIDENCE_DIRECTORY_ALREADY_EXISTS");
	const started = new Date().toISOString();
	const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	writeFileSync(join(evidence, `${label}.log`), log, { flag: "wx" });
	const outcome = {
		started,
		finished: new Date().toISOString(),
		command: args,
		runner: { path: runnerPath, sha256: hash(runnerBytes), capture: "contemporaneous-before-spawn" },
		nativeEnvironment: { artifacts: process.env.COLD_ARTIFACTS, evidence: process.env.COLD_EVIDENCE },
		status: result.status,
		signal: result.signal,
		error: result.error?.message,
		logSha256: hash(log),
	};
	writeFileSync(join(evidence, `${label}.json`), JSON.stringify(outcome, null, 2) + "\n", { flag: "wx" });
	console.log(JSON.stringify(outcome));
	console.log(log.slice(-12000));
	process.exitCode = result.status ?? 1;
} else throw new Error("expected preserve <label> or run <label> <command>...");
