import { compareShadowRun, type ShadowCloseObservation, type ShadowDiagnostic } from "./shadow-comparison.js";

export const SHADOW_RUN_SCHEMA_VERSION = 1;
export const SHADOW_CLOSES_PER_SHARD = 100;
export const SHADOW_REFERENCE_SAMPLES_PER_SHARD = 10;
export const SHADOW_SHARD_STEP = 0x9e37_79b9;

const PROFILES = Object.freeze({
	nightly: Object.freeze({ epochs: 10_000, referenceSamples: 1_000, shards: 100 }),
	pr: Object.freeze({ epochs: 100, referenceSamples: 10, shards: 1 }),
} as const);

export type ShadowTier = keyof typeof PROFILES;

export interface ShadowShardInput {
	readonly closes: typeof SHADOW_CLOSES_PER_SHARD;
	readonly seed: number;
}

export interface ShadowRunReport {
	readonly appliedVertices: number;
	readonly browsers: readonly string[];
	readonly completedEpochs: number;
	readonly completedShards: number;
	readonly date: string;
	readonly epochs: number;
	readonly mismatches: readonly ShadowDiagnostic[];
	readonly nonemptyStates: number;
	readonly referenceSamples: number;
	readonly runtimes: readonly string[];
	readonly schemaVersion: typeof SHADOW_RUN_SCHEMA_VERSION;
	readonly seed: number;
	readonly sha: string;
	readonly shards: number;
	readonly tier: ShadowTier;
}

const REPORT_KEYS = Object.freeze([
	"appliedVertices",
	"browsers",
	"completedEpochs",
	"completedShards",
	"date",
	"epochs",
	"mismatches",
	"nonemptyStates",
	"referenceSamples",
	"runtimes",
	"schemaVersion",
	"seed",
	"sha",
	"shards",
	"tier",
] as const);
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object";
}

function safeNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function uint32(value: unknown): value is number {
	return safeNonnegativeInteger(value) && value <= 0xffff_ffff;
}

function validDate(value: unknown): value is string {
	if (typeof value !== "string" || !UTC_DATE.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function closedKeys(value: Readonly<Record<string, unknown>>): boolean {
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === REPORT_KEYS.length &&
		keys.every((key, index) => typeof key === "string" && key === REPORT_KEYS[index])
	);
}

function capturedRoster(value: readonly string[], allowEmpty: boolean, label: string): readonly string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		throw new TypeError(`shadow ${label} roster is invalid`);
	}
	for (let index = 0; index < value.length; index++) {
		const entry = value[index];
		if (
			!Object.hasOwn(value, index) ||
			typeof entry !== "string" ||
			entry.length === 0 ||
			(index > 0 && (value[index - 1] as string) >= entry)
		) {
			throw new TypeError(`shadow ${label} roster must be sorted and duplicate-free`);
		}
	}
	return Object.freeze([...value]);
}

function shardSeeds(baseSeed: number, count: number): readonly number[] {
	return Object.freeze(
		Array.from({ length: count }, (_, index) => (baseSeed + Math.imul(index, SHADOW_SHARD_STEP)) >>> 0)
	);
}

function frozenReport(
	input: Omit<ShadowRunReport, "browsers" | "mismatches" | "runtimes" | "schemaVersion"> &
		Readonly<{
			browsers: readonly string[];
			mismatches: readonly ShadowDiagnostic[];
			runtimes: readonly string[];
		}>
): ShadowRunReport {
	return Object.freeze({
		appliedVertices: input.appliedVertices,
		browsers: Object.freeze([...input.browsers]),
		completedEpochs: input.completedEpochs,
		completedShards: input.completedShards,
		date: input.date,
		epochs: input.epochs,
		mismatches: Object.freeze([...input.mismatches]),
		nonemptyStates: input.nonemptyStates,
		referenceSamples: input.referenceSamples,
		runtimes: Object.freeze([...input.runtimes]),
		schemaVersion: SHADOW_RUN_SCHEMA_VERSION,
		seed: input.seed,
		sha: input.sha,
		shards: input.shards,
		tier: input.tier,
	});
}

function invalidDiagnostic(seed: number): ShadowDiagnostic {
	return Object.freeze({ epoch: -1, kind: "invalid-observation", seed });
}

/**
 * Derives one deterministic diagnostic seed from a UTC date and exact Git SHA.
 * @param input - Exact run date and checked-out SHA.
 * @returns Unsigned 32-bit base seed.
 */
export function deriveShadowSeed(input: Readonly<{ date: string; sha: string }>): number {
	if (!validDate(input.date) || typeof input.sha !== "string" || !GIT_SHA.test(input.sha)) {
		throw new TypeError("shadow date or sha is invalid");
	}
	let hash = 2_166_136_261;
	for (const character of `${input.date}\0${input.sha}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/**
 * Executes the exact bounded shadow profile and compares every produced shard.
 * @param input - Captured run identity, rosters and genuine shard producer.
 * @returns Immutable complete or first-mismatch report.
 */
export async function runShadowTier(
	input: Readonly<{
		browsers: readonly string[];
		date: string;
		produceShard(input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]>;
		runtimes: readonly string[];
		sha: string;
		tier: ShadowTier;
	}>
): Promise<ShadowRunReport> {
	const profile = PROFILES[input.tier];
	if (profile === undefined || typeof input.produceShard !== "function") {
		throw new TypeError("shadow tier or producer is invalid");
	}
	const seed = deriveShadowSeed(input);
	const browsers = capturedRoster(input.browsers, true, "browser");
	const runtimes = capturedRoster(input.runtimes, false, "runtime");
	let appliedVertices = 0;
	let completedEpochs = 0;
	let completedShards = 0;
	let nonemptyStates = 0;
	let referenceSamples = 0;
	for (const shardSeed of shardSeeds(seed, profile.shards)) {
		let observations: readonly ShadowCloseObservation[];
		try {
			observations = await input.produceShard({ closes: SHADOW_CLOSES_PER_SHARD, seed: shardSeed });
		} catch {
			return frozenReport({
				appliedVertices,
				browsers,
				completedEpochs,
				completedShards,
				date: input.date,
				epochs: profile.epochs,
				mismatches: [invalidDiagnostic(shardSeed)],
				nonemptyStates,
				referenceSamples,
				runtimes,
				seed,
				sha: input.sha,
				shards: profile.shards,
				tier: input.tier,
			});
		}
		const seedBound =
			Array.isArray(observations) &&
			observations.length === SHADOW_CLOSES_PER_SHARD &&
			observations.every((entry, index) => Object.hasOwn(observations, index) && entry.seed === shardSeed);
		const compared = seedBound
			? compareShadowRun({
					expectedCloses: SHADOW_CLOSES_PER_SHARD,
					expectedReferenceSamples: SHADOW_REFERENCE_SAMPLES_PER_SHARD,
					observations,
				})
			: { diagnostic: invalidDiagnostic(shardSeed), kind: "invalid-observation" as const, ok: false as const };
		if (!compared.ok) {
			return frozenReport({
				appliedVertices,
				browsers,
				completedEpochs,
				completedShards,
				date: input.date,
				epochs: profile.epochs,
				mismatches: [compared.diagnostic],
				nonemptyStates,
				referenceSamples,
				runtimes,
				seed,
				sha: input.sha,
				shards: profile.shards,
				tier: input.tier,
			});
		}
		appliedVertices += compared.appliedVertices;
		completedEpochs += compared.closes;
		completedShards++;
		nonemptyStates += compared.nonemptyStates;
		referenceSamples += compared.referenceSamples;
	}
	return frozenReport({
		appliedVertices,
		browsers,
		completedEpochs,
		completedShards,
		date: input.date,
		epochs: profile.epochs,
		mismatches: [],
		nonemptyStates,
		referenceSamples,
		runtimes,
		seed,
		sha: input.sha,
		shards: profile.shards,
		tier: input.tier,
	});
}

function validLedgerReport(value: unknown): value is ShadowRunReport {
	if (!isRecord(value) || !closedKeys(value)) return false;
	const candidate = value as unknown as ShadowRunReport;
	try {
		if (
			candidate.schemaVersion !== SHADOW_RUN_SCHEMA_VERSION ||
			candidate.tier !== "nightly" ||
			!validDate(candidate.date) ||
			typeof candidate.sha !== "string" ||
			!GIT_SHA.test(candidate.sha) ||
			!uint32(candidate.seed) ||
			candidate.seed !== deriveShadowSeed(candidate) ||
			candidate.shards !== PROFILES.nightly.shards ||
			candidate.epochs !== PROFILES.nightly.epochs ||
			candidate.completedShards !== candidate.shards ||
			candidate.completedEpochs !== candidate.epochs ||
			candidate.referenceSamples !== PROFILES.nightly.referenceSamples ||
			candidate.nonemptyStates !== candidate.epochs ||
			candidate.appliedVertices !== candidate.epochs * 3 ||
			!Array.isArray(candidate.mismatches) ||
			candidate.mismatches.length !== 0
		) {
			return false;
		}
		capturedRoster(candidate.browsers, true, "browser");
		capturedRoster(candidate.runtimes, false, "runtime");
		return true;
	} catch {
		return false;
	}
}

/**
 * Validates an existing reviewed ledger and returns one detached append candidate.
 * @param input - Existing exact ledger rows and one complete nightly report.
 * @returns Frozen append-only ledger value; no file or Git effects occur.
 */
export function appendShadowLedger(
	input: Readonly<{
		candidate: ShadowRunReport;
		ledger: readonly ShadowRunReport[];
	}>
): readonly ShadowRunReport[] {
	if (!Array.isArray(input.ledger) || !validLedgerReport(input.candidate)) {
		throw new TypeError("shadow ledger candidate schema, tier, counts or roster are invalid");
	}
	const captured: ShadowRunReport[] = [];
	let previousDate: string | undefined;
	const identities = new Set<string>();
	for (let index = 0; index < input.ledger.length; index++) {
		const entry = input.ledger[index];
		if (!Object.hasOwn(input.ledger, index) || !validLedgerReport(entry)) {
			throw new TypeError("shadow ledger row schema is invalid");
		}
		const identity = `${entry.date}\0${entry.sha}\0${entry.seed}`;
		if ((previousDate !== undefined && entry.date <= previousDate) || identities.has(identity)) {
			throw new TypeError("shadow ledger date order or duplicate identity is invalid");
		}
		previousDate = entry.date;
		identities.add(identity);
		captured.push(frozenReport(entry));
	}
	const candidateIdentity = `${input.candidate.date}\0${input.candidate.sha}\0${input.candidate.seed}`;
	if ((previousDate !== undefined && input.candidate.date <= previousDate) || identities.has(candidateIdentity)) {
		throw new TypeError("shadow ledger candidate is duplicate or out of date order");
	}
	captured.push(frozenReport(input.candidate));
	return Object.freeze(captured);
}
