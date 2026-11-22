/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import type { RoleEndpoint } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Cost guard for the member lull's settling (84917587): a member that issues nothing (receive-only)
// pays no confirming received-turnover pass in its lull. The settling's further pass decides the
// issuance on the drained journal; it releases only the member's own rows that the previous pass's
// decision still held. A receive-only member has none, so its lull runs exactly the passes it ran
// before (2d825dec: 2 per steady epoch; 84917587: 3, one pass that releases nothing every epoch).
// A Writer's further pass is not idle: it releases its committed rows of the drained scope, as the
// install's turnover did before the skip (app-rollover-skip-member-retirement-native). Its install
// still skips the turnover its lull ran.
const EPOCHS = 8;

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

type Settle = { epoch: number; passes: number; settled: boolean };

it("a receive-only member's lull runs no confirming turnover pass and its install keeps the skip", async () => {
	const events: Readonly<Record<string, unknown>>[] = [];
	const restore = await installEnvironment("node", (event) => events.push(event));
	const directory = mkdtempSync(join(tmpdir(), "member-lull-turnover-cost-"));
	directories.push(directory);
	const options = {
		// Grid enrolls its members as Writers (a receive-only reader may not fetch its successor material).
		app: "canvas" as const,
		host: "node" as const,
		recipient: "receive-only" as const,
		creatorLull: false,
		epochs: EPOCHS,
		moves: 1,
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
	try {
		const creator = await openRole(options, 0, env);
		const member = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
		const cursor: (number | null)[] = [null, null];
		const flush = async (from: RoleEndpoint, to: RoleEndpoint, key: 0 | 1) => {
			const rows = await from.published(cursor[key]);
			const last = rows.at(-1);
			if (last === undefined) return;
			await to.receive(rows);
			cursor[key] = last.authorSequence;
		};
		const observed: { epoch: number; lull: string; settle: Settle[]; install: string[]; unsettled: number }[] = [];
		for (let epoch = 0; epoch < EPOCHS; epoch++) {
			await creator.issue(epoch, 0);
			await flush(creator, member, 0);
			await creator.seal(epoch);
			await creator.adopt();
			const offer = (await creator.exportOffer()).offer;
			const installFrom = events.length;
			await member.install(offer);
			const install = events
				.slice(installFrom)
				.filter((event) => event.kind === "recipient-received-turnover")
				.map((event) => String(event.outcome));
			await creator.lull();
			const lullFrom = events.length;
			const lull = await member.lull();
			const settle = events
				.slice(lullFrom)
				.filter((event) => event.kind === "recipient-lull-turnover-settle")
				.map((event) => event as unknown as Settle);
			const settlement = (await member.settlementStatus?.()) as { unsettledEpochs?: number } | null;
			observed.push({
				epoch: epoch + 1,
				lull: lull.kind,
				settle,
				install,
				unsettled: settlement?.unsettledEpochs ?? -1,
			});
			process.stdout.write(`MEMBER_LULL_COST ${JSON.stringify(observed.at(-1))}\n`);
		}
		await member.close();
		await creator.close();
		const steady = observed.filter((record) => record.epoch >= 5);
		for (const record of steady) {
			expect(record.lull, `lull of epoch ${record.epoch}`).toBe("maintained");
			expect(record.settle, `settling of epoch ${record.epoch}`).toHaveLength(1);
			expect(record.settle[0]?.settled, `settled at epoch ${record.epoch}`).toBe(true);
			// The pass count of 2d825dec: no confirming pass.
			expect(record.settle[0]?.passes, `lull passes at epoch ${record.epoch}`).toBeLessThanOrEqual(2);
			expect(record.unsettled, `unsettled at epoch ${record.epoch}`).toBe(0);
		}
		// The next install skips the turnover its lull ran (7125cdb1).
		for (const record of steady.slice(1))
			expect(record.install, `install of epoch ${record.epoch}`).not.toContain("ran");
	} finally {
		restore();
	}
}, 900_000);
