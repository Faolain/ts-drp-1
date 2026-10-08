import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const prompt = readFileSync(resolve(import.meta.dirname, "prompt.md"), "utf8");
const schema = readFileSync(resolve(import.meta.dirname, "schema.json"), "utf8");
const args = [
	"-p",
	"--model",
	"opus",
	"--effort",
	"xhigh",
	"--permission-mode",
	"dontAsk",
	"--allowedTools",
	"Read,Grep,Glob",
	"--disallowedTools",
	"Bash,Write,Edit,NotebookEdit,Agent,WebFetch,WebSearch",
	"--output-format",
	"json",
	"--json-schema",
	schema,
	prompt,
];
writeFileSync(
	resolve(import.meta.dirname, "opus.command.txt"),
	"claude -p --model opus --effort xhigh --permission-mode dontAsk --allowedTools Read,Grep,Glob --disallowedTools Bash,Write,Edit,NotebookEdit,Agent,WebFetch,WebSearch --output-format json --json-schema <schema.json> <prompt.md>\n"
);
const child = spawn("claude", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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
writeFileSync(resolve(import.meta.dirname, "opus.raw.json"), Buffer.concat(stdout));
writeFileSync(resolve(import.meta.dirname, "opus.stderr.txt"), Buffer.concat(stderr));
writeFileSync(resolve(import.meta.dirname, "opus.status"), `${String(code)}\n`);
process.exitCode = typeof code === "number" ? code : 1;
