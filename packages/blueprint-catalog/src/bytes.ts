import {
	BlueprintCatalogError,
	readTrustedBlueprintCatalog,
	type TrustedBlueprintCatalog,
} from "./catalog-validation.js";

export { BlueprintCatalogError } from "./catalog-validation.js";
export type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "./catalog-validation.js";

export interface TrustedBlueprintCatalogBytesOptions {
	readonly catalogBytes: Uint8Array;
	/** Exact toolchain outputs keyed by <blueprintDigest>.<artifact.mjs|package.bin|lint.bin|receipt.bin>. */
	readonly assets: Readonly<Record<string, Uint8Array>>;
}

/**
 * Validates host-selected bundled bytes with the same catalog/package/lint/receipt checks as native loading.
 * All bytes are copied; validation grants no host authentication or anti-rollback freshness.
 * @param options - Host-selected exact catalog and asset bytes.
 * @returns Detached, frozen catalog resolver.
 */
export function openTrustedBlueprintCatalogBytes(
	options: TrustedBlueprintCatalogBytesOptions
): TrustedBlueprintCatalog {
	if (typeof options !== "object" || options === null) {
		throw new BlueprintCatalogError("BLUEPRINT_CATALOG_SCHEMA_INVALID", "catalog byte inputs are invalid");
	}
	const catalog = Object.getOwnPropertyDescriptor(options, "catalogBytes");
	const assets = Object.getOwnPropertyDescriptor(options, "assets");
	if (
		catalog === undefined ||
		!(catalog.value instanceof Uint8Array) ||
		assets === undefined ||
		typeof assets.value !== "object" ||
		assets.value === null
	) {
		throw new BlueprintCatalogError("BLUEPRINT_CATALOG_SCHEMA_INVALID", "catalog byte inputs are invalid");
	}
	const captured = new Map<string, Uint8Array>([["catalog.bin", new Uint8Array(catalog.value)]]);
	for (const filename of Reflect.ownKeys(assets.value)) {
		const descriptor = Object.getOwnPropertyDescriptor(assets.value, filename);
		if (
			typeof filename !== "string" ||
			filename === "catalog.bin" ||
			descriptor === undefined ||
			!(descriptor.value instanceof Uint8Array)
		) {
			throw new BlueprintCatalogError("BLUEPRINT_ENTRY_FILE_UNREADABLE", "catalog asset bytes are invalid");
		}
		captured.set(filename, new Uint8Array(descriptor.value));
	}
	return readTrustedBlueprintCatalog((filename, code) => {
		const value = captured.get(filename);
		if (value === undefined || value.length === 0) throw new BlueprintCatalogError(code, "catalog asset is unreadable");
		return value;
	});
}
