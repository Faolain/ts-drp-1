/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole, type RoleEnvironment } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Found by fix/slow-member-follow; the defect is in the retained-work resolution of a skip install
// (fix/silent-writer-catchup, v3-room resolveRetainedFromFrontier), not in that branch's change.
//
// A Writer that skip-installs (an install more than one epoch ahead) with moves in flight more than
// once. The first skip's in-flight moves are resolved from the creator's frontier (never admitted:
// given back, offered again, admitted once). The moves in flight at the second and later skips stay
// "manual-review" in the settlement plan for good: never admitted, never given back, while
// settlementStatus() reports nothing waiting (unsettledEpochs 0, nothing undelivered).

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

type RowValue = { epoch: number; author: string; authorSequence: number; operation: Record<string, unknown> };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};

type MemberHooks = Pick<RoleEnvironment, "deliveryRoom"> & Readonly<{ relay?(request: string, forward: () => Promise<string[]>): Promise<string[]> }>;

async function openPair(directory: string, member: MemberHooks = {}) {
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
	const writer = await openRole(options, 1, {
		...env,
		...(member.deliveryRoom === undefined ? {} : { deliveryRoom: member.deliveryRoom }),
		relay: (request) =>
			member.relay === undefined ? creator.dispatch(request) : member.relay(request, () => creator.dispatch(request)),
	});
	return { creator, writer };
}

/** The scripted row wire: each side's rows reach the other only in the receiver's current epoch. */
function rowWire(creator: RoleEndpoint, writer: RoleEndpoint) {
	const cursor = { creator: null as number | null, writer: null as number | null };
	const carry = async (from: RoleEndpoint, to: RoleEndpoint, key: "creator" | "writer") => {
		const published = await from.published(cursor[key]);
		if (published.length === 0) return;
		const current = (await to.authorityEpoch()) ?? 0;
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		if (rows.length === 0) return;
		await to.inject(rows.filter((row) => rowValue(row).epoch === current));
		cursor[key] = rows.at(-1)?.authorSequence ?? cursor[key];
	};
	return {
		toWriter: () => carry(creator, writer, "creator"),
		toCreator: () => carry(writer, creator, "writer"),
	};
}

/** Creator moves (with the creator's rows carried to the Writer) until its policy rolls the epoch. */
async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creator.issue(0, ordinal.next++);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await sleep(100);
	}
}

/** Accepted vertices of `author` carrying each move id, on one replica. */
async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[]) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map((id) => vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length);
}


async function repeatedSkips(connectedEpochs: number) {
		const restore = await installEnvironment("node", () => undefined);
		const directory = mkdtempSync(join(tmpdir(), "app-rollover-repeated-skip-"));
		directories.push(directory);
		try {
			const { creator, writer } = await openPair(directory);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: 0 };
			const ids: string[] = [];
			let n = 0;
			let epoch = 0;
			try {
				// Connected for `connectedEpochs` epochs first: rows both ways.
				while (epoch < connectedEpochs) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch);
					await rows.toWriter();
					await writer.issue(epoch, n);
					ids.push(`block-1-${n++}`);
					await rows.toCreator();
				}
				let writerAuthor = "";
				for (let skip = 0; skip < 3; skip++) {
					// Two moves the creator never receives, then the creator rolls three epochs before the
					// Writer hears of any: its next install skips them.
					for (let k = 0; k < 2; k++) {
						await writer.issue(epoch, n);
						ids.push(`block-1-${n++}`);
					}
					writerAuthor ||= rowValue((await writer.published(null))[0]!).author;
					await wire.pause();
					for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
					wire.resume();
					await wire.caughtUp(epoch);
					await rows.toWriter();
					process.stdout.write(
						`REPEATED_SKIP ${JSON.stringify({ skip, epoch, settlement: await writer.settlementStatus?.(), plan: (await writer.settlementAudit()).dispositions })}\n`
					);
				}
				// Connected again: every move must reach the creator once (given back and offered again).
				await waitFor(
					"the creator admits every move of the Writer",
					async () => {
						await rows.toCreator();
						const counts = await acceptedCounts(creator, writerAuthor, ids);
						if (counts.some((count) => count === 0)) {
							epoch = await rollCreator(creator, rows.toWriter, ordinal);
							await wire.caughtUp(epoch);
							await rows.toWriter();
						}
						return { counts, settlement: await writer.settlementStatus?.(), plan: (await writer.settlementAudit()).dispositions };
					},
					(value) => value.counts.every((count) => count >= 1),
					180_000
				);
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await rows.toCreator();
				expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
			} finally {
				process.stdout.write(
					`REPEATED_SKIP_SUMMARY ${JSON.stringify({ epoch, ids, plan: await writer.settlementAudit(), status: await writer.rolloverStatus?.() })}\n`
				);
				await wire.stop();
			}
		} finally {
			restore();
		}
}

it(
	"moves in flight at each of three skip installs are each admitted once (repeated skip installs)",
	() => repeatedSkips(2),
	600_000
);

it(
	"moves in flight at each of three skip installs are each admitted once, the first install already a skip",
	() => repeatedSkips(0),
	600_000
);

// RED (fix/int7-handback-policy): a Writer whose first install is a skip gives back its own bootstrap
// operation. The Writer's sequence-0 row carries the application's bootstrapOperation (Grid:
// installRoster), which the creator never received; the settlement window resolves it as expired and
// writeMergedSettlementPlan records a hand-back for it like a move. The application then offers
// installRoster again as a move, and when that row is displaced in turn the room's settlement policy
// has no displacement policy for it ("v3 room settlement policy is unavailable"), the install fails
// and the session closes. Only operations the application can re-derive (those with a displacement
// policy) may be given back.
it("a Writer whose first install is a skip gives back only its moves, never its bootstrap operation", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-first-skip-bootstrap-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		try {
			for (let k = 0; k < 2; k++) await writer.issue(epoch, k);
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, () => Promise.resolve(), ordinal);
			wire.resume();
			await wire.caughtUp(epoch);
			await rows.toWriter();
			const status = (await writer.settlementStatus?.()) as {
				undelivered?: readonly { operations: readonly Record<string, unknown>[] }[];
			} | null;
			const givenBack = (status?.undelivered ?? []).flatMap((entry) => entry.operations.map((op) => op.action));
			process.stdout.write(`FIRST_SKIP_BOOTSTRAP ${JSON.stringify({ epoch, givenBack })}\n`);
			expect(givenBack.length, "the Writer's two moves are given back").toBeGreaterThan(0);
			expect(
				givenBack.filter((action) => action !== "placeBlock"),
				"given back only moves"
			).toEqual([]);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}, 300_000);
