import type { ProcessIdentity } from "./process-forest.js";
import type { RunFinalizationObservation } from "./run-finalizer.js";
import type { SettledFailureOwnership } from "./settled-failure-ownership.js";

export interface SettledRunOwnershipContext {
	readonly childPid: number;
	readonly chromiumExecutablePath: string;
	readonly controllerPid: number;
	readonly profilePath: string;
}

export type ProfileDisposition = "remove" | "retain";

export type RunCompletion =
	| Readonly<{ kind: "pass" }>
	| Readonly<{
			finalization: Pick<RunFinalizationObservation, "unresolvedOwnedGroups">;
			kind: "failed-finalized";
	  }>
	| Readonly<{ kind: "finalization-failed" }>;

function hasExactArgument(command: string, argument: string): boolean {
	return (
		command === argument ||
		command.startsWith(`${argument} `) ||
		command.includes(` ${argument} `) ||
		command.endsWith(` ${argument}`)
	);
}

function hasExactExecutable(command: string, executablePath: string): boolean {
	return command === executablePath || command.startsWith(`${executablePath} `);
}

function validIdentity(identity: ProcessIdentity): boolean {
	return (
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		Number.isSafeInteger(identity.ppid) &&
		identity.ppid >= 0 &&
		Number.isSafeInteger(identity.pgid) &&
		identity.pgid > 0 &&
		identity.birthToken.length > 0 &&
		identity.command.length > 0 &&
		identity.state.length > 0
	);
}

function uniqueIdentities(forest: readonly ProcessIdentity[]): boolean {
	return new Set(forest.map(({ pid }) => pid)).size === forest.length;
}

/**
 * Resolves bounded settled-run ownership while the Node child is present or
 * after Chromium has been reparented. Only one exact executable, profile,
 * controller and renderer topology grants signal authority.
 * @param forest - Parent-captured process table after the child failure.
 * @param context - Parent-authoritative executable, profile and controller identity.
 * @returns Owned evidence and the narrower validated signal authority.
 */
export function inspectSettledRunOwnership(
	forest: readonly ProcessIdentity[],
	context: SettledRunOwnershipContext
): SettledFailureOwnership {
	const profileArgument = `--user-data-dir=${context.profilePath}`;
	const candidates = forest.filter(
		(identity) =>
			hasExactExecutable(identity.command, context.chromiumExecutablePath) &&
			hasExactArgument(identity.command, profileArgument)
	);
	const children = forest.filter(({ pid }) => pid === context.childPid);
	const discoverableGroups = Object.freeze([
		...new Set(
			[...children, ...candidates].filter(({ pgid }) => Number.isSafeInteger(pgid) && pgid > 0).map(({ pgid }) => pgid)
		),
	]);
	const recordedForest = Object.freeze(forest.filter(({ pgid }) => discoverableGroups.includes(pgid)));
	const unresolved = (): SettledFailureOwnership =>
		Object.freeze({ ownedGroups: discoverableGroups, recordedForest, validatedGroups: Object.freeze([]) });

	const controllers = forest.filter(({ pid }) => pid === context.controllerPid);
	if (
		context.profilePath.length === 0 ||
		context.chromiumExecutablePath.length === 0 ||
		!Number.isSafeInteger(context.childPid) ||
		context.childPid <= 0 ||
		!Number.isSafeInteger(context.controllerPid) ||
		context.controllerPid <= 0 ||
		forest.some((identity) => !validIdentity(identity)) ||
		!uniqueIdentities(forest) ||
		controllers.length !== 1 ||
		children.length > 1 ||
		candidates.length !== 1
	) {
		return unresolved();
	}

	const controller = controllers[0] as ProcessIdentity;
	const browserRoot = candidates[0] as ProcessIdentity;
	const renderers = forest.filter(
		(identity) =>
			identity.ppid === browserRoot.pid &&
			identity.pgid === browserRoot.pgid &&
			hasExactExecutable(identity.command, context.chromiumExecutablePath) &&
			hasExactArgument(identity.command, "--type=renderer")
	);
	if (browserRoot.pid !== browserRoot.pgid || browserRoot.pgid === controller.pgid || renderers.length === 0) {
		return unresolved();
	}
	if (children.length === 1) {
		const child = children[0] as ProcessIdentity;
		if (
			child.pid !== child.pgid ||
			child.pgid === controller.pgid ||
			child.pgid === browserRoot.pgid ||
			browserRoot.ppid !== child.pid
		) {
			return unresolved();
		}
		return Object.freeze({
			ownedGroups: Object.freeze([child.pgid, browserRoot.pgid]),
			recordedForest,
			validatedGroups: Object.freeze([child.pgid, browserRoot.pgid]),
		});
	}

	return Object.freeze({
		ownedGroups: Object.freeze([browserRoot.pgid]),
		recordedForest,
		validatedGroups: Object.freeze([browserRoot.pgid]),
	});
}

/**
 * Returns the closed profile-removal decision for one completed run path.
 * @param completion - Pass, finalized failure, or failed finalization outcome.
 * @returns Whether the profile is safe to remove or must be retained.
 */
export function profileDispositionFor(completion: RunCompletion): ProfileDisposition {
	if (completion.kind === "pass") return "remove";
	if (completion.kind === "finalization-failed") return "retain";
	return completion.finalization.unresolvedOwnedGroups.length === 0 ? "remove" : "retain";
}

/**
 * Applies profile disposal only after the closed policy granted it.
 * @param profilePath - Isolated profile owned by this run.
 * @param disposition - Closed removal or retention decision.
 * @param removeProfile - Injected profile-removal effect.
 * @returns Whether removal was invoked.
 */
export function disposeProfileWhenAllowed(
	profilePath: string,
	disposition: ProfileDisposition,
	removeProfile: (profilePath: string) => void
): boolean {
	if (disposition === "retain") return false;
	removeProfile(profilePath);
	return true;
}
