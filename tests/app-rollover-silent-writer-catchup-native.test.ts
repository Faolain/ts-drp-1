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

// A Grid Writer whose settlement does not reach the creator (fix/silent-writer-catchup).
//
// Before the fix (c08d8680, tests/app-rollover-silent-writer-settlement-red.test.ts): each epoch the
// creator closed without the Writer's rows left the Writer one more protected journal scope, and at
// the eighth such epoch its journal retirement preparation held 8 scopes, above
// LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes (7): "journal retirement refused: malformed-input", then
// "v3 room session is closed". With moves, each install also replaced every unsettled move again,
// so plan entries and outbox rows grew without bound, and the Writer died sooner. Measured on
// c08d8680 with this file: protected scopes [0..5], 21 plan entries and 29 outbox rows at epoch 6,
// then its install of epoch 7 refused "creator snapshot role reconciliation refused: chain-invalid
// (RECOVERY_CERTIFICATE_STAGE:native-source-snapshot)" and the session closed; the unreachable-creator
// case failed because a move was issued (no read-only state).
//
// The fix is a settlement window (V3_SETTLEMENT_OWN_WINDOW_EPOCHS): a displaced own row (its epoch
// closed, the creator's signed frontier excluded it) that has waited the window is resolved as
// expired on that signed exclusion, so its scope is collected and its rows retire; a move that has
// waited the window is no longer replaced and is given back to the application, which keeps it and
// offers it again once the Writer's moves reach the creator. Two epochs before the window the page
// is told ("not-reaching-host"). With the creator unreachable the member is read-only (its moves are
// kept, not issued) and resumes by itself. An expired original can never be admitted later: its
// epoch is closed and ingress admits only the current epoch's anchor.
const SILENT_EPOCHS = 13;
const WINDOW = 4;
const MAX_PROTECTED_SCOPES = 7;

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
const moveId = (epoch: number) => `block-1-${epoch}`;
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};

/** The Writer's journal retirement control, read straight from its SQLite file. */
function journalRetirement(directory: string, name: string) {
	const file = join(
		directory,
		`${createHash("sha256").update(JSON.stringify(["journal", name])).digest("hex")}.sqlite.drp-live-journal-v1.sqlite`
	);
	if (!existsSync(file)) return { scopes: [] as number[], protectedScopes: [] as number[], activeProtected: [] as number[] };
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const scopes = db.prepare("SELECT epoch FROM scopes ORDER BY epoch").all().map((row) => Number(row.epoch));
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
		return { scopes, protectedScopes, activeProtected };
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

type Status = Readonly<{ state: string; epoch: number; kept: readonly Record<string, unknown>[]; unsettledEpochs?: number }>;

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

/** Waits until the member's install of `epoch`; a stall reports the member's refusal. */
async function follow(wire: ReturnType<typeof successorWire>, writer: RoleEndpoint, epoch: number) {
	try {
		await wire.caughtUp(epoch, 60_000);
	} catch (error) {
		const member = await writer.successorDelivery?.();
		throw new Error(
			`the Writer stopped following at epoch ${member?.epoch} (creator ${epoch}): ${JSON.stringify(member?.lastError ?? null)} first refusal ${JSON.stringify(member?.refusals[0] ?? null)}`,
			{ cause: error }
		);
	}
}

/** The policy's status once it has read the room's settlement as of the current install. */
async function policyStatus(writer: RoleEndpoint): Promise<Status> {
	const deadline = performance.now() + 5_000;
	for (;;) {
		const room = (await writer.settlementStatus?.()) as { epoch: number; unsettledEpochs: number } | null;
		const status = (await writer.rolloverStatus?.()) as Status;
		if (room === null || (status.unsettledEpochs === room.unsettledEpochs && status.epoch >= room.epoch)) return status;
		if (performance.now() > deadline) return status;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Accepted vertices of `author` carrying each move id, on one replica. */
async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[], fromEpoch = 0) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map(
		(id) => vertices.filter((vertex) => vertex.author === author && vertex.epoch >= fromEpoch && idOf(vertex.operation) === id).length
	);
}

it(
	"a Writer silent for 13 epochs stays within the settlement window, is told, gets its moves back and writes again on reconnect",
	async () => {
		const restore = await installEnvironment("node", () => undefined);
		const directory = mkdtempSync(join(tmpdir(), "app-rollover-silent-writer-catchup-"));
		directories.push(directory);
		try {
			const { creator, writer } = await openPair(directory);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: 0 };
			const ids: string[] = [];
			const observed: Readonly<{
				epoch: number;
				protectedScopes: readonly number[];
				activeProtected: readonly number[];
				journalScopes: number;
				plan: number;
				outbox: number;
				state: string;
				unsettled: number;
				kept: number;
			}>[] = [];
			let original: WireRow | undefined;
			let writerAuthor = "";
			try {
				// Silent: the creator's rows reach the Writer; the Writer's rows reach no one. The Writer
				// follows each rollover through the pages' own successor delivery and makes one move a epoch.
				for (let epoch = 0; epoch < SILENT_EPOCHS; ) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await follow(wire, writer, epoch);
					await rows.toWriter();
					await writer.issue(1, epoch);
					ids.push(moveId(epoch));
					const own = await writer.published(null);
					if (epoch === 1) {
						original = own.find((row) => rowValue(row).operation.id === moveId(1));
						writerAuthor = rowValue(own[0]!).author;
					}
					const journal = journalRetirement(directory, "recipient");
					const plan = await writer.settlementAudit();
					const status = await policyStatus(writer);
					observed.push({
						epoch,
						protectedScopes: journal.protectedScopes,
						activeProtected: journal.activeProtected,
						journalScopes: journal.scopes.length,
						plan: plan.entries,
						outbox: own.length,
						state: status.state,
						unsettled: status.unsettledEpochs ?? -1,
						kept: status.kept.length,
					});
					process.stdout.write(`SILENT_WRITER_EPOCH ${JSON.stringify(observed.at(-1))}\n`);
					// Scopes never exceed the retirement bound (the c08d8680 death is the eighth).
					expect(journal.protectedScopes.length).toBeLessThanOrEqual(MAX_PROTECTED_SCOPES);
					expect(journal.activeProtected.length).toBeLessThanOrEqual(MAX_PROTECTED_SCOPES);
				}
				expect(original).toBeDefined();

				// Bounded by the window: per epoch one fence, at most WINDOW - 1 moves still being replaced
				// and one new move, retained WINDOW (plan) or WINDOW + 1 (rows) epochs.
				for (const record of observed) {
					expect(record.plan).toBeLessThanOrEqual(WINDOW * (WINDOW + 1));
					expect(record.outbox).toBeLessThanOrEqual((WINDOW + 1) * (WINDOW + 1));
				}
				const steady = observed.filter((record) => record.epoch >= 8);
				expect(Math.max(...steady.map((record) => record.plan))).toBeLessThanOrEqual(steady[0]!.plan);
				expect(Math.max(...steady.map((record) => record.outbox))).toBeLessThanOrEqual(steady[0]!.outbox);
				// Told two epochs before the window, and from then on.
				for (const record of observed.filter((value) => value.epoch >= WINDOW - 2))
					expect(record.state, `epoch ${record.epoch}`).toBe("not-reaching-host");
				// The moves the window gave back are kept, in order: every move that has waited the window
				// (moves 1..9 at epoch 13; moves 10..13 are still being replaced).
				expect((await policyStatus(writer)).kept.map((operation) => operation.id)).toEqual(
					ids.slice(0, SILENT_EPOCHS - WINDOW)
				);

				// Reconnect: the Writer's current rows reach the creator (its fence and the moves still being
				// replaced), the creator rolls over, the Writer installs, its settlement lands, and the policy
				// offers the given-back moves again.
				await rows.toCreator();
				let epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				const reconnected = epoch;
				const ready = await waitFor(
					"the policy offers its kept moves again",
					() => policyStatus(writer),
					(status) => status.kept.length === 0 && status.state === "ready"
				);
				expect(ready.unsettledEpochs).toBe(0);
				await waitFor(
					"the creator admits every move of the Writer",
					async () => {
						await rows.toCreator();
						return acceptedCounts(creator, writerAuthor, ids);
					},
					(counts) => counts.every((count) => count >= 1)
				);
				// The late original: the expired first row of move 1 arrives at the creator through normal
				// ingress after its reissue. Then a new move, which joins after it in ingress order.
				await creator.inject([original!]);
				await writer.issue(1, 100);
				await waitFor(
					"the creator admits the Writer's new move",
					async () => {
						await rows.toCreator();
						return acceptedCounts(creator, writerAuthor, [moveId(100)]);
					},
					(counts) => counts[0] === 1
				);
				expect(await creator.acceptance([original!.digest])).toEqual([false]);
				// Close the epoch the moves landed in; the Writer follows it.
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				await rows.toCreator();
				// Exactly once on the creator (its history), across the silent moves and the reissues.
				expect(await acceptedCounts(creator, writerAuthor, [...ids, moveId(100)])).toEqual(
					[...ids, moveId(100)].map(() => 1)
				);
				// Exactly once in the creator's closed cuts since the reconnect (the epochs it closed while the
				// Writer was silent hold none of the Writer's moves).
				const occurrences = new Map<string, number>();
				for (let closed = reconnected - 1; closed < epoch; closed++) {
					const cut = await creator.closedProjection?.(closed);
					expect(cut, `creator cut ${closed}`).not.toBeNull();
					for (const entry of cut?.operations ?? [])
						if (entry.author === writerAuthor && typeof entry.operation.id === "string")
							occurrences.set(entry.operation.id, (occurrences.get(entry.operation.id) ?? 0) + 1);
				}
				expect([...ids, moveId(100)].map((id) => occurrences.get(id) ?? 0)).toEqual([...ids, moveId(100)].map(() => 1));
				// The Writer's replica is the creator's: its installed checkpoint plus the same current epoch.
				expect(await writer.authorityEpoch()).toBe(epoch);
				expect(await writer.state()).toBe(await creator.state());
				const journal = journalRetirement(directory, "recipient");
				expect(journal.protectedScopes.length).toBeLessThanOrEqual(MAX_PROTECTED_SCOPES);
			} finally {
				process.stdout.write(
					`SILENT_WRITER_SUMMARY ${JSON.stringify({ observed: observed.length, member: await writer.successorDelivery?.(), creatorErrors: (await creator.rollover?.())?.errors })}\n`
				);
				await wire.stop();
			}
		} finally {
			restore();
		}
	},
	900_000
);

/** Drives the unreachable-creator scenario; `inFlight` leaves one move undelivered at the disconnect. */
async function unreachableCreator(inFlight: boolean) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-unreachable-creator-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		try {
			// Connected for two epochs: rows both ways.
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				await writer.issue(1, epoch);
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			const kept = [moveId(51)];
			let original: WireRow | undefined;
			if (inFlight) {
				// One more move the creator never receives (in flight when the creator becomes unreachable).
				await writer.issue(1, 50);
				original = (await writer.published(null)).find((row) => rowValue(row).operation.id === moveId(50));
				expect(original).toBeDefined();
				kept.unshift(moveId(50));
			}
			await wire.pause();
			await writer.setPeerConnected?.(false);
			const before = epoch;
			// Read-only: a move is kept and refused, the session stays open.
			const refused = await writer.issue(1, 51).then(
				() => undefined,
				(error: unknown) => error
			);
			expect((refused as Error | undefined)?.name, "the move while the creator is unreachable").toBe("V3RoomReadOnly");
			const readOnly = await policyStatus(writer);
			expect(readOnly.state).toBe("read-only");
			expect(readOnly.kept.map((operation) => operation.id)).toEqual([moveId(51)]);
			expect(await writer.authorityEpoch()).toBe(before);
			// The creator carries on alone for more than the window (with a move in flight, for more epochs
			// than the journal may protect: the retained work must not hold its scope).
			const absence = inFlight ? MAX_PROTECTED_SCOPES + 2 : WINDOW + 2;
			while (epoch < before + absence) epoch = await rollCreator(creator, async () => undefined, ordinal);
			expect(await writer.authorityEpoch()).toBe(before);
			expect((await writer.rolloverStatus?.()) as Status).toMatchObject({ state: "read-only" });

			// The creator is back: the Writer installs the latest epoch by itself, its settlement lands at
			// the next close, and its kept moves (and a move given back) are offered again.
			await writer.setPeerConnected?.(true);
			wire.resume();
			await follow(wire, writer, epoch);
			await rows.toWriter();
			await rows.toCreator();
			expect(journalRetirement(directory, "recipient").protectedScopes.length).toBeLessThanOrEqual(MAX_PROTECTED_SCOPES);
			const reconnected = epoch;
			process.stdout.write(
				`UNREACHABLE_CREATOR_RECONNECTED ${JSON.stringify({ epoch, settlement: await writer.settlementStatus?.(), plan: await writer.settlementAudit(), own: (await writer.published(null)).map((row) => [row.authorSequence, rowValue(row).epoch, rowValue(row).operation.action, rowValue(row).operation.id]) })}\n`
			);
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await follow(wire, writer, epoch);
			await rows.toWriter();
			await waitFor(
				"the policy offers its kept moves again",
				() => policyStatus(writer),
				(status) => status.kept.length === 0 && status.state === "ready"
			);
			await waitFor(
				"the creator admits the kept moves",
				async () => {
					await rows.toCreator();
					return acceptedCounts(creator, writerAuthor, kept);
				},
				(counts) => counts.every((count) => count >= 1)
			);
			// A late original (in flight at the disconnect) arrives after its reissue; then a new move.
			if (original !== undefined) await creator.inject([original]);
			await writer.issue(1, 52);
			await waitFor(
				"the creator admits the Writer's new move",
				async () => {
					await rows.toCreator();
					return acceptedCounts(creator, writerAuthor, [moveId(52)]);
				},
				(counts) => counts[0] === 1
			);
			if (original !== undefined) expect(await creator.acceptance([original.digest])).toEqual([false]);
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await follow(wire, writer, epoch);
			await rows.toWriter();
			expect(await acceptedCounts(creator, writerAuthor, [...kept, moveId(52)])).toEqual([...kept, moveId(52)].map(() => 1));
			expect(await acceptedCounts(creator, writerAuthor, kept, reconnected)).toEqual(kept.map(() => 1));
			// Its settlement reaches the creator again: nothing of its own is left waiting.
			expect(((await writer.settlementStatus?.()) as { unsettledEpochs: number }).unsettledEpochs).toBe(0);
			expect(await writer.state()).toBe(await creator.state());
			expect(journalRetirement(directory, "recipient").protectedScopes.length).toBeLessThanOrEqual(MAX_PROTECTED_SCOPES);
		} finally {
			process.stdout.write(
				`UNREACHABLE_CREATOR_SUMMARY ${JSON.stringify({ epoch, member: await writer.successorDelivery?.(), status: await writer.rolloverStatus?.(), settlement: await writer.settlementStatus?.() })}\n`
			);
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it(
	"with the creator unreachable the Writer is read-only (kept, not closed) and resumes writing by itself",
	() => unreachableCreator(false),
	900_000
);

// A move in flight when the creator becomes unreachable. Before the fix (94d117ca, and already at
// c08d8680): a Writer that installs a successor more than one epoch ahead retains its old epoch's own
// rows as unknown accepted work (v3-live retainCreatorAcceptedSourceCustody: disposition
// "manual-review" with a retained source context), and the drain then withholds the author fence for
// good ("unknown retained work still withholds the author fence"). The creator's frontier stops below
// the in-flight move, every later row of the Writer stays unsettled, and the page is told
// "not-reaching-host" forever with the move kept and never offered again. The fix resolves that
// retained work from the creator's signed frontier: a row the frontier settled was committed, a row it
// proves was never admitted is expired and its move handed back to the application.
it(
	"with a move in flight when the creator becomes unreachable, the Writer's settlement lands again after it resumes",
	() => unreachableCreator(true),
	900_000
);
