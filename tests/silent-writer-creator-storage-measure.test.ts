/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import { fromBase64, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// MEASUREMENT (observation only, no assertion on growth): the creator's native storage per
// epoch while one Grid Writer is silent (its rows never reach the creator and it makes no
// move), against a control where the same Writer's settlement rows are delivered. Scenario
// source: app-rollover-silent-writer-settlement-red.test.ts. Run with
// SILENT_WRITER_CREATOR_MEASURE=silent|delivered (and _OUT=<file.json>).
const MODE = process.env.SILENT_WRITER_CREATOR_MEASURE;
const MOVES = Number(process.env.SILENT_WRITER_CREATOR_MOVES ?? 100);
const OUT = process.env.SILENT_WRITER_CREATOR_OUT;

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const rowValue = (row: WireRow) =>
	decodeCanonical(fromBase64(row.preimage)) as { epoch: number; operation: { action: string } };

it.skipIf(MODE !== "silent" && MODE !== "delivered")(
	"creator storage per epoch with a silent (or delivered) Grid Writer",
	async () => {
		const restore = await installEnvironment("node", () => undefined);
		const directory = mkdtempSync(join(tmpdir(), "silent-writer-creator-"));
		directories.push(directory);
		const samples: unknown[] = [];
		try {
			const options = { app: "grid" as const, host: "node" as const, recipient: "writer" as const, creatorLull: false,
				epochs: 1, moves: 1, chatFormat: "shares" as const, rollover: "app" as const };
			const env = {
				host: nodeHostFor("node", directory),
				unique: directory,
				track,
				openFloor: (role: string) => createNodeRoomHeadAuthority({ filename: join(directory, `${role}-external-floor.sqlite`),
					initialization: { kind: "create" as const } }),
			};
			const creator = await openRole(options, 0, env);
			const writer = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
			const peers = [creator, writer] as const;
			const wire = successorWire(() => peers);
			const delivered: (number | null)[] = [null, null];
			const deliver = async (from: 0 | 1): Promise<void> => {
				const published = await peers[from].published(delivered[from]);
				if (published.length === 0) return;
				const receiver = peers[from === 0 ? 1 : 0];
				const current = (await receiver.authorityEpoch()) ?? 0;
				const ahead = published.findIndex((row) => rowValue(row).epoch > current);
				const rows = ahead < 0 ? published : published.slice(0, ahead);
				if (rows.length === 0) return;
				await receiver.inject(rows.filter((row) => rowValue(row).epoch === current));
				delivered[from] = rows.at(-1)?.authorSequence ?? delivered[from];
			};
			let lastEpoch = -1;
			const sample = async (ordinal: number) => {
				const epoch = (await creator.authorityEpoch()) ?? 0;
				if (epoch === lastEpoch) return;
				lastEpoch = epoch;
				const writerEpoch = (await writer.authorityEpoch()) ?? null;
				samples.push({ ordinal, epoch, writerEpoch, creator: await creator.census() });
				process.stdout.write(`SILENT_CREATOR ${MODE} epoch=${epoch} writer=${writerEpoch} ordinal=${ordinal}\n`);
			};
			try {
				for (let ordinal = 0; ordinal < MOVES; ordinal++) {
					await creator.issue(0, ordinal);
					await deliver(0);
					if (MODE === "delivered") await deliver(1);
					await sample(ordinal);
				}
				const target = (await creator.rollover?.())?.epoch ?? 0;
				// Let the Writer follow as far as it can (bounded), then take a final sample.
				for (let round = 0; round < 3; round++) {
					try { await wire.caughtUp(target, 20_000); } catch { /* the silent Writer may strand */ }
					if (MODE === "delivered") await deliver(1);
				}
				lastEpoch = -1;
				await sample(MOVES);
			} finally {
				const member = await writer.successorDelivery?.();
				const policy = await creator.rollover?.();
				process.stdout.write(`SILENT_CREATOR_END ${MODE} creatorEpoch=${policy?.epoch} errors=${JSON.stringify(policy?.errors)} member=${JSON.stringify({ ...member, refusals: member?.refusals.length, firstRefusal: member?.refusals[0] })}\n`);
				await wire.stop();
			}
		} finally {
			if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(samples));
			restore();
		}
		expect(samples.length).toBeGreaterThan(0);
	},
	600_000
);
