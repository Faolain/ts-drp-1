import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Run focused gates and require completed all-engine evidence before accepting RED. */
function main(): void {
	const label = process.argv[2];
	const run = process.argv[3];
	if (!label || !run || label === run || !/^[a-z0-9-]+$/.test(label) || !/^[a-z0-9-]+$/.test(run))
		throw new Error("supply distinct fresh gate and run labels");
	const base = ".logs/bounded-storage-lifecycle/declaration-discovery-provenance-ownership-red-01";
	mkdirSync(base, { recursive: true });
	if (existsSync(`${base}/${run}`)) throw new Error("immutable run exists");
	const evidence = `${base}/${label}`;
	mkdirSync(evidence);
	const fixture = "tests/fixtures/snapshot-declaration-ownership-provenance";
	const commands = [
		["strict", "pnpm", ["exec", "tsc", "-p", `${fixture}/tsconfig.json`]],
		["lint", "pnpm", ["exec", "eslint", fixture, "--max-warnings=0"]],
		["format", "pnpm", ["exec", "prettier", "--check", fixture]],
		["ownership", process.execPath, ["--import", "tsx", `${fixture}/runner.ts`, run]],
	] as const;
	let severe = false;
	let runStatus: number | null = null;
	for (const [name, command, args] of commands) {
		const child = spawnSync(command, [...args], { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
		writeFileSync(`${evidence}/${name}.stdout.txt`, child.stdout ?? "");
		writeFileSync(`${evidence}/${name}.stderr.txt`, child.stderr ?? "");
		writeFileSync(
			`${evidence}/${name}.terminal.json`,
			JSON.stringify(
				{
					command: [command, ...args],
					cwd: process.cwd(),
					status: child.status,
					signal: child.signal,
					error: child.error?.message,
				},
				null,
				2
			)
		);
		severe ||= !!child.signal || !!child.error || (name !== "ownership" && child.status !== 0);
		if (name === "ownership") runStatus = child.status;
		console.log(`${name}: ${child.status}`);
	}
	const bytes = readFileSync(`${base}/${run}/summary.json`);
	const summary = JSON.parse(bytes.toString("utf8")) as {
		engine: string;
		controlsPass: boolean;
		observationMatchesNoHook: boolean;
		cases: { normative: Record<string, boolean> | null }[];
	}[];
	const receipt = JSON.parse(readFileSync(`${base}/${run}/completed-outcome.json`, "utf8")) as {
		completed?: boolean;
		label?: string;
		status?: number;
		summarySha256?: string;
	};
	const actual = summary.some((item) => !item.controlsPass || !item.observationMatchesNoHook)
		? 2
		: summary.some((item) =>
					item.cases.some((entry) => !entry.normative || Object.values(entry.normative).some((pass) => !pass))
			  )
			? 1
			: 0;
	severe ||=
		receipt.completed !== true ||
		receipt.label !== run ||
		receipt.summarySha256 !== createHash("sha256").update(bytes).digest("hex") ||
		receipt.status !== actual ||
		runStatus !== actual ||
		JSON.stringify(summary.map((item) => item.engine)) !==
			JSON.stringify(["node-direct", "node-bundled", "chromium", "firefox", "webkit"]) ||
		summary.some((item) => item.cases.length !== 4);
	const status = severe ? 2 : actual;
	writeFileSync(`${evidence}/completed-gate.json`, JSON.stringify({ completed: true, label, run, status }, null, 2));
	process.exitCode = status;
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
}
