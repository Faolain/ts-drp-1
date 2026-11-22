import {
	BlueprintCatalogError,
	openTrustedBlueprintCatalog,
	type ResolvedBlueprintBytes,
	type TrustedBlueprintCatalog,
	type TrustedBlueprintCatalogOptions,
} from "../../../packages/blueprint-catalog/src/index.js";

declare const catalogDirectory: string;
declare const blueprintDigest: string;

const options: TrustedBlueprintCatalogOptions = { catalogDirectory };
const catalog: TrustedBlueprintCatalog = openTrustedBlueprintCatalog(options);
const resolved: ResolvedBlueprintBytes = catalog.resolve(blueprintDigest);
const error: BlueprintCatalogError = new BlueprintCatalogError("BLUEPRINT_NOT_CATALOGUED");

const tier: "nightly" = resolved.evidence.conformanceTier;
const result: "passed" = resolved.evidence.conformanceResult;
const packageBytes: Uint8Array = resolved.canonicalBlueprintPackageBytes;
const artifactBytes: Uint8Array = resolved.exactArtifactBytes;
const engines: readonly {
	readonly name: "node" | "chromium" | "firefox" | "webkit";
	readonly build: string;
}[] = resolved.evidence.engines;

// @ts-expect-error Open is synchronous and owns all I/O before it returns.
const asynchronousCatalog: Promise<TrustedBlueprintCatalog> = openTrustedBlueprintCatalog(options);
// @ts-expect-error Resolve returns no runtime or admission capability.
const leakedAuthority: { readonly preparedBlueprintRuntime: unknown } = resolved;

void [artifactBytes, asynchronousCatalog, catalog, engines, error, leakedAuthority, packageBytes, result, tier];
