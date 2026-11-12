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

// G28 for the removed author's settlement plan (fix/removed-author-replaced-source-classification): the
// mutate fork dies by SIGKILL immediately AFTER a real SQLite COMMIT returns, at
// - "frontier-persist": the plan write that first stores the last-member frontier (removing close);
// - "custody-write": the plan write in which a completed replacement entry first gains its displaced
//   source's context (removing close, the replayed-move shape);
// - "post-removal-install": the first commit of another store after the frontier is stored, inside the
//   first install after the removal.
// A separate recover fork reopens the SAME directory and keeps installing; the stored frontier and the
// custody are exactly what the dead process committed, and the move stays applied exactly once.
// No native write, signature, verifier or transaction is mocked.
const INNER = process.env.RUN_MEMBER_FRONTIER_CRASH === "1";
const EDGES = ["frontier-persist", "custody-write", "post-removal-install"] as const;
type Edge = (typeof EDGES)[number];
const MOVE = "frontier-crash-move";

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const PLAN_LIMITS = { maxBytes: 4_194_304, maxDepth: 32, maxItems: 65_536 };

type Plan = { memberFrontier?: { digest: Uint8Array }; entries: { sourceSequence: number; disposition: string;
	replacementSequence: number | null; sourceContextDigest?: Uint8Array }[] };
/** Both native carriers: the canonical whole-plan record, or the legacy entries JSON (no frontier, no contexts). */
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

/** Read-only native evidence of the local member's plan. */
function nativePlan(directory: string) {
	const issuance = new DatabaseSync(issuanceFile(directory), { readOnly: true });
	try {
		const row = issuance.prepare("SELECT revision, entries_json FROM settlement_plans").get();
		if (row === undefined) return null;
		const plan = decodePlan(String(row.entries_json));
		return { revision: row.revision as number, memberFrontier: hex(plan.memberFrontier?.digest) ?? null,
			entries: plan.entries.map(entry => ({ sequence: entry.sourceSequence, disposition: entry.disposition,
				replacement: entry.replacementSequence, context: hex(entry.sourceContextDigest) ?? null })) };
	} finally { issuance.close(); }
}

const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const count = (peer: Peer, text: string) =>
	peer.room.projection().messages.filter((entry) => entry.clientOperationId === text).length;
const revoke = (f: Fixture, creator: Peer) =>
	creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });
async function roll(f: Fixture, creator: Peer, member: Peer) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
}

it.runIf(INNER)("the removed author's plan survives process death at its real committed boundary", async () => {
	const directory = required(process.env.MEMBER_FRONTIER_CRASH_DIRECTORY);
	const edge = required(process.env.MEMBER_FRONTIER_CRASH_EDGE) as Edge;
	const mode = required(process.env.MEMBER_FRONTIER_CRASH_MODE);
	const reportFile = join(directory, "death.json"), setupFile = join(directory, "setup.json");
	const prepare = DatabaseSync.prototype.prepare, run = StatementSync.prototype.run, exec = DatabaseSync.prototype.exec;
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
	const written = new WeakSet<DatabaseSync>();
	const armed = { value: false, sequence: -1, issuance: "", frontierCommitted: false };
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
				if ((edge === "frontier-persist" || edge === "post-removal-install") && plan?.memberFrontier !== undefined)
					written.add(source.database);
				if (edge === "custody-write" && plan?.entries.some(entry => entry.sourceSequence === armed.sequence &&
					entry.replacementSequence !== null && entry.sourceContextDigest !== undefined)) written.add(source.database);
			}
			return result;
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
			if (sql === "ROLLBACK") written.delete(this);
			if (sql !== "COMMIT") return result;
			const target = edge === "post-removal-install"
				? armed.frontierCommitted && location(this) !== armed.issuance
				: written.has(this);
			if (edge === "post-removal-install" && written.has(this)) { written.delete(this); armed.frontierCommitted = true; }
			if (target) {
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
			if (edge === "custody-write") {
				// The replayed-move shape: m1 lost in epoch 0, replayed by the adjacent install, then removal.
				const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
				Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
				await member.room.issue(message(MOVE)).catch(() => undefined);
				const m1 = required((await f.issuedAfter(1, null)).at(-1)).commit.authorSequence;
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
				await f.install(member);
				const rows = (await f.issuedAfter(1, m1)).filter(row => row.commit.authorSequence > m1);
				expect(await creator.receive(rows, 1, 30_000)).toBe(true);
				armed.sequence = m1;
			} else {
				await member.room.issue(message(MOVE));
				expect(await creator.receive(await f.issuedAfter(1, null), 1, 30_000)).toBe(true);
				await roll(f, creator, member);
			}
			expect(count(creator, MOVE)).toBe(1);
			const lineage = await f.withIssuance(1, store => store.readLineage({ objectId: f.objectId, author: required(f.identities[1]).author }));
			armed.issuance = realpathSync(issuanceFile(directory));
			writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors, lineage, m1: armed.sequence,
				epoch: member.room.authority().epoch }));
			await revoke(f, creator);
			armed.value = true;
			for (let seal = 0; seal < 3; seal++) await roll(f, creator, member);
			throw Error(`NATIVE_COMMITTED_EDGE_NOT_REACHED:${edge}`);
		}
		const before = JSON.parse(readFileSync(reportFile, "utf8")) as { native: ReturnType<typeof nativePlan> };
		const setup = JSON.parse(readFileSync(setupFile, "utf8")) as { selectors: Record<number, { slot: number; incarnation: number }>;
			lineage: unknown; m1: number; epoch: number };
		// The committed boundary is exactly the write the edge names.
		if (edge === "custody-write")
			expect(before.native?.entries.find(entry => entry.sequence === setup.m1)).toMatchObject({ disposition: "rebase",
				context: expect.stringMatching(/^[0-9a-f]{64}$/u) });
		else expect(before.native?.memberFrontier).toMatch(/^[0-9a-f]{64}$/u);
		const f = await fixture(directory, setup.selectors);
		const creator = await f.open(0, { reopen: true }), member = await f.open(1, { reopen: true, promote: true });
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member);
		const after = nativePlan(directory);
		// Written once and kept: the same frontier and the same custody the dead process committed.
		expect(after?.memberFrontier).toBe(before.native?.memberFrontier);
		for (const entry of before.native?.entries.filter(value => value.context !== null) ?? [])
			expect(after?.entries.find(value => value.sequence === entry.sequence)?.context ?? entry.context).toBe(entry.context);
		expect(await f.withIssuance(1, store => store.readLineage({ objectId: f.objectId, author: required(f.identities[1]).author })))
			.toEqual(setup.lineage);
		expect(count(creator, MOVE)).toBe(1);
		writeFileSync(join(directory, "recovered.json"), JSON.stringify({ edge, before: before.native, after,
			epoch: member.room.authority().epoch }));
	} finally {
		DatabaseSync.prototype.prepare = prepare;
		StatementSync.prototype.run = run;
		DatabaseSync.prototype.exec = exec;
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 300_000);

it.skipIf(INNER).each(EDGES)("SIGKILL right after the %s commit recovers and keeps installing", async (edge) => {
	const directory = mkdtempSync(join(tmpdir(), `member-frontier-crash-${edge}-`));
	const file = fileURLToPath(import.meta.url);
	const fork = (mode: "mutate" | "recover") => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		// Asynchronous child: a synchronous spawn starves this worker's RPC for minutes.
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			cwd: join(fileURLToPath(new URL(".", import.meta.url)), ".."), timeout: 600_000,
			env: { ...process.env, RUN_MEMBER_FRONTIER_CRASH: "1", MEMBER_FRONTIER_CRASH_DIRECTORY: directory,
				MEMBER_FRONTIER_CRASH_EDGE: edge, MEMBER_FRONTIER_CRASH_MODE: mode } });
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
		console.info(`MEMBER_FRONTIER_CRASH ${JSON.stringify(recovered)}`);
	} finally { rmSync(directory, { recursive: true, force: true }); }
}, 1_300_000);
