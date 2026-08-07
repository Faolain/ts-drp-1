import { FIXTURE_OBJECT_ID } from "../fixtures/fixture-records.js";
import { readOracleRecords } from "../fixtures/oracle-idb.js";

declare global {
	interface Window {
		phase2bRecover(databaseName: string): ReturnType<typeof readOracleRecords>;
	}
}

window.phase2bRecover = (databaseName): ReturnType<typeof readOracleRecords> =>
	readOracleRecords(databaseName, FIXTURE_OBJECT_ID);
