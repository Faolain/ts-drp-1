import { openTrustedBlueprintCatalogBytes, type TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";

import lifetimeMaterial from "./chat-catalog-material.json" with { type: "json" };
import windowMaterial from "./chat-window-catalog-material.json" with { type: "json" };

/** One embedded single-blueprint catalog and its only blueprint digest. */
export interface ShippingChatCatalog {
	readonly catalog: TrustedBlueprintCatalog;
	readonly blueprintDigest: string;
}

/**
 * The shipped Chat's two embedded catalogs. `window` (artifact `v3-shipping-chat.v4`, the rolling
 * window) is what new rooms sign into their genesis. `lifetime` (artifact `v3-shipping-chat.v3`,
 * every message kept against a lifetime share) stays, byte for byte, so rooms whose genesis signed
 * it keep opening with the format they signed. A room's format is its signed genesis blueprint
 * digest; nothing here migrates one format to the other.
 */
export interface ShippingChatCatalogs {
	readonly window: ShippingChatCatalog;
	readonly lifetime: ShippingChatCatalog;
}

interface CatalogMaterial {
	readonly catalogBytes: string;
	readonly assets: Readonly<Record<string, string>>;
}

function decodeBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}

function openEmbedded(material: CatalogMaterial): ShippingChatCatalog {
	const catalog = openTrustedBlueprintCatalogBytes({
		catalogBytes: decodeBase64(material.catalogBytes),
		assets: Object.fromEntries(Object.entries(material.assets).map(([name, value]) => [name, decodeBase64(value)])),
	});
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined || catalog.blueprintDigests.length !== 1)
		throw new TypeError("Chat requires its exact shipping catalogs");
	return Object.freeze({ catalog, blueprintDigest });
}

let opened: ShippingChatCatalogs | undefined;

/**
 * Opens (once) and returns both embedded catalogs.
 * @returns The new-room window catalog and the kept lifetime catalog.
 */
export function openShippingChatCatalogs(): ShippingChatCatalogs {
	opened ??= Object.freeze({
		window: openEmbedded(windowMaterial),
		lifetime: openEmbedded(lifetimeMaterial),
	});
	return opened;
}
