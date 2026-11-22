/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

// A slow Grid Writer that follows the creator only by skip installs (each two epochs ahead), making a
// move in each epoch it is at, then catches up and delivers every epoch. Once it delivers, its own
// issued rows must retire back to a flat level: its oldest own row advances, its journal scope 0 is
// collected and its plan entries stop growing.
//
// SKIP_MEMBER_ONLY=adjacent|skip runs one of the two.
//
// The slow-member measurement (fix/skip-scope-carrier, conserve-counts-settle-01): after the first
// skip install the member's oldest own row stayed (epoch 0, sequence 0) for good, its own rows grew
// 22 -> 128 and its plan entries 57 -> 153, and its journal scope 0 stayed protected. Measured here, a
// Grid Writer that follows adjacently from the start leaks the same way: its own pinned bootstrap
// (sequence 0, epoch 0, terminal under the creator's frontier, no plan entry) never counts as settled
// for its journal scope 0, so that scope is never collected, its rows 0 and 1 stay retirement holes
// and the prefix pruner never passes them (two own rows and one plan entry more per epoch).
const SKIPS = Number(process.env.SKIP_MEMBER_SKIPS ?? 5);
const DELIVERING = Number(process.env.SKIP_MEMBER_DELIVERING ?? 8);
const ONLY = process.env.SKIP_MEMBER_ONLY;
const WINDOW = 4;

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
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new TypeError("SKIP_MEMBER_REQUIRED_VALUE");
	return value;
};
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;

// The Writer's issuance pruning watermark and retirement holes (protected own rows), read straight from
// its SQLite file (diagnostics: which own row stops the prefix and why).
function issuanceRetirement(directory: string, name: string) {
	const file = join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["issuance", name]))
			.digest("hex")}.sqlite.drp-issuance-v1.sqlite`
	);
	if (!existsSync(file)) return null;
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const pruned = db
			.prepare("SELECT author, pruned_through_author_sequence AS through FROM lineages")
			.all()
			.map((row) => [String(row.author).slice(0, 8), row.through]);
		let through: number | null = null;
		let holes: [string, number][] = [];
		for (const row of db.prepare("SELECT record FROM retirement_controls").all()) {
			const value = decodeCanonical(row.record as Uint8Array) as {
				completed: { throughEpoch: number; protectedRecords: { author: string; authorSequence: number }[] } | null;
			};
			if (value.completed === null) continue;
			through = value.completed.throughEpoch;
			holes = value.completed.protectedRecords.map((hole) => [hole.author.slice(0, 8), hole.authorSequence]);
		}
		const head = db
			.prepare(
				"SELECT o.author_sequence AS sequence, o.publish_state AS state, i.canonical_preimage AS preimage FROM issuance_outbox o JOIN issued_records i ON i.object_id = o.object_id AND i.author = o.author AND i.author_sequence = o.author_sequence ORDER BY o.author_sequence LIMIT 3"
			)
			.all()
			.map((row) => {
				const value = decodeCanonical(row.preimage as Uint8Array) as RowValue;
				return [row.sequence, value.epoch, String(value.operation.action), row.state];
			});
		return { pruned, through, holes: holes.slice(0, 12), holeCount: holes.length, head };
	} finally {
		db.close();
	}
}

// The Writer's journal scopes and retirement-protected scopes, read straight from its SQLite file.
function journalRetirement(directory: string, name: string) {
	const file = join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["journal", name]))
			.digest("hex")}.sqlite.drp-live-journal-v1.sqlite`
	);
	if (!existsSync(file)) return { scopes: [] as number[], protectedScopes: [] as number[] };
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const scopes = db
			.prepare("SELECT epoch FROM scopes ORDER BY epoch")
			.all()
			.map((row) => Number(row.epoch));
		let protectedScopes: number[] = [];
		for (const row of db.prepare("SELECT record FROM retirement_controls").all()) {
			const value = decodeCanonical(row.record as Uint8Array) as {
				completed: { protectedScopes: { epoch: number }[] } | null;
			};
			protectedScopes = value.completed?.protectedScopes.map((scope) => scope.epoch) ?? protectedScopes;
		}
		return { scopes, protectedScopes };
	} finally {
		db.close();
	}
}

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
	return { toWriter: () => carry(creator, writer, "creator"), toCreator: () => carry(writer, creator, "writer") };
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

async function followThenDeliver(SKIPS: number, DELIVERING: number) {
	const restore = await installEnvironment("node", () => undefined);
	if (process.env.SKIP_MEMBER_OBSERVE === "1")
		Reflect.set(globalThis, "__warmProofEvent", (event: { kind: string }) => {
			if (event.kind === "closed-retirement-issuance-holes")
				process.stdout.write(`SKIP_MEMBER_OBSERVE ${JSON.stringify(event)}\n`);
		});
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-skip-member-retirement-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let move = 0;
		const trace: Record<string, unknown>[] = [];
		const sample = async (label: string) => {
			const own = await writer.published(null);
			const oldest = own[0] === undefined ? null : rowValue(own[0]);
			const journal = journalRetirement(directory, "recipient");
			const plan = await writer.settlementAudit();
			const settlement = (await writer.settlementStatus?.()) as {
				unsettledEpochs: number;
				undelivered: unknown[];
			} | null;
			const record = {
				label,
				epoch,
				writerEpoch: await writer.authorityEpoch(),
				ownRows: own.length,
				oldestOwn: oldest === null ? null : [oldest.epoch, oldest.authorSequence],
				plan: plan.entries,
				dispositions: plan.dispositions,
				lowestEntries: plan.replacements
					.slice()
					.sort((left, right) => left.sourceSequence - right.sourceSequence)
					.slice(0, 4)
					.map((entry) => [entry.sourceSequence, entry.disposition]),
				issuance: issuanceRetirement(directory, "recipient"),
				protectedScopes: journal.protectedScopes,
				journalScopes: journal.scopes.length,
				unsettled: settlement?.unsettledEpochs ?? null,
				undelivered: settlement?.undelivered.length ?? null,
			};
			trace.push(record);
			process.stdout.write(`SKIP_MEMBER ${JSON.stringify(record)}\n`);
			return record;
		};
		try {
			// Connected: the Writer follows adjacently and its moves land.
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 60_000);
				await rows.toWriter();
				await writer.issue(1, move++);
				await rows.toCreator();
			}
			await sample("connected");
			// Slow: each round the Writer moves in its epoch while the creator rolls two epochs ahead,
			// then follows by a skip install; its move of the skipped epoch never reaches the creator.
			for (let skip = 0; skip < SKIPS; skip++) {
				await wire.pause();
				await writer.issue(1, move++);
				const before = epoch;
				while (epoch < before + 2) epoch = await rollCreator(creator, () => Promise.resolve(), ordinal);
				wire.resume();
				await wire.caughtUp(epoch, 120_000);
				await rows.toWriter();
				await sample(`skip-${skip + 1}`);
			}
			// Caught up: the Writer follows adjacently and delivers every epoch.
			for (let round = 0; round < DELIVERING; round++) {
				await writer.issue(1, move++);
				await rows.toCreator();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 120_000);
				await rows.toWriter();
				await rows.toCreator();
				await sample(`delivering-${round + 1}`);
			}
		} finally {
			await wire.stop();
		}
		const end = trace.at(-1) as {
			epoch: number;
			oldestOwn: [number, number] | null;
			plan: number;
			protectedScopes: number[];
			ownRows: number;
		};
		const tail = trace.slice(-3) as (typeof end)[];
		// The oldest own row is within the window behind the creator's epoch: the rest retired.
		expect(end.oldestOwn === null || end.oldestOwn[0] >= end.epoch - WINDOW - 1).toBe(true);
		// Scope 0 is collectible (no longer protected).
		expect(end.protectedScopes).not.toContain(0);
		// Own rows and plan entries are flat over the last delivering epochs and bounded by the window.
		expect(Math.max(...tail.map((record) => record.ownRows))).toBeLessThanOrEqual(required(tail[0]).ownRows);
		expect(Math.max(...tail.map((record) => record.plan))).toBeLessThanOrEqual(required(tail[0]).plan);
		expect(end.plan).toBeLessThanOrEqual(WINDOW * (WINDOW + 1));
	} finally {
		restore();
	}
}

// Control: a Writer that follows adjacently from the start. Its first own rows (its own pinned bootstrap
// and its epoch-0 fence, both terminal under the creator's frontier) must retire too, so its journal
// scope 0 is collected and its own rows stay flat.
it.skipIf(ONLY === "skip")(
	"an adjacent Grid Writer retires its own rows",
	() => followThenDeliver(0, DELIVERING + 2),
	1_800_000
);

it.skipIf(ONLY === "adjacent")(
	"a Writer that followed by skip installs retires its own rows once it delivers again",
	() => followThenDeliver(SKIPS, DELIVERING),
	1_800_000
);
