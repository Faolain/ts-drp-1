import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const prompt = readFileSync(resolve(import.meta.dirname, "prompt.md"), "utf8");
const args = ["--model", "kimi-code/k3", "--prompt", prompt, "--output-format", "stream-json"];
writeFileSync(
	resolve(import.meta.dirname, "kimi.command.txt"),
	"KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi --model kimi-code/k3 --prompt <prompt.md> --output-format stream-json\n"
);
const child = spawn("kimi", args, {
	cwd: root,
	env: { ...process.env, KIMI_LOOP_MAX_STEPS_PER_TURN: "100" },
	stdio: ["ignore", "pipe", "pipe"],
});
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
writeFileSync(resolve(import.meta.dirname, "kimi.stream.jsonl"), Buffer.concat(stdout));
writeFileSync(resolve(import.meta.dirname, "kimi.stderr.txt"), Buffer.concat(stderr));
writeFileSync(resolve(import.meta.dirname, "kimi.status"), `${String(code)}\n`);
process.exitCode = typeof code === "number" ? code : 1;
