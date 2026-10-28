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
import { fromBase64, type RoleEndpoint, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// fix/skip-scope-carrier: a skip install asks the creator for the departed epoch's carrier (its Cut,
// commit QC, successor trust and closed membership) so the member can retire the journal scope it
// departed from. The creator kept those carriers in memory only, so a creator that restarted while a
// member was catching up answered "unavailable": that member never recorded the departed scope's
// closed membership, so the scope's received rows stayed protected, and enough such scopes make the
// member's journal retirement refuse (maxScopes = 7) and close its session. Here the creator restarts
// before each of the Writer's skip installs reaches it; no scope the Writer departed from may stay
// protected without its closed membership. The control does the same without restarts.
const ROUNDS = Number(process.env.SKIP_RESTART_ROUNDS ?? 3);
// Creator rollovers per skip (the departed scope is this many epochs behind the install's target).
const GAP = Number(process.env.SKIP_RESTART_GAP ?? 2);

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

type RowValue = { epoch: number };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;

const OPTIONS = {
	app: "grid" as const,
	host: "node" as const,
	recipient: "writer" as const,
	creatorLull: false,
	epochs: 1,
	moves: 1,
	chatFormat: "shares" as const,
	rollover: "app" as const,
};
const envFor = (directory: string, reopen: boolean) => ({
	host: nodeHostFor("node", directory, reopen),
	unique: directory,
	track,
	openFloor: (role: string) =>
		createNodeRoomHeadAuthority({
			filename: join(directory, `${role}-external-floor.sqlite`),
			initialization: { kind: reopen ? ("reopen" as const) : ("create" as const) },
		}),
});

/** The Writer's material relay follows `peers.creator`, so the creator can restart under it. */
async function openPair(directory: string) {
	const peers = { creator: await openRole(OPTIONS, 0, envFor(directory, false)) };
	const writer = await openRole(OPTIONS, 1, {
		...envFor(directory, false),
		relay: (request) => peers.creator.dispatch(request),
	});
	return { peers, writer };
}

/** Each side's rows reach the other only in the receiver's current epoch. */
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

async function follow(wire: ReturnType<typeof successorWire>, writer: RoleEndpoint, epoch: number) {
	try {
		await wire.caughtUp(epoch, 120_000);
	} catch (error) {
		const member = await writer.successorDelivery?.();
		throw new Error(
			`the Writer stopped following at epoch ${member?.epoch} (creator ${epoch}): ${JSON.stringify(member?.lastError ?? null)}`,
			{ cause: error }
		);
	}
}

/** The Writer's journal scopes and its retirement's protected scopes, read from its own file. */
function journalRetirement(directory: string, name: string) {
	const file = join(
		directory,
		`${createHash("sha256").update(JSON.stringify(["journal", name])).digest("hex")}.sqlite.drp-live-journal-v1.sqlite`
	);
	if (!existsSync(file))
		return { scopes: [] as number[], protectedScopes: [] as number[], activeProtected: [] as number[], membership: [] as number[] };
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const scopes = db.prepare("SELECT epoch FROM scopes ORDER BY epoch").all().map((row) => Number(row.epoch));
		// The scopes whose closed membership the Writer holds: what makes a scope's received rows collectible.
		const membership = db
			.prepare("SELECT epoch FROM scopes WHERE closed_membership_bytes IS NOT NULL ORDER BY epoch")
			.all()
			.map((row) => Number(row.epoch));
		let protectedScopes: number[] = [];
		let activeProtected: number[] = [];
		for (const row of db.prepare("SELECT record FROM retirement_controls").all()) {
			const value = decodeCanonical(row.record as Uint8Array) as {
				completed: { protectedScopes: { epoch: number }[] } | null;
				active: { preparation?: { protectedScopes?: { epoch: number }[] } } | null;
			};
			protectedScopes = value.completed?.protectedScopes.map((scope) => scope.epoch) ?? protectedScopes;
			activeProtected = value.active?.preparation?.protectedScopes?.map((scope) => scope.epoch) ?? activeProtected;
		}
		return { scopes, protectedScopes, activeProtected, membership };
	} finally {
		db.close();
	}
}

type CarrierEvent = Readonly<{ kind: string; departedEpoch: number; outcome: string; detail?: string }>;

async function skipFollow(restart: boolean) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-skip-carrier-restart-"));
	directories.push(directory);
	// The departed-carrier proof events, observation only.
	const events: CarrierEvent[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: CarrierEvent) => {
		if (event?.kind === "creator-departed-carrier" || event?.kind === "recipient-departed-carrier") events.push(event);
	});
	try {
		const { peers, writer } = await openPair(directory);
		const wire = successorWire(() => [peers.creator, writer] as const);
		let rows = rowWire(peers.creator, writer);
		const ordinal = { next: 0 };
		const departed: number[] = [];
		let epoch = 0;
		let next = 100;
		try {
			// One adjacent epoch first, so no departed scope is the genesis scope.
			await writer.issue(1, next++);
			await rows.toCreator();
			epoch = await rollCreator(peers.creator, rows.toWriter, ordinal);
			await follow(wire, writer, epoch);
			await rows.toWriter();
			for (let round = 0; round < ROUNDS; round++) {
				// A move in the epoch the Writer is at, received by the creator: that scope has detail.
				await writer.issue(1, next++);
				await rows.toCreator();
				await wire.pause();
				const before = (await writer.authorityEpoch()) ?? 0;
				epoch = await rollCreator(peers.creator, rows.toWriter, ordinal);
				for (let roll = 1; roll < GAP; roll++) epoch = await rollCreator(peers.creator, async () => undefined, ordinal);
				if (restart) {
					// The creator restarts before the Writer's skip install reaches it.
					await peers.creator.close();
					peers.creator = await openRole(OPTIONS, 0, envFor(directory, true));
					rows = rowWire(peers.creator, writer);
					// A reopened creator's delivery has no offer to answer with until its next adoption, so
					// it rolls once more; its in-memory carriers then hold only closes after the departed one.
					epoch = await rollCreator(peers.creator, async () => undefined, ordinal);
				}
				wire.resume();
				await follow(wire, writer, epoch);
				if (epoch - before > 1) departed.push(before);
				await rows.toWriter();
			}
			// Adjacent epochs: each install runs the Writer's journal retirement again.
			for (let round = 0; round < 2; round++) {
				await rows.toCreator();
				epoch = await rollCreator(peers.creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
			}
			const journal = journalRetirement(directory, "recipient");
			const member = (await writer.successorDelivery?.()) as { refusals?: readonly string[] } | undefined;
			process.stdout.write(
				`SKIP_RESTART_SUMMARY ${JSON.stringify({ restart, epoch, departed, journal, events, refusals: member?.refusals ?? [] })}\n`
			);
			expect(departed).toHaveLength(ROUNDS);
			expect(await writer.authorityEpoch()).toBe(epoch);
			// No scope the Writer departed from by a skip install stays protected for want of its closed
			// membership: each is retired, or holds its membership (a retired scope's header may stay,
			// its membership cleared). A scope that holds its membership can still be protected by the
			// Writer's own unsettled rows; this test does not judge that.
			const isProtected = (scope: number) =>
				journal.protectedScopes.includes(scope) || journal.activeProtected.includes(scope);
			expect(departed.filter((scope) => isProtected(scope) && !journal.membership.includes(scope))).toEqual([]);
		} finally {
			await wire.stop();
		}
	} finally {
		Reflect.deleteProperty(globalThis, "__warmProofEvent");
		restore();
	}
}

it("a Writer whose skip installs reach a restarted creator still retires each scope it departed from", () =>
	skipFollow(true), 1_800_000);

it("a Writer whose skip installs reach the same creator retires each scope it departed from (control)", () =>
	skipFollow(false), 1_800_000);
