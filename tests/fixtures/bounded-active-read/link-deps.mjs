/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JavaScript dependency bootstrap has no TypeScript return annotation syntax. */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

// Test-lane dependency bootstrap: registry bytes stay external; workspace owners stay local.
const root = resolve(import.meta.dirname, "../../..");
const basis = process.argv[2];
if (!basis || !existsSync(join(basis, "node_modules/.pnpm"))) throw new Error("external dependency basis required");
/**
 * @param source
 * @param destination
 * @returns
 */
function links(source, destination) {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name),
			to = join(destination, entry.name);
		if ([".vite", ".vite-temp", ".cache"].includes(entry.name)) {
			try {
				if (lstatSync(to).isSymbolicLink()) unlinkSync(to);
			} catch {
				/* Fresh lane. */
			}
			mkdirSync(to, { recursive: true });
			continue;
		}
		try {
			lstatSync(to);
			continue;
		} catch {
			/* Only new lane-owned links are created. */
		}
		if (entry.name.startsWith("@") && entry.isDirectory()) links(from, to);
		else {
			const actual = realpathSync(from);
			const owner = actual.startsWith(join(basis, "packages") + "/")
				? join(root, "packages", basename(actual))
				: actual;
			symlinkSync(owner, to, "dir");
		}
	}
}
links(join(basis, "node_modules"), join(root, "node_modules"));
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
	const manifest = join(root, "packages", entry.name, "package.json");
	if (!entry.isDirectory() || !existsSync(manifest)) continue;
	const name = JSON.parse(readFileSync(manifest, "utf8")).name;
	if (typeof name === "string" && name.startsWith("@ts-drp/")) {
		const destination = join(root, "node_modules", name);
		mkdirSync(join(root, "node_modules/@ts-drp"), { recursive: true });
		if (!existsSync(destination)) symlinkSync(join(root, "packages", entry.name), destination, "dir");
	}
}
for (const entry of readdirSync(join(basis, "packages"), { withFileTypes: true })) {
	const from = join(basis, "packages", entry.name, "node_modules");
	if (entry.isDirectory() && existsSync(from)) links(from, join(root, "packages", entry.name, "node_modules"));
}
console.log(JSON.stringify({ root, externalDependencyBasis: realpathSync(join(basis, "node_modules")) }));
