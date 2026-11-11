/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// RED first (fix/int7-turnover-skip-bounds): a silent Writer whose own lull ran the received turnover
// keeps its install's turnover skip AND keeps its own work within the settlement window.
//
// 7125cdb1 lets a member's install skip the received turnover its own lull just ran at the same
// boundary. The lull's turnover is not at a fixpoint when it drains a closed journal scope: its
// issuance decision P classified the Writer's own issued rows from the journal as it was before that
// drain, so the rows of the drained scope stay protected; a further pass at the same boundary resumes
// the same P (the recipient never acknowledged the completed drain, so the drain's reconstruction
// re-derives P) and changes nothing. Before the skip, the install's turnover was that further pass: its
// received closed membership changes the source, the reconstruction is declined, a fresh P on the
// physical journal releases the rows, and the install's cleanup prunes them before its settlement write.
// With the skip, the release waits for the next lull, one epoch later, so the Writer holds its oldest
// displaced source one epoch past the window: unsettledEpochs 5 > window 4 from epoch 5 on (measured on
// perf/integration-7 2d825dec; the catchup test's plan climbs to 25 > 20).
//
// The fix must keep both halves: the install still skips ("reconciled", the epoch-4 slowdown that
// member-install-after-lull-turnover-native guards), and the Writer's unsettled epochs stay within
// the window at every epoch.
const EPOCHS = 7;

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

const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as { epoch: number };

async function openPair(directory: string) {
	const options = {
		app: "grid" as const,
		host: "node" as const,
		recipient: "writer" as const,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
	};
	const env = {
		host: nodeHostFor("node", directory),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: "create" as const },
			}),
	};
	const creator = await openRole(options, 0, env);
	const writer = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
	return { creator, writer };
}

/** The creator's rows reach the Writer in its current epoch; the Writer's rows reach no one. */
function creatorRows(creator: RoleEndpoint, writer: RoleEndpoint) {
	let cursor: number | null = null;
	return async () => {
		const published = await creator.published(cursor);
		if (published.length === 0) return;
		const current = (await writer.authorityEpoch()) ?? 0;
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		if (rows.length === 0) return;
		await writer.inject(rows.filter((row) => rowValue(row).epoch === current));
		cursor = rows.at(-1)?.authorSequence ?? cursor;
	};
}

async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creator.issue(0, ordinal.next++);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}

type Settlement = Readonly<{ epoch: number; unsettledEpochs: number; window: number }>;

it("a silent Writer's install keeps its lull skip and its own work stays within the settlement window", async () => {
	const turnovers: { epoch: number; outcome: string }[] = [];
	const restore = await installEnvironment("node", (event) => {
		if (event.kind === "recipient-received-turnover")
			turnovers.push({ epoch: Number(event.epoch), outcome: String(event.outcome) });
	});
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-silent-writer-lull-skip-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const toWriter = creatorRows(creator, writer);
		const ordinal = { next: 0 };
		const observed: { epoch: number; unsettled: number; window: number; install: string[] }[] = [];
		try {
			for (let epoch = 0; epoch < EPOCHS; ) {
				const from = turnovers.length;
				epoch = await rollCreator(creator, toWriter, ordinal);
				await wire.caughtUp(epoch, 120_000);
				await toWriter();
				await writer.issue(1, epoch);
				// The room's settlement as of this install (its drain writes the plan after the install).
				let settlement = (await writer.settlementStatus?.()) as Settlement | null;
				for (
					const deadline = performance.now() + 30_000;
					(settlement?.epoch ?? -1) < epoch && performance.now() < deadline;

				) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					settlement = (await writer.settlementStatus?.()) as Settlement | null;
				}
				expect(settlement?.epoch, "the install's settlement").toBe(epoch);
				observed.push({
					epoch,
					unsettled: settlement?.unsettledEpochs ?? -1,
					window: settlement?.window ?? -1,
					install: turnovers.slice(from).map((event) => event.outcome),
				});
				process.stdout.write(`SILENT_WRITER_LULL_SKIP ${JSON.stringify(observed.at(-1))}\n`);
			}
		} finally {
			await wire.stop();
		}
		// The skip is kept: from the Writer's epoch 4 install on (its lull ran at that epoch), the
		// install's received turnover is "reconciled", never "ran".
		for (const record of observed.filter((value) => value.epoch >= 5))
			expect(record.install, `install of epoch ${record.epoch}`).toEqual(["reconciled"]);
		// Retention: the Writer's oldest displaced own source is never older than the window.
		for (const record of observed) {
			expect(record.window).toBe(4);
			expect(record.unsettled, `epoch ${record.epoch}`).toBeLessThanOrEqual(record.window);
		}
	} finally {
		restore();
	}
}, 900_000);
