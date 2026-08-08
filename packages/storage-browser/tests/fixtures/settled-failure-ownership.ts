import type { ProcessIdentity } from "./process-forest.js";
import { validateTwoGroupForest } from "./process-forest.js";

export interface SettledFailureOwnership {
	readonly ownedGroups: readonly number[];
	readonly recordedForest: readonly ProcessIdentity[];
	readonly validatedGroups: readonly number[];
}

const EMPTY_OWNERSHIP: SettledFailureOwnership = Object.freeze({
	ownedGroups: Object.freeze([]),
	recordedForest: Object.freeze([]),
	validatedGroups: Object.freeze([]),
});

function distinctGroups(groups: readonly number[]): readonly number[] {
	return Object.freeze([...new Set(groups)]);
}

function hasExactArgument(command: string, argument: string): boolean {
	return (
		command === argument ||
		command.startsWith(`${argument} `) ||
		command.includes(` ${argument} `) ||
		command.endsWith(` ${argument}`)
	);
}

/**
 * Discovers the two groups owned by one failed settled child while its direct
 * browser relationship and exact persistent profile are still observable.
 * Contradictory evidence is retained as unvalidated ownership, never as kill
 * authority.
 * @param forest - Process table captured before direct child cleanup.
 * @param childPid - PID of the isolated settled Node child.
 * @param profilePath - Exact persistent profile owned by this run.
 * @param controllerPid - Parent test-controller PID, whose group is never owned.
 * @returns Bounded owned, validated and recorded process evidence.
 */
export function inspectSettledFailureOwnership(
	forest: readonly ProcessIdentity[],
	childPid: number,
	profilePath: string,
	controllerPid: number
): SettledFailureOwnership {
	const child = forest.filter((identity) => identity.pid === childPid);
	const controller = forest.filter((identity) => identity.pid === controllerPid);
	const controllerPgid = controller.length === 1 ? controller[0]?.pgid : undefined;
	const profileFlag = `--user-data-dir=${profilePath}`;
	const browserCandidates = forest.filter(
		(identity) => identity.ppid === childPid && hasExactArgument(identity.command, profileFlag)
	);
	const discoverableGroups = distinctGroups(
		[...child.map((identity) => identity.pgid), ...browserCandidates.map((identity) => identity.pgid)].filter(
			(pgid) => pgid !== controllerPgid
		)
	);
	const recordedForest = Object.freeze(forest.filter((identity) => discoverableGroups.includes(identity.pgid)));

	try {
		if (browserCandidates.length !== 1) {
			throw new TypeError(`expected one exact profile browser root, observed ${browserCandidates.length}`);
		}
		const browserRoot = browserCandidates[0] as ProcessIdentity;
		const groups = validateTwoGroupForest(forest, childPid, browserRoot.pid);
		if (
			child.length !== 1 ||
			controller.length !== 1 ||
			child[0]?.pgid !== childPid ||
			browserRoot.pgid !== browserRoot.pid ||
			groups.childPgid === controllerPgid ||
			groups.browserPgid === controllerPgid
		) {
			throw new TypeError("settled failure forest does not prove isolated group leaders");
		}
		const validatedGroups = Object.freeze([groups.childPgid, groups.browserPgid]);
		return Object.freeze({ ownedGroups: validatedGroups, recordedForest, validatedGroups });
	} catch {
		return Object.freeze({
			ownedGroups: discoverableGroups,
			recordedForest,
			validatedGroups: Object.freeze([]),
		});
	}
}

/** Carries bounded process ownership through the existing run failure. */
export class SettledRunFailure extends Error {
	readonly ownership: SettledFailureOwnership;

	/**
	 * Creates one structured settled-role failure.
	 * @param cause - Original classified failure source.
	 * @param ownership - Ownership observed before child cleanup.
	 */
	constructor(cause: unknown, ownership: SettledFailureOwnership) {
		super(cause instanceof Error ? cause.message : "settled run failed", { cause });
		this.name = "SettledRunFailure";
		this.ownership = ownership;
	}
}

/**
 * Returns structured ownership only for the durable settled-failure envelope.
 * @param error - Untrusted run error.
 * @returns Structured ownership or the frozen no-authority default.
 */
export function ownershipFromSettledFailure(error: unknown): SettledFailureOwnership {
	return error instanceof SettledRunFailure ? error.ownership : EMPTY_OWNERSHIP;
}
