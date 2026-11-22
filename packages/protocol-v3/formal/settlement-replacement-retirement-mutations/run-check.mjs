// Bound every checker and retire its own process group, including JVM descendants.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const seconds = Number(process.env.TRACK_J_TIMEOUT_SECONDS ?? 3600);
if (!command || !Number.isFinite(seconds) || seconds <= 0) {
  console.error("Expected a command and a positive TRACK_J_TIMEOUT_SECONDS");
  process.exit(2);
}
const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], detached: true });
let stopped = false;
function stop(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
let killTimer;
function abort(reason) {
  if (stopped) return;
  stopped = true;
  console.error(reason);
  stop("SIGTERM");
  killTimer = setTimeout(() => stop("SIGKILL"), 5000);
}
const timeout = setTimeout(() => abort(`CHECK TIMEOUT after ${seconds}s`), seconds * 1000);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => abort(`CHECK INTERRUPTED: ${signal}`));
child.on("error", error => {
  console.error(error.message);
  clearTimeout(timeout);
  process.exitCode = 2;
});
child.on("close", code => {
  clearTimeout(timeout);
  clearTimeout(killTimer);
  // Servers launched by a checker belong to this invocation, even when the CLI exits first.
  stop("SIGKILL");
  process.exitCode = stopped ? 124 : (code ?? 1);
});
