/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// The CREATOR dies by SIGKILL immediately AFTER a real SQLite COMMIT inside its
// own epoch close, at each committed boundary of the close. A separate recover
// fork reopens the SAME directory. The creator must recover to exactly one of:
// the sealed epoch adopted, or the epoch unsealed with its admitted work intact;
// either way the room continues, one more epoch seals and adopts, a fresh issue
// is accepted, and no record the creator had accepted is lost. No native write,
// signature, verifier or transaction is mocked.
//   close-scope-open: the close's own snapshot quarantine scope INSERT (before
//     any seal vote; the original scratch control's edge).
//   seal-<phase>: the seal actor's durable evidence record reaching <phase>
//     (packages/seal/src/creator.ts: close_evidence_committed ... successor_completed).
//   close-scope-retained: the close's snapshot scope reaching recovery retention.
//   close-head: the close's staged successor generation head in the AHE store
//     (sealEpoch then returns "successor-pending-adoption").
//   adoption-floor-pending / adoption-head / adoption-floor-stable: the
//     adoption's first external room-head floor commit, its AHE head commit, and
//     its second floor commit.
const INNER = process.env.RUN_CREATOR_CLOSE_CRASH === "1";
const SEAL_PHASES = [
	"evidence-committed",
	"prepare-voted",
	"prepared",
	"commit-voted",
	"commit-qc-committed",
	"finalized",
] as const;
const EDGES = [
	"close-scope-open",
	"close-scope-retained",
	...SEAL_PHASES.map((phase) => `seal-${phase}` as const),
	"close-head",
	"adoption-floor-pending",
	"adoption-head",
	"adoption-floor-stable",
] as const;
type Edge = (typeof EDGES)[number];
// Warm seals before the fatal close. Three: the fatal close at epoch 3 fills the
// four-scope recovery pool and its retry's capacity check meets the retained
// scope. Five (steady state): readiness maintenance retires the classified
// scope after every adoption, so the reopened creator's readiness turnover
// itself meets the interrupted close's retained scope.
const WARM_SEALS = Number(process.env.CREATOR_CLOSE_CRASH_WARM ?? 3);
const STEADY_EDGES = ["close-scope-retained", ...SEAL_PHASES.map((phase) => `seal-${phase}` as const)] as const;
// Offered: after reopen and BEFORE the interrupted close retries, the creator
// is offered its own new work and a member's append. Neither may enter the
// interrupted epoch's state: each is refused retryably or deferred, the retry
// completes on the exact same scope and incarnation, and the offered work is
// accepted once reissued after the retry.
const OFFERED = [
	["close-scope-open", 3],
	["close-scope-retained", 3],
	["seal-prepared", 3],
	["seal-finalized", 3],
	["close-scope-retained", 5],
	["seal-finalized", 5],
] as const;
const CASES = [
	...EDGES.map((edge) => [edge, 3, ""] as const),
	...STEADY_EDGES.map((edge) => [edge, 5, ""] as const),
	...OFFERED.map(([edge, warm]) => [edge, warm, " with work offered before the retry"] as const),
];
// A retryable refusal of a creator issue while its interrupted close is on disk.
const RETRYABLE_REFUSAL = /close-pending/;

type CloseScopeRow = { object_id: string; epoch: number; anchor: string; manifest_digest: string; incarnation: string };
/**
 * Every native snapshot scope row at `epoch` in the directory (identity and incarnation).
 * @param directory - The crash directory.
 * @param epoch - The interrupted close's epoch.
 * @returns The rows, ordered.
 */
const closeScopes = (directory: string, epoch: number): CloseScopeRow[] =>
	readdirSync(directory)
		.filter((name) => name.endsWith(".drp-snapshot-quarantine-v1.sqlite"))
		.sort()
		.flatMap((name) => {
			const database = new DatabaseSync(join(directory, name), { readOnly: true });
			try {
				return database
					.prepare(
						"SELECT object_id, epoch, anchor, manifest_digest, incarnation FROM snapshot_scopes_v2 WHERE epoch = ? ORDER BY object_id, anchor, manifest_digest"
					)
					.all(epoch) as CloseScopeRow[];
			} finally {
				database.close();
			}
		});

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({
		directory,
		members: ["genesis"],
		format: "window",
		localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }),
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;

const texts = (peer: Peer) => peer.room.projection().messages.map((entry) => entry.clientOperationId);

it.runIf(INNER)(
	"a creator survives process death inside its own epoch close",
	async () => {
		const directory = required(process.env.CREATOR_CLOSE_CRASH_DIRECTORY);
		const edge = required(process.env.CREATOR_CLOSE_CRASH_EDGE) as Edge;
		const mode = required(process.env.CREATOR_CLOSE_CRASH_MODE);
		const offer = process.env.CREATOR_CLOSE_CRASH_OFFER === "1";
		const reportFile = join(directory, "death.json"),
			setupFile = join(directory, "setup.json");
		const prepare = DatabaseSync.prototype.prepare,
			run = StatementSync.prototype.run,
			exec = DatabaseSync.prototype.exec;
		const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
		const written = new WeakSet<DatabaseSync>();
		// Armed only around the creator's fatal close (and its adoption): no other owner writes then.
		const armed = { value: false, stage: "", hits: 0 };
		const floorFile = "/peer-0-external-floor.sqlite";
		if (mode === "mutate") {
			DatabaseSync.prototype.prepare = function (sql: string) {
				const statement = prepare.call(this, sql);
				statements.set(statement, { database: this, sql });
				return statement;
			};
			StatementSync.prototype.run = function (...args: unknown[]) {
				const result = Reflect.apply(run, this, args) as ReturnType<typeof run>,
					source = statements.get(this);
				if (armed.value && source !== undefined) {
					if (
						edge === "close-scope-open" &&
						armed.stage === "seal" &&
						source.sql.startsWith("INSERT INTO snapshot_scopes_v2")
					)
						written.add(source.database);
					if (
						edge.startsWith("seal-") &&
						source.sql.startsWith("INSERT INTO signing_rows") &&
						args[0] === "sealEvidence" &&
						args[4] instanceof Uint8Array &&
						(decodeCanonical(args[4]) as { phase?: string }).phase === edge.slice("seal-".length)
					)
						written.add(source.database);
					if (
						edge === "close-scope-retained" &&
						armed.stage === "seal" &&
						source.sql.startsWith("UPDATE snapshot_scopes_v2 SET retention='recovery'")
					)
						written.add(source.database);
					const head = source.sql.startsWith("INSERT INTO objects(object_id, head_record) VALUES (?, ?)");
					if (
						(edge === "close-head" && armed.stage === "seal" && head) ||
						(edge === "adoption-head" && armed.stage === "adopt" && head)
					)
						written.add(source.database);
					if (
						edge.startsWith("adoption-floor") &&
						armed.stage === "adopt" &&
						source.database.location()?.endsWith(floorFile) === true
					)
						written.add(source.database);
				}
				return result;
			};
			DatabaseSync.prototype.exec = function (sql: string) {
				const result = exec.call(this, sql);
				if (sql === "ROLLBACK") {
					written.delete(this);
				}
				if (sql === "COMMIT" || sql.endsWith("COMMIT")) {
					const hit = written.has(this);
					written.delete(this);
					if (hit && ++armed.hits === (edge === "adoption-floor-stable" ? 2 : 1)) {
						writeFileSync(
							reportFile,
							JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL", stage: armed.stage, file: this.location() })
						);
						process.kill(process.pid, "SIGKILL");
						throw Error("SIGKILL_DID_NOT_TERMINATE");
					}
				}
				return result;
			};
		}
		// Delivers every member row above `after` to the creator; returns the last delivered sequence.
		const deliver = async (f: Fixture, creator: Peer, after: number | null) => {
			const rows = await f.issuedAfter(1, after);
			if (rows.length === 0) return after;
			expect(await creator.receive(rows, 1)).toBe(true);
			return required(rows.at(-1)).commit.authorSequence;
		};
		try {
			if (mode === "mutate") {
				const f = await fixture(directory);
				const creator = await f.open(0),
					member = await f.open(1);
				const accepted: string[] = [];
				let delivered: number | null = null;
				for (let seal = 0; seal < WARM_SEALS; seal++) {
					await creator.room.issue(message(`creator-${seal}`));
					accepted.push(`creator-${seal}`);
					await member.room.issue(message(`member-${seal}`));
					delivered = await deliver(f, creator, delivered);
					accepted.push(`member-${seal}`);
					expect((await creator.room.sealEpoch()).ok).toBe(true);
					await creator.room.adoptCreatorSuccessor();
					await f.install(member);
				}
				// Work admitted into the epoch the creator dies closing.
				await creator.room.issue(message("creator-fatal"));
				accepted.push("creator-fatal");
				await member.room.issue(message("member-fatal"));
				delivered = await deliver(f, creator, delivered);
				accepted.push("member-fatal");
				expect(texts(creator)).toEqual(expect.arrayContaining(accepted));
				const epochBefore = required(creator.room.authority()).epoch;
				writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors, accepted, delivered, epochBefore }));
				armed.value = true;
				armed.stage = "seal";
				const sealed = await creator.room.sealEpoch();
				expect(sealed.ok).toBe(true);
				armed.stage = "adopt";
				await creator.room.adoptCreatorSuccessor();
				armed.value = false;
				throw Error(`NATIVE_COMMITTED_EDGE_NOT_REACHED:${edge}`);
			}
			const death = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
			const setup = JSON.parse(readFileSync(setupFile, "utf8")) as {
				selectors: Record<number, { slot: number; incarnation: number }>;
				accepted: string[];
				delivered: number | null;
				epochBefore: number;
			};
			// The interrupted close's own scope as the death left it (read before any reopen).
			const scopesAtDeath = closeScopes(directory, setup.epochBefore);
			const f = await fixture(directory, setup.selectors);
			const creator = await f.open(0, { reopen: true }),
				member = await f.open(1, { reopen: true, promote: true });
			const reopenedEpoch = required(creator.room.authority()).epoch;
			// Exactly one of: the dead close's epoch adopted, or not sealed.
			expect([setup.epochBefore, setup.epochBefore + 1]).toContain(reopenedEpoch);
			// Nothing the creator accepted is lost across the death.
			expect(texts(creator)).toEqual(expect.arrayContaining(setup.accepted));
			const epochs: number[] = [];
			const offered: string[] = [];
			let offeredOutcome: Record<string, unknown> | undefined;
			if (offer) {
				expect(reopenedEpoch).toBe(setup.epochBefore);
				expect(scopesAtDeath).toHaveLength(1);
				// The creator's own new work, before the interrupted close retries.
				let creatorSettled: { accepted: true } | { accepted: false; reason: string } | undefined;
				const creatorIssue = creator.room.issue(message("creator-offered")).then(
					() => {
						creatorSettled = { accepted: true };
					},
					(error: unknown) => {
						creatorSettled = { accepted: false, reason: String(error) };
					}
				);
				await Promise.race([creatorIssue, new Promise((resolve) => setTimeout(resolve, 30_000))]);
				const creatorRefused = creatorSettled?.accepted === false ? creatorSettled.reason : undefined;
				// Never admitted into the interrupted epoch: refused retryably, or still deferred.
				expect(creatorSettled?.accepted, "the creator admitted work into the interrupted epoch").not.toBe(true);
				if (creatorRefused !== undefined) expect(creatorRefused).toMatch(RETRYABLE_REFUSAL);
				// A member's append, offered to the creator before the retry.
				await member.room.issue(message("member-offered"));
				const memberRows = await f.issuedAfter(1, setup.delivered);
				expect(memberRows).toHaveLength(1);
				const receivedBeforeRetry = await creator.receive(memberRows, 1, 30_000);
				expect(receivedBeforeRetry, "the creator admitted a member append into the interrupted epoch").toBe(false);
				expect(texts(creator)).not.toContain("creator-offered");
				expect(texts(creator)).not.toContain("member-offered");
				// The retry runs on the exact scope and incarnation the death left.
				const retried = await creator.room.sealEpoch();
				expect(retried.ok, JSON.stringify(retried)).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				await f.install(member);
				epochs.push(required(creator.room.authority()).epoch);
				expect(closeScopes(directory, setup.epochBefore)).toEqual(scopesAtDeath);
				// The offered work is accepted once reissued (or once its deferral completes).
				if (creatorRefused === undefined) {
					await creatorIssue;
					expect(creatorSettled).toEqual({ accepted: true });
				} else await creator.room.issue(message("creator-offered"));
				// The member's offered row was signed in the interrupted epoch; its
				// install of the adopted successor carries that unsettled work forward.
				setup.delivered = await deliver(f, creator, setup.delivered);
				expect(texts(creator)).toContain("member-offered");
				offered.push("creator-offered", "member-offered");
				offeredOutcome = { creatorRefused: creatorRefused ?? "deferred", receivedBeforeRetry, scopesAtDeath };
			}
			for (let seal = epochs.length; seal < 2; seal++) {
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				await f.install(member);
				epochs.push(required(creator.room.authority()).epoch);
			}
			expect(required(epochs[0])).toBe(reopenedEpoch + 1);
			// A fresh issue is accepted by the creator (its own and a member's).
			await creator.room.issue(message("creator-after"));
			await member.room.issue(message("member-after"));
			await deliver(f, creator, setup.delivered);
			const all = [...setup.accepted, ...offered, "creator-after", "member-after"];
			expect(texts(creator)).toEqual(expect.arrayContaining(all));
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await f.install(member);
			expect(texts(creator)).toEqual(expect.arrayContaining(all));
			expect(texts(member)).toEqual(expect.arrayContaining(all));
			writeFileSync(
				join(directory, "recovered.json"),
				JSON.stringify({
					edge,
					death,
					offer,
					...(offeredOutcome === undefined ? {} : { offeredOutcome }),
					epochBefore: setup.epochBefore,
					reopenedEpoch,
					epochs,
					finalEpoch: required(creator.room.authority()).epoch,
				})
			);
		} finally {
			DatabaseSync.prototype.prepare = prepare;
			StatementSync.prototype.run = run;
			DatabaseSync.prototype.exec = exec;
			expect(await closeChatSharesRooms()).toEqual([]);
		}
	},
	600_000
);

it.skipIf(INNER).each(CASES)(
	"SIGKILL right after the creator's %s commit (after %i warm seals)%s recovers and the room continues",
	async (edge, warm, offered) => {
		const directory = mkdtempSync(
			join(tmpdir(), `creator-close-crash-${edge}-w${warm}${offered === "" ? "" : "-offer"}-`)
		);
		const file = fileURLToPath(import.meta.url);
		const fork = (mode: "mutate" | "recover") =>
			new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				// Asynchronous child: a synchronous spawn starves this worker's RPC for minutes.
				const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
					cwd: join(fileURLToPath(new URL(".", import.meta.url)), ".."),
					timeout: 900_000,
					env: {
						...process.env,
						RUN_CREATOR_CLOSE_CRASH: "1",
						CREATOR_CLOSE_CRASH_DIRECTORY: directory,
						CREATOR_CLOSE_CRASH_EDGE: edge,
						CREATOR_CLOSE_CRASH_WARM: String(warm),
						CREATOR_CLOSE_CRASH_OFFER: offered === "" ? "0" : "1",
						CREATOR_CLOSE_CRASH_MODE: mode,
					},
				});
				let stdout = "",
					stderr = "";
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += String(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += String(chunk);
				});
				child.on("error", reject);
				child.on("close", (status) => resolve({ status, stdout, stderr }));
			});
		const keep = process.env.CREATOR_CLOSE_CRASH_KEEP === "1";
		try {
			const mutate = await fork("mutate");
			expect(existsSync(join(directory, "death.json")), mutate.stdout + mutate.stderr).toBe(true);
			const death = JSON.parse(readFileSync(join(directory, "death.json"), "utf8")) as { signal: string; edge: string };
			expect(death).toMatchObject({ signal: "SIGKILL", edge });
			expect(mutate.status, "the mutate fork died; vitest reports the lost worker").not.toBe(0);
			const recover = await fork("recover");
			if (keep) writeFileSync(join(directory, "recover.log"), recover.stdout + recover.stderr);
			expect(recover.status, recover.stdout + recover.stderr).toBe(0);
			const recovered = JSON.parse(readFileSync(join(directory, "recovered.json"), "utf8")) as Record<string, unknown>;
			expect(recovered).toMatchObject({ edge });
			console.info(`CREATOR_CLOSE_CRASH ${JSON.stringify(recovered)}`);
		} finally {
			if (keep) console.info(`CREATOR_CLOSE_CRASH_DIRECTORY ${edge} ${directory}`);
			else rmSync(directory, { recursive: true, force: true });
		}
	},
	1_900_000
);
