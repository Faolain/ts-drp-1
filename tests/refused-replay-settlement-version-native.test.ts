import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// G25 cross-version probe for a refused replay's hand-back (SettlementPlanEntry.handedBack and the
// hand-back record's reason; no schema bump). One store directory, two processes: "setup" (this code)
// hands back a Writer's refused replay at an install; "continue" reopens the SAME directory and keeps
// installing. The driver runs "continue" from a checkout of the code before the field existed
// (downgrade: it must fail closed, refusing the unknown closed plan field, and leave every native
// issuance image exactly as it was) and then from this code again (it must continue, the move listed
// once). Skipped unless REFUSED_REPLAY_VERSION_PHASE is set.
const PHASE = process.env.REFUSED_REPLAY_VERSION_PHASE;
const DIRECTORY = process.env.REFUSED_REPLAY_VERSION_DIRECTORY;
const DOOM_EPOCH = 2;
const fresh = Object.freeze({ kind: "fresh" as const, commit: () => "committed" as const, release: () => undefined });
const doomingPolicy = (context: Readonly<{ epoch: number }>) =>
	Object.freeze({
		reserve: (operation: Readonly<Record<string, unknown>>) =>
			context.epoch >= DOOM_EPOCH && String(operation.id ?? "").startsWith("doomed")
				? Object.freeze({ kind: "rejected" as const })
				: fresh,
	});
const block = (id: string, x: number) => ({ action: "placeBlock", id, kind: "stone", x, y: 0 });

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
});

/** The Writer's native issuance image (every row of every table), read-only. */
function nativeImage(directory: string) {
	const prefix = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
	const files = readdirSync(directory)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".drp-issuance-v1.sqlite"))
		.sort();
	if (files.length !== 1) throw new Error(`the Writer's issuance store is not unique: ${JSON.stringify(readdirSync(directory))}`);
	return Object.fromEntries(
		files.map((name) => {
			const database = new DatabaseSync(join(directory, name), { readOnly: true });
			try {
				const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
					name: string;
				}[]).map((row) => row.name);
				return [
					name,
					Object.fromEntries(
						tables.map((table) => [
							table,
							database
								.prepare(`SELECT * FROM ${table}`)
								.all()
								.map((row) =>
									JSON.stringify(row, (_key, value: unknown) =>
										value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value
									)
								),
						])
					),
				];
			} finally {
				database.close();
			}
		})
	);
}

async function room(directory: string, reopen: boolean) {
	const fixture = await readinessHoldRoom({ directory, writers: 1, createOperationAdmissionPolicy: doomingPolicy as never });
	const creator = await fixture.open(0, { reopen });
	const writer = await fixture.open(1, { reopen });
	const cursorFile = join(directory, "delivered.json");
	let delivered: number | null = existsSync(cursorFile) ? (JSON.parse(readFileSync(cursorFile, "utf8")) as number | null) : null;
	const save = (): void => writeFileSync(cursorFile, JSON.stringify(delivered));
	const deliver = async (): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(1, delivered);
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await creator.receive(chunk.slice(0, last + 1), 1);
			creator.inject(chunk.slice(last + 1), 1);
		}
		if (rows.length !== 0) delivered = required(rows.at(-1)).commit.authorSequence;
		save();
	};
	const lose = async (): Promise<void> => {
		const lost = await fixture.publishedAfter(1, delivered);
		if (lost.length !== 0) delivered = required(lost.at(-1)).commit.authorSequence;
		save();
	};
	const rollover = async (epoch: number): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const ids = (peer: typeof creator): string[] =>
		(peer.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();
	return { creator, writer, deliver, lose, rollover, ids };
}

const chain = (cause: unknown): string[] => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 8; value = value.cause) parts.push(value.message);
	return parts;
};

it.runIf(PHASE === "setup")("setup: a Writer's refused replay is handed back at an install", async () => {
	const directory = required(DIRECTORY);
	const peers = await room(directory, false);
	await peers.writer.room.issue(block("w-0", 0));
	await peers.deliver();
	await peers.rollover(1);
	await peers.deliver();
	await peers.writer.room.issue(block("doomed-1", 1));
	await peers.lose();
	await peers.rollover(2);
	const undelivered = required(peers.writer.room.settlementStatus?.()).undelivered;
	expect(undelivered.map((move) => move.operations[0]?.id)).toEqual(["doomed-1"]);
	writeFileSync(join(directory, "image-setup.json"), JSON.stringify(nativeImage(directory)));
	console.info(`REFUSED_REPLAY_VERSION setup ${JSON.stringify(undelivered)}`);
}, 300_000);

it.runIf(PHASE === "continue")("continue: reopen the same stores and keep installing", async () => {
	const directory = required(DIRECTORY);
	const label = required(process.env.REFUSED_REPLAY_VERSION_LABEL);
	const log: unknown[] = [];
	let ok = true;
	try {
		const peers = await room(directory, true);
		log.push({ label: "reopened", epoch: peers.writer.room.authority()?.epoch });
		await peers.deliver();
		await peers.writer.room.issue(block("w-2", 2));
		await peers.deliver();
		await peers.rollover(3);
		await peers.deliver();
		await peers.rollover(4);
		const listed = required(peers.writer.room.settlementStatus?.()).undelivered.map((move) => move.operations[0]?.id);
		log.push({ label: "continued", creator: peers.ids(peers.creator), writer: peers.ids(peers.writer), listed });
		expect(peers.ids(peers.creator)).toEqual(["w-0", "w-2"]);
		expect(listed).toEqual(["doomed-1"]);
	} catch (cause) {
		ok = false;
		log.push({ label: "failed", error: chain(cause) });
	}
	writeFileSync(join(directory, `continue-${label}.json`), JSON.stringify({ ok, log }));
	writeFileSync(join(directory, `image-${label}.json`), JSON.stringify(nativeImage(directory)));
	for (const row of log) console.info(`REFUSED_REPLAY_VERSION continue ${label} ${JSON.stringify(row)}`);
	if (process.env.REFUSED_REPLAY_VERSION_EXPECT === "refused") expect(ok).toBe(false);
	else expect(ok).toBe(true);
}, 300_000);
