import { EXPECTED_NEW_DIGEST, EXPECTED_OLD_DIGEST, FIXTURE_OBJECT_ID } from "./fixture-records.js";
import { boundedDetail, isWorkerFailureCode } from "./worker-protocol.js";
import type { WorkerFailureCode } from "../../src/internal/instrumented-idb.js";

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
	return Object.freeze({
		...candidate,
		browser: Object.freeze({ ...(browser as Record<string, unknown>) }),
		expectedDigests: Object.freeze({ ...(expectedDigests as Record<string, unknown>) }),
	}) as unknown as FailureArtifact;
}
