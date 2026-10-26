/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// T9: the mutate fork dies by SIGKILL immediately AFTER a real SQLite COMMIT
// returns: either the abandonment plan CAS or the original retirement owner's
// preparation that covers the abandoned source. A separate recover fork reopens
// the SAME directory. No native write, signature, verifier or transaction is mocked.
const INNER = process.env.RUN_SOURCE_ABANDONMENT_CRASH === "1";
const EDGES = ["plan-cas", "retirement-prepare"] as const;
type Edge = (typeof EDGES)[number];

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });

type Plan = { entries: { sourceSequence: number; disposition: string; sourceResolutionDigest?: Uint8Array }[] };
const decodePlan = (json: string) => decodeCanonical(Buffer.from((JSON.parse(json) as { bytes: string }).bytes, "base64")) as Plan;

function issuanceFile(directory: string): string {
	const found: string[] = [];
	const walk = (path: string): void => { for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) walk(child); else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) found.push(child);
	} };
	walk(join(directory, "local-sessions"));
	return required(found.length === 1 ? found[0] : undefined);
}

/** Read-only native evidence of the local member's issuance owner. */
function nativeSnapshot(directory: string, sequence: number) {
	const issuance = new DatabaseSync(issuanceFile(directory), { readOnly: true });
	try {
		const plan = issuance.prepare("SELECT revision, entries_json FROM settlement_plans").get();
		const outbox = issuance.prepare("SELECT author_sequence, publish_state FROM issuance_outbox WHERE author_sequence=?").get(sequence);
		const control = issuance.prepare("SELECT record FROM retirement_controls").get();
		const entry = plan === undefined ? undefined : decodePlan(String(plan.entries_json)).entries.find(value => value.sourceSequence === sequence);
		const record = control === undefined ? undefined : decodeCanonical(control.record as Uint8Array) as
			{ active: { preparation: { protectedRecords: { authorSequence: number }[] } } | null; completed: { throughEpoch: number; protectedRecords: { authorSequence: number }[] } | null };
		return {
			revision: plan?.revision as number | undefined,
			entry: entry === undefined ? undefined : { disposition: entry.disposition,
				resolution: entry.sourceResolutionDigest === undefined ? undefined : Buffer.from(entry.sourceResolutionDigest).toString("hex") },
			publishState: outbox?.publish_state as string | undefined,
			active: record?.active === null || record?.active === undefined ? null : record.active.preparation.protectedRecords.map(hole => hole.authorSequence),
			completed: record?.completed == null ? null : { throughEpoch: record.completed.throughEpoch,
				holes: record.completed.protectedRecords.map(hole => hole.authorSequence) },
		};
	} finally { issuance.close(); }
}

const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });

it.runIf(INNER)("abandonment survives process death at its real committed boundary", async () => {
	const directory = required(process.env.SOURCE_ABANDONMENT_CRASH_DIRECTORY);
	const edge = required(process.env.SOURCE_ABANDONMENT_CRASH_EDGE) as Edge;
	const mode = required(process.env.SOURCE_ABANDONMENT_CRASH_MODE);
	const reportFile = join(directory, "death.json"), setupFile = join(directory, "setup.json");
	const prepare = DatabaseSync.prototype.prepare, run = StatementSync.prototype.run, exec = DatabaseSync.prototype.exec;
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
	const written = new WeakSet<DatabaseSync>();
	const armed = { value: false, sequence: -1, author: "" };
	if (mode === "mutate") {
		DatabaseSync.prototype.prepare = function (sql: string) {
			const statement = prepare.call(this, sql);
			statements.set(statement, { database: this, sql });
			return statement;
		};
		StatementSync.prototype.run = function (...args: any[]) {
			const result = Reflect.apply(run, this, args) as ReturnType<typeof run>, source = statements.get(this);
			if (armed.value && source !== undefined) {
				if (edge === "plan-cas" && source.sql.startsWith("UPDATE settlement_plans SET") && typeof args[2] === "string") {
					const entry = decodePlan(args[2]).entries.find(value => value.sourceSequence === armed.sequence);
					if (entry?.disposition === "expire" && entry.sourceResolutionDigest !== undefined) written.add(source.database);
				}
				if (edge === "retirement-prepare" && source.sql === "UPDATE retirement_controls SET record=? WHERE object_id=?" &&
					args[0] instanceof Uint8Array) {
					const control = decodeCanonical(args[0]) as { kind?: string;
						active: { preparation: { protectedRecords: { author: string; authorSequence: number }[] } } | null };
					// The member's original owner's preparation that no longer protects the abandoned source
					// (the creator's own issuance owner prepares independently and is ignored).
					const holes = control.active?.preparation.protectedRecords ?? [];
					if (control.kind === "v3-issuance-retirement-control-1" && control.active !== null &&
						holes.some(hole => hole.author === armed.author) &&
						!holes.some(hole => hole.author === armed.author && hole.authorSequence === armed.sequence)) written.add(source.database);
				}
			}
			return result;
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
			if (sql === "ROLLBACK") written.delete(this);
			if (sql === "COMMIT" && written.has(this)) {
				writeFileSync(reportFile, JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL",
					native: nativeSnapshot(directory, armed.sequence) }));
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
			Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never acknowledged.
			await member.room.issue(message("before-removal")).catch(() => undefined);
			const author = required(f.identities[1]).author;
			await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await f.install(member);
			const unresolved = required((await member.room.unresolvedAcceptedWork())[0]);
			armed.sequence = unresolved.sourceSequence; armed.author = author;
			writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors, unresolved }));
			const selector = { sourceSequence: unresolved.sourceSequence, sourceDigest: unresolved.sourceDigest,
				sourceContextDigest: unresolved.sourceContextDigest };
			if (edge === "plan-cas") {
				armed.value = true;
				await member.room.abandonUnresolvedAcceptedWork(selector);
			} else {
				const result = await member.room.abandonUnresolvedAcceptedWork(selector);
				writeFileSync(setupFile, JSON.stringify({ selectors: f.localSelectors, unresolved, result }));
				armed.value = true;
				for (let seal = 0; seal < 6; seal++) {
					expect((await creator.room.sealEpoch()).ok).toBe(true);
					await creator.room.adoptCreatorSuccessor();
					await f.install(member);
				}
			}
			throw Error(`NATIVE_COMMITTED_EDGE_NOT_REACHED:${edge}`);
		}
		const before = JSON.parse(readFileSync(reportFile, "utf8")) as { native: ReturnType<typeof nativeSnapshot> };
		const setup = JSON.parse(readFileSync(setupFile, "utf8")) as { selectors: Record<number, { slot: number; incarnation: number }>;
			unresolved: { sourceSequence: number; sourceDigest: string; sourceContextDigest: string } };
		const sequence = setup.unresolved.sourceSequence;
		// The committed boundary is exactly the signed expiry (never partial), the source never published.
		expect(before.native.entry).toMatchObject({ disposition: "expire" });
		expect(before.native.entry?.resolution).toMatch(/^[0-9a-f]{64}$/u);
		expect(before.native.publishState).toBe("pending");
		if (edge === "retirement-prepare") expect(before.native.active).not.toContain(sequence);
		const f = await fixture(directory, setup.selectors);
		const creator = await f.open(0, { reopen: true }), member = await f.open(1, { reopen: true, promote: true });
		const published: string[] = [];
		Reflect.set(member.networkNode, "publishMessage", (packet: { data?: Uint8Array }) => {
			if (packet?.data instanceof Uint8Array) published.push(Buffer.from(packet.data).toString("hex"));
			return Promise.resolve(true);
		});
		// Reopen authenticates the retained receipt; the work stays terminal.
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		// Retry is idempotent: the same receipt, never a second signature.
		const retried = await member.room.abandonUnresolvedAcceptedWork({ sourceSequence: sequence,
			sourceDigest: setup.unresolved.sourceDigest, sourceContextDigest: setup.unresolved.sourceContextDigest });
		expect(retried).toMatchObject({ sourceSequence: sequence, disposition: "expire", commitment: "unknown",
			expiryDigest: before.native.entry?.resolution });
		expect(nativeSnapshot(directory, sequence).revision).toBe(before.native.revision);
		// The original retirement owner converges: no active intent, abandoned source retired, still pending.
		for (let seal = 0; seal < 4; seal++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await f.install(member);
		}
		await member.republish();
		const after = nativeSnapshot(directory, sequence);
		expect(after.active).toBeNull();
		expect(after.completed?.holes).not.toContain(sequence);
		expect(after.publishState).toBe("pending");
		expect(after.entry).toEqual(before.native.entry);
		const issued = await f.issuedAfter(1, null);
		const source = required(issued.find(row => row.commit.authorSequence === sequence));
		const sourceHex = Buffer.from(source.commit.envelope.canonicalPreimageBytes).toString("hex");
		expect(published.some(bytes => bytes.includes(sourceHex))).toBe(false);
		await expect(member.room.issue(message("still-not-a-writer"))).rejects.toThrow();
		const maintenance = await f.withIssuance(1, async store => required(durableIssuancePruningMaintenanceForStore(store)).inspectPruningState(
			{ objectId: f.objectId, author: required(f.identities[1]).author }));
		writeFileSync(join(directory, "recovered.json"), JSON.stringify({ edge, before: before.native, after, retried,
			prunedThrough: maintenance.prunedThroughAuthorSequence }));
	} finally {
		DatabaseSync.prototype.prepare = prepare;
		StatementSync.prototype.run = run;
		DatabaseSync.prototype.exec = exec;
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 300_000);

// Both edges run by default. The retirement-prepare edge dies INSIDE the member's
// successor install (its received predecessor quarantine is open, not yet
// retained); recovery installs a checkpoint past that epoch, whose retention
// supersedes the dead receive's temporary scope (see
// creator-recipient-crash-recovery-native.test.ts for the same defect without abandonment).
it.skipIf(INNER).each(EDGES)("SIGKILL right after the %s commit recovers to one authenticated terminal expiry", async (edge) => {
	const directory = mkdtempSync(join(tmpdir(), `source-abandonment-crash-${edge}-`));
	const file = fileURLToPath(import.meta.url);
	const fork = (mode: "mutate" | "recover") => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		// Asynchronous child: a synchronous spawn starves this worker's RPC for minutes.
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			cwd: join(fileURLToPath(new URL(".", import.meta.url)), ".."), timeout: 600_000,
			env: { ...process.env, RUN_SOURCE_ABANDONMENT_CRASH: "1", SOURCE_ABANDONMENT_CRASH_DIRECTORY: directory,
				SOURCE_ABANDONMENT_CRASH_EDGE: edge, SOURCE_ABANDONMENT_CRASH_MODE: mode } });
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
		console.info(`SOURCE_ABANDONMENT_CRASH ${JSON.stringify(recovered)}`);
	} finally { rmSync(directory, { recursive: true, force: true }); }
}, 1_300_000);
