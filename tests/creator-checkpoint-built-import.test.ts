import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// Each public subpath enters a fresh native ESM graph. A transformed test import
// can hide eager reads through protocol/index/signing-owner cycles.
it.each([
	["protocol-v3", "@ts-drp/protocol-v3/creator-checkpoint"],
	["protocol-v3", "@ts-drp/protocol-v3/creator-author-issuance-frontiers"],
	["protocol-v3", "@ts-drp/protocol-v3/internal/owned-signing-request"],
	["storage", "@ts-drp/storage/snapshot-transfer"],
	["node", "@ts-drp/node/creator-adoption"],
])("loads built %s entry %s without initialization cycles", (packageName, specifier) => {
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)});`], {
		cwd: resolve(process.cwd(), "packages", packageName!), encoding: "utf8", timeout: 10_000,
	});
	expect(child.error, child.stderr).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
});
