import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const schema = readFileSync(resolve(import.meta.dirname, "schema.json"), "utf8");
const session = "01a0642c-d006-7963-871a-6f66b7bd9f39";
const prompt =
	"Resume this exact confirmation session. Your prior public response contains a complete valid terminal JSON object, but the wrapper recorded NO_VERDICT. Re-emit only that exact terminal JSON object now, with no inspection, tools, prose, markdown, or changed findings.";
const args = [
	"--resume",
	session,
	"--cwd",
	root,
	"--permission-mode",
	"dontAsk",
	"--no-subagents",
	"--disable-web-search",
	"--reasoning-effort",
	"high",
	"--max-turns",
	"4",
	"--json-schema",
	schema,
	"-p",
	prompt,
];
writeFileSync(
	resolve(import.meta.dirname, "grok-resume.command.txt"),
	`grok --resume ${session} --permission-mode dontAsk --no-subagents --disable-web-search --reasoning-effort high --max-turns 4 --json-schema <schema.json> -p <reemit-prompt>\n`
);
const child = spawn("grok", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => {
	stdout.push(chunk);
	process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
	stderr.push(chunk);
	process.stderr.write(chunk);
});
child.on("error", (error) => {
	stderr.push(Buffer.from(`${error.stack ?? error.message}\n`));
});
const code = await new Promise((resolveExit) => child.on("close", resolveExit));
writeFileSync(resolve(import.meta.dirname, "grok-resume.raw.json"), Buffer.concat(stdout));
writeFileSync(resolve(import.meta.dirname, "grok-resume.stderr.txt"), Buffer.concat(stderr));
writeFileSync(resolve(import.meta.dirname, "grok-resume.status"), `${String(code)}\n`);
process.exitCode = typeof code === "number" ? code : 1;
