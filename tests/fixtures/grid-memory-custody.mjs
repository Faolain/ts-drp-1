import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Hash staged and unstaged sources plus explicitly required untracked inputs. */
export function collectGridSourceHashes(root, requiredFiles) {
	const changed = execFileSync("git", ["diff", "HEAD", "--name-only", "-z"], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
	return Object.fromEntries(
		[...new Set([...changed, ...requiredFiles])].sort().map((file) => [
			file,
			createHash("sha256")
				.update(readFileSync(join(root, file)))
				.digest("hex"),
		])
	);
}
