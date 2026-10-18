import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Noncreating acquisition must be enforced by SQLite, not an exists-then-open
 * check. The ordinary filename remains the native reservation identity.
 * @param filename - Host-selected physical filename.
 * @param initialization - Explicit mechanical acquisition policy.
 * @returns SQLite URI with native create permission selected explicitly.
 */
export function sqliteFilename(filename: string, initialization: "create" | "reopen" = "create"): string {
	if (initialization !== "create" && initialization !== "reopen") throw new TypeError("invalid SQLite initialization");
	if (initialization === "create") return filename;
	const uri = pathToFileURL(resolve(filename));
	uri.searchParams.set("mode", "rw");
	return uri.href;
}
