import type { DatabaseSync } from "node:sqlite";

/**
 * Native owner fences (ea4eb158): the snapshot, issuance and live-journal stores install
 * BEFORE triggers that call connection-local predicates (`snapshot_writer_v4`,
 * `issuance_retirement_connection`/`issuance_retirement_record`,
 * `journal_retirement_allows`). A connection that has not installed the current
 * owner's predicate cannot write at all ("no such function"), by design: it fences
 * an already-open legacy connection.
 *
 * Tests that simulate OUT-OF-BAND storage damage (an adversary or a disk with raw file
 * access: deleting a row, zeroing bytes, planting a competitor) must say so: this
 * installs predicates that admit every raw write on THIS connection only. It is never
 * an owner, it grants the product nothing, and a test that checks the fence itself must
 * not call it.
 * @param database - A raw fixture connection used only to damage stored bytes.
 * @returns The same connection.
 */
export function allowOutOfBandWrites(database: DatabaseSync): DatabaseSync {
	const allow = (): number => 1;
	database.function("snapshot_writer_v4", { varargs: true }, allow);
	database.function("snapshot_collectible_v4", { varargs: true }, allow);
	database.function("issuance_retirement_connection", { varargs: true }, allow);
	database.function("issuance_retirement_record", { varargs: true }, allow);
	database.function("journal_retirement_allows", { varargs: true }, allow);
	return database;
}
