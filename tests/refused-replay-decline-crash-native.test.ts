import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Declining a given-back move across process death (fix/refused-replay-settlement, declineHandBack).
// A Writer's refused replay is handed back at an install (one durable hand-back record); the
// application declines it: ONE settlement plan write drops exactly that record. The whole process
// (creator and Writer) is SIGKILLed at that write:
//   before: as the Writer's issuance store is about to COMMIT the decline (the write is lost);
//   after:  right after that COMMIT (the decline is durable).
// The same directory is reopened. Wanted, either way: the record is either still there (declining
// again drops it: "declined") or gone ("absent"), never half-written; the move is never replayed or
// admitted; and the Writer keeps installing and playing with nothing listed. Nothing native is mocked.

const INNER = process.env.RUN_DECLINE_CRASH === "1";
const EDGES = ["before", "after"] as const;
type Edge = (typeof EDGES)[number];
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
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

/** A stored settlement plan row's state: whether a refused replay was handed back, and its records. */
function planState(entriesJson: string): Readonly<{ handedBack: boolean; records: number }> {
	const decoded = JSON.parse(entriesJson) as unknown;
	if (Array.isArray(decoded)) return { handedBack: false, records: 0 };
	const bytes = Buffer.from((decoded as { bytes: string }).bytes, "base64");
	const plan = decodeCanonical(new Uint8Array(bytes)) as { entries: { handedBack?: unknown }[]; handBacks?: unknown[] };
	return {
		handedBack: plan.entries.some((entry) => entry.handedBack !== undefined),
		records: plan.handBacks?.length ?? 0,
	};
}

async function scenario(directory: string, reopen: boolean) {
	const fixture = await readinessHoldRoom({ directory, writers: 1, createOperationAdmissionPolicy: doomingPolicy as never });
	const creator = await fixture.open(0, { reopen });
	const writer = await fixture.open(1, { reopen });
	const cursorFile = join(directory, "delivered.json");
	let delivered: number | null = existsSync(cursorFile) ? (JSON.parse(readFileSync(cursorFile, "utf8")) as number | null) : null;
	const setDelivered = (value: number | null): void => {
		delivered = value;
		writeFileSync(cursorFile, JSON.stringify(value));
	};
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const author = required(fixture.identities[1]).author;
	const scope = { objectId: fixture.objectId, author };
	const publishedAfter = async (after: number | null): Promise<readonly DurableIssuanceOutboxRecord[]> => {
		const store = await host.openIssuance("peer-1");
		try {
			return await store.readOutboxPage({
				scope,
				afterKey: after === null ? null : [fixture.objectId, author, after],
				limit: 128,
			});
		} finally {
			await store.close();
		}
	};
	/** The Writer's durable unconsumed hand-back records, read from its own store. */
	const records = async () => {
		const store = await host.openIssuance("peer-1");
		try {
			return ((await store.readSettlementPlan(scope))?.handBacks ?? []).filter((record) => record.reissueSequence === null);
		} finally {
			await store.close();
		}
	};
	const deliver = async (): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await publishedAfter(delivered);
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await creator.receive(chunk.slice(0, last + 1), 1);
			creator.inject(chunk.slice(last + 1), 1);
		}
		if (rows.length !== 0) setDelivered(required(rows.at(-1)).commit.authorSequence);
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
	const ids = (room: typeof creator): string[] =>
		(room.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();
	return { creator, writer, deliver, rollover, ids, publishedAfter, records, delivered: () => delivered, setDelivered };
}

it.runIf(INNER)(
	"the process dies at the decline's plan write",
	async () => {
		const directory = process.env.DECLINE_CRASH_DIRECTORY!;
		const edge = process.env.DECLINE_CRASH_EDGE as Edge;
		const deathFile = join(directory, "death.json");
		const watch = { armed: false, inside: false };
		const die = (detail: Record<string, unknown>): never => {
			writeFileSync(deathFile, JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL", ...detail }));
			process.kill(process.pid, "SIGKILL");
			throw Error("SIGKILL_DID_NOT_TERMINATE");
		};
		const exec = DatabaseSync.prototype.exec;
		DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
			const commit = sql === "COMMIT" || sql.endsWith("COMMIT");
			const issuance = this.location()?.endsWith(".drp-issuance-v1.sqlite") === true;
			// The connection sees its own uncommitted write: a handed-back plan with its record dropped.
			const declined = (): boolean => {
				watch.inside = true;
				try {
					return (this.prepare("SELECT entries_json FROM settlement_plans").all() as { entries_json: string }[])
						.map((row) => planState(row.entries_json))
						.some((state) => state.handedBack && state.records === 0);
				} finally {
					watch.inside = false;
				}
			};
			if (watch.armed && !watch.inside && commit && issuance && edge === "before" && declined())
				die({ at: "before-commit" });
			const result = exec.call(this, sql);
			if (watch.armed && !watch.inside && commit && issuance && edge === "after" && declined())
				die({ at: "after-commit" });
			return result;
		};
		const room = await scenario(directory, false);
		await room.writer.room.issue(block("w-0", 0));
		await room.deliver();
		await room.rollover(1);
		await room.deliver();
		await room.writer.room.issue(block("doomed-1", 1));
		const lost = await room.publishedAfter(room.delivered());
		expect(lost.filter((row) => !isControl(row)).length).toBe(1);
		room.setDelivered(required(lost.at(-1)).commit.authorSequence);
		await room.rollover(2);
		const given = required(required(room.writer.room.settlementStatus?.()).undelivered[0]);
		expect(given.operations[0]?.id).toBe("doomed-1");
		writeFileSync(join(directory, "hand-back.json"), JSON.stringify(given.handBack));
		watch.armed = true;
		await required(room.writer.room.declineHandBack)(given.handBack);
		throw Error(`DECLINE_CRASH_EDGE_NOT_REACHED:${edge}`);
	},
	300_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL %s the decline commit: the record is there or gone, the move never lands, and the Writer keeps playing",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), `refused-replay-decline-crash-${edge}-`));
		const file = fileURLToPath(import.meta.url);
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			env: { ...process.env, RUN_DECLINE_CRASH: "1", DECLINE_CRASH_DIRECTORY: directory, DECLINE_CRASH_EDGE: edge },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile)) throw new Error(`the process did not die at ${edge}:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Record<string, unknown>;
		expect(death).toMatchObject({ signal: "SIGKILL", edge });
		const handBack = JSON.parse(readFileSync(join(directory, "hand-back.json"), "utf8")) as {
			sourceSequence: number;
			intent: number;
		};

		const room = await scenario(directory, true);
		expect(room.writer.room.authority()?.epoch).toBe(2);
		const durable = await room.records();
		// The decline is one write: before its commit the record is whole, after it the record is gone.
		expect(durable.length, "the record is whole or gone").toBe(edge === "before" ? 1 : 0);
		if (edge === "before") {
			expect(durable[0]).toMatchObject(handBack);
			expect(decodeCanonical(required(durable[0]).exactCanonicalOperationBytes)).toMatchObject({ id: "doomed-1" });
		}
		const again = await required(room.writer.room.declineHandBack)(handBack);
		console.log(`DECLINE_CRASH ${JSON.stringify({ edge, death, durable: durable.length, again })}`);
		expect(again.kind).toBe(edge === "before" ? "declined" : "absent");
		expect(await room.records()).toEqual([]);

		// The Writer keeps playing; the declined move is never replayed and never admitted.
		await room.deliver();
		await room.writer.room.issue(block("w-2", 2));
		await room.deliver();
		await room.rollover(3);
		await room.deliver();
		await room.rollover(4);
		expect(room.ids(room.creator)).toEqual(["w-0", "w-2"]);
		expect(room.ids(room.writer)).toEqual(["w-0", "w-2"]);
		expect(required(room.writer.room.settlementStatus?.()).undelivered).toEqual([]);
	},
	600_000
);
