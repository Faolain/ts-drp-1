import { openTrustedBlueprintCatalogBytes, type TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";

import lifetimeMaterial from "./chat-catalog-material.json" with { type: "json" };
import sharesMaterial from "./chat-shares-catalog-material.json" with { type: "json" };
import windowMaterial from "./chat-window-catalog-material.json" with { type: "json" };

/** One embedded single-blueprint catalog and its only blueprint digest. */
export interface ShippingChatCatalog {
	readonly catalog: TrustedBlueprintCatalog;
	readonly blueprintDigest: string;
}

/**
 * The shipped Chat's embedded catalogs. `shares` (artifact `v3-shipping-chat.v5`, the rolling
 * window with membership-aware shares, Track W2) is what new rooms sign into their genesis.
 * `window` (artifact `v3-shipping-chat.v4`, Track W's rolling window) and `lifetime` (artifact
 * `v3-shipping-chat.v3`, every message kept against a lifetime share) stay, byte for byte, so
 * rooms whose genesis signed them keep opening with the format they signed. A room's format is
 * its signed genesis blueprint digest; nothing here migrates one format to another.
 */
export interface ShippingChatCatalogs {
	readonly shares: ShippingChatCatalog;
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
 * Opens (once) and returns the embedded catalogs.
 * @returns The new-room shares catalog and the kept window and lifetime catalogs.
 */
export function openShippingChatCatalogs(): ShippingChatCatalogs {
	opened ??= Object.freeze({
		shares: openEmbedded(sharesMaterial),
		window: openEmbedded(windowMaterial),
		lifetime: openEmbedded(lifetimeMaterial),
	});
	return opened;
}
