// Evidence-only wrapper around the root Vitest config: records every workspace
// package module actually served to the test worker (resolved path, on-disk file
// sha256 and transformed-code sha256). It changes no resolution or behaviour.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig } from "vite";
import base from "../../../vite.config.mts";

const root = path.resolve(import.meta.dirname, "../../..");
const ledger = process.env.ROLLBACK_PROMOTION_MODULE_LEDGER;
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export default mergeConfig(base, {
	plugins: [{
		name: "rollback-promotion-loaded-module-ledger",
		enforce: "post" as const,
		transform(code: string, id: string) {
			if (ledger === undefined) return;
			const file = id.split("?")[0]!;
			if (!file.startsWith(root + "/packages/") && !file.startsWith(root + "/examples/")) return;
			const fileSha = existsSync(file) ? sha(readFileSync(file)) : null;
			appendFileSync(ledger, JSON.stringify({ file: path.relative(root, file), fileSha, transformedSha: sha(code) }) + "\n");
		},
	}],
});
