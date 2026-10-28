/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// Conservation for a silent Chat Writer (its network publishes nowhere, so nothing it issues ever
// settles): every move the room accepts ends given back to the application (a durable hand-back
// record), still live (its latest row is in the Writer's current epoch, replaced again each install),
// or was refused at issue time (V3RoomLocalBacklogFull). None is ever expired unrecorded.
//
// The plan holds at most SETTLEMENT_HAND_BACK_LIMITS.maxRecords (64) hand-back records. Before this
// fix the settlement window expired every move of the epoch it closed and recorded only the first 64:
// the 65th was resolved "expire" with no record and lost (measured: 80 moves, 64 given back). And
// nothing bounded the Writer's backlog: with the application offering every given-back move again,
// live moves grew with every message typed (measured: plan 126, outbox 151 after 32 silent epochs).
//
// Both run only with RUN_SILENT_BACKLOG=1 (each epoch replaces up to 64 moves on genuine SQLite):
//   burst   65 messages in one silent epoch, then SEALS installs past the window;
//   steady  (RUN_SILENT_BACKLOG_STEADY=1) one message per epoch for STEADY_EPOCHS silent epochs,
//           every given-back move offered again: live moves stay within the bound and the plan and
//           outbox stop growing.
const RUN = process.env.RUN_SILENT_BACKLOG === "1";
const STEADY = RUN && process.env.RUN_SILENT_BACKLOG_STEADY === "1";
const BOUND = 64;
const BURST = 65;
// Past the window (4) and far enough that a move kept live by the record bound would outgrow the
// Writer's protected journal scopes (LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes = 7) if it held them.
const SEALS = Number(process.env.SILENT_BACKLOG_SEALS ?? 10);
const STEADY_EPOCHS = Number(process.env.SILENT_BACKLOG_STEADY_EPOCHS ?? 100);
const PER_EPOCH = Number(process.env.SILENT_BACKLOG_PER_EPOCH ?? 1);
const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Every clientOperationId string anywhere in a decoded value.
const operationIds = (value: unknown, out: string[] = []): string[] => {
	if (Array.isArray(value)) for (const item of value) operationIds(item, out);
	else if (value !== null && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			if (key === "clientOperationId" && typeof item === "string") out.push(item);
			else operationIds(item, out);
		}
	return out;
};

// The Writer's journal scopes (its owned local session's live journal, read-only): the scopes it
// holds and those its completed journal retirement protects (bounded by maxScopes = 7).
const writerJournalScopes = (directory: string): { held: number; protected: number } => {
	const files = (root: string): string[] =>
		readdirSync(root).flatMap((name) => {
			const path = join(root, name);
			if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) return files(path);
			return name.endsWith(".drp-live-journal-v1.sqlite") ? [path] : [];
		});
	const out = { held: 0, protected: 0 };
	for (const file of files(join(directory, "local-sessions"))) {
		const database = new DatabaseSync(file, { readOnly: true });
		try {
			out.held += Number((database.prepare("SELECT COUNT(*) AS n FROM scopes").get() as { n: number }).n);
			for (const row of database.prepare("SELECT record FROM retirement_controls").all()) {
				const value = decodeCanonical(row.record as Uint8Array) as {
					completed: { protectedScopes: unknown[] } | null;
				};
				out.protected += value.completed?.protectedScopes.length ?? 0;
			}
		} finally {
			database.close();
		}
	}
	return out;
};

const backlogFull = (error: unknown): boolean => error instanceof Error && error.name === "V3RoomLocalBacklogFull";

const openRoom = async (directory: string) => {
	const f = await chatSharesRoomFixture({
		directory,
		members: ["genesis"],
		format: "window",
		localMembers: [1],
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0),
		member = await f.open(1);
	type Member = typeof member;
	// The Writer's moves: live (a row in its current epoch), given back, plan entries and held rows.
	const census = async (room: Member) => {
		const settlement = required(room.room.settlementStatus?.());
		const author = required(f.identities[1]).author,
			scope = { objectId: f.objectId, author };
		const live = new Set<string>();
		let outboxRows = 0;
		const plan = await f.withIssuance(1, async (store) => {
			for (let afterKey: readonly [string, string, number] | null = null; ; ) {
				const page = await store.readOutboxPage({ scope, afterKey, limit: 128 });
				outboxRows += page.length;
				for (const row of page) {
					const preimage = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { epoch: number };
					if (preimage.epoch === settlement.epoch) for (const id of operationIds(preimage)) live.add(id);
				}
				if (page.length < 128) break;
				afterKey = [f.objectId, author, required(page.at(-1)).commit.authorSequence];
			}
			return store.readSettlementPlan(scope);
		});
		const given = new Set(settlement.undelivered.flatMap((record) => operationIds(record.operations)));
		return {
			epoch: settlement.epoch,
			live,
			given,
			undelivered: settlement.undelivered,
			planEntries: plan?.entries.length ?? 0,
			outboxRows,
			journalScopes: writerJournalScopes(directory),
		};
	};
	const epoch = async () => {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
	};
	return { f, creator, member, census, epoch };
};

it.skipIf(!RUN)(
	"a silent Chat Writer's 65 moves of one epoch are each given back, still live, or refused at issue",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-chat-silent-backlog-burst-"));
		directories.push(directory);
		try {
			const { member, census, epoch } = await openRoom(directory);
			const accepted: string[] = [],
				refused: string[] = [];
			for (let index = 0; index < BURST; index++) {
				const id = `burst-${index}`;
				try {
					await member.room.issue(message(id));
					accepted.push(id);
				} catch (error) {
					if (!backlogFull(error)) throw error;
					refused.push(id);
				}
			}
			const trace: unknown[] = [];
			for (let seal = 0; seal < SEALS; seal++) {
				await epoch();
				const now = await census(member);
				const lost = accepted.filter((id) => !now.live.has(id) && !now.given.has(id));
				const both = accepted.filter((id) => now.live.has(id) && now.given.has(id));
				trace.push({
					epoch: now.epoch,
					live: now.live.size,
					given: now.given.size,
					lost,
					both,
					planEntries: now.planEntries,
					outboxRows: now.outboxRows,
					journalScopes: now.journalScopes,
				});
				process.stdout.write(`SILENT_BACKLOG_BURST ${JSON.stringify(trace.at(-1))}\n`);
				expect({ epoch: now.epoch, lost, both }).toEqual({ epoch: now.epoch, lost: [], both: [] });
			}
			const end = await census(member);
			// The window has expired every accepted move: the record bound holds 64, the rest stay live.
			expect(end.given.size).toBe(Math.min(BOUND, accepted.length));
			expect(end.live.size + end.given.size + refused.length).toBe(BURST);
			expect(end.undelivered.length).toBeLessThanOrEqual(BOUND);
		} finally {
			expect(await closeChatSharesRooms()).toEqual([]);
		}
	},
	14_400_000
);

it.skipIf(!STEADY)(
	"a silent Chat Writer typing every epoch keeps its live moves within the backlog bound and its plan flat",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-chat-silent-backlog-steady-"));
		directories.push(directory);
		try {
			const { member, census, epoch } = await openRoom(directory);
			const accepted = new Set<string>();
			const kept: string[] = []; // refused at issue: the application keeps them and offers them again
			const offered = new Set<string>();
			const samples: { epoch: number; backlog: number; planEntries: number; outboxRows: number; refused: number }[] =
				[];
			for (let index = 0; index < STEADY_EPOCHS; index++) {
				let refused = 0;
				// Given-back moves first (a reissue keeps its backlog slot), then kept and new messages.
				for (const record of required(member.room.settlementStatus?.()).undelivered) {
					const key = `${record.handBack.sourceSequence}:${record.handBack.intent}`;
					if (offered.has(key)) continue;
					offered.add(key);
					for (const operation of record.operations) await member.room.issue(operation, { handBack: record.handBack });
				}
				const typed = [...kept.splice(0), ...Array.from({ length: PER_EPOCH }, (_, n) => `steady-${index}-${n}`)];
				for (const id of typed) {
					try {
						await member.room.issue(message(id));
						accepted.add(id);
					} catch (error) {
						if (!backlogFull(error)) throw error;
						kept.push(id);
						refused++;
					}
				}
				await epoch();
				const now = await census(member);
				const lost = [...accepted].filter((id) => !now.live.has(id) && !now.given.has(id));
				// Live undelivered moves: replaced moves plus the plan's hand-back records.
				const backlog = new Set([...now.live, ...now.given]).size;
				const sample = { epoch: now.epoch, backlog, planEntries: now.planEntries, outboxRows: now.outboxRows, refused };
				samples.push(sample);
				process.stdout.write(
					`SILENT_BACKLOG_STEADY ${JSON.stringify({ ...sample, kept: kept.length, lost: lost.length })}\n`
				);
				expect({ epoch: now.epoch, lost }).toEqual({ epoch: now.epoch, lost: [] });
				// The bound, plus the new moves one epoch may accept before an install displaces them.
				expect(backlog).toBeLessThanOrEqual(BOUND + PER_EPOCH);
			}
			// Once the backlog is full the plan and outbox stop growing: the last third peaks no
			// higher in its later half than in its earlier half.
			const tail = samples.slice(Math.floor((2 * samples.length) / 3));
			const half = Math.floor(tail.length / 2);
			const peak = (part: typeof tail, key: "planEntries" | "outboxRows") =>
				Math.max(...part.map((sample) => sample[key]));
			for (const key of ["planEntries", "outboxRows"] as const)
				expect(peak(tail.slice(half), key)).toBeLessThanOrEqual(peak(tail.slice(0, half), key));
		} finally {
			expect(await closeChatSharesRooms()).toEqual([]);
		}
	},
	86_400_000
);
