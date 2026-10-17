import { type DRPErrorCode } from "@ts-drp/errors";
import fs from "node:fs";
import path from "node:path";

import {
	BlueprintCatalogError,
	readTrustedBlueprintCatalog,
	type TrustedBlueprintCatalog,
} from "./catalog-validation.js";

export { BlueprintCatalogError } from "./catalog-validation.js";
export type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "./catalog-validation.js";

export interface TrustedBlueprintCatalogOptions {
	readonly catalogDirectory: string;
}

type CatalogCode = Extract<DRPErrorCode, `BLUEPRINT_${string}`>;
function fail(code: CatalogCode, message: string): never {
	throw new BlueprintCatalogError(code, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function safeRead(root: string, filename: string, code: CatalogCode): Uint8Array {
	try {
		const before = fs.lstatSync(filename);
		if (!before.isFile() || before.isSymbolicLink() || before.size === 0)
			fail(code, "catalog asset is not a regular file");
		const real = fs.realpathSync(filename);
		if (path.dirname(real) !== root) fail(code, "catalog asset escapes its directory");
		const bytes = fs.readFileSync(filename);
		const after = fs.lstatSync(filename);
		if (
			!after.isFile() ||
			after.isSymbolicLink() ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			bytes.length !== before.size
		) {
			fail(code, "catalog asset changed while being read");
		}
		return new Uint8Array(bytes);
	} catch (error) {
		if (error instanceof BlueprintCatalogError) throw error;
		fail(code, "catalog asset is unreadable");
	}
}

function openDirectory(options: TrustedBlueprintCatalogOptions): string {
	try {
		if (!isRecord(options) || typeof options.catalogDirectory !== "string") {
			fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
		}
		const supplied = options.catalogDirectory;
		if (supplied.length === 0 || !path.isAbsolute(supplied)) {
			fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
		}
		const stat = fs.lstatSync(supplied);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
		}
		return fs.realpathSync(supplied);
	} catch (error) {
		if (error instanceof BlueprintCatalogError) throw error;
		fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
	}
}

/**
 * Validates a caller-selected local catalog with regular-file and readback checks.
 * Host selection supplies trust; neither digest validation nor local files grant freshness.
 * @param options - Absolute caller-selected catalog directory.
 * @returns Detached, frozen catalog resolver.
 */
export function openTrustedBlueprintCatalog(options: TrustedBlueprintCatalogOptions): TrustedBlueprintCatalog {
	const root = openDirectory(options);
	return readTrustedBlueprintCatalog((filename, code) => safeRead(root, path.join(root, filename), code));
}
