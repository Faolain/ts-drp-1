import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertRegistryVersionBump } from "../src/registry.js";

const registryPath = "packages/protocol-v2/registry/field-registry.json";
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const currentRegistryPath = fileURLToPath(new URL("../registry/field-registry.json", import.meta.url));
const baseRevision = process.argv.slice(2).find((argument) => argument !== "--");

if (baseRevision === undefined || baseRevision.length === 0) {
	throw new TypeError("usage: check-registry-version.mts <base-revision>");
}

function git(...arguments_: string[]): string {
	return execFileSync("git", arguments_, {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function gitFileAtRevision(revision: string, path: string): string | undefined {
	try {
		return execFileSync("git", ["show", `${revision}:${path}`], {
			cwd: repositoryRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

function registryVersion(source: string, label: string): number {
	const parsed = JSON.parse(source) as { registryVersion?: unknown };
	if (!Number.isSafeInteger(parsed.registryVersion)) {
		throw new TypeError(`${label} registryVersion must be a safe integer`);
	}
	return parsed.registryVersion as number;
}

const changedPaths = git("diff", "--name-only", `${baseRevision}...HEAD`)
	.split(/\r?\n/u)
	.filter((path) => path.length > 0);
const baseRegistry = gitFileAtRevision(baseRevision, registryPath);
const currentRegistry = readFileSync(currentRegistryPath, "utf8");

assertRegistryVersionBump({
	baseVersion: baseRegistry === undefined ? 0 : registryVersion(baseRegistry, "base"),
	changedPaths,
	currentVersion: registryVersion(currentRegistry, "current"),
});

console.log("protocol-v2 registryVersion gate passed");
