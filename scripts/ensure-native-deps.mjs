/**
 * pnpm materializes transitive native deps from its store without re-running
 * their install scripts when the store entry predates script approval — after
 * some installs node-datachannel (needed by @libp2p/webrtc) ends up without
 * its .node binary and every WebRTC code path fails at import time. Fetch the
 * prebuild whenever the binary is missing so installs are self-healing.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const pnpmDir = join(import.meta.dirname, "..", "node_modules", ".pnpm");

if (!existsSync(pnpmDir)) {
	process.exit(0);
}

const packageDirs = readdirSync(pnpmDir)
	.filter((entry) => entry.startsWith("node-datachannel@"))
	.map((entry) => join(pnpmDir, entry, "node_modules", "node-datachannel"))
	.filter((dir) => existsSync(dir));

for (const dir of packageDirs) {
	if (existsSync(join(dir, "build", "Release", "node_datachannel.node"))) {
		continue;
	}

	console.log(`[ensure-native-deps] node-datachannel binary missing, fetching prebuild in ${dir}`);
	execSync("npx prebuild-install -r napi", { cwd: dir, stdio: "inherit" });

	if (!existsSync(join(dir, "build", "Release", "node_datachannel.node"))) {
		throw new Error(`[ensure-native-deps] failed to materialize node_datachannel.node in ${dir}`);
	}
}
