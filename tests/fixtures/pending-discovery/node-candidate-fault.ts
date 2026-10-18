import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { unmatchedRecord, verifyUnmatchedPersistence } from "./candidate-fault-plan.js";
import type { CandidateFault } from "./types.js";
/**
 * Bind independently mutated native generation bytes to an exact fixture-owned database.
 * @param identity - Exact fixture-owned native database directory.
 * @returns Setup-only physical fault operation.
 */
export function nodeCandidateFault(identity: string): CandidateFault {
	return async (bootstrap, mode): Promise<void> => {
		await Promise.resolve();
		if (mode !== "unmatched") throw new Error("UNMATCHED_NATIVE_MODE");
		const database = new DatabaseSync(join(identity, "ahe.sqlite"));
		try {
			const object = bootstrap.expectedPreviousRoomHead.objectId;
			const rows = database
				.prepare("SELECT generation_id,record FROM generations WHERE object_id=?")
				.all(object)
				.map((row) => ({ generationId: String(row.generation_id), record: row.record as Uint8Array }));
			const changed = unmatchedRecord(rows);
			if (
				database
					.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?")
					.run(changed.record, object, changed.generationId).changes !== 1
			)
				throw new Error("UNMATCHED_NATIVE_WRITE");
			const persisted = database
				.prepare("SELECT record FROM generations WHERE object_id=? AND generation_id=?")
				.get(object, changed.generationId)?.record as Uint8Array;
			if (Buffer.compare(persisted, changed.record) !== 0) throw new Error("UNMATCHED_NATIVE_PERSISTENCE");
			verifyUnmatchedPersistence(persisted, changed.expectedBase);
		} finally {
			database.close();
		}
	};
}
