import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Per-command evidence recorder; execution is separate from acceptance.
const [label, cwd, command, ...args] = process.argv.slice(2);
if (!label || !cwd || !command || !/^[a-z0-9-]+$/.test(label)) throw Error("invalid command");
const root = resolve(dirname(fileURLToPath(import.meta.url)), label);
mkdirSync(root);
const start = new Date().toISOString();
writeFileSync(resolve(root, "command.json"), JSON.stringify({ cwd, command, args, start }, null, 2) + "\n", { flag: "wx" });
const stdout = openSync(resolve(root, "stdout"), "wx");
const stderr = openSync(resolve(root, "stderr"), "wx");
const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (bytes) => { writeSync(stdout, bytes); process.stdout.write(bytes); });
child.stderr.on("data", (bytes) => { writeSync(stderr, bytes); process.stderr.write(bytes); });
let spawnError;
child.on("error", (error) => { spawnError = String(error); });
child.on("close", (code, signal) => {
  closeSync(stdout);
  closeSync(stderr);
  writeFileSync(resolve(root, "status.json"), JSON.stringify({ code, signal, spawnError, start, finish: new Date().toISOString(), pid: child.pid }, null, 2) + "\n", { flag: "wx" });
  process.exitCode = code ?? 1;
});
