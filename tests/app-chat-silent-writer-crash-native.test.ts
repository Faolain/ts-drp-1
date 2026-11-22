/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// A silent Chat Writer (its network publishes nowhere) sends a message in every epoch. The process
// dies (SIGKILL) right after the real SQLite COMMIT of an issuance retirement control write whose
// active preparation retires rows of this Writer that the completed one still protected: the
// retirement that drops their completed settlement entries from the plan rewrite. Both peers then
// reopen over the same stores and the Writer follows the creator's successors; every install must
// succeed. Before the custody fix the first reopened install refused "creator recovery dependency hold
// unavailable:outbox-classification:2:displaced:published": the rewrite had dropped the completed
// entry of a retired row the store still held, so the recovery census found a displaced published
// row with no completion entry. No native write, signature or transaction is mocked.
const INNER = process.env.RUN_CHAT_SILENT_CRASH === "1";
const AFTER = 6;
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
type Hole = { author: string; authorSequence: number };
type Preparation = { throughEpoch: number; protectedRecords: Hole[] };
type Control = { kind?: string; completed: Preparation | null; active: { preparation: Preparation } | null };

const directories: string[] = [];
afterEach(() => {
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.runIf(INNER)(
	"a silent Chat Writer dies right after a retirement control commit",
	async () => {
		const directory = required(process.env.CHAT_SILENT_CRASH_DIRECTORY);
		const deathFile = join(directory, "death.json"),
			setupFile = join(directory, "setup.json");
		const prepare = DatabaseSync.prototype.prepare,
			run = StatementSync.prototype.run,
			exec = DatabaseSync.prototype.exec;
		const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
		const written = new WeakMap<DatabaseSync, unknown>();
		const watch = { armed: false, author: "", seal: -1 };
		DatabaseSync.prototype.prepare = function (sql: string) {
			const statement = prepare.call(this, sql);
			statements.set(statement, { database: this, sql });
			return statement;
		};
		StatementSync.prototype.run = function (...args: unknown[]) {
			const result = Reflect.apply(run, this, args) as ReturnType<typeof run>,
				source = statements.get(this);
			if (
				watch.armed &&
				source?.sql === "UPDATE retirement_controls SET record=? WHERE object_id=?" &&
				args[0] instanceof Uint8Array
			) {
				const control = decodeCanonical(args[0]) as Control;
				const mine = (control.active?.preparation.protectedRecords ?? [])
					.filter((hole) => hole.author === watch.author)
					.map((hole) => hole.authorSequence);
				const completedMine = (control.completed?.protectedRecords ?? [])
					.filter((hole) => hole.author === watch.author)
					.map((hole) => hole.authorSequence);
				if (
					control.kind === "v3-issuance-retirement-control-1" &&
					control.active !== null &&
					control.completed !== null &&
					mine.length > 0 &&
					completedMine.some((sequence) => !mine.includes(sequence))
				)
					written.set(source.database, {
						through: control.active.preparation.throughEpoch,
						mine,
						completedMine,
						completedThrough: control.completed.throughEpoch,
					});
			}
			return result;
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
			if (sql === "ROLLBACK") written.delete(this);
			if (sql === "COMMIT" && written.has(this)) {
				writeFileSync(deathFile, JSON.stringify({ pid: process.pid, signal: "SIGKILL", seal: watch.seal, detail: written.get(this) }));
				process.kill(process.pid, "SIGKILL");
				throw Error("SIGKILL_DID_NOT_TERMINATE");
			}
			return result;
		};
		try {
			const f = await fixture(directory);
			const creator = await f.open(0),
				member = await f.open(1);
			watch.author = required(f.identities[1]).author;
			await member.room.issue(message("writer-0")).catch(() => undefined);
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await f.install(member);
			writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors }));
			watch.armed = true;
			for (let seal = 0; seal < 8; seal++) {
				watch.seal = seal;
				await member.room.issue(message(`writer-${seal + 1}`)).catch(() => undefined);
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				await f.install(member);
			}
			throw Error("CHAT_SILENT_CRASH_EDGE_NOT_REACHED");
		} finally {
			DatabaseSync.prototype.prepare = prepare;
			StatementSync.prototype.run = run;
			DatabaseSync.prototype.exec = exec;
			expect(await closeChatSharesRooms()).toEqual([]);
		}
	},
	600_000
);

it.skipIf(INNER)(
	"SIGKILL right after a silent Chat Writer's retirement commit: every reopened install succeeds",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-chat-silent-crash-"));
		directories.push(directory);
		const child = spawn(
			"npx",
			["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
			{
				env: { ...process.env, RUN_CHAT_SILENT_CRASH: "1", CHAT_SILENT_CRASH_DIRECTORY: directory },
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile)) throw new Error(`the Writer did not die:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Record<string, unknown>;
		const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as {
			selectors: Record<number, { slot: number; incarnation: number }>;
		};
		expect(death).toMatchObject({ signal: "SIGKILL" });
		try {
			const f = await fixture(directory, setup.selectors);
			const creator = await f.open(0, { reopen: true }),
				member = await f.open(1, { reopen: true, promote: true });
			Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(true));
			const installed: number[] = [];
			let refused: unknown;
			for (let seal = 0; seal < AFTER && refused === undefined; seal++) {
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				try {
					await f.install(member);
					installed.push(seal + 1);
				} catch (error) {
					refused = error;
				}
			}
			const causes: string[] = [];
			for (let value: unknown = refused; value instanceof Error && causes.length < 10; value = value.cause)
				causes.push(String(value.message));
			process.stdout.write(`CHAT_SILENT_CRASH ${JSON.stringify({ death, installed, causes })}\n`);
			expect(causes).toEqual([]);
			expect(installed).toEqual(Array.from({ length: AFTER }, (_, index) => index + 1));
		} finally {
			expect(await closeChatSharesRooms()).toEqual([]);
		}
	},
	1_200_000
);
