import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";

import base from "../../../vite.config.mts";

// One thread keeps the native test and the CLI in the same OS process. The
// parent-owned FD3 pipe is synchronous IPC and SIGKILL terminates every owner.
const root = fileURLToPath(new URL("../../../", import.meta.url));
export default mergeConfig(base, {
	root,
	test: {
		root,
		name: "rejoin-sigkill-worker",
		globalSetup: [fileURLToPath(new URL("../../../scripts/check-shadowed-sources.mjs", import.meta.url))],
		include: ["tests/fixtures/rejoin-sigkill/worker.child.ts"],
		coverage: { enabled: false },
		pool: "threads",
		poolOptions: { threads: { singleThread: true } },
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
	},
});
