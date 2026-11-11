import type { SQLInputValue, StatementSync } from "node:sqlite";

import { releaseIterationStatement } from "./sqlite-statement-cache.js";

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
	// A statement checked out by iterationStatement returns to its connection only once this
	// iteration finished: exhausted, failed, or closed early through return().
	const next = rows.next.bind(rows);
	const close = rows.return?.bind(rows);
	let finished = false;
	const finish = (): void => {
		if (finished) return;
		finished = true;
		releaseIterationStatement(query);
	};
	rows.next = (...values: [] | [undefined]) => {
		let result: ReturnType<typeof next>;
		try {
			result = next(...values);
		} catch (cause) {
			finish();
			throw cause;
		}
		if (result.done === true) finish();
		return result;
	};
	if (close !== undefined)
		rows.return = (value?: unknown) => {
			try {
				return close(value as never);
			} finally {
				finish();
			}
		};
	return rows;
}
