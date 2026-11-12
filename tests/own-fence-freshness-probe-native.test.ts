import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, describe, expect, it } from "vitest";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// G6 probe (measurement, not yet a RED): what happens today when a Writer's own fence row is missing
// from its store. A move m1 the creator never received is displaced by the epoch-0 close; the Writer's
// install of epoch 1 fences it (own fence f, a later sequence) and settles it. The creator then admits
// the Writer's epoch-1 rows and closes again. The Writer's store then loses f in one of four ways:
//   delete-row: f's issued record and outbox entry deleted (write triggers bypassed), later rows kept;
//   suffix: f and every later own row deleted and the lineage lowered to f (one store only);
//   restore: the whole device restored from a backup taken before the epoch-1 install;
//   restore-undelivered: as restore, but f never reached the creator;
//   restore-fence-only: as restore, but only f reached the creator (not m1's replacement after it);
//   none: the store is left as it is (a current Writer: the control for no false refusal).
// For each, the probe records the reopen, the install of the creator's current successor, an issue
// after it, and m1's fate (accepted on the creator, listed as given back, or neither).

// Process death around the refusal: an inner vitest process runs the probe over an external directory
// and dies (SIGKILL, real SQLite, nothing mocked) either at the first COMMIT of any store during the
// refused install, or right after the install returned. The outer process reopens the same stores.
const INNER = process.env.RUN_OWN_FENCE_SIGKILL === "1";
type KillEdge = "first-commit" | "after-refusal";
const directories: string[] = [];
afterEach(async () => {
	expect(await closeChatSharesRooms()).toEqual([]);
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Loss = "delete-row" | "suffix" | "restore" | "restore-undelivered" | "restore-fence-only" | "none";
const fixture = (directory?: string) =>
	chatSharesRoomFixture({
		...(directory === undefined ? {} : { directory }),
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
const issuanceFile = (directory: string) =>
	join(
		directory,
		`${createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex")}.sqlite.drp-issuance-v1.sqlite`
	);

/** Arms a SIGKILL of this process at the first COMMIT of any store, or kills it now. */
function deathWatch(directory: string, edge: KillEdge) {
	const exec = DatabaseSync.prototype.exec;
	const die = (detail: Record<string, unknown>): never => {
		writeFileSync(join(directory, "death.json"), JSON.stringify({ pid: process.pid, signal: "SIGKILL", edge, ...detail }));
		process.kill(process.pid, "SIGKILL");
		throw Error("SIGKILL_DID_NOT_TERMINATE");
	};
	return {
		arm: () => {
			if (edge !== "first-commit") return;
			DatabaseSync.prototype.exec = function (sql: string) {
				const result = exec.call(this, sql);
				if (sql === "COMMIT" || sql.endsWith("COMMIT")) die({ at: "commit", location: this.location() });
				return result;
			};
		},
		die: (installed: unknown) => die({ at: "after-install", installed }),
	};
}
const FENCE = "$drp.author-fence.v1";
const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
type Preimage = { epoch: number; authorSequence: number; operation?: Record<string, unknown> };
const preimageOf = (row: DurableIssuanceOutboxRecord) => decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as Preimage;
const describeRow = (row: DurableIssuanceOutboxRecord) => {
	const value = preimageOf(row);
	const operation = value.operation ?? {};
	return `${value.authorSequence}:e${value.epoch}:${String(operation.action ?? "?")}${
		typeof operation.clientOperationId === "string" ? `(${operation.clientOperationId})` : ""
	}${operation.action === FENCE ? `@${String(operation.fenceSequence)}` : ""}`;
};
const outcome = async <T>(run: () => Promise<T>) =>
	run().then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error: String((error as Error)?.message ?? error).slice(0, 300) })
	);

async function probe(loss: Loss, death?: Readonly<{ directory: string; edge: KillEdge }>) {
	const f = await fixture(death?.directory);
	const log = (label: string, value: unknown) =>
		process.stdout.write(`OWN_FENCE_FRESHNESS ${loss} ${label} ${JSON.stringify(value)}\n`);
	const plan = () => readPlan(issuanceFile(f.directory));
	const creator = await f.open(0);
	const before = new Set(readdirSync(f.directory));
	let member = await f.open(1);
	const author = required(f.identities[1]).author;
	await member.room.issue(message("m0"));
	expect(await creator.receive(await f.issuedAfter(1, null), 1)).toBe(true);
	// m1: never delivered; the epoch-0 close displaces it.
	await member.room.issue(message("m1"));
	await f.stop(member);
	const rows0 = await f.issuedAfter(1, null);
	log("rows-before-install", rows0.map(describeRow));
	const bobFiles = readdirSync(f.directory).filter((file) => !before.has(file));
	const backup = join(f.directory, "bob-backup");
	mkdirSync(backup);
	for (const file of bobFiles) copyFileSync(join(f.directory, file), join(backup, file));

	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	// The device's files: those its first session created, and those it creates while it runs again
	// below. The creator's files (some created lazily, at its seals) are never part of the restore.
	const beforeSecondSession = new Set(readdirSync(f.directory));
	member = await f.open(1, { reopen: true, promote: true });
	log("install-epoch-1", await outcome(() => f.install(member)));
	const rows1 = await f.issuedAfter(1, null);
	log("rows-after-install", rows1.map(describeRow));
	log("status-after-install", member.room.settlementStatus?.());
	log("plan-after-install", plan());
	const fence = rows1.find((row) => {
		const value = preimageOf(row);
		return value.operation?.action === FENCE && value.epoch === 1;
	});
	log("epoch-1-fence", fence === undefined ? null : describeRow(fence));
	const epoch1 = rows1.filter((row) => preimageOf(row).epoch === 1);
	const delivered = loss === "restore-fence-only" ? epoch1.filter((row) => row === fence) : epoch1;
	if (loss !== "restore-undelivered" && delivered.length > 0)
		log("creator-receives-epoch-1-rows", { rows: delivered.map(describeRow), accepted: await creator.receive(delivered, 1, 20_000) });
	await f.stop(member);
	const bobLater = readdirSync(f.directory).filter((file) => !beforeSecondSession.has(file));
	log("device-files", { first: bobFiles, later: bobLater });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	log("creator-epoch", creator.room.authority()?.epoch ?? 0);
	log("creator-accepted-m1", acceptedOperation(creator, author, "m1"));

	if (loss === "delete-row" || loss === "suffix") {
		const target = required(fence);
		const sequence = target.commit.authorSequence;
		const database = new DatabaseSync(issuanceFile(f.directory));
		try {
			database.function("issuance_retirement_connection", { varargs: true }, () => 1);
			database.function("issuance_retirement_record", { varargs: true }, () => 1);
			const comparator = loss === "delete-row" ? "=" : ">=";
			for (const table of ["issued_records", "issuance_outbox"])
				database
					.prepare(`DELETE FROM ${table} WHERE object_id=? AND author=? AND author_sequence ${comparator} ?`)
					.run(f.objectId, author, sequence);
			if (loss === "suffix")
				database.prepare("UPDATE lineages SET next=? WHERE object_id=? AND author=?").run(sequence, f.objectId, author);
		} finally {
			database.close();
		}
	} else if (loss !== "none") {
		for (const file of new Set([...bobFiles, ...bobLater])) rmSync(join(f.directory, file), { force: true });
		for (const file of bobFiles) copyFileSync(join(backup, file), join(f.directory, file));
	}

	const reopened = await outcome(() => f.open(1, { reopen: true, promote: true }));
	log("reopen", reopened.ok ? "opened" : reopened);
	if (!reopened.ok) return { f, loss, reopen: reopened.error };
	member = reopened.value;
	log("rows-after-reopen", (await f.issuedAfter(1, null)).map(describeRow));
	log("currency-after-reopen", member.room.localIssueCurrency?.());
	log("status-after-reopen", member.room.settlementStatus?.());
	const planAtReopen = plan();
	log("plan-after-reopen", planAtReopen);
	const authorityAtReopen = member.room.authority()?.epoch ?? 0;
	const watch = death === undefined ? undefined : deathWatch(death.directory, death.edge);
	if (death !== undefined) writeFileSync(join(death.directory, "setup.json"), JSON.stringify({ planAtReopen, authorityAtReopen }));
	watch?.arm();
	const installed = await outcome(() => f.install(member));
	watch?.die(installed);
	log("install-current", installed);
	log("rows-after-current-install", (await f.issuedAfter(1, null)).map(describeRow));
	log("status-after-current-install", member.room.settlementStatus?.());
	const authorityAfterInstall = member.room.authority()?.epoch ?? 0;
	log("authority-after-current-install", authorityAfterInstall);
	const planAfterInstall = plan();
	log("plan-after-current-install", planAfterInstall);
	// A refused install is retried as the room would: it must stay refused and still change nothing.
	const retried = installed.ok ? undefined : await outcome(() => f.install(member));
	if (retried !== undefined) log("install-retry", retried);
	const planAfterRetry = plan();
	const issued = await outcome(() => member.room.issue(message("m2")));
	log("issue-after", issued);
	const after = await f.issuedAfter(1, null);
	log("rows-final", after.map(describeRow));
	const current = after.filter((row) => preimageOf(row).epoch === (creator.room.authority()?.epoch ?? 0));
	if (current.length > 0) log("creator-receives-current", await creator.receive(current, 1, 20_000));
	log("creator-accepted-m1-final", acceptedOperation(creator, author, "m1"));
	log("creator-accepted-m2-final", acceptedOperation(creator, author, "m2"));
	const status = member.room.settlementStatus?.();
	const givenBack = (status?.undelivered ?? []).some((entry) =>
		entry.operations.some((operation) => operation.clientOperationId === "m1")
	);
	log("m1-given-back", givenBack);
	await f.stop(member);
	return {
		f,
		loss,
		reopen: "opened",
		installed,
		retried,
		issued,
		givenBack,
		planAtReopen,
		planAfterInstall,
		planAfterRetry,
		authorityAtReopen,
		authorityAfterInstall,
	};
}

/** The Writer's stored settlement plan: [sourceSequence, disposition, replacementSequence] per entry. */
function readPlan(path: string) {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return database.prepare("SELECT revision, fence_sequence, entries_json FROM settlement_plans").all().map((row) => {
			const carrier = JSON.parse(String(row.entries_json)) as { bytes?: string };
			if (typeof carrier.bytes !== "string") return { revision: row.revision, fence: row.fence_sequence, raw: String(row.entries_json).slice(0, 200) };
			const value = decodeCanonical(Buffer.from(carrier.bytes, "base64")) as { entries?: Record<string, unknown>[] };
			return {
				revision: row.revision,
				fence: row.fence_sequence,
				entries: (value.entries ?? []).map((entry) => [entry.sourceSequence, entry.disposition, entry.replacementSequence]),
			};
		});
	} catch (error) {
		return String((error as Error).message);
	} finally {
		database.close();
	}
}

function acceptedOperation(peer: { room: { projection(): unknown } }, _author: string, id: string): boolean {
	return JSON.stringify(peer.room.projection()).includes(`"${id}"`);
}

it.skipIf(INNER).each(["delete-row", "suffix", "restore", "restore-undelivered", "restore-fence-only"] as const)(
	"G6 probe: own fence lost by %s",
	async (loss) => {
		const result = await probe(loss);
		process.stdout.write(`OWN_FENCE_FRESHNESS_RESULT ${loss} ${JSON.stringify({ ...result, f: undefined })}\n`);
	},
	240_000
);

// RED (G6, fail closed). A Writer brought back from a backup taken before its epoch-1 fence, when only
// that fence reached the creator: the creator's frontier (4) is at or above the backup's lineage
// (next 4), and m1 (sequence 3) was never admitted. The install is refused at its first signature
// (V3_LOCAL_LINEAGE_BEHIND_FRONTIER), which is right, but only after the install rewrote the stored
// settlement plan (revision 1 -> 4: m1 "expire" with no hand-back record) and adopted epoch 2. A
// refused install must change nothing: m1 stays pending, recoverable once the device is healed,
// instead of dropped without being given back (G2).
it.skipIf(INNER)("[RED] a Writer refused for being behind its frontier keeps its settlement plan", async () => {
	const result = await probe("restore-fence-only");
	expect(result.reopen).toBe("opened");
	expect(result.installed).toMatchObject({ ok: false });
	expect(String((result.installed as { error?: string }).error)).toContain("V3_LOCAL_LINEAGE_BEHIND_FRONTIER");
	expect(result.planAfterInstall).toEqual(result.planAtReopen);
}, 240_000);

// G6 guard: the refusal adopts nothing and holds. The refused install leaves the restored store's
// authority where it was, a retry is refused the same way without writing, and the session signs
// nothing (sync before sending: "behind-frontier") until the store is healed.
it.skipIf(INNER)("a Writer behind its frontier adopts nothing, stays refused on retry and signs nothing", async () => {
	const result = await probe("restore-fence-only");
	expect(result.reopen).toBe("opened");
	expect(String((result.installed as { error?: string }).error)).toContain("V3_LOCAL_LINEAGE_BEHIND_FRONTIER");
	expect(result.authorityAfterInstall).toBe(result.authorityAtReopen);
	expect(result.retried).toMatchObject({ ok: false });
	expect(String((result.retried as { error?: string }).error)).toMatch(/V3_LOCAL_LINEAGE_BEHIND_FRONTIER|behind-frontier/u);
	expect(result.planAfterRetry).toEqual(result.planAtReopen);
	expect(result.issued).toMatchObject({ ok: false });
	expect(String((result.issued as { error?: string }).error)).toMatch(/V3_ROOM_NOT_YET_CURRENT|behind-frontier/u);
}, 240_000);

// No false refusal: a Writer whose store is current (above its creator-signed frontier) reopens,
// installs the creator's current successor and issues, exactly as before the guard.
it.skipIf(INNER)("a current Writer store installs and issues (no false refusal)", async () => {
	const result = await probe("none");
	expect(result.reopen).toBe("opened");
	expect(result.installed).toMatchObject({ ok: true });
	expect(result.authorityAfterInstall).toBeGreaterThan(result.authorityAtReopen ?? 0);
	expect(result.issued).toMatchObject({ ok: true });
}, 240_000);

it.runIf(INNER)("inner: a Writer behind its frontier dies around its refused install", async () => {
	const directory = required(process.env.OWN_FENCE_SIGKILL_DIRECTORY);
	const edge = required(process.env.OWN_FENCE_SIGKILL_EDGE) as KillEdge;
	await probe("restore-fence-only", { directory, edge });
	throw Error("OWN_FENCE_SIGKILL_EDGE_NOT_REACHED");
}, 600_000);

describe.skipIf(INNER)("SIGKILL around a behind-frontier refusal", () => {
	it.each(["first-commit", "after-refusal"] as const)(
		"killed at %s: the restored store reopens unchanged and is refused again without writing",
		async (edge) => {
			const directory = mkdtempSync(join(tmpdir(), "own-fence-sigkill-"));
			directories.push(directory);
			const child = spawn(
				"npx",
				["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
				{
					env: {
						...process.env,
						RUN_OWN_FENCE_SIGKILL: "1",
						OWN_FENCE_SIGKILL_DIRECTORY: directory,
						OWN_FENCE_SIGKILL_EDGE: edge,
					},
					stdio: ["ignore", "pipe", "pipe"],
				}
			);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
			await new Promise<void>((resolve) => child.on("exit", () => resolve()));
			const deathFile = join(directory, "death.json");
			if (!existsSync(deathFile)) throw new Error(`the Writer did not die at ${edge}:\n${output.slice(-6000)}`);
			const death = JSON.parse(readFileSync(deathFile, "utf8")) as Record<string, unknown>;
			const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as {
				planAtReopen: unknown;
				authorityAtReopen: number;
			};
			expect(death).toMatchObject({ signal: "SIGKILL", edge });
			const f = await fixture(directory);
			const creator = await f.open(0, { reopen: true });
			const member = await f.open(1, { reopen: true, promote: true });
			const plan = () => readPlan(issuanceFile(directory));
			const reopened = { plan: plan(), authority: member.room.authority()?.epoch ?? 0 };
			const installed = await outcome(() => f.install(member));
			const after = { plan: plan(), authority: member.room.authority()?.epoch ?? 0 };
			const issued = await outcome(() => member.room.issue(message("m3")));
			process.stdout.write(
				`OWN_FENCE_SIGKILL ${JSON.stringify({ death, setup, reopened, installed, after, issued, creatorEpoch: creator.room.authority()?.epoch ?? 0 })}\n`
			);
			expect(reopened).toEqual({ plan: setup.planAtReopen, authority: setup.authorityAtReopen });
			expect(installed).toMatchObject({ ok: false });
			expect(String((installed as { error?: string }).error)).toContain("V3_LOCAL_LINEAGE_BEHIND_FRONTIER");
			expect(after).toEqual(reopened);
			expect(issued).toMatchObject({ ok: false });
			await f.stop(member);
		},
		900_000
	);
});
