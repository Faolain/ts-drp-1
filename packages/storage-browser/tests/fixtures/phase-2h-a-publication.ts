import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
	type Phase2hAggregate,
	type Phase2hDiagnosticIdentity,
	phase2hOverflowIdentity,
	type Phase2hSubmissionCensus,
} from "./phase-2h-a-aggregate.js";
import type { Phase2hValidationRecord } from "./phase-2h-a-record.js";
import { type Phase2hEngineName, PHASE_2H_ENGINES } from "./phase-2h-a-registry.js";

export interface Phase2hRunLayout {
	readonly aggregatePath: string;
	readonly gitSha: string;
	readonly outputBase: string;
	readonly runId: string;
	readonly runRoot: string;
}

export interface Phase2hPublisher {
	census(): Phase2hSubmissionCensus;
	submit(
		input: Readonly<{ project: Phase2hEngineName; record: Phase2hValidationRecord }>
	): "accepted" | "duplicate" | "rejected-bound";
}

function lowercaseDigest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Reads the exact tested worktree SHA without accepting an environment alias.
 * @param cwd - Repository working directory.
 * @returns Forty-character lowercase Git commit.
 */
export function phase2hGitSha(cwd: string): string {
	const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	if (!/^[0-9a-f]{40}$/u.test(value)) throw new TypeError("Phase 2h GitSha is malformed");
	return value;
}

/**
 * Creates a fresh create-only RunId topology below the exact output base.
 * @param input - Repository and optional deterministic identity for tests.
 * @returns Current invocation layout.
 */
export function preparePhase2hRun(
	input: Readonly<{ gitSha: string; outputBase: string; uuid?: string }>
): Phase2hRunLayout {
	const uuid = input.uuid ?? randomUUID();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid))
		throw new TypeError("Phase 2h UUID is not lowercase UUID-v4");
	const runId = `phase-2h/${input.gitSha}/${uuid}`;
	const runRoot = path.join(input.outputBase, runId);
	fs.mkdirSync(input.outputBase, { recursive: true });
	fs.mkdirSync(path.dirname(runRoot), { recursive: true });
	fs.mkdirSync(runRoot);
	for (const root of ["records", "collisions"]) {
		const rootPath = path.join(runRoot, root);
		fs.mkdirSync(rootPath);
		for (const project of PHASE_2H_ENGINES) fs.mkdirSync(path.join(rootPath, project));
	}
	return Object.freeze({
		aggregatePath: path.join(input.outputBase, "ahe-storage-validation.json"),
		gitSha: input.gitSha,
		outputBase: input.outputBase,
		runId,
		runRoot,
	});
}

/**
 * Writes the one closed aggregate owned by finalization.
 * @param layout - Current invocation layout.
 * @param aggregate - Bound aggregate.
 */
export function writePhase2hAggregate(layout: Phase2hRunLayout, aggregate: Phase2hAggregate): void {
	if (aggregate.gitSha !== layout.gitSha || aggregate.runId !== layout.runId)
		throw new TypeError("refusing to write a stale Phase 2h aggregate");
	fs.writeFileSync(layout.aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
}

/**
 * Publishes create-only validation records and owns the bounded collision census.
 * @param layout - Fresh current invocation layout.
 * @param options - Optional marker failure injection for the named control.
 * @returns Bounded publisher and census.
 */
export function createPhase2hPublisher(
	layout: Phase2hRunLayout,
	options: Readonly<{ failMarkerWrite?: boolean }> = {}
): Phase2hPublisher {
	let attempts = 0;
	let bounded = false;
	const seen = new Set<Phase2hDiagnosticIdentity>();
	const duplicates = new Set<Phase2hDiagnosticIdentity>();
	const invalid = new Set<Phase2hDiagnosticIdentity>();

	function markDuplicate(identity: Phase2hDiagnosticIdentity, project: Phase2hEngineName): void {
		duplicates.add(identity);
		invalid.add(identity);
		if (options.failMarkerWrite === true) return;
		const marker = Object.freeze({
			artifactKind: "ts-drp/ahe-storage-validation-collision/v1",
			diagnosticIdentity: identity,
			gitSha: layout.gitSha,
			project,
			runId: layout.runId,
			schemaVersion: 1,
		});
		const markerPath = path.join(layout.runRoot, "collisions", project, `${lowercaseDigest(identity)}.collision.json`);
		try {
			fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	return Object.freeze({
		census(): Phase2hSubmissionCensus {
			return Object.freeze({
				duplicateIdentities: Object.freeze([...duplicates]),
				invalidIdentities: Object.freeze([...invalid]),
			});
		},
		submit(
			input: Readonly<{ project: Phase2hEngineName; record: Phase2hValidationRecord }>
		): "accepted" | "duplicate" | "rejected-bound" {
			attempts += 1;
			if (attempts > 512) {
				if (!bounded) {
					invalid.add(phase2hOverflowIdentity("record-attempt-bound", layout.runId));
					bounded = true;
				}
				return "rejected-bound";
			}
			const identity = input.record.tupleId;
			if (seen.has(identity)) {
				markDuplicate(identity, input.project);
				return "duplicate";
			}
			seen.add(identity);
			const recordPath = path.join(layout.runRoot, "records", input.project, `${encodeURIComponent(identity)}.json`);
			try {
				fs.writeFileSync(recordPath, `${JSON.stringify(input.record)}\n`, { encoding: "utf8", flag: "wx" });
				return "accepted";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				markDuplicate(identity, input.project);
				return "duplicate";
			}
		},
	});
}
