import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";
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
//   restore-fence-only: as restore, but only f reached the creator (not m1's replacement after it).
// For each, the probe records the reopen, the install of the creator's current successor, an issue
// after it, and m1's fate (accepted on the creator, listed as given back, or neither).

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

type Loss = "delete-row" | "suffix" | "restore" | "restore-undelivered" | "restore-fence-only";
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

async function probe(loss: Loss) {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const log = (label: string, value: unknown) =>
		process.stdout.write(`OWN_FENCE_FRESHNESS ${loss} ${label} ${JSON.stringify(value)}\n`);
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
	member = await f.open(1, { reopen: true, promote: true });
	log("install-epoch-1", await outcome(() => f.install(member)));
	const rows1 = await f.issuedAfter(1, null);
	log("rows-after-install", rows1.map(describeRow));
	log("status-after-install", member.room.settlementStatus?.());
	const fence = rows1.find((row) => {
		const value = preimageOf(row);
		return value.operation?.action === FENCE && value.epoch === 1;
	});
	log("epoch-1-fence", fence === undefined ? null : describeRow(fence));
	const epoch1 = rows1.filter((row) => preimageOf(row).epoch === 1);
	const delivered = loss === "restore-fence-only" ? epoch1.filter((row) => row === fence) : epoch1;
	if (loss !== "restore-undelivered" && delivered.length > 0)
		log("creator-receives-epoch-1-rows", { rows: delivered.map(describeRow), accepted: await creator.receive(delivered, 1) });
	await f.stop(member);
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	log("creator-epoch", creator.room.authority()?.epoch ?? 0);
	log("creator-accepted-m1", acceptedOperation(creator, author, "m1"));

	const key = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
	const issuancePath = join(f.directory, `${key}.sqlite.drp-issuance-v1.sqlite`);
	if (loss === "delete-row" || loss === "suffix") {
		const target = required(fence);
		const sequence = target.commit.authorSequence;
		const database = new DatabaseSync(issuancePath);
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
			log("plan-row", database.prepare("SELECT revision, fence_sequence, entries_json FROM settlement_plans").all());
		} finally {
			database.close();
		}
	} else {
		for (const file of readdirSync(f.directory).filter((name) => !before.has(name) && name !== "bob-backup"))
			rmSync(join(f.directory, file));
		for (const file of bobFiles) copyFileSync(join(backup, file), join(f.directory, file));
	}

	const reopened = await outcome(() => f.open(1, { reopen: true, promote: true }));
	log("reopen", reopened.ok ? "opened" : reopened);
	if (!reopened.ok) return { f, loss, reopen: reopened.error };
	member = reopened.value;
	log("rows-after-reopen", (await f.issuedAfter(1, null)).map(describeRow));
	log("currency-after-reopen", member.room.localIssueCurrency?.());
	log("status-after-reopen", member.room.settlementStatus?.());
	const installed = await outcome(() => f.install(member));
	log("install-current", installed);
	log("rows-after-current-install", (await f.issuedAfter(1, null)).map(describeRow));
	log("status-after-current-install", member.room.settlementStatus?.());
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
	return { f, loss, reopen: "opened", installed, issued, givenBack };
}

function acceptedOperation(peer: { room: { projection(): unknown } }, _author: string, id: string): boolean {
	return JSON.stringify(peer.room.projection()).includes(`"${id}"`);
}

it.each(["delete-row", "suffix", "restore", "restore-undelivered", "restore-fence-only"] as const)(
	"G6 probe: own fence lost by %s",
	async (loss) => {
		const result = await probe(loss);
		process.stdout.write(`OWN_FENCE_FRESHNESS_RESULT ${loss} ${JSON.stringify({ ...result, f: undefined })}\n`);
	},
	240_000
);
