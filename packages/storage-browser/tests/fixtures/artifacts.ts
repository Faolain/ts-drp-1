import { EXPECTED_NEW_DIGEST, EXPECTED_OLD_DIGEST, FIXTURE_OBJECT_ID } from "./fixture-records.js";
import type { ProcessIdentity } from "./process-forest.js";
import { boundedDetail, isWorkerFailureCode } from "./worker-protocol.js";
import type { WorkerFailureCode } from "../../src/internal/instrumented-idb.js";
import { KILL_POINT_MANIFEST, type KillHit, type KillPoint, orderedKillPoints } from "../../src/killpoints.js";

export type ParentFailureCode =
	| "UNSUPPORTED_PLATFORM"
	| "SETUP_FAILED"
	| "CHILD_PROTOCOL"
	| "FOREST_CONTRADICTION"
	| "SURVIVOR"
	| "WRONG_EXIT"
	| "PREFIX_MISMATCH"
	| "RECOVERY_INVALID"
	| "RECOVERY_MIXED"
	| "EXPECTED_STATE_MISMATCH"
	| "DURABILITY_PROVENANCE"
	| "TIMEOUT"
	| "UNKNOWN_FAILURE_CODE"
	| "ARTIFACT_SCHEMA";

export type RunStage = "setup" | "seed" | "ready" | "hit" | "freeze" | "kill" | "recovery";

export interface PartialFailureEvidence {
	readonly cleanup: {
		readonly unresolvedOwnedGroups: readonly number[];
		readonly validatedGroups: readonly number[];
	};
	readonly observedHits?: readonly KillHit[];
	readonly recordedForest?: readonly ProcessIdentity[];
	readonly recoveryClassification?: {
		readonly digest: string;
		readonly state: "old" | "new" | "mixed";
	};
	readonly settledChildren?: readonly SettledChildEvidence[];
}

export interface FailureArtifact {
	readonly schemaVersion: 1;
	readonly verdict: "fail";
	readonly browser: {
		readonly executablePath: string;
		readonly name: "chromium";
		readonly version: string;
	};
	readonly databaseName: string;
	readonly expectedDigests: {
		readonly new: typeof EXPECTED_NEW_DIGEST;
		readonly old: typeof EXPECTED_OLD_DIGEST;
	};
	readonly gitSha: string;
	readonly objectId: typeof FIXTURE_OBJECT_ID;
	readonly platform: "darwin" | "linux";
	readonly profilePath: string;
	readonly runId: string;
	readonly runKind: "tuple" | "discovery" | "arming";
	readonly stage: RunStage;
	readonly code: WorkerFailureCode | ParentFailureCode;
	readonly detail: string;
	readonly partialEvidence: PartialFailureEvidence;
}

export interface BrowserIdentity {
	readonly executablePath: string;
	readonly name: "chromium";
	readonly version: string;
}

export interface SettledChildEvidence {
	readonly role: "seed" | "discovery" | "arming" | "recovery";
	readonly child: ProcessIdentity & { readonly exitCode: 0; readonly exitSignal: null };
	readonly browserRoot: ProcessIdentity;
	readonly ownedGroups: readonly {
		readonly role: "child" | "browser";
		readonly pgid: number;
		readonly rootPid: number;
		readonly absent: true;
	}[];
	readonly recordedForest: readonly ProcessIdentity[];
	readonly allRecordedProcessesAbsent: true;
}

interface PassBase {
	readonly schemaVersion: 1;
	readonly verdict: "pass";
	readonly browser: BrowserIdentity;
	readonly databaseName: string;
	readonly expectedDigests: { readonly old: typeof EXPECTED_OLD_DIGEST; readonly new: typeof EXPECTED_NEW_DIGEST };
	readonly gitSha: string;
	readonly objectId: typeof FIXTURE_OBJECT_ID;
	readonly platform: "darwin" | "linux";
	readonly profilePath: string;
	readonly runId: string;
}

export interface TuplePassArtifact extends PassBase {
	readonly runKind: "tuple";
	readonly armedPoint: KillPoint;
	readonly expectedRecoveredState: "old" | "new";
	readonly recoveredState: "old" | "new";
	readonly mixed: false;
	readonly expectedTransactionDurability: "not-reached" | "strict";
	readonly observedTransactionDurability: "not-reached" | "strict";
	readonly recoveredFixtureRecordsDigest: string;
	readonly observedHits: readonly KillHit[];
	readonly armedCellValue: 1;
	readonly crossOriginIsolated: true;
	readonly child: ProcessIdentity & { readonly exitCode: null; readonly exitSignal: "SIGKILL" };
	readonly browserRoot: ProcessIdentity;
	readonly killedGroups: readonly {
		readonly role: "child" | "browser";
		readonly pgid: number;
		readonly rootPid: number;
		readonly stopAccepted: true;
		readonly killAccepted: true;
		readonly absent: true;
	}[];
	readonly recordedForest: readonly ProcessIdentity[];
	readonly recordedProcessDeaths: readonly {
		readonly pid: number;
		readonly birthToken: string;
		readonly outcome: "absent" | "reused";
		readonly currentBirthToken: string | null;
	}[];
	readonly settledChildren: readonly [SettledChildEvidence, SettledChildEvidence];
}

export interface DiscoveryPassArtifact extends PassBase {
	readonly runKind: "discovery";
	readonly armedPoint: null;
	readonly recoveredState: "new";
	readonly mixed: false;
	readonly recoveredFixtureRecordsDigest: typeof EXPECTED_NEW_DIGEST;
	readonly observedHits: readonly KillHit[];
	readonly completeObservedPairs: readonly KillPoint[];
	readonly completeTransactionDurability: "strict";
	readonly finalCellValue: 0;
	readonly crossOriginIsolated: true;
	readonly settledChildren: readonly [SettledChildEvidence, SettledChildEvidence, SettledChildEvidence];
}

export interface ArmingPassArtifact extends PassBase {
	readonly runKind: "arming";
	readonly armedPoint: { readonly id: "left-write"; readonly edge: "before" };
	readonly recoveredState: "new";
	readonly mixed: false;
	readonly recoveredFixtureRecordsDigest: typeof EXPECTED_NEW_DIGEST;
	readonly preResumeObservedHits: readonly KillHit[];
	readonly observedHits: readonly KillHit[];
	readonly armedHitTransactionDurability: "strict";
	readonly notifyWoken: 1;
	readonly finalCellValue: 2;
	readonly completeObservedPairs: readonly KillPoint[];
	readonly completeTransactionDurability: "strict";
	readonly crossOriginIsolated: true;
	readonly settledChildren: readonly [SettledChildEvidence, SettledChildEvidence, SettledChildEvidence];
}

export type PassArtifact = TuplePassArtifact | DiscoveryPassArtifact | ArmingPassArtifact;

export interface CampaignAggregate {
	readonly artifactCount: 16;
	readonly tupleCount: 14;
	readonly discoveryCount: 1;
	readonly armingCount: 1;
	readonly old: 13;
	readonly new: 1;
	readonly mixed: 0;
	readonly notReachedDurability: 3;
	readonly strictDurability: 11;
	readonly missingKillPoints: readonly [];
}

const PARENT_CODES: ReadonlySet<ParentFailureCode> = new Set([
	"UNSUPPORTED_PLATFORM",
	"SETUP_FAILED",
	"CHILD_PROTOCOL",
	"FOREST_CONTRADICTION",
	"SURVIVOR",
	"WRONG_EXIT",
	"PREFIX_MISMATCH",
	"RECOVERY_INVALID",
	"RECOVERY_MIXED",
	"EXPECTED_STATE_MISMATCH",
	"DURABILITY_PROVENANCE",
	"TIMEOUT",
	"UNKNOWN_FAILURE_CODE",
	"ARTIFACT_SCHEMA",
]);
const RUN_STAGES: ReadonlySet<RunStage> = new Set(["setup", "seed", "ready", "hit", "freeze", "kill", "recovery"]);
const RUN_KINDS = new Set(["tuple", "discovery", "arming"]);

/**
 * Classifies an exception message only when it carries a closed Phase 2b code prefix.
 * @param error - Reached exception value.
 * @param fallback - Stage-specific closed code used for unclassified exceptions.
 * @returns A bounded detail and closed failure code.
 */
export function classifyRunFailure(
	error: unknown,
	fallback: ParentFailureCode
): Readonly<{ readonly code: FailureArtifact["code"]; readonly detail: string }> {
	const raw = error instanceof Error ? error.message : "unknown Phase 2b run failure";
	const detail = raw.slice(0, 256) || fallback;
	const prefix = detail.split(":", 1)[0];
	const code = isWorkerFailureCode(prefix) || PARENT_CODES.has(prefix as ParentFailureCode) ? prefix : fallback;
	return Object.freeze({ code: code as FailureArtifact["code"], detail });
}

function closedRecord(value: object, keys: readonly string[]): boolean {
	if (Object.getOwnPropertySymbols(value).length !== 0) return false;
	const actual = Object.getOwnPropertyNames(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]) &&
		actual.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		})
	);
}

/**
 * Parses one closed Phase 2b failure artifact.
 * @param value - Untrusted artifact value.
 * @returns A frozen validated failure artifact.
 */
export function parseFailureArtifact(value: unknown): FailureArtifact {
	if (typeof value !== "object" || value === null) throw new TypeError("artifact must be an object");
	if (
		!closedRecord(value, [
			"schemaVersion",
			"verdict",
			"browser",
			"databaseName",
			"expectedDigests",
			"gitSha",
			"objectId",
			"platform",
			"profilePath",
			"runId",
			"runKind",
			"stage",
			"code",
			"detail",
			"partialEvidence",
		])
	) {
		throw new TypeError("artifact has missing or extra fields");
	}
	const candidate = value as Record<string, unknown>;
	const browser = candidate.browser;
	const expectedDigests = candidate.expectedDigests;
	if (
		candidate.schemaVersion !== 1 ||
		candidate.verdict !== "fail" ||
		typeof browser !== "object" ||
		browser === null ||
		!closedRecord(browser, ["executablePath", "name", "version"]) ||
		(browser as Record<string, unknown>).name !== "chromium" ||
		typeof (browser as Record<string, unknown>).version !== "string" ||
		(browser as Record<string, unknown>).version === "" ||
		typeof (browser as Record<string, unknown>).executablePath !== "string" ||
		(browser as Record<string, unknown>).executablePath === "" ||
		typeof candidate.databaseName !== "string" ||
		candidate.databaseName === "" ||
		typeof expectedDigests !== "object" ||
		expectedDigests === null ||
		!closedRecord(expectedDigests, ["old", "new"]) ||
		(expectedDigests as Record<string, unknown>).old !== EXPECTED_OLD_DIGEST ||
		(expectedDigests as Record<string, unknown>).new !== EXPECTED_NEW_DIGEST ||
		typeof candidate.gitSha !== "string" ||
		!/^[0-9a-f]{40}$/u.test(candidate.gitSha) ||
		candidate.objectId !== FIXTURE_OBJECT_ID ||
		(candidate.platform !== "darwin" && candidate.platform !== "linux") ||
		typeof candidate.profilePath !== "string" ||
		candidate.profilePath === "" ||
		typeof candidate.runId !== "string" ||
		candidate.runId.length === 0 ||
		!RUN_KINDS.has(candidate.runKind as string) ||
		!RUN_STAGES.has(candidate.stage as RunStage) ||
		(!isWorkerFailureCode(candidate.code) && !PARENT_CODES.has(candidate.code as ParentFailureCode)) ||
		boundedDetail(candidate.detail) === undefined
	) {
		throw new TypeError("artifact is outside the closed failure schema");
	}
	const partialEvidence = requirePartialFailureEvidence(candidate.partialEvidence);
	return Object.freeze({
		...candidate,
		browser: Object.freeze({ ...(browser as Record<string, unknown>) }),
		expectedDigests: Object.freeze({ ...(expectedDigests as Record<string, unknown>) }),
		partialEvidence,
	}) as unknown as FailureArtifact;
}

function requireClosed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || !closedRecord(value, keys)) {
		throw new TypeError(`${label} is outside its closed schema`);
	}
	return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) {
		throw new TypeError(`${label} must be a closed array`);
	}
	const names = Object.getOwnPropertyNames(value).sort();
	const expected = [...value.keys()].map(String).concat("length").sort();
	if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
		throw new TypeError(`${label} must be dense and expando-free`);
	}
	return value;
}

function requirePositiveGroups(value: unknown, label: string): readonly number[] {
	const groups = requireArray(value, label);
	if (
		groups.some((group) => !Number.isSafeInteger(group) || Number(group) <= 0) ||
		new Set(groups).size !== groups.length
	) {
		throw new TypeError(`${label} must contain unique positive process groups`);
	}
	return Object.freeze(groups as number[]);
}

function requirePartialFailureEvidence(value: unknown): PartialFailureEvidence {
	if (typeof value !== "object" || value === null) throw new TypeError("partial failure evidence must be an object");
	const names = Object.getOwnPropertyNames(value);
	const permitted = new Set(["cleanup", "observedHits", "recordedForest", "recoveryClassification", "settledChildren"]);
	if (
		Object.getOwnPropertySymbols(value).length !== 0 ||
		!names.includes("cleanup") ||
		names.some((name) => !permitted.has(name)) ||
		names.some((name) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
		})
	) {
		throw new TypeError("partial failure evidence is outside its closed schema");
	}
	const candidate = value as Record<string, unknown>;
	const cleanup = requireClosed(
		candidate.cleanup,
		["validatedGroups", "unresolvedOwnedGroups"],
		"failure cleanup evidence"
	);
	const validatedGroups = requirePositiveGroups(cleanup.validatedGroups, "validated cleanup groups");
	const unresolvedOwnedGroups = requirePositiveGroups(cleanup.unresolvedOwnedGroups, "unresolved owned groups");
	if (validatedGroups.some((pgid) => unresolvedOwnedGroups.includes(pgid))) {
		throw new TypeError("failure cleanup group classes must be disjoint");
	}
	const partial: {
		cleanup: PartialFailureEvidence["cleanup"];
		observedHits?: readonly KillHit[];
		recordedForest?: readonly ProcessIdentity[];
		recoveryClassification?: { readonly digest: string; readonly state: "old" | "new" | "mixed" };
		settledChildren?: readonly SettledChildEvidence[];
	} = {
		cleanup: Object.freeze({ validatedGroups, unresolvedOwnedGroups }),
	};
	if (Object.hasOwn(candidate, "observedHits")) partial.observedHits = requireHits(candidate.observedHits);
	if (Object.hasOwn(candidate, "recordedForest")) {
		partial.recordedForest = Object.freeze(
			requireArray(candidate.recordedForest, "failure forest").map(
				(identity) => requireIdentity(identity) as unknown as ProcessIdentity
			)
		);
	}
	if (Object.hasOwn(candidate, "recoveryClassification")) {
		const classification = requireClosed(
			candidate.recoveryClassification,
			["digest", "state"],
			"failure recovery classification"
		);
		if (
			typeof classification.digest !== "string" ||
			classification.digest.length === 0 ||
			(classification.state !== "old" && classification.state !== "new" && classification.state !== "mixed")
		) {
			throw new TypeError("failure recovery classification is malformed");
		}
		partial.recoveryClassification = Object.freeze({
			digest: classification.digest,
			state: classification.state,
		});
	}
	if (Object.hasOwn(candidate, "settledChildren")) {
		partial.settledChildren = Object.freeze(
			requireArray(candidate.settledChildren, "failure settled children").map(requireSettled)
		);
	}
	return Object.freeze(partial);
}

function requireIdentity(value: unknown, extra: readonly string[] = []): Record<string, unknown> {
	const identity = requireClosed(
		value,
		["pid", "ppid", "pgid", "birthToken", "state", "command", ...extra],
		"process identity"
	);
	if (
		![identity.pid, identity.pgid].every((item) => Number.isSafeInteger(item) && Number(item) > 0) ||
		!Number.isSafeInteger(identity.ppid) ||
		Number(identity.ppid) < 0 ||
		![identity.birthToken, identity.state, identity.command].every(
			(item) => typeof item === "string" && item.length > 0
		)
	) {
		throw new TypeError("process identity values are malformed");
	}
	return identity;
}

function requirePoint(value: unknown): KillPoint {
	const point = requireClosed(value, ["id", "edge"], "kill point");
	if (
		typeof point.id !== "string" ||
		!Object.hasOwn(KILL_POINT_MANIFEST, point.id) ||
		(point.edge !== "before" && point.edge !== "after")
	) {
		throw new TypeError("kill point values are malformed");
	}
	return Object.freeze({ id: point.id as KillPoint["id"], edge: point.edge });
}

function requireHits(value: unknown): readonly KillHit[] {
	return Object.freeze(
		requireArray(value, "hit evidence").map((untrusted) => {
			const hit = requireClosed(untrusted, ["id", "edge", "transactionDurability"], "hit");
			const point = requirePoint({ id: hit.id, edge: hit.edge });
			if (hit.transactionDurability !== "not-reached" && hit.transactionDurability !== "strict") {
				throw new TypeError("hit durability is malformed");
			}
			return Object.freeze({ ...point, transactionDurability: hit.transactionDurability });
		})
	);
}

function pointKey(point: { readonly id: unknown; readonly edge: unknown }): string {
	return `${String(point.id)}/${String(point.edge)}`;
}

function expectedDurability(point: KillPoint): KillHit["transactionDurability"] {
	return point.id === "database-open" || (point.id === "transition-begin" && point.edge === "before")
		? "not-reached"
		: "strict";
}

function requireExactHitSequence(hits: readonly KillHit[], points: readonly KillPoint[], label: string): void {
	if (
		hits.length !== points.length ||
		hits.some(
			(hit, index) =>
				pointKey(hit) !== pointKey(points[index] as KillPoint) || hit.transactionDurability !== expectedDurability(hit)
		)
	) {
		throw new TypeError(`${label} is not the exact manifest/durability sequence`);
	}
}

function sameIdentity(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	return (
		left.pid === right.pid &&
		left.ppid === right.ppid &&
		left.pgid === right.pgid &&
		left.birthToken === right.birthToken &&
		left.command === right.command
	);
}

function requireOwnedForest(
	child: Record<string, unknown>,
	browserRoot: Record<string, unknown>,
	forestValues: unknown,
	groupValues: unknown,
	groupKeys: readonly string[]
): readonly Record<string, unknown>[] {
	const forest = requireArray(forestValues, "owned forest").map((identity) => requireIdentity(identity));
	if (
		new Set(forest.map((identity) => `${String(identity.pid)}:${String(identity.birthToken)}`)).size !== forest.length
	) {
		throw new TypeError("owned forest identities are not unique");
	}
	const childInForest = forest.find((identity) => identity.pid === child.pid);
	const browserInForest = forest.find((identity) => identity.pid === browserRoot.pid);
	if (
		childInForest === undefined ||
		browserInForest === undefined ||
		!sameIdentity(childInForest, child) ||
		!sameIdentity(browserInForest, browserRoot) ||
		browserRoot.ppid !== child.pid ||
		child.pgid !== child.pid ||
		browserRoot.pgid !== browserRoot.pid ||
		forest.some((identity) => identity.pgid !== child.pgid && identity.pgid !== browserRoot.pgid) ||
		!forest.some(
			(identity) =>
				identity.pgid === browserRoot.pgid &&
				identity.ppid === browserRoot.pid &&
				typeof identity.command === "string" &&
				/renderer/u.test(identity.command)
		)
	) {
		throw new TypeError("owned forest does not prove the child/browser two-group topology");
	}
	const groups = requireArray(groupValues, "owned groups").map((untrusted) =>
		requireClosed(untrusted, groupKeys, "owned group")
	);
	if (groups.length !== 2 || new Set(groups.map((group) => group.role)).size !== 2) {
		throw new TypeError("owned evidence requires one child and one browser group");
	}
	for (const group of groups) {
		const root = group.role === "child" ? child : group.role === "browser" ? browserRoot : undefined;
		if (root === undefined || group.rootPid !== root.pid || group.pgid !== root.pgid) {
			throw new TypeError("owned group does not match its process root");
		}
	}
	return Object.freeze(forest);
}

function requireSettled(value: unknown): SettledChildEvidence {
	const settled = requireClosed(
		value,
		["role", "child", "browserRoot", "ownedGroups", "recordedForest", "allRecordedProcessesAbsent"],
		"settled evidence"
	);
	if (
		settled.role !== "seed" &&
		settled.role !== "discovery" &&
		settled.role !== "arming" &&
		settled.role !== "recovery"
	) {
		throw new TypeError("settled role is malformed");
	}
	const child = requireIdentity(settled.child, ["exitCode", "exitSignal"]);
	if (child.exitCode !== 0 || child.exitSignal !== null) throw new TypeError("settled child did not exit zero");
	const browserRoot = requireIdentity(settled.browserRoot);
	const groups = requireArray(settled.ownedGroups, "settled groups");
	groups.forEach((untrusted) => {
		const group = requireClosed(untrusted, ["role", "pgid", "rootPid", "absent"], "settled group");
		if (group.absent !== true) throw new TypeError("settled group is not absent");
	});
	requireOwnedForest(child, browserRoot, settled.recordedForest, settled.ownedGroups, [
		"role",
		"pgid",
		"rootPid",
		"absent",
	]);
	if (settled.allRecordedProcessesAbsent !== true) throw new TypeError("settled processes were not all absent");
	return value as SettledChildEvidence;
}

function requireBase(candidate: Record<string, unknown>): void {
	const browser = requireClosed(candidate.browser, ["name", "version", "executablePath"], "browser identity");
	const digests = requireClosed(candidate.expectedDigests, ["old", "new"], "expected digests");
	if (
		candidate.schemaVersion !== 1 ||
		candidate.verdict !== "pass" ||
		(candidate.platform !== "darwin" && candidate.platform !== "linux") ||
		typeof candidate.runId !== "string" ||
		candidate.runId.length === 0 ||
		typeof candidate.gitSha !== "string" ||
		!/^[0-9a-f]{40}$/u.test(candidate.gitSha) ||
		typeof candidate.profilePath !== "string" ||
		candidate.profilePath.length === 0 ||
		typeof candidate.databaseName !== "string" ||
		candidate.databaseName.length === 0 ||
		candidate.objectId !== FIXTURE_OBJECT_ID ||
		browser.name !== "chromium" ||
		typeof browser.version !== "string" ||
		browser.version.length === 0 ||
		typeof browser.executablePath !== "string" ||
		browser.executablePath.length === 0 ||
		digests.old !== EXPECTED_OLD_DIGEST ||
		digests.new !== EXPECTED_NEW_DIGEST
	) {
		throw new TypeError("pass artifact base values are malformed");
	}
}

/**
 * Parses one exact closed schema-v1 pass artifact.
 * @param value - Untrusted run artifact.
 * @returns The validated closed pass variant.
 */
export function parsePassArtifact(value: unknown): PassArtifact {
	if (typeof value !== "object" || value === null) throw new TypeError("pass artifact must be an object");
	const kind = (value as Record<string, unknown>).runKind;
	const common = [
		"schemaVersion",
		"verdict",
		"browser",
		"databaseName",
		"expectedDigests",
		"gitSha",
		"objectId",
		"platform",
		"profilePath",
		"runId",
		"runKind",
	];
	let keys: readonly string[];
	if (kind === "tuple") {
		keys = [
			...common,
			"armedPoint",
			"expectedRecoveredState",
			"recoveredState",
			"mixed",
			"expectedTransactionDurability",
			"observedTransactionDurability",
			"recoveredFixtureRecordsDigest",
			"observedHits",
			"armedCellValue",
			"crossOriginIsolated",
			"child",
			"browserRoot",
			"killedGroups",
			"recordedForest",
			"recordedProcessDeaths",
			"settledChildren",
		];
	} else if (kind === "discovery") {
		keys = [
			...common,
			"armedPoint",
			"recoveredState",
			"mixed",
			"recoveredFixtureRecordsDigest",
			"observedHits",
			"completeObservedPairs",
			"completeTransactionDurability",
			"finalCellValue",
			"crossOriginIsolated",
			"settledChildren",
		];
	} else if (kind === "arming") {
		keys = [
			...common,
			"armedPoint",
			"recoveredState",
			"mixed",
			"recoveredFixtureRecordsDigest",
			"preResumeObservedHits",
			"observedHits",
			"armedHitTransactionDurability",
			"notifyWoken",
			"finalCellValue",
			"completeObservedPairs",
			"completeTransactionDurability",
			"crossOriginIsolated",
			"settledChildren",
		];
	} else {
		throw new TypeError("pass artifact has an unknown run kind");
	}
	const candidate = requireClosed(value, keys, `${String(kind)} pass artifact`);
	requireBase(candidate);
	const hits = requireHits(candidate.observedHits);
	if (candidate.mixed !== false || candidate.crossOriginIsolated !== true) {
		throw new TypeError("pass artifact contains a false pass sentinel");
	}
	const settled = requireArray(candidate.settledChildren, "settled children").map(requireSettled);
	if (kind === "tuple") {
		const point = requirePoint(candidate.armedPoint);
		const expectedState = point.id === "transaction-complete" && point.edge === "after" ? "new" : "old";
		const expectedDurability =
			point.id === "database-open" || (point.id === "transition-begin" && point.edge === "before")
				? "not-reached"
				: "strict";
		if (
			candidate.expectedRecoveredState !== expectedState ||
			candidate.recoveredState !== expectedState ||
			candidate.recoveredFixtureRecordsDigest !==
				(expectedState === "old" ? EXPECTED_OLD_DIGEST : EXPECTED_NEW_DIGEST) ||
			candidate.expectedTransactionDurability !== expectedDurability ||
			candidate.observedTransactionDurability !== expectedDurability ||
			candidate.armedCellValue !== 1 ||
			settled.length !== 2 ||
			settled[0]?.role !== "seed" ||
			settled[1]?.role !== "recovery"
		) {
			throw new TypeError("tuple pass scalar or settled evidence is malformed");
		}
		const child = requireIdentity(candidate.child, ["exitCode", "exitSignal"]);
		if (child.exitCode !== null || child.exitSignal !== "SIGKILL")
			throw new TypeError("tuple child death is malformed");
		const browserRoot = requireIdentity(candidate.browserRoot);
		const groups = requireArray(candidate.killedGroups, "killed groups");
		groups.forEach((untrusted) => {
			const group = requireClosed(
				untrusted,
				["role", "pgid", "rootPid", "stopAccepted", "killAccepted", "absent"],
				"killed group"
			);
			if (group.stopAccepted !== true || group.killAccepted !== true || group.absent !== true) {
				throw new TypeError("killed group lacks complete death evidence");
			}
		});
		const forest = requireOwnedForest(child, browserRoot, candidate.recordedForest, candidate.killedGroups, [
			"role",
			"pgid",
			"rootPid",
			"stopAccepted",
			"killAccepted",
			"absent",
		]);
		const deaths = requireArray(candidate.recordedProcessDeaths, "process deaths").map((untrusted) => {
			const death = requireClosed(untrusted, ["pid", "birthToken", "outcome", "currentBirthToken"], "process death");
			if (
				!Number.isSafeInteger(death.pid) ||
				typeof death.birthToken !== "string" ||
				death.birthToken.length === 0 ||
				(death.outcome !== "absent" && death.outcome !== "reused") ||
				(death.outcome === "absent" && death.currentBirthToken !== null) ||
				(death.outcome === "reused" &&
					(typeof death.currentBirthToken !== "string" ||
						death.currentBirthToken.length === 0 ||
						death.currentBirthToken === death.birthToken))
			) {
				throw new TypeError("process death is malformed");
			}
			return death;
		});
		if (
			deaths.length !== forest.length ||
			new Set(deaths.map((death) => death.pid)).size !== deaths.length ||
			forest.some(
				(identity) => !deaths.some((death) => death.pid === identity.pid && death.birthToken === identity.birthToken)
			)
		) {
			throw new TypeError("process deaths do not cover the recorded forest identities");
		}
		const prefixLength =
			orderedKillPoints().findIndex(
				(candidatePoint) => candidatePoint.id === point.id && candidatePoint.edge === point.edge
			) + 1;
		const expectedPrefix = orderedKillPoints().slice(0, prefixLength);
		requireExactHitSequence(hits, expectedPrefix, "tuple hit prefix");
		if (hits.at(-1)?.transactionDurability !== candidate.observedTransactionDurability) {
			throw new TypeError("tuple terminal hit durability disagrees with the scalar evidence");
		}
		return value as TuplePassArtifact;
	}
	const points = requireArray(candidate.completeObservedPairs, "complete pairs").map(requirePoint);
	requireExactHitSequence(hits, orderedKillPoints(), "control hit stream");
	if (
		candidate.recoveredState !== "new" ||
		candidate.recoveredFixtureRecordsDigest !== EXPECTED_NEW_DIGEST ||
		candidate.completeTransactionDurability !== "strict" ||
		JSON.stringify(points) !== JSON.stringify(orderedKillPoints())
	) {
		throw new TypeError("control complete evidence is malformed");
	}
	if (kind === "discovery") {
		if (
			candidate.armedPoint !== null ||
			candidate.finalCellValue !== 0 ||
			settled.length !== 3 ||
			settled.map((item) => item.role).join(",") !== "seed,discovery,recovery"
		) {
			throw new TypeError("discovery pass evidence is malformed");
		}
		return value as DiscoveryPassArtifact;
	}
	const armed = requirePoint(candidate.armedPoint);
	const preResume = requireHits(candidate.preResumeObservedHits);
	requireExactHitSequence(preResume, orderedKillPoints().slice(0, 9), "arming pre-resume hit stream");
	if (
		armed.id !== "left-write" ||
		armed.edge !== "before" ||
		candidate.armedHitTransactionDurability !== "strict" ||
		candidate.notifyWoken !== 1 ||
		candidate.finalCellValue !== 2 ||
		settled.length !== 3 ||
		settled.map((item) => item.role).join(",") !== "seed,arming,recovery"
	) {
		throw new TypeError("arming pass evidence is malformed");
	}
	return value as ArmingPassArtifact;
}

/**
 * Aggregates exactly sixteen pass artifacts after closed parsing.
 * @param values - Untrusted complete campaign artifacts.
 * @returns Exact campaign counts and empty manifest difference.
 */
export function aggregatePassArtifacts(values: readonly unknown[]): CampaignAggregate {
	const artifacts = values.map(parsePassArtifact);
	if (artifacts.length !== 16 || new Set(artifacts.map((artifact) => artifact.runId)).size !== 16) {
		throw new TypeError("aggregate requires sixteen unique pass artifacts");
	}
	const tuples = artifacts.filter((artifact): artifact is TuplePassArtifact => artifact.runKind === "tuple");
	const discovery = artifacts.filter((artifact) => artifact.runKind === "discovery");
	const arming = artifacts.filter((artifact) => artifact.runKind === "arming");
	const expected = new Set(orderedKillPoints().map((point) => `${point.id}/${point.edge}`));
	const actual = new Set(tuples.map((artifact) => `${artifact.armedPoint.id}/${artifact.armedPoint.edge}`));
	const missing = [...expected].filter((point) => !actual.has(point));
	if (
		tuples.length !== 14 ||
		discovery.length !== 1 ||
		arming.length !== 1 ||
		actual.size !== 14 ||
		missing.length !== 0 ||
		tuples.filter((artifact) => artifact.recoveredState === "old").length !== 13 ||
		tuples.filter((artifact) => artifact.recoveredState === "new").length !== 1 ||
		tuples.filter((artifact) => artifact.observedTransactionDurability === "not-reached").length !== 3 ||
		tuples.filter((artifact) => artifact.observedTransactionDurability === "strict").length !== 11
	) {
		throw new TypeError("aggregate evidence does not match the exact sixteen-run contract");
	}
	return Object.freeze({
		artifactCount: 16,
		tupleCount: 14,
		discoveryCount: 1,
		armingCount: 1,
		old: 13,
		new: 1,
		mixed: 0,
		notReachedDurability: 3,
		strictDurability: 11,
		missingKillPoints: Object.freeze([] as const),
	});
}
