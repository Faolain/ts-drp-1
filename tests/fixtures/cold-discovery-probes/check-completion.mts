import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const label = process.argv[2];
if (!label || !/^check-[0-9]+$/.test(label)) throw new Error("CHECK_LABEL_REQUIRED");
const out = join(".logs/bounded-storage-lifecycle/cold-discovery-completion-controls-01", label);
mkdirSync(out);
const files = [
	"completion-control.ts",
	"completion-node.ts",
	"completion-browser.ts",
	"run-completion.mts",
	"check-completion.mts",
	"tsconfig.completion.json",
].map((name) => `tests/fixtures/cold-discovery-probes/${name}`);
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const receipts = [];
for (const [name, args] of [
	["typecheck", ["exec", "tsc", "-p", "tests/fixtures/cold-discovery-probes/tsconfig.completion.json"]],
	["lint", ["exec", "eslint", ...files.filter((file) => !file.endsWith(".json"))]],
	["format", ["exec", "prettier", "--check", ...files]],
	["diff", null],
]) {
	const command = args ? ["pnpm", ...args] : ["git", "diff", "--check"];
	const started = new Date().toISOString();
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	});
	for (const channel of ["stdout", "stderr"])
		writeFileSync(join(out, `${name}.${channel}`), result[channel] ?? "", { flag: "wx" });
	receipts.push({
		name,
		command,
		started,
		finished: new Date().toISOString(),
		status: result.status,
		signal: result.signal,
		error: result.error?.message,
		stdoutSha256: hash(result.stdout ?? ""),
		stderrSha256: hash(result.stderr ?? ""),
	});
	console.log(JSON.stringify(receipts.at(-1)));
}
writeFileSync(
	join(out, "receipts.json"),
	JSON.stringify({ files: files.map((path) => ({ path, sha256: hash(readFileSync(path)) })), receipts }, null, 2),
	{ flag: "wx" }
);
if (receipts.some((receipt) => receipt.status !== 0)) process.exitCode = 1;
