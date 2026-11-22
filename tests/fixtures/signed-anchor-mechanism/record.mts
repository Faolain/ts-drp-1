// Durable raw command terminals, explicit owned root links and exact tests-only postimages.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
const [directory, name, executable, ...args] = process.argv.slice(2);
if (!directory || !name || !executable) throw new Error("RECORD_ARGUMENTS");
mkdirSync(directory, { recursive: true });
if (name === "links") {
	const links = resolve("node_modules/@ts-drp");
	mkdirSync(links, { recursive: true });
	for (const folder of readdirSync("packages")) {
		const manifest = join("packages", folder, "package.json");
		if (!existsSync(manifest)) continue;
		const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
		if (!pkg.name?.startsWith("@ts-drp/")) continue;
		const link = join(links, pkg.name.slice(8)),
			target = resolve("packages", folder);
		if (!existsSync(link)) symlinkSync(target, link);
		if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== target) throw new Error("FOREIGN_LINK:" + link);
	}
}
const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "",
	stderr = "";
child.stdout.on("data", (bytes: Buffer) => {
	stdout += bytes.toString();
	process.stdout.write(bytes);
});
child.stderr.on("data", (bytes: Buffer) => {
	stderr += bytes.toString();
	process.stderr.write(bytes);
});
const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
	(resolveTerminal, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolveTerminal({ code, signal }));
	}
);
const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
writeFileSync(join(directory, name + ".stdout"), stdout);
writeFileSync(join(directory, name + ".stderr"), stderr);
writeFileSync(
	join(directory, name + ".terminal.json"),
	JSON.stringify(
		{
			executable,
			args,
			cwd: process.cwd(),
			env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("SIGNED_ANCHOR_"))),
			pid: child.pid,
			...terminal,
			stdoutSha256: hash(stdout),
			stderrSha256: hash(stderr),
		},
		null,
		2
	)
);
process.exitCode = terminal.code ?? 1;
