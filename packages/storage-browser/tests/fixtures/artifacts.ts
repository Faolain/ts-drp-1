import type { ProcessIdentity } from "./process-forest.js";

export type ParentFailureCode =
	| "UNSUPPORTED_PLATFORM"
	| "SETUP_FAILED"
	| "CHILD_PROTOCOL"
	| "FOREST_CONTRADICTION"
	| "SURVIVOR"
	| "WRONG_EXIT"
	| "RECOVERY_INVALID"
	| "RECOVERY_MIXED"
	| "TIMEOUT"
	| "ARTIFACT_SCHEMA";

export type RunStage = "setup" | "seed" | "ready" | "hit" | "freeze" | "kill" | "recovery";

export interface PartialFailureEvidence {
	readonly cleanup: {
		readonly unresolvedOwnedGroups: readonly number[];
		readonly validatedGroups: readonly number[];
	};
	readonly recordedForest?: readonly ProcessIdentity[];
}

export interface FailureArtifact {
	readonly schemaVersion: 1;
	readonly verdict: "fail";
	readonly browser: { readonly executablePath: string; readonly name: "chromium"; readonly version: string };
	readonly databaseName: string;
	readonly gitSha: string;
	readonly platform: "darwin" | "linux";
	readonly profilePath: string;
	readonly runId: string;
	readonly stage: RunStage;
	readonly code: ParentFailureCode;
	readonly detail: string;
	readonly partialEvidence: PartialFailureEvidence;
}

const CODES = new Set<ParentFailureCode>([
	"UNSUPPORTED_PLATFORM",
	"SETUP_FAILED",
	"CHILD_PROTOCOL",
	"FOREST_CONTRADICTION",
	"SURVIVOR",
	"WRONG_EXIT",
	"RECOVERY_INVALID",
	"RECOVERY_MIXED",
	"TIMEOUT",
	"ARTIFACT_SCHEMA",
]);
const STAGES = new Set<RunStage>(["setup", "seed", "ready", "hit", "freeze", "kill", "recovery"]);

function closedRecord(value: object, keys: readonly string[]): boolean {
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		Object.getOwnPropertyNames(value).sort().join("\0") === [...keys].sort().join("\0") &&
		Object.getOwnPropertyNames(value).every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		})
	);
}

function positiveGroups(value: unknown): readonly number[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => !Number.isSafeInteger(item) || Number(item) <= 0) ||
		new Set(value).size !== value.length
	)
		throw new TypeError("cleanup groups are malformed");
	return Object.freeze([...value] as number[]);
}

function processIdentities(value: unknown): readonly ProcessIdentity[] {
	if (!Array.isArray(value)) throw new TypeError("recorded forest is not an array");
	return Object.freeze(
		value.map((item) => {
			if (
				typeof item !== "object" ||
				item === null ||
				!closedRecord(item, ["birthToken", "command", "pgid", "pid", "ppid", "state"])
			)
				throw new TypeError("recorded process identity is outside its closed schema");
			const identity = item as Record<string, unknown>;
			if (
				![identity.pid, identity.pgid].every((number) => Number.isSafeInteger(number) && Number(number) > 0) ||
				!Number.isSafeInteger(identity.ppid) ||
				Number(identity.ppid) < 0 ||
				![identity.birthToken, identity.command, identity.state].every(
					(text) => typeof text === "string" && text.length > 0
				)
			)
				throw new TypeError("recorded process identity is malformed");
			return Object.freeze({ ...identity }) as unknown as ProcessIdentity;
		})
	);
}

/**
 * Parses one closed failure artifact used by the shared process-cleanup controls.
 * @param value - Untrusted artifact input.
 * @returns One validated, frozen failure artifact.
 */
export function parseFailureArtifact(value: unknown): FailureArtifact {
	if (typeof value !== "object" || value === null) throw new TypeError("artifact must be an object");
	if (
		!closedRecord(value, [
			"schemaVersion",
			"verdict",
			"browser",
			"databaseName",
			"gitSha",
			"platform",
			"profilePath",
			"runId",
			"stage",
			"code",
			"detail",
			"partialEvidence",
		])
	)
		throw new TypeError("artifact has missing or extra fields");
	const candidate = value as Record<string, unknown>;
	const browser = candidate.browser;
	const partial = candidate.partialEvidence;
	if (
		candidate.schemaVersion !== 1 ||
		candidate.verdict !== "fail" ||
		typeof browser !== "object" ||
		browser === null ||
		!closedRecord(browser, ["executablePath", "name", "version"]) ||
		(browser as Record<string, unknown>).name !== "chromium" ||
		!["executablePath", "version"].every(
			(key) =>
				typeof (browser as Record<string, unknown>)[key] === "string" &&
				String((browser as Record<string, unknown>)[key]).length > 0
		) ||
		typeof candidate.databaseName !== "string" ||
		!/^\p{ASCII}+$/u.test(candidate.databaseName) ||
		typeof candidate.gitSha !== "string" ||
		!/^[0-9a-f]{40}$/u.test(candidate.gitSha) ||
		(candidate.platform !== "darwin" && candidate.platform !== "linux") ||
		![candidate.profilePath, candidate.runId, candidate.detail].every(
			(item) => typeof item === "string" && item.length > 0
		) ||
		String(candidate.detail).length > 256 ||
		!STAGES.has(candidate.stage as RunStage) ||
		!CODES.has(candidate.code as ParentFailureCode) ||
		typeof partial !== "object" ||
		partial === null
	)
		throw new TypeError("artifact is outside the closed failure schema");
	const partialKeys = Object.getOwnPropertyNames(partial);
	if (
		Object.getOwnPropertySymbols(partial).length !== 0 ||
		!partialKeys.includes("cleanup") ||
		partialKeys.some((key) => key !== "cleanup" && key !== "recordedForest")
	)
		throw new TypeError("partial evidence is outside its closed schema");
	const cleanup = (partial as Record<string, unknown>).cleanup;
	if (
		typeof cleanup !== "object" ||
		cleanup === null ||
		!closedRecord(cleanup, ["validatedGroups", "unresolvedOwnedGroups"])
	)
		throw new TypeError("cleanup evidence is outside its closed schema");
	const validatedGroups = positiveGroups((cleanup as Record<string, unknown>).validatedGroups);
	const unresolvedOwnedGroups = positiveGroups((cleanup as Record<string, unknown>).unresolvedOwnedGroups);
	if (validatedGroups.some((pgid) => unresolvedOwnedGroups.includes(pgid)))
		throw new TypeError("cleanup group classes overlap");
	return Object.freeze({
		...candidate,
		browser: Object.freeze({ ...(browser as Record<string, unknown>) }),
		partialEvidence: Object.freeze({
			...(Object.hasOwn(partial, "recordedForest")
				? {
						recordedForest: processIdentities((partial as Record<string, unknown>).recordedForest),
					}
				: {}),
			cleanup: Object.freeze({ unresolvedOwnedGroups, validatedGroups }),
		}),
	}) as unknown as FailureArtifact;
}
