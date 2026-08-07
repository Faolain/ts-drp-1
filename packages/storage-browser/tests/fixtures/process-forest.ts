export interface ProcessIdentity {
	readonly birthToken: string;
	readonly command: string;
	readonly pgid: number;
	readonly pid: number;
	readonly ppid: number;
	readonly state: string;
}

const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/u;

export const PROCESS_FOREST_ARGUMENTS = Object.freeze(["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,state=,command="]);

/**
 * Captures the complete process table using the ratified C-locale command.
 * @returns Parsed full process identities.
 */
export function captureProcessForest(): readonly ProcessIdentity[] {
	return parseProcessForest(
		execFileSync("ps", PROCESS_FOREST_ARGUMENTS, {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			maxBuffer: 16 * 1024 * 1024,
		})
	);
}

/**
 * Returns the transitive descendant closure including the root.
 * @param forest - Complete process-table capture.
 * @param rootPid - Owned isolated child root.
 * @returns Stable forest subset reachable through parent IDs.
 */
export function processClosure(forest: readonly ProcessIdentity[], rootPid: number): readonly ProcessIdentity[] {
	const owned = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const identity of forest) {
			if (owned.has(identity.ppid) && !owned.has(identity.pid)) {
				owned.add(identity.pid);
				changed = true;
			}
		}
	}
	return Object.freeze(forest.filter((identity) => owned.has(identity.pid)));
}

/**
 * Locates the unique Chromium root directly owned by the isolated child.
 * @param forest - Complete process-table capture.
 * @param childPid - Isolated Node child PID.
 * @param profilePath - Exact fresh persistent-profile path.
 * @returns The unique browser root identity.
 */
export function locateBrowserRoot(
	forest: readonly ProcessIdentity[],
	childPid: number,
	profilePath: string
): ProcessIdentity {
	const candidates = forest.filter(
		(identity) => identity.ppid === childPid && identity.command.includes(`--user-data-dir=${profilePath}`)
	);
	if (candidates.length !== 1) throw new TypeError(`expected one browser root, observed ${candidates.length}`);
	return candidates[0] as ProcessIdentity;
}

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
			if (
				!Number.isSafeInteger(pid) ||
				pid <= 0 ||
				!Number.isSafeInteger(ppid) ||
				ppid < 0 ||
				!Number.isSafeInteger(pgid) ||
				pgid <= 0
			) {
				throw new TypeError("pid/pgid must be positive and ppid must be non-negative safe integers");
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
import { execFileSync } from "node:child_process";
