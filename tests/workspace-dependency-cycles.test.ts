import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- a plain .mjs build script without declarations.
import { workspaceDependencyCycles, workspacePackageDirectories } from "../scripts/check-workspace-cycles.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("workspace dependency graph", () => {
	// pnpm cannot order a cycle: on a fresh clone the postinstall build compiles one side
	// before the other has emitted declarations and fails (node <-> storage-node, TS2307).
	it("has no cycle between workspace packages", () => {
		expect(workspaceDependencyCycles(ROOT)).toEqual([]);
	});

	it("sees the packages that formed the original cycle", () => {
		const names = (workspacePackageDirectories(ROOT) as string[]).map((directory) => path.basename(directory));
		expect(names).toEqual(expect.arrayContaining(["node", "storage-node", "cli"]));
	});
});
