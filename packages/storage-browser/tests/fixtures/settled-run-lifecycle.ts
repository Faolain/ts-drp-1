import type { ProcessIdentity } from "./process-forest.js";
import type { RunFinalizationObservation } from "./run-finalizer.js";
import {
	type OwnershipEvidenceState,
	type SettledFailureOwnership,
	settledFailureOwnership,
} from "./settled-failure-ownership.js";

export interface SettledRunOwnershipContext {
	readonly childPid: number;
	readonly chromiumExecutablePath: string;
	readonly controllerPid: number;
	readonly profilePath: string;
	readonly priorOwnershipEvidenceState?: OwnershipEvidenceState;
	readonly trustedChildIdentity?: ProcessIdentity;
}

interface CapturedSettledRunOwnershipContext extends SettledRunOwnershipContext {
	readonly captureState: OwnershipEvidenceState;
}

export type ProfileDisposition = "remove" | "retain";

export type RunCompletion =
	| Readonly<{ kind: "pass" }>
	| Readonly<{
			finalization: Pick<RunFinalizationObservation, "unresolvedOwnedGroups">;
			kind: "failed-finalized";
			ownershipEvidenceState: OwnershipEvidenceState;
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

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.birthToken === right.birthToken &&
		left.command === right.command &&
		left.pgid === right.pgid &&
		left.pid === right.pid &&
		left.ppid === right.ppid &&
		left.state === right.state
	);
}

function ownershipEvidenceState(context: CapturedSettledRunOwnershipContext): OwnershipEvidenceState {
	return context.captureState === "unknown" || context.priorOwnershipEvidenceState === "unknown"
		? "unknown"
		: "captured";
}

/**
 * Captures the process table and delegates all pure ownership inspection to the
 * settled-run inspector. Capture failure is explicit incomplete evidence and
 * never grants signal authority.
 * @param captureProcessForest - Complete process-table capture effect.
 * @param context - Parent-authoritative browser and child context.
 * @returns Owned evidence, validated groups and evidence completeness.
 */
export function captureSettledRunOwnership(
	captureProcessForest: () => readonly ProcessIdentity[],
	context: SettledRunOwnershipContext
): SettledFailureOwnership {
	let forest: readonly ProcessIdentity[];
	try {
		forest = captureProcessForest();
	} catch {
		return inspectSettledRunOwnership(Object.freeze([]), { ...context, captureState: "unknown" });
	}
	return inspectSettledRunOwnership(forest, { ...context, captureState: "captured" });
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
	context: SettledRunOwnershipContext & { readonly captureState?: OwnershipEvidenceState }
): SettledFailureOwnership {
	const capturedContext: CapturedSettledRunOwnershipContext = {
		...context,
		captureState: context.captureState ?? "captured",
	};
	const profileArgument = `--user-data-dir=${context.profilePath}`;
	const profileCandidates = forest.filter((identity) => hasExactArgument(identity.command, profileArgument));
	const executableCandidates = profileCandidates.filter((identity) =>
		hasExactExecutable(identity.command, context.chromiumExecutablePath)
	);
	const contradictoryProfileAuthority =
		profileCandidates.length > 0 && (profileCandidates.length !== 1 || executableCandidates.length !== 1);
	const evidenceState =
		contradictoryProfileAuthority || ownershipEvidenceState(capturedContext) === "unknown" ? "unknown" : "captured";
	const children = forest.filter(({ pid }) => pid === context.childPid);
	const possibleUncapturedChildGroup =
		capturedContext.captureState === "unknown" && Number.isSafeInteger(context.childPid) && context.childPid > 0
			? [context.childPid]
			: [];
	const discoverableGroups = Object.freeze([
		...new Set([
			...possibleUncapturedChildGroup,
			...children.filter(({ pgid }) => Number.isSafeInteger(pgid) && pgid > 0).map(({ pgid }) => pgid),
			...profileCandidates.filter(({ pgid }) => Number.isSafeInteger(pgid) && pgid > 0).map(({ pgid }) => pgid),
		]),
	]);
	const recordedForest = Object.freeze(forest.filter(({ pgid }) => discoverableGroups.includes(pgid)));
	const unresolved = (): SettledFailureOwnership =>
		settledFailureOwnership(
			{ ownedGroups: discoverableGroups, recordedForest, validatedGroups: Object.freeze([]) },
			evidenceState
		);

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
		contradictoryProfileAuthority ||
		executableCandidates.length !== 1
	) {
		return unresolved();
	}

	const controller = controllers[0] as ProcessIdentity;
	const browserRoot = executableCandidates[0] as ProcessIdentity;
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
	const validatedGroups: number[] = [];
	if (children.length === 1 && context.trustedChildIdentity !== undefined) {
		const child = children[0] as ProcessIdentity;
		if (
			!sameIdentity(child, context.trustedChildIdentity) ||
			child.pid !== child.pgid ||
			child.pgid === controller.pgid ||
			child.pgid === browserRoot.pgid ||
			browserRoot.ppid !== child.pid
		) {
			return settledFailureOwnership(
				{
					ownedGroups: discoverableGroups,
					recordedForest,
					validatedGroups: Object.freeze([browserRoot.pgid]),
				},
				evidenceState
			);
		}
		validatedGroups.push(child.pgid);
	}
	validatedGroups.push(browserRoot.pgid);
	return settledFailureOwnership(
		{ ownedGroups: discoverableGroups, recordedForest, validatedGroups: Object.freeze(validatedGroups) },
		evidenceState
	);
}

/**
 * Returns the closed profile-removal decision for one completed run path.
 * @param completion - Pass, finalized failure, or failed finalization outcome.
 * @returns Whether the profile is safe to remove or must be retained.
 */
export function profileDispositionFor(completion: RunCompletion): ProfileDisposition {
	if (completion.kind === "pass") return "remove";
	if (completion.kind === "finalization-failed") return "retain";
	if (completion.ownershipEvidenceState !== "captured") return "retain";
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
