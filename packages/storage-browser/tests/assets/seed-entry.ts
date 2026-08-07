import { seedInstrumentedDatabase } from "../../src/internal/instrumented-idb.js";
import { FIXTURE_OBJECT_ID } from "../fixtures/fixture-records.js";

declare global {
	interface Window {
		phase2bSeed(databaseName: string): ReturnType<typeof seedInstrumentedDatabase>;
	}
}

window.phase2bSeed = (databaseName): ReturnType<typeof seedInstrumentedDatabase> =>
	seedInstrumentedDatabase(databaseName, FIXTURE_OBJECT_ID);
