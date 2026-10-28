/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import { fromBase64, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Fixed (fix/silent-writer-catchup): formerly a skipped RED. A Grid Writer whose own rows
// never reach the creator (it makes no move, and nothing carries its settlement rows: a Writer
// that cannot send) follows the creator's automatic rollovers by the pages' own successor
// delivery. After about eight rollovers its install fails hard: the creator's journal retirement
// reports malformed input, and every later install of the Writer refuses the same way, so the
// Writer never catches up again. The expected behaviour is that a Writer that cannot send still
// follows every successor (or is told, terminally, why it cannot).
//
// Found running app-rollover-policy-native's ["grid", "silent-writer"] case without delivering the
// Writer's rows (deliver(1)). Run it with APP_ROLLOVER_SILENT_WRITER_RED=1.
//
// Diagnosis (fix/recipient-stuck-authority): two defects. (1) The trigger: each epoch whose own
// rows the creator never acknowledged leaves the Writer one protected journal scope, and at
// epoch 8 the received turnover's journal retirement preparation carries 8 protected scopes,
// above LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes (7, the AHE generation bound), so
// captureJournalRetirementPreparation refuses it ("journal retirement refused: malformed-input")
// at the Writer's lull and every retry. Fixed by fix/silent-writer-catchup: the settlement window
// (V3_SETTLEMENT_OWN_WINDOW_EPOCHS) resolves a displaced own row as expired once it has waited the
// window (tests/app-rollover-silent-writer-catchup-native.test.ts covers moves, the status and the
// reconnect). (2) The wedge: that failed lull marks the room for recovery, whose reopen is halted on
// the lull's completed retirement; before the fix every later install refused "creator recipient
// current authority is unavailable". Fixed: the recovery reopen now runs the retirement resume.
// The final state comparison carries the creator's last rows once the Writer has caught up.
const enabled = process.env.APP_ROLLOVER_SILENT_WRITER_RED !== "0";
const MOVES = Number(process.env.APP_ROLLOVER_SILENT_WRITER_MOVES ?? 100);

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

it.skipIf(!enabled)(
	"a Grid Writer that cannot send its settlement still follows every automatic rollover",
	async () => {
		const restore = await installEnvironment("node", () => undefined);
		const directory = mkdtempSync(join(tmpdir(), "app-rollover-silent-writer-"));
		directories.push(directory);
		try {
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
			const peers = [creator, writer] as const;
			const wire = successorWire(() => peers);
			let delivered: number | null = null;
			// The creator's rows reach the Writer in its current epoch; the Writer's rows go nowhere.
			const deliverCreator = async (): Promise<void> => {
				const published = await creator.published(delivered);
				if (published.length === 0) return;
				const current = (await writer.authorityEpoch()) ?? 0;
				const ahead = published.findIndex((row) => rowValue(row).epoch > current);
				const rows = ahead < 0 ? published : published.slice(0, ahead);
				if (rows.length === 0) return;
				await writer.inject(rows.filter((row) => rowValue(row).epoch === current));
				delivered = rows.at(-1)?.authorSequence ?? delivered;
			};
			const followed: number[] = [];
			try {
				for (let ordinal = 0; ordinal < MOVES; ordinal++) {
					await creator.issue(0, ordinal);
					await deliverCreator();
				}
				const policy = await creator.rollover?.();
				const target = policy?.epoch ?? 0;
				// Follow each epoch the Writer reaches, so the failure says where it stopped.
				for (;;) {
					const reached = (await writer.successorDelivery?.())?.epoch ?? 0;
					if (followed.at(-1) !== reached) followed.push(reached);
					if (reached >= target) break;
					await wire.caughtUp(reached + 1, 60_000);
				}
			} finally {
				const member = await writer.successorDelivery?.();
				const policy = await creator.rollover?.();
				process.stdout.write(
					`SILENT_WRITER followed=${JSON.stringify(followed)} creatorEpoch=${policy?.epoch} creatorErrors=${JSON.stringify(policy?.errors)} firstRefusal=${JSON.stringify(member?.refusals[0])} member=${JSON.stringify({ ...member, refusals: member?.refusals.length })}\n`
				);
				await wire.stop();
			}
			expect(await writer.authorityEpoch()).toBe((await creator.rollover?.())?.epoch);
			// Remote ingress is asynchronous: wait (bounded) for the delivered rows to join.
			await deliverCreator();
			const deadline = performance.now() + 30_000;
			while ((await writer.state()) !== (await creator.state()) && performance.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 100));
			expect(await writer.state()).toBe(await creator.state());
		} finally {
			restore();
		}
	},
	1_200_000
);
