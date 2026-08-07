import type {
	ArmingPassArtifact,
	DiscoveryPassArtifact,
	PassArtifact,
	SettledChildEvidence,
	TuplePassArtifact,
} from "./artifacts.js";
import { EXPECTED_NEW_DIGEST, EXPECTED_OLD_DIGEST, FIXTURE_OBJECT_ID } from "./fixture-records.js";
import type { ProcessIdentity } from "./process-forest.js";
import { type KillHit, type KillPoint, orderedKillPoints } from "../../src/killpoints.js";

const GIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({
		pid,
		ppid,
		pgid,
		birthToken: `Fri Aug  7 20:00:${String(pid % 60).padStart(2, "0")} 2026`,
		state: "T",
		command,
	});
}

function settled(role: SettledChildEvidence["role"], ordinal: number): SettledChildEvidence {
	const childPid = 10_000 + ordinal * 10;
	const browserPid = childPid + 1;
	const rendererPid = childPid + 2;
	const child = identity(childPid, 42, childPid, `node ${role}-child.js`);
	const browserRoot = identity(browserPid, childPid, browserPid, `chromium ${role} --browser`);
	const renderer = identity(rendererPid, browserPid, browserPid, `chromium ${role} --type=renderer`);
	return Object.freeze({
		role,
		child: Object.freeze({ ...child, exitCode: 0 as const, exitSignal: null }),
		browserRoot,
		ownedGroups: Object.freeze([
			Object.freeze({ role: "child" as const, pgid: childPid, rootPid: childPid, absent: true as const }),
			Object.freeze({ role: "browser" as const, pgid: browserPid, rootPid: browserPid, absent: true as const }),
		]),
		recordedForest: Object.freeze([child, browserRoot, renderer]),
		allRecordedProcessesAbsent: true,
	});
}

function base(
	runId: string,
	ordinal: number
): {
	readonly browser: { readonly executablePath: string; readonly name: "chromium"; readonly version: string };
	readonly databaseName: string;
	readonly expectedDigests: { readonly new: typeof EXPECTED_NEW_DIGEST; readonly old: typeof EXPECTED_OLD_DIGEST };
	readonly gitSha: string;
	readonly objectId: typeof FIXTURE_OBJECT_ID;
	readonly platform: "linux";
	readonly profilePath: string;
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly verdict: "pass";
} {
	return {
		schemaVersion: 1 as const,
		verdict: "pass" as const,
		browser: Object.freeze({ name: "chromium" as const, version: "149.0.0.0", executablePath: "/chromium" }),
		databaseName: `phase-2b-${runId}`,
		expectedDigests: Object.freeze({ old: EXPECTED_OLD_DIGEST, new: EXPECTED_NEW_DIGEST }),
		gitSha: GIT_SHA,
		objectId: FIXTURE_OBJECT_ID as typeof FIXTURE_OBJECT_ID,
		platform: "linux" as const,
		profilePath: `/tmp/phase-2b-${ordinal}`,
		runId,
	};
}

function expectedDurability(point: KillPoint): KillHit["transactionDurability"] {
	return point.id === "database-open" || (point.id === "transition-begin" && point.edge === "before")
		? "not-reached"
		: "strict";
}

function hits(points: readonly KillPoint[]): readonly KillHit[] {
	return Object.freeze(
		points.map((point) => Object.freeze({ ...point, transactionDurability: expectedDurability(point) }))
	);
}

function tuple(point: KillPoint, ordinal: number): TuplePassArtifact {
	const childPid = 20_000 + ordinal * 10;
	const browserPid = childPid + 1;
	const rendererPid = childPid + 2;
	const child = identity(childPid, 42, childPid, "node crash-child.js");
	const browserRoot = identity(browserPid, childPid, browserPid, "chromium --browser");
	const renderer = identity(rendererPid, browserPid, browserPid, "chromium --type=renderer");
	const forest = Object.freeze([child, browserRoot, renderer]);
	const recoveredState = point.id === "transaction-complete" && point.edge === "after" ? "new" : "old";
	const durability = expectedDurability(point);
	return Object.freeze({
		...base(`tuple-${String(ordinal).padStart(2, "0")}-${point.id}-${point.edge}`, ordinal),
		runKind: "tuple",
		armedPoint: Object.freeze({ ...point }),
		expectedRecoveredState: recoveredState,
		recoveredState,
		mixed: false,
		expectedTransactionDurability: durability,
		observedTransactionDurability: durability,
		recoveredFixtureRecordsDigest: recoveredState === "old" ? EXPECTED_OLD_DIGEST : EXPECTED_NEW_DIGEST,
		observedHits: hits(orderedKillPoints().slice(0, ordinal + 1)),
		armedCellValue: 1,
		crossOriginIsolated: true,
		child: Object.freeze({ ...child, exitCode: null, exitSignal: "SIGKILL" as const }),
		browserRoot,
		killedGroups: Object.freeze([
			Object.freeze({
				role: "browser" as const,
				pgid: browserPid,
				rootPid: browserPid,
				stopAccepted: true as const,
				killAccepted: true as const,
				absent: true as const,
			}),
			Object.freeze({
				role: "child" as const,
				pgid: childPid,
				rootPid: childPid,
				stopAccepted: true as const,
				killAccepted: true as const,
				absent: true as const,
			}),
		]),
		recordedForest: forest,
		recordedProcessDeaths: Object.freeze(
			forest.map((process) =>
				Object.freeze({
					pid: process.pid,
					birthToken: process.birthToken,
					outcome: "absent" as const,
					currentBirthToken: null,
				})
			)
		),
		settledChildren: Object.freeze([settled("seed", ordinal * 2), settled("recovery", ordinal * 2 + 1)] as const),
	});
}

function discovery(): DiscoveryPassArtifact {
	const points = orderedKillPoints();
	return Object.freeze({
		...base("discovery", 14),
		runKind: "discovery",
		armedPoint: null,
		recoveredState: "new",
		mixed: false,
		recoveredFixtureRecordsDigest: EXPECTED_NEW_DIGEST,
		observedHits: hits(points),
		completeObservedPairs: points,
		completeTransactionDurability: "strict",
		finalCellValue: 0,
		crossOriginIsolated: true,
		settledChildren: Object.freeze([settled("seed", 40), settled("discovery", 41), settled("recovery", 42)] as const),
	});
}

function arming(): ArmingPassArtifact {
	const points = orderedKillPoints();
	return Object.freeze({
		...base("arming", 15),
		runKind: "arming",
		armedPoint: Object.freeze({ id: "left-write", edge: "before" }),
		recoveredState: "new",
		mixed: false,
		recoveredFixtureRecordsDigest: EXPECTED_NEW_DIGEST,
		preResumeObservedHits: hits(points.slice(0, 9)),
		observedHits: hits(points),
		armedHitTransactionDurability: "strict",
		notifyWoken: 1,
		finalCellValue: 2,
		completeObservedPairs: points,
		completeTransactionDurability: "strict",
		crossOriginIsolated: true,
		settledChildren: Object.freeze([settled("seed", 50), settled("arming", 51), settled("recovery", 52)] as const),
	});
}

/**
 * Returns a self-contained exact sixteen-artifact positive control.
 * @returns Valid manifest-derived tuple, discovery, and arming artifacts.
 */
export function validCorrectiveCampaign(): readonly PassArtifact[] {
	return Object.freeze([...orderedKillPoints().map(tuple), discovery(), arming()]);
}
