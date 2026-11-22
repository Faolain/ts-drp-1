import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { NativeReadReservationPort } from "./internal/native-read-reservation.js";

import {
	createBrowserDurableIssuanceStoreImplementation,
	createBrowserRoomDurableIssuanceStoreImplementation,
} from "./internal/browser-issuance-store.js";

export interface BrowserDurableIssuanceStoreOptions {
	readonly primaryDatabaseName: string;
}

/**
 * Creates one strict-durability browser issuance capability over its dedicated derived database.
 * @param options - Exact browser factory options.
 * @returns The shared eight-method durable issuance capability.
 */
export async function createBrowserDurableIssuanceStore(
	options: BrowserDurableIssuanceStoreOptions
): Promise<DurableIssuanceStore & NativeReadReservationPort> {
	return createBrowserDurableIssuanceStoreImplementation(options);
}

/**
 * Creates the issuance capability inside a ready version-7 room database (slice 14a).
 * @param options - The room database name.
 * @param options.databaseName
 * @returns The shared eight-method durable issuance capability in the `issuance:` namespace.
 */
export async function createBrowserRoomDurableIssuanceStore(
	options: Readonly<{ databaseName: string }>
): Promise<DurableIssuanceStore & NativeReadReservationPort> {
	return createBrowserRoomDurableIssuanceStoreImplementation(options);
}
