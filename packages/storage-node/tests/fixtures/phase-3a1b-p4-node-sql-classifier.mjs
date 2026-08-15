// Analyzer fixture for the external Node observer; it is not a production SQL parser or substitute.
const IDENTIFIER = '(?:[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")+"|`(?:[^`]|``)+`)';

function quotedName(name) {
	return `(?:${name}|"${name}"|\`${name}\`)`;
}

function withoutStringLiterals(sql) {
	return sql.replace(/'(?:[^']|'')*'/gu, "''");
}

/** Returns whether a statement clause addresses the exact optionally-qualified table. */
export function referencesPhase3a1bP4NodeTable(sql, name) {
	const table = quotedName(name);
	const qualified = String.raw`(?:(?:${IDENTIFIER})\s*\.\s*)?${table}`;
	return new RegExp(String.raw`\b(?:FROM|INTO|UPDATE|JOIN)\s+${qualified}(?![A-Za-z0-9_])`, "iu").test(
		withoutStringLiterals(sql)
	);
}

/** Separates the writer's scope lookup from post-commit closure observation. */
export function isPhase3a1bP4NodeMutationScopeRead(sql) {
	return /^\s*SELECT\b/iu.test(sql) && referencesPhase3a1bP4NodeTable(sql, "scopes");
}
