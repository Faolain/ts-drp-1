import { fileURLToPath } from "node:url";

const REVIEWED_EXECUTOR_NAME = /^[A-Za-z0-9_-]+\.(?:js|ts)$/u;

/**
 * Resolves a reviewed executor basename without depending on the caller's cwd.
 * @param name - Strict checked-in executor module basename.
 * @returns Absolute path inside the source executor directory.
 */
export function reviewedExecutorModulePath(name: string): string {
	if (!REVIEWED_EXECUTOR_NAME.test(name)) {
		throw new Error(
			"executor must be a checked-in .ts or .js module name under packages/network-spike/src/public-campaign-executors"
		);
	}
	return fileURLToPath(new URL(`../public-campaign-executors/${name}`, import.meta.url));
}
