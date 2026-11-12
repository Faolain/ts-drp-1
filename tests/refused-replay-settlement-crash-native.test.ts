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

// Refused replay across process death (fix/refused-replay-settlement). A Writer's displaced move whose
// replay its own admission refuses at an install is handed back in ONE settlement plan write: the
// source's entry becomes `expire` with `handedBack`, and the hand-back records carrying the reason are
// added. The whole process (creator and Writer) is SIGKILLed at that write:
//   before: as the Writer's issuance store is about to COMMIT the write (the write is lost);
//   after:  right after that COMMIT (the write is durable, the install is not finished).
// The same directory is reopened. Wanted, either way: the move is listed exactly once, typed with the
// refusal reason, never replayed (the creator never admits it), and the Writer keeps installing and
// playing. No native write, signature or transaction is mocked.

const INNER = process.env.RUN_REFUSED_REPLAY_CRASH === "1";
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

/** Whether a settlement plan row's stored entries carry a refused replay's hand-back. */
function handedBackIn(entriesJson: string): boolean {
	const decoded = JSON.parse(entriesJson) as unknown;
	if (Array.isArray(decoded)) return false;
	const bytes = Buffer.from((decoded as { bytes: string }).bytes, "base64");
	const plan = decodeCanonical(new Uint8Array(bytes)) as { entries: { handedBack?: unknown }[] };
	return plan.entries.some((entry) => entry.handedBack !== undefined);
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
	// The Writer's published rows, read through a host that reopens its store (the fixture's own
	// reader creates stores, which a reopened directory already holds).
	const reader = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const author = required(fixture.identities[1]).author;
	const publishedAfter = async (after: number | null): Promise<readonly DurableIssuanceOutboxRecord[]> => {
		const store = await reader.openIssuance("peer-1");
		try {
			return await store.readOutboxPage({
				scope: { objectId: fixture.objectId, author },
				afterKey: after === null ? null : [fixture.objectId, author, after],
				limit: 128,
			});
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
	const install = async (epoch: number): Promise<void> => {
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const rollover = async (epoch: number): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await install(epoch);
	};
	const ids = (room: typeof creator): string[] =>
		(room.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();
	return { fixture, creator, writer, deliver, install, rollover, ids, publishedAfter, delivered: () => delivered, setDelivered };
}

it.runIf(INNER)(
	"the process dies at the refused replay's hand-back write",
	async () => {
		const directory = process.env.REFUSED_REPLAY_CRASH_DIRECTORY!;
		const edge = process.env.REFUSED_REPLAY_CRASH_EDGE as Edge;
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
			const handedBack = (): boolean => {
				watch.inside = true;
				try {
					return (this.prepare("SELECT entries_json FROM settlement_plans").all() as { entries_json: string }[]).some(
						(row) => handedBackIn(row.entries_json)
					);
				} finally {
					watch.inside = false;
				}
			};
			// The connection sees its own uncommitted write: the COMMIT about to run carries the hand-back.
			if (watch.armed && !watch.inside && commit && issuance && edge === "before" && handedBack())
				die({ at: "before-commit" });
			const result = exec.call(this, sql);
			if (watch.armed && !watch.inside && commit && issuance && edge === "after" && handedBack())
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
		const sealed = await room.creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await room.creator.room.adoptCreatorSuccessor();
		watch.armed = true;
		await room.install(2);
		throw Error(`REFUSED_REPLAY_CRASH_EDGE_NOT_REACHED:${edge}`);
	},
	300_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL %s the hand-back commit: the refused move is listed once, never replayed, and the Writer keeps playing",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), `refused-replay-crash-${edge}-`));
		const file = fileURLToPath(import.meta.url);
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			env: {
				...process.env,
				RUN_REFUSED_REPLAY_CRASH: "1",
				REFUSED_REPLAY_CRASH_DIRECTORY: directory,
				REFUSED_REPLAY_CRASH_EDGE: edge,
			},
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

		const room = await scenario(directory, true);
		// The creator adopted epoch 2 before the death; the Writer's install of it did not finish.
		expect(room.creator.room.authority()?.epoch).toBe(2);
		if ((room.writer.room.authority()?.epoch ?? 0) < 2) await room.install(2);
		const status = required(room.writer.room.settlementStatus?.());
		console.log(`REFUSED_REPLAY_CRASH ${JSON.stringify({ edge, death, writerEpoch: room.writer.room.authority()?.epoch, status })}`);
		const undelivered = status.undelivered;
		expect(undelivered.map((move) => move.operations[0]?.id), "listed exactly once").toEqual(["doomed-1"]);
		expect(Reflect.get(required(undelivered[0]), "reason")).toBe("admission-rejected");

		// The Writer keeps playing; the refused move is never replayed and never admitted.
		await room.deliver();
		await room.writer.room.issue(block("w-2", 2));
		await room.deliver();
		await room.rollover(3);
		await room.deliver();
		await room.rollover(4);
		expect(room.ids(room.creator)).toEqual(["w-0", "w-2"]);
		expect(room.ids(room.writer)).toEqual(["w-0", "w-2"]);
		const later = required(room.writer.room.settlementStatus?.()).undelivered;
		expect(later.map((move) => move.operations[0]?.id), "still listed once").toEqual(["doomed-1"]);
	},
	600_000
);
