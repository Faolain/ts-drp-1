import { parseStorageObjectId } from "@ts-drp/storage";

import { type ClosedFixtureRecord, FIXTURE_OBJECT_ID, validateOracleRecords } from "./fixture-records.js";

/**
 * Independently enumerates the complete records store through its terminal cursor.
 * @param databaseName - Isolated Phase 2b database name.
 * @param objectId - Frozen creator-bound object ID.
 * @returns The independently validated recovered image.
 */
export function readOracleRecords(
	databaseName: string,
	objectId: string
): Promise<readonly [ClosedFixtureRecord, ClosedFixtureRecord]> {
	const parsed = parseStorageObjectId(objectId);
	if (!parsed.ok || objectId !== FIXTURE_OBJECT_ID) return Promise.reject(new TypeError("invalid oracle object ID"));
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(databaseName);
		open.onerror = (): void => reject(new TypeError("oracle database open failed"));
		open.onupgradeneeded = (): void => reject(new TypeError("oracle observed an unexpected upgrade"));
		open.onsuccess = (): void => {
			const database = open.result;
			database.onerror = (): void => reject(new TypeError("oracle database request failed"));
			database.onversionchange = (): void => database.close();
			const transaction = database.transaction("records", "readonly");
			const request = transaction.objectStore("records").openCursor();
			const records: unknown[] = [];
			request.onerror = (): void => reject(new TypeError("oracle cursor failed"));
			request.onsuccess = (): void => {
				const cursor = request.result;
				if (cursor === null) {
					database.close();
					try {
						resolve(validateOracleRecords(records));
					} catch (error) {
						reject(error);
					}
					return;
				}
				records.push(cursor.value);
				cursor.continue();
			};
		};
	});
}
