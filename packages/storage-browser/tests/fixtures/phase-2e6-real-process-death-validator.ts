import { PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./phase-2e5-browser-request-inventory.js";
import {
	type Phase2e6CampaignEvidence,
	type Phase2e6CaseEvidence,
	type Phase2e6DeclaredEdge,
	phase2e6ExpectedTracePrefix,
	phase2e6OracleImages,
	PHASE_2E6_DECLARED_EDGES,
} from "./phase-2e6-real-process-death-contract.js";
import {
	freezeCurrentOwnedUnion,
	processClosure,
	type ProcessIdentity,
	validateTwoGroupForest,
} from "./process-forest.js";

export interface Phase2e6ArtifactEnvelope {
	readonly campaignId: string;
	readonly evidence: Phase2e6CaseEvidence;
	readonly gitSha: string;
	readonly runId: string;
	readonly schemaVersion: 1;
}

const EVIDENCE_KEYS = Object.freeze(
	[
		"armReachCount",
		"browserExecutable",
		"browserRoot",
		"child",
		"childExit",
		"controllerPgid",
		"databaseCreateCountAfterSeed",
		"databaseDeleteCount",
		"databaseIdentityPreserved",
		"databaseName",
		"edgeId",
		"expectedState",
		"frozenForest",
		"head",
		"initialForest",
		"killedGroups",
		"operationTransactionCount",
		"profilePath",
		"reachedRequestedArm",
		"recordedProcessDeaths",
		"recoveredDatabaseName",
		"recoveredImage",
		"recoveryResult",
		"scenarioOperation",
		"sentinelRetained",
		"tracePrefix",
		"unsupported",
		"workerCrossOriginIsolated",
		"workerRealm",
		"writeRequestCount",
	].sort()
);

function stable(value: unknown): string {
	return JSON.stringify(value, (_key, nested) => {
		if (nested instanceof Uint8Array) return { bytes: [...nested] };
		if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return nested;
		return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
	});
}

/**
 * Parses closed persisted artifacts into the sole campaign boundary.
 * @param values - Untrusted artifact documents in declared edge order.
 * @param controls - Real stale-revision and monotone-recovery control evidence.
 * @param provenance - Exact reviewed candidate and campaign identity.
 * @returns Closed campaign evidence.
 */
export function phase2e6CampaignFromArtifacts(
	values: readonly unknown[],
	controls: Omit<Phase2e6CampaignEvidence, "cases">,
	provenance: Readonly<{ campaignId: string; gitSha: string }>
): Phase2e6CampaignEvidence {
	const cases = values.map((value, index) => {
		if (typeof value !== "object" || value === null) throw new TypeError("artifact is not an object");
		if (Object.keys(value).sort().join("\0") !== "campaignId\0evidence\0gitSha\0runId\0schemaVersion")
			throw new TypeError("artifact envelope is not closed");
		const envelope = value as Record<string, unknown>;
		const edge = PHASE_2E6_DECLARED_EDGES[index];
		if (
			edge === undefined ||
			envelope.schemaVersion !== 1 ||
			envelope.gitSha !== provenance.gitSha ||
			envelope.campaignId !== provenance.campaignId ||
			envelope.runId !== phase2e6RunId(edge, index)
		)
			throw new TypeError("artifact provenance is malformed");
		if (
			typeof envelope.evidence !== "object" ||
			envelope.evidence === null ||
			stable(Object.keys(envelope.evidence).sort()) !== stable(EVIDENCE_KEYS)
		)
			throw new TypeError("artifact evidence is not closed");
		return envelope.evidence as Phase2e6CaseEvidence;
	});
	if (new Set(cases.map(({ profilePath }) => profilePath)).size !== cases.length)
		throw new TypeError("profiles are not unique");
	if (new Set(cases.map(({ databaseName }) => databaseName)).size !== cases.length)
		throw new TypeError("databases are not unique");
	return { ...controls, cases };
}

/**
 * Derives the deterministic edge artifact identity.
 * @param edge - Declared durability edge.
 * @param index - Edge ordinal in the frozen matrix.
 * @returns Stable run and filename stem.
 */
export function phase2e6RunId(edge: Phase2e6DeclaredEdge, index: number): string {
	return `${String(index).padStart(2, "0")}-${edge.id.replaceAll("/", "-")}`;
}

function processErrors(observed: Phase2e6CaseEvidence): readonly string[] {
	try {
		const initial = observed.initialForest as readonly ProcessIdentity[];
		const frozen = observed.frozenForest as readonly ProcessIdentity[];
		const initialGroups = validateTwoGroupForest(initial, observed.child.pid, observed.browserRoot.pid);
		if (processClosure(initial, observed.child.pid).length !== initial.length)
			return ["initial forest escapes child ownership"];
		if (
			!observed.browserRoot.command.includes(observed.browserExecutable) ||
			!observed.browserRoot.command.includes(observed.profilePath)
		)
			return ["browser executable/profile provenance mismatch"];
		if (observed.controllerPgid === initialGroups.childPgid || observed.controllerPgid === initialGroups.browserPgid)
			return ["controller overlaps owned process groups"];
		const acceptedFrozen = freezeCurrentOwnedUnion(frozen, {
			browserRoot: observed.browserRoot,
			childRoot: observed.child,
			initialForest: initial,
		});
		if (acceptedFrozen === undefined || stable(acceptedFrozen) !== stable(frozen))
			return ["frozen owned union is invalid"];
		const expectedGroups = [
			{
				absent: true,
				killAccepted: true,
				pgid: initialGroups.browserPgid,
				role: "browser",
				rootPid: observed.browserRoot.pid,
			},
			{ absent: true, killAccepted: true, pgid: initialGroups.childPgid, role: "child", rootPid: observed.child.pid },
		];
		if (stable(observed.killedGroups) !== stable(expectedGroups)) return ["wrong process group or kill order"];
		const frozenBirths = new Map(frozen.map(({ birthToken, pid }) => [pid, birthToken]));
		if (observed.recordedProcessDeaths.length !== frozenBirths.size) return ["process death coverage mismatch"];
		for (const death of observed.recordedProcessDeaths) {
			const birth = frozenBirths.get(death.pid);
			if (
				birth !== death.birthToken ||
				(death.outcome === "absent" ? death.currentBirthToken !== null : death.currentBirthToken === birth)
			)
				return ["process survivor or birth-token mismatch"];
		}
	} catch {
		return ["invalid Phase 2b two-group evidence"];
	}
	return [];
}

function expectedWrites(edge: Phase2e6DeclaredEdge): number {
	return phase2e6ExpectedTracePrefix(edge).filter(
		({ id, kind }) => kind === "request-success" && /-(?:add|put)-/u.test(id)
	).length;
}

/**
 * Applies the complete process, image, recovery, and control oracle.
 * @param evidence - Closed campaign evidence.
 * @returns Every fail-closed acceptance error.
 */
export function phase2e6CampaignErrors(evidence: Phase2e6CampaignEvidence): readonly string[] {
	const errors: string[] = [];
	const actualIds = evidence.cases.map(({ edgeId }) => edgeId);
	const expectedIds = PHASE_2E6_DECLARED_EDGES.map(({ id }) => id);
	if (new Set(actualIds).size !== actualIds.length) errors.push("duplicate edge evidence");
	if (stable(actualIds) !== stable(expectedIds)) errors.push("missing, skipped, extra, or reordered edge evidence");
	for (const edge of PHASE_2E6_DECLARED_EDGES) {
		const observed = evidence.cases.find(({ edgeId }) => edgeId === edge.id);
		if (observed === undefined) continue;
		const row = PHASE_2E5_BROWSER_REQUEST_INVENTORY.find(({ id }) => id === edge.scenarioId);
		if (row === undefined) throw new TypeError(`unknown scenario: ${edge.scenarioId}`);
		if (observed.scenarioOperation !== row.operation) errors.push(`${edge.id}: wrong adapter operation`);
		if (!observed.workerRealm || !observed.workerCrossOriginIsolated)
			errors.push(`${edge.id}: invalid Worker isolation`);
		if (!observed.reachedRequestedArm || observed.armReachCount !== 1 || observed.unsupported)
			errors.push(`${edge.id}: requested arm absent/duplicate/unsupported`);
		if (stable(observed.tracePrefix) !== stable(phase2e6ExpectedTracePrefix(edge)))
			errors.push(`${edge.id}: trace prefix mismatch`);
		if (observed.childExit.code !== null || observed.childExit.signal !== "SIGKILL")
			errors.push(`${edge.id}: child was not SIGKILLed`);
		errors.push(...processErrors(observed).map((error) => `${edge.id}: ${error}`));
		if (
			!observed.databaseIdentityPreserved ||
			observed.databaseName !== observed.recoveredDatabaseName ||
			observed.databaseDeleteCount !== 0 ||
			observed.databaseCreateCountAfterSeed !== 0
		)
			errors.push(`${edge.id}: database deletion/recreation`);
		if (!observed.sentinelRetained || observed.recoveryResult !== "OK")
			errors.push(`${edge.id}: recovery/sentinel missing`);
		if (observed.writeRequestCount !== expectedWrites(edge) || observed.writeRequestCount === 0)
			errors.push(`${edge.id}: reached write count mismatch`);
		if (observed.operationTransactionCount !== 1) errors.push(`${edge.id}: two-transaction operation`);
		const state = edge.target === "request" ? "old" : "new";
		if (
			observed.expectedState !== state ||
			stable(observed.recoveredImage) !== stable(phase2e6OracleImages(edge.scenarioId)[state])
		)
			errors.push(`${edge.id}: independent image oracle mismatch`);
		if (row.operation === "swapHead") {
			if (
				observed.head.kind !== "swap" ||
				!observed.head.monotone ||
				observed.head.recovered !== (state === "old" ? observed.head.old : observed.head.new)
			)
				errors.push(`${edge.id}: swap head/closure XOR failed`);
		} else if (observed.head.kind !== "unchanged" || observed.head.recovered !== observed.head.old)
			errors.push(`${edge.id}: non-swap head changed`);
	}
	if (evidence.staleExpectedRevision !== "HEAD_CONFLICT") errors.push("stale expected revision did not conflict");
	if (
		evidence.competingRecovery.same !== "MONOTONE" ||
		evidence.competingRecovery.future !== "MONOTONE" ||
		evidence.competingRecovery.rollback !== "MONOTONE"
	)
		errors.push("competing recovery was not monotone");
	return errors;
}
