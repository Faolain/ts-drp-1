export interface ProcessIdentity {
	readonly birthToken: string;
	readonly command: string;
	readonly pgid: number;
	readonly pid: number;
	readonly ppid: number;
	readonly state: string;
}

const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/u;

/**
 * Parses one exact C-locale process-table capture.
 * @param output - Raw `ps` output.
 * @returns Frozen process identities.
 */
export function parseProcessForest(output: string): readonly ProcessIdentity[] {
	if (output.length === 0) return [];
	return output
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => {
			const match = PROCESS_LINE.exec(line);
			if (!match) throw new TypeError(`malformed process line: ${line}`);
			const pid = Number(match[1]);
			const ppid = Number(match[2]);
			const pgid = Number(match[3]);
			if (![pid, ppid, pgid].every((value) => Number.isSafeInteger(value) && value > 0)) {
				throw new TypeError("process IDs must be positive safe integers");
			}
			return Object.freeze({
				pid,
				ppid,
				pgid,
				birthToken: match[4] as string,
				state: match[5] as string,
				command: match[6] as string,
			});
		});
}

/**
 * Validates the synthetic two-group ownership proof.
 * @param forest - Parsed process identities.
 * @param childPid - Detached Node child root.
 * @param browserPid - Detached Chromium root.
 * @returns The two group IDs and complete owned PID set.
 */
export function validateTwoGroupForest(
	forest: readonly ProcessIdentity[],
	childPid: number,
	browserPid: number
): { readonly browserPgid: number; readonly childPgid: number; readonly ownedPids: readonly number[] } {
	const child = forest.filter((process) => process.pid === childPid);
	const browser = forest.filter((process) => process.pid === browserPid);
	if (child.length !== 1 || browser.length !== 1) throw new TypeError("forest requires unique child and browser roots");
	const childPgid = child[0]?.pgid;
	const browserPgid = browser[0]?.pgid;
	if (childPgid === undefined || browserPgid === undefined || childPgid === browserPgid) {
		throw new TypeError("forest requires exactly two distinct process groups");
	}
	const owned = forest.filter((process) => process.pgid === childPgid || process.pgid === browserPgid);
	if (!owned.some((process) => process.ppid === browserPid && /renderer/u.test(process.command))) {
		throw new TypeError("forest requires at least one browser renderer");
	}
	const identities = new Set(owned.map((process) => `${process.pid}:${process.birthToken}`));
	if (identities.size !== owned.length) throw new TypeError("forest contains ambiguous process identity");
	return Object.freeze({ childPgid, browserPgid, ownedPids: Object.freeze(owned.map((process) => process.pid)) });
}
