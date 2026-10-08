import { compareBytes } from "@ts-drp/canonical";

export interface ShadowIdentity {
	readonly anchor: string;
	readonly blueprintDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

export interface ShadowStateObservation extends ShadowIdentity {
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

export interface ShadowTypeScriptObservation extends ShadowStateObservation {
	readonly order: readonly string[];
	readonly payloadDigest: string;
}

export type ShadowReferenceObservation =
	| Readonly<{ readonly kind: "not-sampled" }>
	| Readonly<{ readonly kind: "observed"; readonly value: ShadowStateObservation }>;

export interface ShadowCloseObservation {
	readonly appliedVertices: number;
	readonly archival: ShadowStateObservation;
	readonly engineA: ShadowTypeScriptObservation;
	readonly engineB: ShadowTypeScriptObservation;
	readonly reference: ShadowReferenceObservation;
	readonly seed: number;
}

export type ShadowDiagnosticKind =
	| "agreement"
	| "identity-mismatch"
	| "invalid-observation"
	| "order-mismatch"
	| "payload-mismatch"
	| "state-mismatch";

export interface ShadowDiagnostic {
	readonly epoch: number;
	readonly kind: ShadowDiagnosticKind;
	readonly seed: number;
}

export type ShadowComparisonResult =
	| Readonly<{
			readonly appliedVertices: number;
			readonly closes: number;
			readonly diagnostics: readonly Readonly<ShadowDiagnostic>[];
			readonly kind: "agreement";
			readonly nonemptyStates: number;
			readonly ok: true;
			readonly referenceSamples: number;
	  }>
	| Readonly<{
			readonly diagnostic: Readonly<ShadowDiagnostic>;
			readonly kind: Exclude<ShadowDiagnosticKind, "agreement">;
			readonly ok: false;
	  }>;

const LOWER_HEX_DIGEST = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object";
}

function safeNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function closedKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === expected.length && keys.every((key, index) => typeof key === "string" && key === expected[index])
	);
}

function bytes(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array && value.byteLength > 0;
}

function digest(value: unknown): value is string {
	return typeof value === "string" && LOWER_HEX_DIGEST.test(value);
}

function validIdentity(value: Readonly<Record<string, unknown>>): boolean {
	return (
		typeof value.objectId === "string" &&
		value.objectId.length > 0 &&
		safeNonnegativeInteger(value.epoch) &&
		digest(value.anchor) &&
		digest(value.blueprintDigest)
	);
}

const STATE_KEYS = Object.freeze([
	"anchor",
	"blueprintDigest",
	"epoch",
	"objectId",
	"exactCanonicalStateBytes",
	"stateDigest",
] as const);
const TYPESCRIPT_KEYS = Object.freeze([
	"anchor",
	"blueprintDigest",
	"epoch",
	"objectId",
	"exactCanonicalStateBytes",
	"order",
	"payloadDigest",
	"stateDigest",
] as const);

function validStateObservation(value: unknown, expectedKeys: readonly string[]): value is ShadowStateObservation {
	return (
		isRecord(value) &&
		closedKeys(value, expectedKeys) &&
		validIdentity(value) &&
		bytes(value.exactCanonicalStateBytes) &&
		digest(value.stateDigest)
	);
}

function validTypeScriptObservation(value: unknown): value is ShadowTypeScriptObservation {
	if (!validStateObservation(value, TYPESCRIPT_KEYS)) return false;
	const candidate = value as ShadowTypeScriptObservation;
	return (
		Array.isArray(candidate.order) &&
		candidate.order.length > 0 &&
		candidate.order.every((entry) => digest(entry)) &&
		new Set(candidate.order).size === candidate.order.length &&
		digest(candidate.payloadDigest)
	);
}

function sameIdentity(left: ShadowIdentity, right: ShadowIdentity): boolean {
	return (
		left.objectId === right.objectId &&
		left.epoch === right.epoch &&
		left.anchor === right.anchor &&
		left.blueprintDigest === right.blueprintDigest
	);
}

function sameState(left: ShadowStateObservation, right: ShadowStateObservation): boolean {
	return (
		left.stateDigest === right.stateDigest &&
		compareBytes(left.exactCanonicalStateBytes, right.exactCanonicalStateBytes) === 0
	);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function diagnostic(kind: ShadowDiagnosticKind, seed: number, epoch: number): Readonly<ShadowDiagnostic> {
	return Object.freeze({ epoch, kind, seed });
}

function failure(
	kind: Exclude<ShadowDiagnosticKind, "agreement">,
	seed: number,
	epoch: number
): ShadowComparisonResult {
	const selected = diagnostic(kind, seed, epoch);
	return Object.freeze({ diagnostic: selected, kind, ok: false });
}

function invalidSeed(value: unknown): number {
	return safeNonnegativeInteger(value) ? value : -1;
}

function invalidEpoch(value: unknown): number {
	return safeNonnegativeInteger(value) ? value : -1;
}

/**
 * Compares detached observations from independent shadow-fold legs without executing or authorizing a fold.
 * @param input - Closed run observations and exact liveness expectations.
 * @returns Immutable agreement counters or the first typed mismatch.
 */
export function compareShadowRun(
	input: Readonly<{
		readonly expectedCloses: number;
		readonly expectedReferenceSamples: number;
		readonly observations: readonly ShadowCloseObservation[];
	}>
): ShadowComparisonResult {
	if (
		!safeNonnegativeInteger(input.expectedCloses) ||
		input.expectedCloses === 0 ||
		!safeNonnegativeInteger(input.expectedReferenceSamples) ||
		input.expectedReferenceSamples === 0 ||
		!Array.isArray(input.observations) ||
		input.observations.length !== input.expectedCloses
	) {
		return failure("invalid-observation", -1, -1);
	}

	const diagnostics: Array<Readonly<ShadowDiagnostic>> = [];
	let appliedVertices = 0;
	let nonemptyStates = 0;
	let referenceSamples = 0;
	for (const candidate of input.observations as readonly unknown[]) {
		if (!isRecord(candidate)) return failure("invalid-observation", -1, -1);
		const seed = invalidSeed(candidate.seed);
		const engineAEpoch = isRecord(candidate.engineA) ? invalidEpoch(candidate.engineA.epoch) : -1;
		if (
			!closedKeys(candidate, ["appliedVertices", "archival", "engineA", "engineB", "reference", "seed"]) ||
			!safeNonnegativeInteger(candidate.seed) ||
			!safeNonnegativeInteger(candidate.appliedVertices) ||
			candidate.appliedVertices === 0 ||
			!validStateObservation(candidate.archival, STATE_KEYS) ||
			!validTypeScriptObservation(candidate.engineA) ||
			!validTypeScriptObservation(candidate.engineB) ||
			!isRecord(candidate.reference)
		) {
			return failure("invalid-observation", seed, engineAEpoch);
		}

		const { archival, engineA, engineB } = candidate;
		let reference: ShadowStateObservation | undefined;
		if (candidate.reference.kind === "observed") {
			if (
				!closedKeys(candidate.reference, ["kind", "value"]) ||
				!validStateObservation(candidate.reference.value, STATE_KEYS)
			) {
				return failure("invalid-observation", seed, engineA.epoch);
			}
			reference = candidate.reference.value;
			referenceSamples++;
		} else if (candidate.reference.kind !== "not-sampled" || !closedKeys(candidate.reference, ["kind"])) {
			return failure("invalid-observation", seed, engineA.epoch);
		}

		const identities: readonly ShadowStateObservation[] =
			reference === undefined ? [engineA, engineB, archival] : [engineA, engineB, archival, reference];
		if (identities.some((entry) => !sameIdentity(engineA, entry))) {
			return failure("identity-mismatch", seed, engineA.epoch);
		}
		if (identities.some((entry) => !sameState(engineA, entry))) {
			return failure("state-mismatch", seed, engineA.epoch);
		}
		if (!sameStrings(engineA.order, engineB.order)) {
			return failure("order-mismatch", seed, engineA.epoch);
		}
		if (engineA.payloadDigest !== engineB.payloadDigest) {
			return failure("payload-mismatch", seed, engineA.epoch);
		}

		appliedVertices += candidate.appliedVertices;
		nonemptyStates++;
		diagnostics.push(diagnostic("agreement", seed, engineA.epoch));
	}

	if (referenceSamples !== input.expectedReferenceSamples) {
		return failure("invalid-observation", -1, -1);
	}
	return Object.freeze({
		appliedVertices,
		closes: diagnostics.length,
		diagnostics: Object.freeze(diagnostics),
		kind: "agreement",
		nonemptyStates,
		ok: true,
		referenceSamples,
	});
}
