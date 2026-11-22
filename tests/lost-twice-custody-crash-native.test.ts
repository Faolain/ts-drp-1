/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// G28 for lost-twice custody (fix/lost-twice-replacement-dependency): the mutate fork dies by SIGKILL
// immediately AFTER the real SQLite COMMIT of the plan write in which a completed replacement entry
// first gains its displaced source's context at a close where its replacement was not committed:
// - "custody-m1": m1's entry (m1 lost in epoch 0, its replay r1 lost in epoch 1; the close of epoch 1);
// - "custody-r1": r1's entry (r2 lost in epoch 2 as well; the close of epoch 2).
// A separate recover fork reopens the SAME directory, keeps installing, delivers the move's newest link
// and settles: the custody is exactly what the dead process committed and the move lands exactly once
// (creator and member). No native write, signature, verifier or transaction is mocked.
const INNER = process.env.RUN_LOST_TWICE_CRASH === "1";
const EDGES = ["custody-m1", "custody-r1"] as const;
type Edge = (typeof EDGES)[number];
const MOVE = "lost-twice-crash-move";

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const PLAN_LIMITS = { maxBytes: 4_194_304, maxDepth: 32, maxItems: 65_536 };

type Plan = { entries: { sourceSequence: number; disposition: string; replacementSequence: number | null;
	sourceContextDigest?: Uint8Array }[] };
function decodePlan(text: string): Plan {
	const value = JSON.parse(text) as unknown;
	if (!Array.isArray(value)) return decodeCanonical(Buffer.from((value as { bytes: string }).bytes, "base64"), PLAN_LIMITS) as Plan;
	return { entries: (value as Plan["entries"]) };
}
const hex = (bytes: Uint8Array | undefined) => bytes === undefined ? undefined : Buffer.from(bytes).toString("hex");

function issuanceFile(directory: string): string {
	const found: string[] = [];
	const walk = (path: string): void => { for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) walk(child); else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) found.push(child);
	} };
	walk(join(directory, "local-sessions"));
	return required(found.length === 1 ? found[0] : undefined);
}

function nativePlan(directory: string) {
	const issuance = new DatabaseSync(issuanceFile(directory), { readOnly: true });
	try {
		const row = issuance.prepare("SELECT revision, entries_json FROM settlement_plans").get();
		if (row === undefined) return null;
		const plan = decodePlan(String(row.entries_json));
		return { revision: row.revision as number, entries: plan.entries.map(entry => ({ sequence: entry.sourceSequence,
			disposition: entry.disposition, replacement: entry.replacementSequence, context: hex(entry.sourceContextDigest) ?? null })) };
	} finally { issuance.close(); }
}

const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const count = (peer: Peer, text: string) =>
	peer.room.projection().messages.filter((entry) => entry.clientOperationId === text).length;
async function roll(f: Fixture, creator: Peer, member: Peer) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
}
/** The move's links (root first) as the member's issued rows: sequence and signing epoch. */
async function links(f: Fixture) {
	return (await f.issuedAfter(1, null)).map(row => {
		const value = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as
			{ epoch: number; operation: { clientOperationId?: unknown } };
		return { sequence: row.commit.authorSequence, epoch: value.epoch, id: value.operation.clientOperationId, row };
	}).filter(link => link.id === MOVE);
}

it.runIf(INNER)("lost-twice custody survives process death at its real committed boundary", async () => {
	const directory = required(process.env.LOST_TWICE_CRASH_DIRECTORY);
	const edge = required(process.env.LOST_TWICE_CRASH_EDGE) as Edge;
	const mode = required(process.env.LOST_TWICE_CRASH_MODE);
	const reportFile = join(directory, "death.json"), setupFile = join(directory, "setup.json");
	const prepare = DatabaseSync.prototype.prepare, run = StatementSync.prototype.run, exec = DatabaseSync.prototype.exec;
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
	const written = new WeakSet<DatabaseSync>();
	const armed = { value: false, sequence: -1, issuance: "" };
	const location = (database: DatabaseSync) => {
		const path = (database as DatabaseSync & { location(): string | null }).location(); // Node >= 22.16.
		return path === null ? null : realpathSync(path);
	};
	if (mode === "mutate") {
		DatabaseSync.prototype.prepare = function (sql: string) {
			const statement = prepare.call(this, sql);
			statements.set(statement, { database: this, sql });
			return statement;
		};
		StatementSync.prototype.run = function (...args: any[]) {
			const result = Reflect.apply(run, this, args) as ReturnType<typeof run>, source = statements.get(this);
			if (armed.value && source !== undefined && /^(UPDATE|INSERT INTO) settlement_plans/u.test(source.sql) &&
				location(source.database) === armed.issuance) {
				const text = args.find((arg): arg is string => typeof arg === "string" && (arg.startsWith("{") || arg.startsWith("[")));
				const plan = text === undefined ? undefined : decodePlan(text);
				if (plan?.entries.some(entry => entry.sourceSequence === armed.sequence && entry.replacementSequence !== null &&
					entry.sourceContextDigest !== undefined)) written.add(source.database);
			}
			return result;
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
			if (sql === "ROLLBACK") written.delete(this);
			if (sql === "COMMIT" && written.has(this)) {
				writeFileSync(reportFile, JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL", native: nativePlan(directory) }));
				process.kill(process.pid, "SIGKILL");
				throw Error("SIGKILL_DID_NOT_TERMINATE");
			}
			return result;
		};
	}
	try {
		if (mode === "mutate") {
			const f = await fixture(directory);
			const creator = await f.open(0), member = await f.open(1);
			// Rows reach the creator only when delivered; m1 is accepted and never published at all.
			const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
			Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
			await member.room.issue(message(MOVE)).catch(() => undefined);
			Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
			await roll(f, creator, member); // r1 signed in epoch 1; m1's entry completed, no context yet.
			if (edge === "custody-r1") await roll(f, creator, member); // r2 signed in epoch 2.
			const chain = await links(f);
			const target = required(chain[edge === "custody-m1" ? 0 : 1]);
			expect(nativePlan(directory)?.entries.find(entry => entry.sequence === target.sequence))
				.toMatchObject({ disposition: "rebase", context: null });
			const lineage = await f.withIssuance(1, store => store.readLineage({ objectId: f.objectId, author: required(f.identities[1]).author }));
			armed.issuance = realpathSync(issuanceFile(directory));
			armed.sequence = target.sequence;
			writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors, lineage, target: target.sequence,
				links: chain.map(link => link.sequence) }));
			armed.value = true;
			for (let seal = 0; seal < 2; seal++) await roll(f, creator, member);
			throw Error(`NATIVE_COMMITTED_EDGE_NOT_REACHED:${edge}`);
		}
		const before = JSON.parse(readFileSync(reportFile, "utf8")) as { native: ReturnType<typeof nativePlan> };
		const setup = JSON.parse(readFileSync(setupFile, "utf8")) as { selectors: Record<number, { slot: number; incarnation: number }>;
			target: number; links: number[] };
		// The committed boundary is exactly the write the edge names.
		expect(before.native?.entries.find(entry => entry.sequence === setup.target)).toMatchObject({ disposition: "rebase",
			context: expect.stringMatching(/^[0-9a-f]{64}$/u) });
		const f = await fixture(directory, setup.selectors);
		const creator = await f.open(0, { reopen: true }), member = await f.open(1, { reopen: true, promote: true });
		// The dead install resumes on the next roll (possibly a non-adjacent install, whose replacement the
		// drain issues later): roll until the move's newest link is signed in the member's epoch, deliver
		// it inside that epoch, then settle.
		// If the move waited past the settlement window it is handed back instead (never replaced again):
		// the application offers it again with its hand-back key, exactly once.
		let delivered = false, handedBack = false;
		for (let attempt = 0; attempt < 4 && !delivered; attempt++) {
			await roll(f, creator, member);
			const epoch = member.room.authority().epoch;
			if (!handedBack) {
				const given = member.room.settlementStatus?.().undelivered.find(record =>
					record.operations[0]?.clientOperationId === MOVE);
				if (given !== undefined) { await member.room.issue(required(given.operations[0]) as never, { handBack: given.handBack }); handedBack = true; }
			}
			const newest = required((await links(f)).at(-1));
			// The epoch's rows in order (its author fence, then the link): the link depends on the fence.
			if (newest.epoch === epoch) delivered = await creator.receive((await f.issuedAfter(1, null)).filter(row =>
				(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { epoch: number }).epoch === epoch), 1, 30_000);
		}
		if (!delivered) console.info(`LOST_TWICE_CRASH_UNDELIVERED ${JSON.stringify({ epoch: member.room.authority().epoch,
			links: (await links(f)).map(link => ({ sequence: link.sequence, epoch: link.epoch })), plan: nativePlan(directory),
			unresolved: (await member.room.unresolvedAcceptedWork()).map(work => ({ sourceSequence: work.sourceSequence,
				disposition: work.disposition, commitment: work.commitment })) })}`);
		expect(delivered).toBe(true);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member);
		const after = nativePlan(directory);
		// Written once and kept: the same custody the dead process committed.
		for (const entry of before.native?.entries.filter(value => value.context !== null) ?? [])
			expect(after?.entries.find(value => value.sequence === entry.sequence)?.context ?? entry.context).toBe(entry.context);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		writeFileSync(join(directory, "recovered.json"), JSON.stringify({ edge, handedBack, before: before.native, after, epoch: member.room.authority().epoch,
			links: (await links(f)).map(link => ({ sequence: link.sequence, epoch: link.epoch })) }));
	} finally {
		DatabaseSync.prototype.prepare = prepare;
		StatementSync.prototype.run = run;
		DatabaseSync.prototype.exec = exec;
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 300_000);

it.skipIf(INNER).each(EDGES)("SIGKILL right after the %s commit recovers and the move lands once", async (edge) => {
	const directory = mkdtempSync(join(tmpdir(), `lost-twice-crash-${edge}-`));
	const file = fileURLToPath(import.meta.url);
	const fork = (mode: "mutate" | "recover") => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		// Asynchronous child: a synchronous spawn starves this worker's RPC for minutes.
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			cwd: join(fileURLToPath(new URL(".", import.meta.url)), ".."), timeout: 600_000,
			env: { ...process.env, RUN_LOST_TWICE_CRASH: "1", LOST_TWICE_CRASH_DIRECTORY: directory,
				LOST_TWICE_CRASH_EDGE: edge, LOST_TWICE_CRASH_MODE: mode } });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", status => resolve({ status, stdout, stderr }));
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
		console.info(`LOST_TWICE_CRASH ${JSON.stringify(recovered)}`);
	} finally { rmSync(directory, { recursive: true, force: true }); }
}, 1_300_000);
