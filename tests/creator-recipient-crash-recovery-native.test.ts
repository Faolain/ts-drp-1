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

// A recipient (owned local member, revoked Writer with one never-acknowledged
// source) dies by SIGKILL immediately AFTER a real SQLite COMMIT inside its
// own successor install, while the creator keeps sealing. A separate recover
// fork reopens the SAME directory; the member then installs a successor two
// epochs ahead (a checkpoint past the epoch it died in) and keeps installing.
// No native write, signature, verifier or transaction is mocked.
//   received-scope-open: the receive's predecessor quarantine scope INSERT
//     (the scope stays temporary and is never retained by the dead install).
//   issuance-through-3:  the removed author's first issuance retirement
//     preparation through epoch 3 (control: no quarantine is open at death).
const INNER = process.env.RUN_RECIPIENT_CRASH === "1";
const EDGES = ["received-scope-open", "issuance-through-3"] as const;
type Edge = (typeof EDGES)[number];

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

function memberSnapshotFile(directory: string): string {
	const found = readdirSync(join(directory, "local-sessions")).filter((name) =>
		name.endsWith(".drp-snapshot-quarantine-v1.sqlite")
	);
	return join(directory, "local-sessions", required(found.length === 1 ? found[0] : undefined));
}

/**
 * Read-only native evidence of the member's snapshot quarantine.
 * @param directory - The crash directory holding the member's local sessions.
 * @returns Every durable scope epoch and its retention.
 */
function quarantine(directory: string) {
	const database = new DatabaseSync(memberSnapshotFile(directory), { readOnly: true });
	try {
		return database
			.prepare("SELECT epoch, retention FROM snapshot_scopes_v2 ORDER BY epoch")
			.all()
			.map((row) => ({ epoch: Number(row.epoch), retention: String(row.retention) }));
	} finally {
		database.close();
	}
}

const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({
		directory,
		members: ["genesis"],
		format: "window",
		localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }),
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});

it.runIf(INNER)(
	"a recipient survives process death inside its successor install",
	async () => {
		const directory = required(process.env.RECIPIENT_CRASH_DIRECTORY);
		const edge = required(process.env.RECIPIENT_CRASH_EDGE) as Edge;
		const mode = required(process.env.RECIPIENT_CRASH_MODE);
		const reportFile = join(directory, "death.json"),
			setupFile = join(directory, "setup.json");
		const prepare = DatabaseSync.prototype.prepare,
			run = StatementSync.prototype.run,
			exec = DatabaseSync.prototype.exec;
		const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
		const written = new WeakSet<DatabaseSync>();
		// The scope edge is armed only around the member's own install (the creator's close opens scopes too).
		const armed = { value: false, author: "", seal: -1 };
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
						edge === "received-scope-open" &&
						armed.seal >= 1 &&
						source.sql.startsWith("INSERT INTO snapshot_scopes_v2")
					)
						written.add(source.database);
					if (
						edge === "issuance-through-3" &&
						source.sql === "UPDATE retirement_controls SET record=? WHERE object_id=?" &&
						args[0] instanceof Uint8Array
					) {
						const control = decodeCanonical(args[0]) as {
							kind?: string;
							active: { preparation: { throughEpoch: number; protectedRecords: { author: string }[] } } | null;
						};
						if (
							control.kind === "v3-issuance-retirement-control-1" &&
							control.active?.preparation.throughEpoch === 3 &&
							control.active.preparation.protectedRecords.some((hole) => hole.author === armed.author)
						)
							written.add(source.database);
					}
				}
				return result;
			};
			DatabaseSync.prototype.exec = function (sql: string) {
				const result = exec.call(this, sql);
				if (sql === "ROLLBACK") written.delete(this);
				if (sql === "COMMIT" && written.has(this)) {
					writeFileSync(
						reportFile,
						JSON.stringify({
							edge,
							pid: process.pid,
							signal: "SIGKILL",
							seal: armed.seal,
							quarantine: quarantine(directory),
						})
					);
					process.kill(process.pid, "SIGKILL");
					throw Error("SIGKILL_DID_NOT_TERMINATE");
				}
				return result;
			};
		}
		try {
			if (mode === "mutate") {
				const f = await fixture(directory);
				const creator = await f.open(0),
					member = await f.open(1);
				Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never acknowledged.
				await member.room.issue(message("before-removal")).catch(() => undefined);
				armed.author = required(f.identities[1]).author;
				await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: armed.author });
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				await f.install(member);
				writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors }));
				for (let seal = 0; seal < 6; seal++) {
					armed.seal = seal;
					armed.value = edge === "issuance-through-3";
					expect((await creator.room.sealEpoch()).ok).toBe(true);
					await creator.room.adoptCreatorSuccessor();
					armed.value = true;
					await f.install(member);
				}
				throw Error(`NATIVE_COMMITTED_EDGE_NOT_REACHED:${edge}`);
			}
			const death = JSON.parse(readFileSync(reportFile, "utf8")) as {
				quarantine: { epoch: number; retention: string }[];
			};
			const setup = JSON.parse(readFileSync(setupFile, "utf8")) as {
				selectors: Record<number, { slot: number; incarnation: number }>;
			};
			const orphaned = death.quarantine.filter((scope) => scope.retention === "temporary").map((scope) => scope.epoch);
			// The committed boundary: only the received-scope edge leaves an unretained quarantine.
			if (edge === "received-scope-open") expect(orphaned).toHaveLength(1);
			else expect(orphaned).toEqual([]);
			const f = await fixture(directory, setup.selectors);
			const creator = await f.open(0, { reopen: true }),
				member = await f.open(1, { reopen: true, promote: true });
			// Every later install succeeds: the first is a checkpoint past the dead install's epoch;
			// the recovery pool then fills and the received turnover runs on every install.
			for (let seal = 0; seal < 5; seal++) {
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				await f.install(member);
			}
			const after = quarantine(directory);
			// No quarantine scope is left below the member's recovery pool by the dead receive.
			for (const epoch of orphaned)
				expect(after.some((scope) => scope.epoch === epoch && scope.retention === "temporary")).toBe(false);
			await expect(member.room.issue(message("still-not-a-writer"))).rejects.toThrow();
			writeFileSync(join(directory, "recovered.json"), JSON.stringify({ edge, death, after }));
		} finally {
			DatabaseSync.prototype.prepare = prepare;
			StatementSync.prototype.run = run;
			DatabaseSync.prototype.exec = exec;
			expect(await closeChatSharesRooms()).toEqual([]);
		}
	},
	600_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL right after the recipient's %s commit recovers through a checkpoint",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), `recipient-crash-${edge}-`));
		const file = fileURLToPath(import.meta.url);
		const fork = (mode: "mutate" | "recover") =>
			new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				// Asynchronous child: a synchronous spawn starves this worker's RPC for minutes.
				const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
					cwd: join(fileURLToPath(new URL(".", import.meta.url)), ".."),
					timeout: 900_000,
					env: {
						...process.env,
						RUN_RECIPIENT_CRASH: "1",
						RECIPIENT_CRASH_DIRECTORY: directory,
						RECIPIENT_CRASH_EDGE: edge,
						RECIPIENT_CRASH_MODE: mode,
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
		try {
			const mutate = await fork("mutate");
			expect(existsSync(join(directory, "death.json")), mutate.stdout + mutate.stderr).toBe(true);
			const death = JSON.parse(readFileSync(join(directory, "death.json"), "utf8")) as { signal: string; edge: string };
			expect(death).toMatchObject({ signal: "SIGKILL", edge });
			expect(mutate.status, "the mutate fork died; vitest reports the lost worker").not.toBe(0);
			const recover = await fork("recover");
			expect(recover.status, recover.stdout + recover.stderr).toBe(0);
			const recovered = JSON.parse(readFileSync(join(directory, "recovered.json"), "utf8")) as Record<string, unknown>;
			expect(recovered).toMatchObject({ edge });
			console.info(`RECIPIENT_CRASH ${JSON.stringify(recovered)}`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	1_900_000
);
