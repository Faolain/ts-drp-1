/* eslint-disable jsdoc/require-jsdoc -- tests-only orchestration keeps the production runner free of file authority */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import type { ShadowCloseObservation } from "./shadow-contract.js";
import { buildShadowRun } from "./shadow-driver.js";
import {
	SHADOW_CLOSES_PER_SHARD,
	SHADOW_PROFILES,
	SHADOW_REFERENCE_SAMPLES_PER_SHARD,
	SHADOW_RUN_SCHEMA_VERSION,
	SHADOW_SEED_VECTOR,
	SHADOW_SHARD_STEP,
	type ShadowRunnerModule,
	type ShadowRunReport,
	type ShadowShardInput,
	type ShadowTier,
} from "./shadow-runner-contract.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const LEDGER_PATH = path.join(REPOSITORY_ROOT, "docs/production-hardening/shadow-soak-ledger.json");
const WORKFLOW_PATH = path.join(REPOSITORY_ROOT, ".github/workflows/phase-4d-shadow-comparison.yml");

type FutureBuildShadowRun = (
	input?: Readonly<{
		closes?: number;
		referenceSampleInterval?: number;
		seed?: number;
	}>
) => Promise<readonly ShadowCloseObservation[]>;

const buildProfiledShadowRun = buildShadowRun as FutureBuildShadowRun;

export function independentSeed(input: Readonly<{ date: string; sha: string }>): number {
	let hash = 2_166_136_261;
	for (const character of `${input.date}\0${input.sha}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

export function independentShardSeeds(baseSeed: number, shards: number): readonly number[] {
	return Object.freeze(
		Array.from({ length: shards }, (_, index) => (baseSeed + Math.imul(index, SHADOW_SHARD_STEP)) >>> 0)
	);
}

export function assertIndependentContract(): void {
	if (independentSeed(SHADOW_SEED_VECTOR) !== SHADOW_SEED_VECTOR.seed) {
		throw new TypeError("shadow seed vector drifted");
	}
	if (
		SHADOW_PROFILES.pr.shards * SHADOW_CLOSES_PER_SHARD !== SHADOW_PROFILES.pr.epochs ||
		SHADOW_PROFILES.nightly.shards * SHADOW_CLOSES_PER_SHARD !== SHADOW_PROFILES.nightly.epochs ||
		SHADOW_PROFILES.pr.shards * SHADOW_REFERENCE_SAMPLES_PER_SHARD !== SHADOW_PROFILES.pr.referenceSamples ||
		SHADOW_PROFILES.nightly.shards * SHADOW_REFERENCE_SAMPLES_PER_SHARD !== SHADOW_PROFILES.nightly.referenceSamples
	) {
		throw new TypeError("shadow profile arithmetic drifted");
	}
	if (new Set(independentShardSeeds(SHADOW_SEED_VECTOR.seed, SHADOW_PROFILES.nightly.shards)).size !== 100) {
		throw new TypeError("shadow shard seed schedule is not injective");
	}
}

export async function genuineShard(input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> {
	return buildProfiledShadowRun({
		closes: input.closes,
		referenceSampleInterval: SHADOW_CLOSES_PER_SHARD / SHADOW_REFERENCE_SAMPLES_PER_SHARD,
		seed: input.seed,
	});
}

export function cloneShardWithSeed(
	observations: readonly ShadowCloseObservation[],
	seed: number
): readonly ShadowCloseObservation[] {
	return Object.freeze(observations.map((entry) => Object.freeze({ ...entry, seed })));
}

function exactReportBytes(report: ShadowRunReport): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
}

function exactLedgerBytes(ledger: readonly ShadowRunReport[]): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(ledger, null, 2)}\n`);
}

export async function emitRequestedWorkflowArtifacts(owner: ShadowRunnerModule): Promise<ShadowRunReport | undefined> {
	const output = process.env.SHADOW_OUTPUT;
	const ledgerOutput = process.env.SHADOW_LEDGER_OUTPUT;
	if (output === undefined && ledgerOutput === undefined) return undefined;
	if (
		output === undefined ||
		ledgerOutput === undefined ||
		!path.isAbsolute(output) ||
		!path.isAbsolute(ledgerOutput)
	) {
		throw new TypeError("shadow artifact paths must be two explicit absolute paths");
	}
	const tier = process.env.SHADOW_TIER as ShadowTier | undefined;
	const date = process.env.SHADOW_DATE;
	const sha = process.env.SHADOW_SHA;
	if ((tier !== "pr" && tier !== "nightly") || date === undefined || sha === undefined) {
		throw new TypeError("shadow workflow environment is incomplete");
	}
	const report = await owner.runShadowTier({
		browsers: [],
		date,
		produceShard: genuineShard,
		runtimes: [`node-${process.versions.node.split(".")[0]}`],
		sha,
		tier,
	});
	writeFileSync(output, exactReportBytes(report));
	const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as unknown;
	if (!Array.isArray(ledger)) throw new TypeError("shadow ledger root must be an array");
	const complete = reportIsComplete(report);
	const proposed = tier === "nightly" && complete ? owner.appendShadowLedger({ candidate: report, ledger }) : ledger;
	writeFileSync(ledgerOutput, exactLedgerBytes(proposed));
	if (!complete) throw new TypeError("shadow comparison report is incomplete");
	return report;
}

export function parsedWorkflow(): Readonly<Record<string, unknown>> | undefined {
	try {
		return parseDocument(readFileSync(WORKFLOW_PATH, "utf8"), { schema: "core" }).toJS() as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function ledgerExists(): boolean {
	try {
		return readFileSync(LEDGER_PATH, "utf8").trim() === "[]";
	} catch {
		return false;
	}
}

export function reportIsComplete(report: ShadowRunReport): boolean {
	return (
		report.schemaVersion === SHADOW_RUN_SCHEMA_VERSION &&
		report.completedShards === report.shards &&
		report.completedEpochs === report.epochs &&
		report.mismatches.length === 0
	);
}
