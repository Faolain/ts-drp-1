import type { SQLInputValue, StatementSync } from "node:sqlite";

// Node 22's native iterator does not retain its StatementSync wrapper. Weak
// keys tie each statement to exactly the reachable iterator, not room history.
const statements = new WeakMap<ReturnType<StatementSync["iterate"]>, StatementSync>();

/**
 * Streams native rows with statement custody, without materializing the query.
 * @param query - Owning native statement, with its original read configuration.
 * @param parameters - Original anonymous SQLite parameters.
 * @returns The unchanged native iterator, retaining its statement through use.
 */
export function iterateSqliteRows(
	query: StatementSync,
	...parameters: SQLInputValue[]
): ReturnType<StatementSync["iterate"]> {
	const rows = query.iterate(...parameters);
	statements.set(rows, query);
	return rows;
}
