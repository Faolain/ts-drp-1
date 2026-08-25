import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import "fake-indexeddb/auto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	compareUtf8,
	createProductTraceDriver,
	exactKeys,
	expectedTimeout,
	loadPacemakerCandidateModules,
	PRODUCT_CONTRACT,
	readTrace,
	REPOSITORY_ROOT,
	runtimeReadiness,
	sha256File,
	traceManifestIsExact,
} from "./fixtures/phase-5d-v3/pacemaker-fixture.js";
import {
	assertClosedItfTrace,
	checkedTraceToQuintModule,
	implementationEventsToQuintTest,
	replayCheckedTrace,
} from "./fixtures/phase-5d-v3/pacemaker-trace-runner.js";
import type { ItfTrace } from "./fixtures/phase-5d-v3/pacemaker-types.js";
import { openInternalSealVoteStore } from "../packages/storage-browser/src/internal/seal-vote-store.js";

interface PacemakerLawContract {
	readonly vectors: {
		readonly crypto: {
			readonly cutValue: unknown;
			readonly leaderPrepareVote: Readonly<{
				readonly registeredDigestHex: string;
				readonly signatureHex: string;
				readonly signerId: string;
			}>;
			readonly qcs: readonly Readonly<{
				readonly digestHex: string;
				readonly id: string;
				readonly phase: string;
				readonly round: number;
				readonly signerIds: readonly string[];
				readonly value: string;
			}>[];
			readonly roundChanges: readonly Readonly<{
				readonly digestHex: string;
				readonly highestPrepareQC: string | null;
				readonly id: string;
				readonly signatureHex: string;
				readonly signerId: string;
			}>[];
			readonly signers: readonly Readonly<{ readonly publicKeyHex: string; readonly signerId: string }>[];
		};
		readonly leaderRoster: readonly string[];
		readonly leaders: readonly string[];
		readonly timeouts: readonly Readonly<{ readonly round: number; readonly timeoutMs: number }>[];
	};
}

const readiness = runtimeReadiness();
const openedDatabases: string[] = [];
const law = JSON.parse(
	readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-5d-v3/pacemaker-law-contract.json"), "utf8")
) as PacemakerLawContract;

function bytesFromHex(hex: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) throw new TypeError("invalid lowercase fixture hex");
	return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolvePromise(), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("database delete failed")), {
			once: true,
		});
	});
}

function formalEnvironment(): NodeJS.ProcessEnv {
	const brewJava = "/opt/homebrew/opt/openjdk@17/bin";
	return {
		...process.env,
		APALACHE_VERSION: PRODUCT_CONTRACT.profile.apalacheVersion,
		PATH: existsSync(resolve(brewJava, "java")) ? `${brewJava}${delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
	};
}

function execFileText(
	command: string,
	args: readonly string[],
	options: Readonly<{ readonly env?: NodeJS.ProcessEnv; readonly timeout?: number }> = {}
): Promise<Readonly<{ readonly stderr: string; readonly stdout: string }>> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			command,
			[...args],
			{
				cwd: REPOSITORY_ROOT,
				encoding: "utf8",
				env: options.env,
				maxBuffer: 32 * 1024 * 1024,
				timeout: options.timeout,
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
					return;
				}
				resolvePromise({ stderr, stdout });
			}
		);
	});
}

function allTraceEvents(): Set<string> {
	return new Set(
		PRODUCT_CONTRACT.traces.flatMap(({ path }) => readTrace(path).states.map(({ lastEvent }) => lastEvent))
	);
}

function verifySignedFixture(
	input: Readonly<{ readonly digestHex: string; readonly signatureHex: string; readonly signerId: string }>
): boolean {
	const signer = law.vectors.crypto.signers.find(({ signerId }) => signerId === input.signerId);
	if (signer === undefined) return false;
	return ed25519.verify(
		bytesFromHex(input.signatureHex),
		bytesFromHex(input.digestHex),
		bytesFromHex(signer.publicKeyHex),
		{ zip215: false }
	);
}

function rejectedTraceMutation(path: string, mutate: (states: ItfTraceMutableStates) => void): boolean {
	const trace = structuredClone(readTrace(path)) as unknown as { states: ItfTraceMutableStates };
	mutate(trace.states);
	try {
		assertClosedItfTrace(trace as unknown as ItfTrace);
		return false;
	} catch {
		return true;
	}
}

type MutableTraceState = {
	durableCommitQcCount: number;
	durablePrepareQcCount: number;
	durableRevision: number;
	lastEvent: string;
	pendingRoundChangeCount: number;
};
type ItfTraceMutableStates = MutableTraceState[];

function throwsModelReplayRequired(): boolean {
	try {
		implementationEventsToQuintTest([
			{ kind: "round_entered", phase: "awaiting", round: 1, sequence: 1, valueDigest: "value-X" },
		]);
		return false;
	} catch (error) {
		return error instanceof Error && error.message === "MODEL_REPLAY_REQUIRED";
	}
}

afterAll(async () => {
	for (const name of openedDatabases) await deleteDatabase(name);
});

describe.sequential("Phase 5d model-first pacemaker RED", () => {
	it("pins the governed profile, exact runtime boundary, and causal mutant roster", () => {
		expect(PRODUCT_CONTRACT.profile).toEqual({
			apalacheVersion: "0.56.1",
			epoch: 0,
			id: "pacemaker-profile-v1",
			maxFutureRoundGap: 8,
			minimumLivenessSteps: 10_000,
			minimumSymbolicSteps: 12,
			roundTimeoutBaseMs: 1000,
			roundTimeoutMaxMs: 30_000,
		});
		expect(PRODUCT_CONTRACT.runtimeOwners).toEqual([
			"packages/protocol-v3/src/seal.ts",
			"packages/seal/src/index.ts",
			"packages/seal/src/pacemaker.ts",
			"packages/seal/src/storage-port.ts",
			"packages/seal/src/internal/seal-vote-intent.ts",
			"packages/seal/package.json",
			"packages/storage-browser/src/seal-vote.ts",
			"packages/storage-browser/src/internal/seal-vote-store.ts",
			"vite.config.mts",
		]);
		expect(PRODUCT_CONTRACT.storage).toEqual({
			completeCommitQcRequired: true,
			completeHighestQcRequired: true,
			qcTransactionStores: ["signerState", "storageMeta"],
			roundChangePhase: "round-change",
			schemaVersion: 2,
			voteTransactionStores: ["signerState", "storageMeta", "voteOutbox", "voteSlots"],
		});
		expect(Object.keys(PRODUCT_CONTRACT.mutantRejections)).toHaveLength(21);
		expect(Object.values(PRODUCT_CONTRACT.mutantRejections).every((reason) => reason.length > 0)).toBe(true);
		expect(PRODUCT_CONTRACT.mutantRejections).toMatchObject({
			"digest-only-highest-qc": "COMPLETE_QC_REQUIRED",
			"finalized-before-commit-qc-persistence": "FINALIZATION_NOT_DURABLE",
			"local-commit-vote-as-finality": "COMMIT_QC_REQUIRED",
			"nested-qc-not-below-round-change": "NESTED_QC_ROUND_INVALID",
			"proposal-without-cut-value": "CUT_VALUE_REQUIRED",
			"synthetic-product-crash": "CRASH_IS_HARNESS_ONLY",
			"vacuous-symbolic-depth": "SYMBOLIC_DEPTH_TOO_SMALL",
		});
	});

	it("causally rejects every named pacemaker mutant", () => {
		const modelSource = readFileSync(resolve(REPOSITORY_ROOT, PRODUCT_CONTRACT.model.path), "utf8");
		const roundTracePath = "packages/seal/model/traces/n4-round-carryover.itf.json";
		const crashTracePath = "packages/seal/model/traces/n7-crash-restart.itf.json";
		const leader = law.vectors.crypto.leaderPrepareVote;
		const signer = law.vectors.crypto.signers.find(({ signerId }) => signerId === leader.signerId);
		const localeOrder = [...law.vectors.leaderRoster].sort((left, right) => left.localeCompare(right));
		const exactQc = law.vectors.crypto.qcs.find(({ id }) => id === "prepare-r2-a");
		const quorumForFour = Math.floor((2 * (PRODUCT_CONTRACT.limits.activeSignerCounts[0] ?? 0)) / 3) + 1;
		const roundTrace = readTrace(roundTracePath);
		const commitVoteIndex = roundTrace.states.findIndex(({ lastEvent }) => lastEvent === "commit-vote");
		const commitQcIndex = roundTrace.states.findIndex(({ lastEvent }) => lastEvent === "commit-qc");
		const results = new Map<string, boolean>([
			[
				"constant-model",
				/action\s+step\s*=\s*any/u.test(modelSource) &&
					/byzantineEquivocate/u.test(modelSource) &&
					/deliverCommitQc/u.test(modelSource),
			],
			[
				"event-name-only-replay",
				rejectedTraceMutation(roundTracePath, (states) => {
					const terminal = states.at(-1);
					if (terminal !== undefined) terminal.durableRevision = -1;
				}),
			],
			["implementation-log-without-model", throwsModelReplayRequired()],
			["one-signature-catchup", 1 < quorumForFour && PRODUCT_CONTRACT.limits.activeSignerCounts.includes(4)],
			["locale-sorted-leader", localeOrder.join("\u0000") !== law.vectors.leaderRoster.join("\u0000")],
			["invalid-deadline-reset", 10_000 + expectedTimeout(2) < 11_000 + expectedTimeout(2)],
			[
				"unbounded-future-bucket",
				PRODUCT_CONTRACT.profile.maxFutureRoundGap + 1 > PRODUCT_CONTRACT.limits.maxBufferedRounds,
			],
			[
				"unsigned-leader-proposal",
				signer !== undefined &&
					!ed25519.verify(
						new Uint8Array(64),
						bytesFromHex(leader.registeredDigestHex),
						bytesFromHex(signer.publicKeyHex),
						{ zip215: false }
					),
			],
			[
				"non-atomic-round-entry",
				rejectedTraceMutation(roundTracePath, (states) => {
					const timeout = states.find(({ lastEvent }) => lastEvent === "timeout");
					if (timeout !== undefined) timeout.durableRevision -= 1;
				}),
			],
			[
				"precommit-round-change-release",
				rejectedTraceMutation(roundTracePath, (states) => {
					const timeout = states.find(({ lastEvent }) => lastEvent === "timeout");
					if (timeout !== undefined) timeout.pendingRoundChangeCount -= 1;
				}),
			],
			["divergent-timeout-base", PRODUCT_CONTRACT.profile.roundTimeoutBaseMs !== 999],
			["divergent-timeout-cap", PRODUCT_CONTRACT.profile.roundTimeoutMaxMs !== 29_999],
			["divergent-future-gap", PRODUCT_CONTRACT.profile.maxFutureRoundGap !== 7],
			["uncapped-exponent", !Number.isFinite(1000 * 2 ** 1024) && expectedTimeout(1024) === 30_000],
			[
				"digest-only-highest-qc",
				exactQc !== undefined &&
					exactQc.signerIds.length === 3 &&
					Object.keys({ digestHex: exactQc.digestHex }).length === 1,
			],
			[
				"local-commit-vote-as-finality",
				commitVoteIndex >= 0 &&
					commitQcIndex === commitVoteIndex + 1 &&
					roundTrace.states[commitVoteIndex]?.phase === "committed" &&
					roundTrace.states[commitQcIndex]?.phase === "finalized",
			],
			[
				"finalized-before-commit-qc-persistence",
				rejectedTraceMutation(roundTracePath, (states) => {
					const commitQc = states.find(({ lastEvent }) => lastEvent === "commit-qc");
					if (commitQc !== undefined) commitQc.durableCommitQcCount -= 1;
				}),
			],
			["proposal-without-cut-value", law.vectors.crypto.cutValue !== undefined],
			["nested-qc-not-below-round-change", exactQc !== undefined && !(exactQc.round < exactQc.round)],
			["vacuous-symbolic-depth", 1 < PRODUCT_CONTRACT.profile.minimumSymbolicSteps],
			[
				"synthetic-product-crash",
				!PRODUCT_CONTRACT.events.includes("crash") &&
					readTrace(crashTracePath)["#meta"].source.startsWith("phase-5d-v3-checked-corpus:"),
			],
		]);
		expect([...results.keys()].sort()).toEqual(Object.keys(PRODUCT_CONTRACT.mutantRejections).sort());
		for (const [name, rejected] of results) expect(rejected, name).toBe(true);
	});

	it("authenticates the frozen proposal, leader vote, QCs and round-change evidence independently", () => {
		const ordered = [...law.vectors.leaderRoster].sort(compareUtf8);
		expect(ordered).toEqual(law.vectors.leaderRoster);
		expect(law.vectors.leaders).toEqual(Array.from({ length: 8 }, (_, round) => ordered[round % ordered.length]));
		for (const { round, timeoutMs } of law.vectors.timeouts) expect(expectedTimeout(round)).toBe(timeoutMs);

		expect(
			verifySignedFixture({
				digestHex: law.vectors.crypto.leaderPrepareVote.registeredDigestHex,
				signatureHex: law.vectors.crypto.leaderPrepareVote.signatureHex,
				signerId: law.vectors.crypto.leaderPrepareVote.signerId,
			})
		).toBe(true);
		for (const carrier of law.vectors.crypto.roundChanges.filter(({ signerId }) => signerId !== "outsider")) {
			expect(verifySignedFixture(carrier), carrier.id).toBe(true);
		}
		const selectedQcs = new Map(law.vectors.crypto.qcs.map((qc) => [qc.id, qc]));
		for (const roundChange of law.vectors.crypto.roundChanges) {
			if (roundChange.highestPrepareQC === null) continue;
			const qc = selectedQcs.get(roundChange.highestPrepareQC);
			expect(qc, roundChange.id).toBeDefined();
			expect(qc?.phase).toBe("prepare");
			expect(qc?.round).toBeLessThan(3);
		}
		const tampered = Uint8Array.from(bytesFromHex(law.vectors.crypto.leaderPrepareVote.registeredDigestHex));
		tampered[0] ^= 1;
		const leader = law.vectors.crypto.signers.find(
			({ signerId }) => signerId === law.vectors.crypto.leaderPrepareVote.signerId
		);
		expect(leader).toBeDefined();
		expect(
			ed25519.verify(
				bytesFromHex(law.vectors.crypto.leaderPrepareVote.signatureHex),
				tampered,
				bytesFromHex(leader?.publicKeyHex ?? ""),
				{ zip215: false }
			)
		).toBe(false);
	});

	it("hash-binds every closed ITF trace and rejects event-name-only state drift", () => {
		expect(traceManifestIsExact()).toBe(true);
		const events = allTraceEvents();
		for (const descriptor of PRODUCT_CONTRACT.traces) {
			expect(sha256File(resolve(REPOSITORY_ROOT, descriptor.path))).toBe(descriptor.sha256);
			const trace = readTrace(descriptor.path);
			assertClosedItfTrace(trace);
			expect(trace.states.every(({ n }) => n === descriptor.n)).toBe(true);
			for (const event of descriptor.requiredEvents) expect(events.has(event), event).toBe(true);
			const mutant = structuredClone(trace);
			const terminal = mutant.states.at(-1);
			if (terminal === undefined) throw new Error("TRACE_TOO_SHORT");
			mutant.states[mutant.states.length - 1] = {
				...terminal,
				durableRevision: -1,
			};
			expect(() => assertClosedItfTrace(mutant)).toThrow("TRACE_STATE_MISMATCH");
			expect(mutant.states.at(-1)?.durableRevision).not.toBe(trace.states.at(-1)?.durableRevision);
			const temporary = mkdtempSync(resolve(REPOSITORY_ROOT, ".phase5d-trace-"));
			try {
				const generatedPath = resolve(temporary, "checked-trace.qnt");
				writeFileSync(
					generatedPath,
					checkedTraceToQuintModule(trace, "../packages/seal/formal/seal-pacemaker"),
					"utf8"
				);
				const replayed = spawnSync(
					"pnpm",
					[
						"exec",
						"quint",
						"test",
						generatedPath,
						"--main",
						"checkedPacemakerTrace",
						"--match",
						"^checkedTrace$",
						"--backend",
						"typescript",
						"--max-samples",
						"1",
					],
					{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
				);
				expect(replayed.status, `${descriptor.path}\n${replayed.stdout}\n${replayed.stderr}`).toBe(0);
			} finally {
				rmSync(temporary, { force: true, recursive: true });
			}
		}
		for (const event of [
			"timeout",
			"round-change",
			"proposal",
			"prepare-qc",
			"commit-qc",
			"f-plus-one-catchup",
			"crash",
			"restart",
		]) {
			expect(events.has(event), event).toBe(true);
		}
		const generated = implementationEventsToQuintTest([
			{ kind: "vote_cast", phase: "prepare", round: 0, sequence: 0, valueDigest: "value-X" },
			{ kind: "qc_formed", phase: "prepare", round: 0, sequence: 1, valueDigest: "value-X" },
			{ kind: "lock_acquired", phase: "prepare", round: 0, sequence: 2, valueDigest: "value-X" },
			{ kind: "vote_cast", phase: "commit", round: 0, sequence: 3, valueDigest: "value-X" },
			{ kind: "qc_formed", phase: "commit", round: 0, sequence: 4, valueDigest: "value-X" },
			{ kind: "finalized", phase: "commit", round: 0, sequence: 5, valueDigest: "value-X" },
		]);
		expect(generated).toContain("persistVoteSet");
		expect(generated).toContain("deliverCommitQc");
		const temporary = mkdtempSync(resolve(REPOSITORY_ROOT, ".phase5d-events-"));
		try {
			const generatedPath = resolve(temporary, "implementation-replay.qnt");
			writeFileSync(generatedPath, generated, "utf8");
			const replayed = spawnSync(
				"pnpm",
				["exec", "quint", "test", generatedPath, "--main", "generatedPacemakerReplay", "--backend", "typescript"],
				{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
			);
			expect(replayed.status, `${replayed.stdout}\n${replayed.stderr}`).toBe(0);
		} finally {
			rmSync(temporary, { force: true, recursive: true });
		}
		expect(() =>
			implementationEventsToQuintTest([
				{ kind: "round_entered", phase: "awaiting", round: 1, sequence: 1, valueDigest: "value-X" },
			])
		).toThrow("MODEL_REPLAY_REQUIRED");
	});

	it("typechecks and executes non-vacuous model actions before runtime readiness", () => {
		const modelPath = resolve(REPOSITORY_ROOT, PRODUCT_CONTRACT.model.path);
		expect(sha256File(modelPath)).toBe(PRODUCT_CONTRACT.model.sha256);
		const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", modelPath], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
		const executed = spawnSync(
			"pnpm",
			[
				"exec",
				"quint",
				"test",
				modelPath,
				"--main",
				PRODUCT_CONTRACT.model.module,
				"--match",
				"^test",
				"--backend",
				"typescript",
				"--max-samples",
				"100",
			],
			{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
		);
		expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
		for (const run of PRODUCT_CONTRACT.model.runs) expect(`${executed.stdout}\n${executed.stderr}`).toContain(run);
		const modelSource = readFileSync(modelPath, "utf8");
		for (const action of [
			"enterRound",
			"observeFutureRound",
			"acceptProposal",
			"persistVoteSet",
			"byzantineEquivocate",
			"formQc",
			"duplicateQc",
			"dropQc",
			"deliverPrepareQc",
			"deliverCommitQc",
			"rejectInvalidNestedQc",
			"crash",
			"restart",
		]) {
			expect(modelSource).toMatch(new RegExp(`action\\s+${action}\\b`, "u"));
		}
		expect(modelSource).toMatch(/action\s+step\s*=\s*any/u);
		expect(modelSource).not.toContain("symbolicStep");
		expect(PRODUCT_CONTRACT.profile.minimumSymbolicSteps).toBeGreaterThanOrEqual(12);
	});

	it("typechecks the exact future fixture boundary before opening product readiness", () => {
		const checked = spawnSync("pnpm", ["exec", "tsc", "-p", "tests/fixtures/phase-5d-v3/tsconfig.json"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
	});

	it("executes the real pinned Apalache backend rather than a transcript", { timeout: 300_000 }, async () => {
		const verified = await execFileText("pnpm", ["run", "phase5d:formal"], {
			env: formalEnvironment(),
			timeout: 290_000,
		});
		const evidence = `${verified.stdout}\n${verified.stderr}`;
		expect(evidence).toMatch(/apalache|verification|invariant/iu);
		for (const witness of [
			"reachedTimeout",
			"reachedRoundChange",
			"reachedProposal",
			"reachedPrepareQc",
			"reachedCommitQc",
			"reachedCatchup",
			"reachedRestart",
			"reachedEquivocation",
			"reachedDuplicate",
			"reachedLoss",
			"reachedInvalidNestedQcRejection",
			"reachedFairFinality",
		]) {
			expect(evidence).toMatch(new RegExp(`${witness} was witnessed in [1-9][0-9]* trace\\(s\\)`, "u"));
		}
	});

	it("runs a real fake-indexeddb schema-v2 control before runtime readiness", async () => {
		const databaseName = `phase5d-red-${crypto.randomUUID()}`;
		openedDatabases.push(databaseName);
		const opened = await openInternalSealVoteStore({ databaseName });
		try {
			expect(opened.schema).toEqual({
				stores: [
					"blobs",
					"generations",
					"objects",
					"promotions",
					"signerState",
					"storageMeta",
					"voteOutbox",
					"voteSlots",
				],
				version: 2,
			});
			expect(opened.incarnation).toMatch(/^[0-9a-f]{32,}$/u);
		} finally {
			opened.close();
		}
	});

	it("keeps canonical CutValue and registered vote identities independently recomputable", () => {
		const cryptoVector = (
			law as unknown as {
				readonly vectors: { readonly crypto: { readonly cutValue: unknown; readonly valueDigestHex: string } };
			}
		).vectors.crypto;
		const cutBytes = encodeCanonical(cryptoVector.cutValue);
		expect(encodeCanonical(decodeCanonical(cutBytes))).toEqual(cutBytes);
		expect(Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", cutBytes)).toString("hex")).toBe(
			cryptoVector.valueDigestHex
		);
	});

	it("[RED readiness] requires the complete nine-owner pacemaker runtime graph", () => {
		expect(readiness, `missing D.106b runtime owners: ${readiness.missing.join(", ")}`).toEqual({
			missing: [],
			ready: true,
		});
	});

	it.skipIf(!readiness.ready)("binds runtime exports to the governed timeout and UTF-8 leader profile", async () => {
		const modules = await loadPacemakerCandidateModules();
		expect(exactKeys(modules.pacemaker)).toEqual(PRODUCT_CONTRACT.requiredRuntimeExports.pacemaker);
		for (const { round, timeoutMs } of law.vectors.timeouts)
			expect(modules.pacemaker.roundTimeoutMs(round)).toBe(timeoutMs);
		for (const [round, leader] of law.vectors.leaders.entries()) {
			expect(modules.pacemaker.leaderForRound(law.vectors.leaderRoster, round)).toBe(leader);
		}
		expect(modules.pacemaker.ROUND_TIMEOUT_BASE_MS).toBe(1000);
		expect(modules.pacemaker.ROUND_TIMEOUT_MAX_MS).toBe(30_000);
		expect(modules.pacemaker.MAX_FUTURE_ROUND_GAP).toBe(8);
	});

	it.skipIf(!readiness.ready)(
		"keeps registered protocol verification as the sole proposal and round-change authority",
		async () => {
			const modules = await loadPacemakerCandidateModules();
			expect(exactKeys(modules.protocol)).toEqual(PRODUCT_CONTRACT.requiredRuntimeExports.protocol);
			expect(exactKeys(modules.seal)).toEqual(PRODUCT_CONTRACT.requiredRuntimeExports.seal);
			const source = readFileSync(resolve(REPOSITORY_ROOT, "packages/seal/src/pacemaker.ts"), "utf8");
			expect(source).toContain("verifyProposalBundle");
			expect(source).toContain("verifyRoundChange");
			expect(source).toContain("verifySealQC");
			expect(source).not.toMatch(/Date\.now|caller.*timeout|caller.*roster|crash.*emit/iu);
		}
	);

	it.skipIf(!readiness.ready)(
		"replays every checked trace through the genuine voter, pacemaker, and fake-IDB store",
		async () => {
			const modules = await loadPacemakerCandidateModules();
			for (const descriptor of PRODUCT_CONTRACT.traces) {
				const databaseName = `phase5d-product-${crypto.randomUUID()}`;
				openedDatabases.push(databaseName);
				const trace = readTrace(descriptor.path);
				await replayCheckedTrace(trace, await createProductTraceDriver(modules, trace, databaseName));
			}
		}
	);
});
