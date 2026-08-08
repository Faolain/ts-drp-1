export interface ProcessIdentity {
	readonly birthToken: string;
	readonly command: string;
	readonly pgid: number;
	readonly pid: number;
	readonly ppid: number;
	readonly state: string;
}

export interface StagedFreezeAuthority {
	readonly browserRoot: ProcessIdentity;
	readonly childRoot: ProcessIdentity;
	readonly initialForest: readonly ProcessIdentity[];
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
	if (!validUniqueForest(forest)) throw new TypeError("forest contains malformed or ambiguous process identity");
	const child = forest.filter((process) => process.pid === childPid);
	const browser = forest.filter((process) => process.pid === browserPid);
	if (child.length !== 1 || browser.length !== 1) throw new TypeError("forest requires unique child and browser roots");
	const childPgid = child[0]?.pgid;
	const browserPgid = browser[0]?.pgid;
	if (childPgid === undefined || browserPgid === undefined || childPgid === browserPgid) {
		throw new TypeError("forest requires exactly two distinct process groups");
	}
	if (childPid !== childPgid || browserPid !== browserPgid || browser[0]?.ppid !== childPid) {
		throw new TypeError("forest requires root-led child and browser process groups");
	}
	const owned = forest.filter((process) => process.pgid === childPgid || process.pgid === browserPgid);
	if (!owned.some((process) => process.ppid === browserPid && /renderer/u.test(process.command))) {
		throw new TypeError("forest requires at least one browser renderer");
	}
	const identities = new Set(owned.map((process) => `${process.pid}:${process.birthToken}`));
	if (identities.size !== owned.length) throw new TypeError("forest contains ambiguous process identity");
	return Object.freeze({ childPgid, browserPgid, ownedPids: Object.freeze(owned.map((process) => process.pid)) });
}

/**
 * Proves that every initially observed child-group member stopped while both
 * group roots retain their exact non-state identities. Browser leaves are not
 * part of this first-stage proof because Chromium may replace them before its
 * group is stopped.
 * @param forest - Current complete process-table capture.
 * @param authority - Roots and initial owned forest validated before signaling.
 * @returns Whether the child group is safely stopped for the second stage.
 */
export function childGroupStoppedForFreeze(
	forest: readonly ProcessIdentity[],
	authority: StagedFreezeAuthority
): boolean {
	const authorized = validatedFreezeAuthority(authority);
	if (authorized === undefined || !validUniqueForest(forest)) return false;
	const childRoot = exactStableIdentity(forest, authority.childRoot);
	const browserRoot = exactStableIdentity(forest, authority.browserRoot);
	if (childRoot === undefined || browserRoot === undefined) return false;

	const currentChildGroup = forest.filter(({ pgid }) => pgid === authorized.childPgid);
	if (currentChildGroup.length === 0 || !currentChildGroup.every(stoppedOrZombie)) return false;
	return authorized.initialChildGroup.every((initial) => {
		const current = exactStableIdentity(forest, initial);
		return current !== undefined && stoppedOrZombie(current);
	});
}

/**
 * Freezes the current members of the two previously authorized process groups
 * after both groups have stopped. Departed initial browser leaves are omitted;
 * replacement leaves are admitted only through the already authorized browser
 * PGID and the complete current topology proof.
 * @param forest - Current complete process-table capture.
 * @param authority - Roots and initial owned forest validated before signaling.
 * @returns Frozen current owned union, or undefined for incomplete evidence.
 */
export function freezeCurrentOwnedUnion(
	forest: readonly ProcessIdentity[],
	authority: StagedFreezeAuthority
): readonly ProcessIdentity[] | undefined {
	const authorized = validatedFreezeAuthority(authority);
	if (authorized === undefined || !validUniqueForest(forest)) return undefined;
	if (
		exactStableIdentity(forest, authority.childRoot) === undefined ||
		exactStableIdentity(forest, authority.browserRoot) === undefined
	) {
		return undefined;
	}
	try {
		const groups = validateTwoGroupForest(forest, authority.childRoot.pid, authority.browserRoot.pid);
		if (groups.childPgid !== authorized.childPgid || groups.browserPgid !== authorized.browserPgid) return undefined;
	} catch {
		return undefined;
	}
	const owned = forest.filter(({ pgid }) => pgid === authorized.childPgid || pgid === authorized.browserPgid);
	if (!owned.every(stoppedOrZombie)) return undefined;
	return Object.freeze([...owned]);
}

function validUniqueForest(forest: readonly ProcessIdentity[]): boolean {
	if (!Array.isArray(forest) || !forest.every(validIdentity)) return false;
	return new Set(forest.map(({ pid }) => pid)).size === forest.length;
}

function validIdentity(identity: ProcessIdentity): boolean {
	return (
		typeof identity === "object" &&
		identity !== null &&
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		Number.isSafeInteger(identity.ppid) &&
		identity.ppid >= 0 &&
		Number.isSafeInteger(identity.pgid) &&
		identity.pgid > 0 &&
		typeof identity.birthToken === "string" &&
		identity.birthToken.length > 0 &&
		typeof identity.command === "string" &&
		identity.command.length > 0 &&
		typeof identity.state === "string" &&
		identity.state.length > 0
	);
}

function sameNonStateIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.ppid === right.ppid &&
		left.pgid === right.pgid &&
		left.birthToken === right.birthToken &&
		left.command === right.command
	);
}

function exactStableIdentity(
	forest: readonly ProcessIdentity[],
	expected: ProcessIdentity
): ProcessIdentity | undefined {
	const matches = forest.filter(({ pid }) => pid === expected.pid);
	return matches.length === 1 && matches[0] !== undefined && sameNonStateIdentity(matches[0], expected)
		? matches[0]
		: undefined;
}

function stoppedOrZombie(identity: ProcessIdentity): boolean {
	return /T|Z/u.test(identity.state);
}

function validatedFreezeAuthority(authority: StagedFreezeAuthority):
	| {
			readonly browserPgid: number;
			readonly childPgid: number;
			readonly initialChildGroup: readonly ProcessIdentity[];
	  }
	| undefined {
	if (
		typeof authority !== "object" ||
		authority === null ||
		!validIdentity(authority.childRoot) ||
		!validIdentity(authority.browserRoot) ||
		!validUniqueForest(authority.initialForest)
	) {
		return undefined;
	}
	if (
		exactStableIdentity(authority.initialForest, authority.childRoot) === undefined ||
		exactStableIdentity(authority.initialForest, authority.browserRoot) === undefined
	) {
		return undefined;
	}
	try {
		const groups = validateTwoGroupForest(authority.initialForest, authority.childRoot.pid, authority.browserRoot.pid);
		if (groups.childPgid !== authority.childRoot.pgid || groups.browserPgid !== authority.browserRoot.pgid) {
			return undefined;
		}
		return Object.freeze({
			childPgid: groups.childPgid,
			browserPgid: groups.browserPgid,
			initialChildGroup: Object.freeze(authority.initialForest.filter(({ pgid }) => pgid === groups.childPgid)),
		});
	} catch {
		return undefined;
	}
}
import { execFileSync } from "node:child_process";
