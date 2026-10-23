// Quint's successful verdict does not require requested witnesses to have occurred.
import { readFileSync } from "node:fs";

const [logPath, ...args] = process.argv.slice(2);
const log = readFileSync(logPath, "utf8");
const start = args.indexOf("--witnesses");
if (start !== -1) {
  for (const name of args.slice(start + 1)) {
    if (name.startsWith("--")) break;
    const prefix = `${name} was witnessed in `;
    const line = log.split("\n").find(value => value.startsWith(prefix));
    if (!line || !/^[1-9][0-9]* trace\(s\)/.test(line.slice(prefix.length))) {
      console.error(`FAIL witness ${name}: no observed trace`);
      process.exitCode = 1;
    }
  }
}
