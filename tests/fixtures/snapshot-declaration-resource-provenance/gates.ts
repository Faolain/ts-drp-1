import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { type ChildOutcome, gateStatus } from "./outcome.js";

/** Run isolated gates and classify only a complete control-verified resource outcome. */
function main(): void {
	const label = process.argv[2];
	const run = process.argv[3];
	if (!label || !run || !/^[a-z0-9-]+$/.test(label) || !/^[a-z0-9-]+$/.test(run) || label === run)
		throw new Error("supply distinct fresh gate and resource run labels");
	const evidence = `.logs/bounded-storage-lifecycle/declaration-discovery-provenance-resource-red-01/${label}`;
	const resourceEvidence = `.logs/bounded-storage-lifecycle/declaration-discovery-provenance-resource-red-01/${run}`;
	if (existsSync(resourceEvidence)) throw new Error("immutable resource run already exists");
	mkdirSync(evidence);
	const fixture = "tests/fixtures/snapshot-declaration-resource-provenance";
	const commands = [
		["strict", "pnpm", ["exec", "tsc", "-p", `${fixture}/tsconfig.json`]],
		["lint", "pnpm", ["exec", "eslint", fixture, "--max-warnings=0"]],
		["format", "pnpm", ["exec", "prettier", "--check", fixture]],
		["outcome", process.execPath, ["--import", "tsx", `${fixture}/outcome-diagnostic.ts`]],
		["resource", process.execPath, ["--import", "tsx", `${fixture}/runner.ts`, run]],
	] as const;
	const terminals: ChildOutcome[] = [];
	for (const [name, command, args] of commands) {
		const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
		terminals.push({ status: result.status, signal: result.signal, error: result.error?.message });
		writeFileSync(`${evidence}/${name}.stdout.txt`, result.stdout ?? "");
		writeFileSync(`${evidence}/${name}.stderr.txt`, result.stderr ?? "");
		writeFileSync(
			`${evidence}/${name}.terminal.json`,
			JSON.stringify(
				{
					command: [command, ...args],
					cwd: process.cwd(),
					status: result.status,
					signal: result.signal,
					error: result.error?.message,
				},
				null,
				2
			)
		);
		console.log(`${name}: terminal ${result.status}`);
	}
	let receipt: unknown;
	let summary: unknown;
	let summarySha256 = "";
	try {
		receipt = JSON.parse(readFileSync(`${resourceEvidence}/completed-outcome.json`, "utf8"));
		const bytes = readFileSync(`${resourceEvidence}/summary.json`);
		summary = JSON.parse(bytes.toString("utf8"));
		summarySha256 = createHash("sha256").update(bytes).digest("hex");
	} catch {
		/* Missing or malformed completion is infrastructure failure, even with terminal 1. */
	}
	const status = gateStatus(
		terminals.slice(0, 4),
		terminals[4] ?? { status: null },
		receipt,
		summary,
		run,
		summarySha256
	);
	writeFileSync(
		`${evidence}/completed-gate.json`,
		JSON.stringify({ completed: true, label, run, status, summarySha256 }, null, 2)
	);
	process.exitCode = status;
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
}
