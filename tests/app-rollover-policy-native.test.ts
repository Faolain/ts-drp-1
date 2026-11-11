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
	type AppKind,
	fromBase64,
	type RecipientMode,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// App rollover policy: each shipped application rolls its own room over. Measured on native
// SQLite (app-rollover-ceiling-native.test.ts), one epoch admits at most 40 of the creator's own
// moves in Canvas and Grid (the creator's issuance image), and 14 of one author's short messages
// in Chat (its per-checkpoint allowance). Each case plays well past that ceiling per role with no
// harness seal: the creator's application policy must roll the room over by itself, every move
// must be accepted (none strands at the ceiling, none is lost), and both roles must converge on
// state that contains every accepted move. Successor offers travel by the pages' own delivery
// (examples/v3-room successor-delivery); the harness only carries rows and the delivery's frames.
const MOVES: Readonly<Record<AppKind, number>> = { canvas: 100, grid: 100, chat: 35 };
// Creator-only play has a receive-only recipient, except in Grid: its members are enrolled
// Writers (a receive-only recipient is not authorised to fetch Grid's successor material), so its
// creator-only case has a Writer that issues nothing.
type Recipient = RecipientMode | "silent-writer";
const cases: readonly (readonly [AppKind, Recipient])[] = [
	["canvas", "receive-only"],
	["canvas", "writer"],
	["chat", "receive-only"],
	["chat", "writer"],
	["grid", "silent-writer"],
	["grid", "writer"],
];

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

async function openApp(
	app: AppKind,
	recipient: RecipientMode,
	rolloverBudget?: Readonly<{ movesPerAuthor: number; idleMs: number }>
) {
	const directory = mkdtempSync(join(tmpdir(), `app-rollover-${app}-`));
	directories.push(directory);
	const options = {
		app,
		host: "node" as const,
		recipient,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
		...(rolloverBudget === undefined ? {} : { rolloverBudget }),
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
	const other = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
	return [creator, other] as const satisfies readonly [RoleEndpoint, RoleEndpoint];
}

/**
 * Plays `moves` per role (alternating, the creator first) with no harness seal. The creator's
 * delivery announces each adopted offer and the member's delivery installs it; the harness wire
 * carries their frames in the background, concurrent with play (a Writer's move refused at
 * capacity waits for that install), and the harness carries every published row in the receiver's
 * epoch. It then checks that every move was accepted, both roles
 * converged, and the state holds every accepted move.
 * @param app - The application.
 * @param recipient - The other role.
 * @param moves - Moves per role.
 * @param rolloverBudget - Test-only trigger values replacing the application's.
 * @param creatorMoves - The creator's own moves (default `moves`); fewer makes a Writer the hot author.
 * @returns The creator's policy observation.
 */
async function playPastCeiling(
	app: AppKind,
	recipient: Recipient,
	moves: number,
	rolloverBudget?: Readonly<{ movesPerAuthor: number; idleMs: number }>,
	creatorMoves = moves
) {
	const peers = await openApp(app, recipient === "receive-only" ? "receive-only" : "writer", rolloverBudget);
	const [creator, other] = peers;
	const writer = recipient === "writer";
	const delivered: (number | null)[] = [null, null];
	const wire = successorWire(() => peers);
	// Every new row of `from` in the receiver's current epoch, then a bounded wait for the last
	// one's acceptance. Rows of an earlier epoch are not delivered, and a row the receiver does not
	// accept is not retried here: a Writer's row the creator closed its epoch without is replaced
	// by the Writer's settlement once it installs the successor. The final state check is what
	// proves no accepted move was lost.
	const deliver = async (from: 0 | 1): Promise<void> => {
		const published = await peers[from].published(delivered[from]);
		const receiver = peers[from === 0 ? 1 : 0];
		const current = (await receiver.authorityEpoch()) ?? 0;
		// A row of an epoch the receiver has not installed yet waits for that install.
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		const last = rows.at(-1);
		if (last === undefined) return;
		const live = rows.filter((row) => rowValue(row).epoch === current);
		delivered[from] = last.authorSequence;
		if (live.length === 0) return;
		await receiver.inject(live);
		// Control rows ($drp.*) are not application acceptance; join the last ordinary move.
		const final = live.findLast((row) => !rowValue(row).operation.action.startsWith("$drp."));
		if (final === undefined) return;
		for (const deadline = performance.now() + 5_000; performance.now() < deadline; ) {
			if ((await receiver.acceptance([final.digest]))[0] === true) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	// Like a room's sync after a reconnect: rows of the receiver's current epoch that it has not
	// accepted (a row injected while its install was replacing the live plane is dropped) are
	// offered again.
	const redeliver = async (from: 0 | 1): Promise<void> => {
		const receiver = peers[from === 0 ? 1 : 0];
		const current = (await receiver.authorityEpoch()) ?? 0;
		const rows = (await peers[from].published(null)).filter((row) => rowValue(row).epoch === current);
		if (rows.length === 0) return;
		const known = await receiver.acceptance(rows.map((row) => row.digest));
		const missing = rows.filter(
			(row, index) => known[index] !== true && !rowValue(row).operation.action.startsWith("$drp.")
		);
		const final = missing.at(-1);
		if (final === undefined) return;
		await receiver.inject(rows);
		for (const deadline = performance.now() + 5_000; performance.now() < deadline; ) {
			if ((await receiver.acceptance([final.digest]))[0] === true) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const accepted: { role: number; ordinal: number }[] = [];
	// A stalled run says where it stands (which role's move, and each policy's view).
	let step = "open";
	const watchdog = setInterval(() => {
		void Promise.all([creator.rollover?.(), other.rollover?.(), other.authorityEpoch()]).then(([own, member, epoch]) =>
			process.stdout.write(
				`ROLLOVER_PROGRESS ${app}/${recipient} step=${step} creator=${JSON.stringify({ epoch: own?.epoch, rollovers: own?.rollovers, waiting: own?.waiting, errors: own?.errors })} member=${JSON.stringify({ epoch, waiting: member?.waiting })}\n`
			)
		);
	}, 30_000);
	try {
		for (let ordinal = 0; ordinal < moves; ordinal++) {
			if (ordinal < creatorMoves) {
				step = `creator#${ordinal}`;
				await creator.issue(0, ordinal);
				accepted.push({ role: 0, ordinal });
				await deliver(0);
			}
			// The member's own rows go to the creator even when it makes no move: each install
			// publishes the member's settlement of the epoch it leaves.
			await deliver(1);
			if (!writer) continue;
			step = `writer#${ordinal}`;
			await other.issue(0, ordinal);
			accepted.push({ role: 1, ordinal });
			await deliver(1);
		}
		// Quiesce: the last rollover joins, its offer is installed, and every row is delivered.
		step = "quiesce";
		for (let round = 0; round < 4; round++) {
			await wire.caughtUp((await creator.rollover?.())?.epoch ?? 0);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await deliver(0);
			await deliver(1);
			await redeliver(0);
			await redeliver(1);
		}
	} finally {
		clearInterval(watchdog);
		await wire.stop();
	}
	const policy = await creator.rollover?.();
	const member = await other.rollover?.();
	process.stdout.write(
		`ROLLOVER_EVENTS ${app}/${recipient} moves=${moves} ${JSON.stringify(policy?.events.map((event) => [event.epoch, event.trigger, event.moves, Math.round(event.ms)]))}\n`
	);
	const delivery = await other.successorDelivery?.();
	process.stdout.write(`ROLLOVER_DELIVERY ${app}/${recipient} ${JSON.stringify(delivery)}\n`);
	expect(delivery?.installed ?? 0, "the member's own delivery installed the successors").toBeGreaterThan(0);
	expect(policy?.errors ?? ["no creator policy"]).toEqual([]);
	expect(member?.waiting ?? 0).toBe(0);
	expect(await other.authorityEpoch()).toBe(policy?.epoch);
	const [left, right] = [await creator.state(), await other.state()];
	expect(left).toBe(right);
	const state = decodeCanonical(Uint8Array.from(Buffer.from(left, "hex"))) as {
		counters?: number[][];
		blocks?: { id: string; x: number }[];
		messages?: { clientOperationId: string }[];
	};
	if (app === "canvas")
		expect(state.counters?.reduce((sum, rgb) => sum + (rgb[0] ?? 0), 0)).toBe(
			accepted.reduce((sum, row) => sum + 1 + row.role, 0)
		);
	else if (app === "grid")
		expect(state.blocks?.map((block) => block.id).sort()).toEqual(
			accepted.map((row) => `block-${row.role}-${row.ordinal}`).sort()
		);
	else
		expect(new Set(state.messages?.map((message) => message.clientOperationId))).toEqual(
			new Set(accepted.map((row) => `m-${row.role}-0-${row.ordinal}`))
		);
	for (const audit of [await creator.settlementAudit(), await other.settlementAudit()])
		expect(audit.missing).toEqual([]);
	return policy;
}

it.each(cases)(
	"%s with a %s recipient: the application rolls its own room over past the ceiling and loses no move",
	async (app, recipient) => {
		const restore = await installEnvironment("node", () => undefined);
		try {
			const policy = await playPastCeiling(app, recipient, MOVES[app]);
			expect(policy?.rollovers ?? 0).toBeGreaterThanOrEqual(3);
			// The budget is safely under every epoch's ceiling: no move ever met a capacity refusal.
			expect(policy?.events.filter((event) => event.trigger === "refusal")).toEqual([]);
		} finally {
			restore();
		}
	},
	1_200_000
);

// The refusal path: with trigger values too high to fire, the creator's move at the native
// ceiling (Canvas: the 41st) or at Chat's allowance (the 15th short message, for the creator and
// for a Writer, who cannot seal and waits for the next installed epoch) is refused, rolled over
// and offered again, and is accepted.
it.each([
	["canvas", "receive-only", 60],
	["chat", "writer", 25],
] as const)(
	"%s with a %s recipient: a move refused at the ceiling is accepted after the rollover it triggers",
	async (app, recipient, moves) => {
		const restore = await installEnvironment("node", () => undefined);
		try {
			const policy = await playPastCeiling(app, recipient, moves, { movesPerAuthor: 10_000, idleMs: 3_600_000 });
			expect(policy?.events.map((event) => event.trigger)).toContain("refusal");
			expect(policy?.events.every((event) => event.trigger === "refusal")).toBe(true);
		} finally {
			restore();
		}
	},
	1_200_000
);

// A hot Writer (fix/maintenance-image-capacity): with trigger values too high to fire, the creator
// refuses the Writer's received moves once its per-epoch maintenance proof book (or issuance
// forecast) is full. That refusal is the typed capacity reason and the creator's policy seals at
// once, so the Writer's held moves land in the successor through the existing re-delivery and
// settlement: every move is accepted, nothing waits for a successor that never comes.
it("grid with a hot writer: a received move refused at the creator's capacity triggers a rollover and is accepted", async () => {
	const restore = await installEnvironment("node", () => undefined);
	try {
		// 400: past the creator's received-move refusal (about writer move 330) and short of the
		// Writer's own settlement row bound (the next case).
		const writerMoves = Number(process.env.HOT_WRITER_MOVES ?? 400);
		const policy = await playPastCeiling("grid", "writer", writerMoves, { movesPerAuthor: 100_000, idleMs: 3_600_000 }, 1);
		expect(policy?.events.map((event) => event.trigger)).toContain("refusal");
		expect(policy?.events.every((event) => event.trigger === "refusal")).toBe(true);
	} finally {
		restore();
	}
}, 1_800_000);

// Writer-side admission and maintenance agree (fix/maintenance-image-capacity): a hot Writer's
// moves the creator closed an epoch without are replaced at the successor's install, under the
// Writer's own issuance row and byte bound. At 1200 moves the Writer admitted moves whose
// replacements its store then refused (row bound) inside the install's drainRebaseOutbox, so it
// never installed. Its admission must reserve one replacement per own move of the epoch and refuse
// (typed, retry after rollover) otherwise; then every admitted move settles. The Writer cannot seal:
// its refused move waits for the creator's next rollover (a received refusal, or the idle timer).
it("grid with a hot writer: no admitted move's settlement is refused by the Writer's own store", async () => {
	const restore = await installEnvironment("node", () => undefined);
	try {
		const writerMoves = Number(process.env.HOT_WRITER_SETTLEMENT_MOVES ?? 1200);
		await playPastCeiling("grid", "writer", writerMoves, { movesPerAuthor: 100_000, idleMs: 20_000 }, 1);
	} finally {
		restore();
	}
}, 3_600_000);
