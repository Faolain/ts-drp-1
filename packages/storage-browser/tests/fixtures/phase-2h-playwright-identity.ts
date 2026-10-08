import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Phase2hEngineName } from "./phase-2h-a-registry.js";

const identityBrand = Symbol("Phase2hPlaywrightInvocationIdentity");

interface ResolvedGraph {
	readonly browserRegistry: Readonly<{
		readonly browsers: readonly Readonly<{
			readonly browserVersion: unknown;
			readonly installByDefault: unknown;
			readonly name: unknown;
		}>[];
	}>;
	readonly rootPin: unknown;
}

type Phase2hPlaywrightInvocationIdentity = Readonly<{
	readonly browserVersions: Readonly<Record<Phase2hEngineName, string>>;
	readonly playwrightVersion: string;
	readonly [identityBrand]: true;
}>;

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const ownerUrl = pathToFileURL(path.join(repositoryRoot, "scripts/phase-2k-browser-currency.mjs")).href;

function resolveAuditedGraph(callerRealpath: string): ResolvedGraph {
	const program = [
		`const owner = await import(${JSON.stringify(ownerUrl)});`,
		`const graph = owner.resolvePlaywrightGraphInput({ callerRealpaths: [process.argv[1]], repositoryRoot: ${JSON.stringify(repositoryRoot)} });`,
		"const audit = owner.auditPlaywrightGraph(graph);",
		"process.stdout.write(JSON.stringify({ browserRegistry: graph.browserRegistry, errors: audit.errors, rootPin: graph.rootPin }));",
	].join("\n");
	const result = JSON.parse(
		execFileSync(process.execPath, ["--input-type=module", "--eval", program, callerRealpath], {
			cwd: repositoryRoot,
			encoding: "utf8",
		})
	) as ResolvedGraph & { readonly errors: readonly string[] };
	if (result.errors.length > 0) throw new TypeError(`tooling-identity:playwright-graph:${result.errors.join(",")}`);
	return result;
}

function browserVersions(graph: ResolvedGraph): Readonly<Record<Phase2hEngineName, string>> {
	return Object.freeze(
		Object.fromEntries(
			(["chromium", "firefox", "webkit"] as const).map((engine) => {
				const rows = graph.browserRegistry.browsers.filter(
					(row) => row.name === engine && row.installByDefault === true
				);
				const version = rows[0]?.browserVersion;
				if (rows.length !== 1 || typeof version !== "string")
					throw new TypeError(`tooling-identity:browser-registry:${engine}`);
				return [engine, version];
			})
		) as Record<Phase2hEngineName, string>
	);
}

/**
 * Resolves one fresh, context-owned Phase 2h Playwright identity. The bounded
 * Phase 2k graph audit is the only graph authority; this wrapper only brands
 * its exact version and browser registry for the current invocation.
 * @param caller - Existing config or setup module whose realpath owns resolution.
 * @returns Deeply immutable invocation identity.
 */
export function resolvePhase2hPlaywrightIdentity(caller: string): Phase2hPlaywrightInvocationIdentity {
	const callerRealpath = fs.realpathSync(caller);
	const graph = resolveAuditedGraph(callerRealpath);
	if (typeof graph.rootPin !== "string") throw new TypeError("tooling-identity:playwright-version");
	return Object.freeze({
		browserVersions: browserVersions(graph),
		playwrightVersion: graph.rootPin,
		[identityBrand]: true as const,
	});
}
