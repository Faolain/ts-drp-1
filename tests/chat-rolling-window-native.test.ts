/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import {
	type ChatWindowPeer,
	type ChatWindowRoom,
	chatWindowRoomFixture,
	closeChatWindowRooms,
	hex,
	required,
	type StoreCensus,
} from "./fixtures/chat-rolling-window/chat-long-room.js";
import { SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND } from "../examples/chat/src/v3-chat-archive.js";

// Track W: a shipped Chat room runs indefinitely. Today's Chat keeps every message in its
// replicated state and refuses new messages once an author's lifetime share is spent (Track T:
// near epoch 57 at 4 messages per epoch). New rooms carry a rolling window instead: each
// member's share bounds that member's messages in the window, a member's new message pushes out
// that member's own oldest messages, and every device keeps the messages it has seen in a local
// archive outside room storage.
//
// One creator and two Writers on genuine SQLite owners send 4 messages every epoch (creator 2,
// each Writer 1) through EPOCHS genuine transitions (seal, adoption, two installs, three
// lulls), with a persisted reopen of every peer half way and a crash of one Writer's archive
// between admitting a message and archiving it.
//
// CHAT_WINDOW_EPOCHS (default 300), CHAT_WINDOW_OUT=<dir> (one JSONL line per epoch),
// CHAT_WINDOW_VERBOSE=1. CHAT_WINDOW_PAD=<n> appends n characters to every text, which only
// shortens the run before the window is full (development; the default is 0).
const EPOCHS = Number(process.env.CHAT_WINDOW_EPOCHS ?? 300);
const PAD = Number(process.env.CHAT_WINDOW_PAD ?? 0);
const REOPEN_AT = Math.floor(EPOCHS / 2);
const CRASH_AT = REOPEN_AT + 5;
const SETTLE_MS = Number(process.env.CHAT_WINDOW_SETTLE_MS ?? 300);
// Who sends each of an epoch's four messages: the creator twice, each Writer once.
const SENDERS = [0, 1, 0, 2] as const;
const WRITERS = 3;
// Peer 2 keeps a small archive, so its bound is exercised inside the run.
const SMALL_ARCHIVE = Object.freeze({ maxMessages: 100, maxBytes: 1_048_576 });
// Peer 1's archive writes only on an explicit flush, so the test can stop it between admitting
// a message and archiving it.
const MANUAL_ARCHIVE = 1;

afterAll(async () => {
	expect(await closeChatWindowRooms(), "native admitted work and owners join").toEqual([]);
});

interface ChatMessage {
	readonly author: string;
	readonly clientOperationId: string;
	readonly displayTimeMs: number;
	readonly text: string;
}
const identityOf = (message: Readonly<{ author: string; clientOperationId: string }>) =>
	`${message.author}\u0000${message.clientOperationId}`;
const recordBytes = (message: ChatMessage) => encodeCanonical(message).byteLength;

function operationFor(sender: number, epoch: number, ordinal: number) {
	return Object.freeze({
		action: "message" as const,
		clientOperationId: `m-${sender}-${epoch}-${ordinal}`,
		displayTimeMs: 1_791_662_400_000 + epoch * 1000 + ordinal * 10 + sender,
		text: `e${epoch} o${ordinal}${PAD > 0 ? ` ${"x".repeat(PAD)}` : ""}`,
	});
}

/**
 * The window as the design states it, kept independently of the product: each member's most
 * recent messages that fit that member's share, oldest first in application order.
 */
class WindowModel {
	readonly messages: ChatMessage[] = [];
	readonly evictions = new Map<string, number>();
	constructor(readonly ceilings: ReadonlyMap<string, number>) {}
	charge(author: string): number {
		return this.messages.reduce((sum, message) => sum + (message.author === author ? recordBytes(message) : 0), 0);
	}
	apply(message: ChatMessage): void {
		const ceiling = required(this.ceilings.get(message.author));
		this.messages.push(message);
		let charge = this.charge(message.author);
		while (charge > ceiling) {
			const oldest = this.messages.findIndex((row) => row.author === message.author);
			charge -= recordBytes(required(this.messages[oldest]));
			this.messages.splice(oldest, 1);
			this.evictions.set(message.author, (this.evictions.get(message.author) ?? 0) + 1);
		}
	}
}

interface EpochRecord {
	readonly epoch: number;
	readonly stateBytes: number;
	readonly windowMessages: number;
	readonly charges: readonly number[];
	readonly census: readonly StoreCensus[];
	readonly archive: readonly Readonly<{
		messages: number;
		bytes: number;
		fileBytes: number;
		/** Measurement only: cumulative since the archive opened (append cost). */
		appended: number;
		transactions: number;
		transactionMs: number;
	}>[];
	readonly latency: Readonly<{
		issue: readonly number[];
		seal: number;
		adopt: number;
		install: readonly number[];
		lull: readonly number[];
	}>;
	readonly lullKinds: readonly string[];
	readonly reopened?: true;
}

interface LongRoomRun {
	readonly room: ChatWindowRoom;
	readonly records: readonly EpochRecord[];
	readonly ceilings: readonly number[];
	/** Every peer's state bytes and digest, every epoch, after install (and the model's). */
	readonly agreement: readonly Readonly<{ epoch: number; digests: readonly string[]; model: string }>[];
	/** The first epoch every member's own new messages had pushed out older ones. */
	readonly steadyEpoch: number;
	/** Every peer's archive after every epoch, as identities in archive order. */
	readonly archives: readonly Readonly<{ epoch: number; keys: readonly (readonly string[])[] }>[];
	readonly issued: readonly ChatMessage[];
	readonly reopen: Readonly<{
		stateBefore: string;
		stateAfter: readonly string[];
		archivesBefore: readonly (readonly string[])[];
		archivesAfter: readonly (readonly string[])[];
	}>;
	readonly crash: Readonly<{ message: string; inArchiveBefore: boolean; inArchiveAfter: boolean; inWindow: boolean }>;
	/** What a joiner installs: the creator's export at sampled epochs, against the model's window. */
	readonly exported: readonly Readonly<{ epoch: number; exported: string; model: string }>[];
}

const latencyOf = async <Value>(task: () => Promise<Value>) => {
	const started = performance.now();
	const value = await task();
	return { value, ms: performance.now() - started };
};

async function runChatWindowRoom(): Promise<LongRoomRun> {
	const room = await chatWindowRoomFixture({
		writers: WRITERS,
		archiveBound: (index) => (index === 2 ? SMALL_ARCHIVE : undefined),
		archiveScheduling: (index) => (index === MANUAL_ARCHIVE ? "manual" : "auto"),
	});
	const genesis = decodeCanonical(room.genesis) as {
		capacity: { allocations: [string, number, number][] };
	};
	const ceilingByAuthor = new Map(genesis.capacity.allocations.map(([author, ceiling]) => [author, ceiling]));
	const ceilings = room.identities.map(({ author }) => required(ceilingByAuthor.get(author)));
	const model = new WindowModel(ceilingByAuthor);
	const opened: ChatWindowPeer[] = [];
	for (let index = 0; index < WRITERS; index++) opened.push(await room.open(index));
	// delivered[from][to]: the last author sequence of `from` that `to` has received.
	const delivered = opened.map(() => opened.map((): number | null => null));
	const deliver = async (from: number) => {
		for (let to = 0; to < WRITERS; to++) {
			if (to === from) continue;
			const rows = await room.publishedAfter(from, required(delivered[from])[to] ?? null);
			if (rows.length === 0) continue;
			await required(opened[to]).receive(rows, from);
			required(delivered[from])[to] = required(rows.at(-1)).commit.authorSequence;
		}
	};
	const issued: ChatMessage[] = [];
	const issue = async (epoch: number, ordinal: number) => {
		const sender = required(SENDERS[ordinal]);
		const operation = operationFor(sender, epoch, ordinal);
		const { ms } = await latencyOf(() => required(opened[sender]).room.issue(operation));
		const message = {
			author: required(room.identities[sender]).author,
			clientOperationId: operation.clientOperationId,
			displayTimeMs: operation.displayTimeMs,
			text: operation.text,
		};
		issued.push(message);
		model.apply(message);
		await deliver(sender);
		return { ms, message };
	};
	const flushArchives = async () => {
		for (const peer of opened) await peer.archive.flush();
	};
	const archiveKeys = () => opened.map((peer) => peer.archive.records().map(identityOf));
	const modelStateBytes = () =>
		encodeCanonical({
			version: 4,
			messages: model.messages,
			capacity: (decodeCanonical(room.genesis) as { capacity: unknown }).capacity,
		});
	const digest = (bytes: Uint8Array) => hex(hashDomain("ts-drp/state/v3", bytes));

	const records: EpochRecord[] = [];
	const agreement: { epoch: number; digests: string[]; model: string }[] = [];
	const archives: { epoch: number; keys: string[][] }[] = [];
	const exported: { epoch: number; exported: string; model: string }[] = [];
	let steadyEpoch = Number.POSITIVE_INFINITY;
	let reopen: LongRoomRun["reopen"] | undefined;
	let crash: LongRoomRun["crash"] | undefined;

	const rollover = async (epoch: number, issueMs: number[], reopened: boolean) => {
		const creator = required(opened[0]);
		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		const seal = await latencyOf(() => creator.room.sealEpoch());
		expect(seal.value, `seal at epoch ${epoch}`).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		const adopt = await latencyOf(() => creator.room.adoptCreatorSuccessor());
		const install: number[] = [];
		for (let index = 1; index < WRITERS; index++) {
			const recipient = required(opened[index]);
			const transfer = await room.successorDelivery(index);
			Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
			const installed = await latencyOf(() =>
				recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers })
			);
			install.push(installed.ms);
			expect(recipient.room.authority(), `install at epoch ${epoch}`).toMatchObject({
				epoch: epoch + 1,
				objectId: room.objectId,
			});
		}
		// Every peer's state equals the model's window, byte for byte, so every digest agrees.
		const states = opened.map((peer) => peer.stateBytes());
		const expected = modelStateBytes();
		agreement.push({ epoch: epoch + 1, digests: states.map(digest), model: digest(expected) });
		const census = opened.map((_, index) => room.census(index));
		const lull: number[] = [];
		const lullKinds: string[] = [];
		for (const peer of opened) {
			const result = await latencyOf(() => peer.room.maintainRecoveryPool());
			lull.push(result.ms);
			const value = result.value as Readonly<{ kind: string; reason?: string }>;
			lullKinds.push(value.reason === undefined ? value.kind : `${value.kind}:${value.reason}`);
		}
		await flushArchives();
		archives.push({ epoch: epoch + 1, keys: archiveKeys() });
		if ([...room.identities].every(({ author }) => (model.evictions.get(author) ?? 0) > 0))
			steadyEpoch = Math.min(steadyEpoch, epoch + 1);
		if (epoch + 1 === steadyEpoch || epoch + 1 === REOPEN_AT || epoch + 1 === EPOCHS)
			exported.push({
				epoch: epoch + 1,
				exported: hex(await room.exportedApplicationStateBytes()),
				model: hex(expected),
			});
		const record: EpochRecord = {
			epoch: epoch + 1,
			stateBytes: required(states[0]).byteLength,
			windowMessages: model.messages.length,
			charges: room.identities.map(({ author }) => model.charge(author)),
			census,
			archive: opened.map((peer, index) => ({
				messages: peer.archive.records().length,
				bytes: peer.archive.stats().bytes,
				fileBytes: room.archiveFileBytes(index),
				appended: peer.archive.stats().appended,
				transactions: peer.archive.stats().transactions,
				transactionMs: peer.archive.stats().transactionMs,
			})),
			latency: { issue: issueMs, seal: seal.ms, adopt: adopt.ms, install, lull },
			lullKinds,
			...(reopened ? { reopened: true as const } : {}),
		};
		records.push(record);
		const line = JSON.stringify({ ...record, census: undefined, censusTotals: census.map(totals) });
		if (process.env.CHAT_WINDOW_VERBOSE === "1") process.stdout.write(`CHAT_WINDOW ${line}\n`);
		const out = process.env.CHAT_WINDOW_OUT;
		if (out !== undefined) {
			mkdirSync(out, { recursive: true });
			appendFileSync(join(out, "chat-window-native.jsonl"), `${JSON.stringify({ ...record })}\n`);
		}
	};

	let reopenedEpoch = false;
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		if (epoch === REOPEN_AT) {
			// A persisted reopen of every peer over the same databases, floors and archive files.
			await flushArchives();
			const stateBefore = hex(required(opened[0]).stateBytes());
			const archivesBefore = archiveKeys();
			for (const peer of [...opened].reverse()) await room.stop(peer);
			for (let index = 0; index < WRITERS; index++) opened[index] = await room.open(index, { reopen: true });
			await flushArchives();
			reopen = {
				stateBefore,
				stateAfter: opened.map((peer) => hex(peer.stateBytes())),
				archivesBefore,
				archivesAfter: archiveKeys(),
			};
			reopenedEpoch = true;
		}
		const issueMs: number[] = [];
		for (let ordinal = 0; ordinal < SENDERS.length; ordinal++) {
			const { ms, message } = await issue(epoch, ordinal);
			issueMs.push(ms);
			if (epoch === CRASH_AT && SENDERS[ordinal] === MANUAL_ARCHIVE) {
				// The Writer's room admitted its message; its archive has not written it. The
				// archive's unwritten work is lost, as in a crash, then the peer reopens.
				const peer = required(opened[MANUAL_ARCHIVE]);
				const inArchiveBefore = peer.archive.records().some((row) => identityOf(row) === identityOf(message));
				await room.stop(peer, { discardArchive: true });
				opened[MANUAL_ARCHIVE] = await room.open(MANUAL_ARCHIVE, { reopen: true });
				const reopenedPeer = required(opened[MANUAL_ARCHIVE]);
				await reopenedPeer.archive.flush();
				crash = {
					message: identityOf(message),
					inArchiveBefore,
					inArchiveAfter: reopenedPeer.archive.records().some((row) => identityOf(row) === identityOf(message)),
					inWindow: reopenedPeer.room.projection().messages.some((row) => identityOf(row) === identityOf(message)),
				};
			}
		}
		await rollover(epoch, issueMs, reopenedEpoch);
		reopenedEpoch = false;
	}
	return {
		room,
		records,
		ceilings,
		agreement,
		steadyEpoch,
		archives,
		issued,
		reopen: required(reopen),
		crash: required(crash),
		exported,
	};
}

function totals(census: StoreCensus) {
	let rows = 0;
	let bytes = 0;
	for (const [key, [tableRows, tableBytes]] of Object.entries(census)) {
		if (key.endsWith(":#file") || key.endsWith(":#missing")) continue;
		rows += tableRows;
		bytes += tableBytes;
	}
	return { rows, bytes };
}

/** Least-squares slope of `values` against their epochs. */
function slope(points: readonly (readonly [number, number])[]): number {
	const n = points.length;
	const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
	const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
	const numerator = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
	const denominator = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
	return denominator === 0 ? 0 : numerator / denominator;
}

let longRoom: Promise<LongRoomRun> | undefined;
const chatWindowRoom = (): Promise<LongRoomRun> => (longRoom ??= runChatWindowRoom());
const TIMEOUT = 4 * 60 * 60 * 1000;

it(
	`a shipped Chat room takes 4 messages every epoch for ${EPOCHS} epochs without a refusal, and every peer agrees on the window every epoch`,
	async () => {
		const run = await chatWindowRoom();
		expect(run.records.map((record) => record.epoch)).toEqual(Array.from({ length: EPOCHS }, (_, epoch) => epoch + 1));
		expect(run.issued).toHaveLength(EPOCHS * SENDERS.length);
		for (const { epoch, digests, model } of run.agreement)
			expect(digests, `state digests at epoch ${epoch}`).toEqual(Array.from({ length: WRITERS }, () => model));
		// The run outlives a lifetime ledger: far more bytes were sent than the whole state holds.
		expect(run.issued.reduce((sum, message) => sum + recordBytes(message), 0)).toBeGreaterThan(4 * 32_768);
	},
	TIMEOUT
);

it(
	"the window holds exactly each member's most recent messages that fit, and no member exceeds their share",
	async () => {
		const run = await chatWindowRoom();
		// The agreement test compares every peer's bytes with the model's window every epoch;
		// here the window's shape: per member, a suffix of what they sent, within their share,
		// and their next older message would not have fitted.
		expect(run.steadyEpoch, "every member's share filled within the run").toBeLessThanOrEqual(EPOCHS - 50);
		const finalState = decodeCanonical(Buffer.from(required(run.exported.at(-1)).exported, "hex")) as {
			version: number;
			messages: ChatMessage[];
		};
		expect(finalState.version).toBe(4);
		run.room.identities.forEach(({ author }, index) => {
			const sent = run.issued.filter((message) => message.author === author);
			const kept = finalState.messages.filter((message) => message.author === author);
			const ceiling = required(run.ceilings[index]);
			expect(kept.map(identityOf), `member ${index} keeps a suffix of their messages`).toEqual(
				sent.slice(sent.length - kept.length).map(identityOf)
			);
			const charge = kept.reduce((sum, message) => sum + recordBytes(message), 0);
			expect(charge, `member ${index} within share`).toBeLessThanOrEqual(ceiling);
			const next = required(sent[sent.length - kept.length - 1]);
			expect(charge + recordBytes(next), `member ${index}: the next older message would not fit`).toBeGreaterThan(
				ceiling
			);
		});
		for (const record of run.records)
			record.charges.forEach((charge, index) =>
				expect(charge, `member ${index} at epoch ${record.epoch}`).toBeLessThanOrEqual(required(run.ceilings[index]))
			);
	},
	TIMEOUT
);

it(
	"state bytes and every room store stay flat from the first steady epoch",
	async () => {
		const run = await chatWindowRoom();
		const steady = run.records.filter((record) => record.epoch >= run.steadyEpoch);
		expect(steady.length).toBeGreaterThanOrEqual(50);
		// Each member's charge stays within one message of their share, so the whole state stays in
		// a band one largest message per member wide, under the 32 KiB ceiling.
		const largest = Math.max(...run.issued.map(recordBytes));
		const full = Math.max(...steady.map((record) => record.stateBytes));
		for (const record of steady) {
			expect(record.stateBytes, `state bytes at epoch ${record.epoch}`).toBeLessThanOrEqual(32_768);
			expect(record.stateBytes, `state bytes at epoch ${record.epoch}`).toBeGreaterThan(full - WRITERS * largest);
		}
		for (let index = 0; index < WRITERS; index++) {
			const series = steady.map((record) => [record.epoch, totals(required(record.census[index]))] as const);
			const first = required(series[0])[1];
			for (const [epoch, value] of series) {
				// Rows: no store keeps a row per message or per epoch.
				expect(value.rows, `peer ${index} room store rows at epoch ${epoch}`).toBeLessThanOrEqual(first.rows + 8);
				expect(value.bytes, `peer ${index} room store bytes at epoch ${epoch}`).toBeLessThanOrEqual(
					first.bytes + 16_384
				);
			}
			// A store growing per message would add at least one message record (over 100 B) per epoch.
			expect(slope(series.map(([epoch, value]) => [epoch, value.rows])), `peer ${index} rows per epoch`).toBeLessThan(
				0.05
			);
			expect(slope(series.map(([epoch, value]) => [epoch, value.bytes])), `peer ${index} bytes per epoch`).toBeLessThan(
				16
			);
			// Per table, too.
			for (const table of Object.keys(required(steady[0]).census[index] ?? {})) {
				if (table.endsWith(":#file")) continue;
				const rows = steady.map((record) => required(required(record.census[index])[table])[0]);
				expect(Math.max(...rows) - Math.min(...rows), `peer ${index} ${table} rows`).toBeLessThanOrEqual(8);
			}
		}
	},
	TIMEOUT
);

it(
	"every device's archive holds every message it admitted, survives a persisted reopen and keeps its bound",
	async () => {
		const run = await chatWindowRoom();
		expect(SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND).toEqual({ maxMessages: 2000, maxBytes: 1_048_576 });
		const all = run.issued.map(identityOf);
		for (const { epoch, keys } of run.archives) {
			const sent = all.slice(0, epoch * SENDERS.length);
			// Default bound (far above this run's 1,200 messages): everything, in the order first seen.
			expect(keys[0], `creator archive at epoch ${epoch}`).toEqual(sent);
			expect(keys[1], `Writer 1 archive at epoch ${epoch}`).toEqual(sent);
			// A 100-message bound: exactly the newest 100, oldest dropped first.
			expect(keys[2], `Writer 2 archive at epoch ${epoch}`).toEqual(sent.slice(-SMALL_ARCHIVE.maxMessages));
		}
		expect(run.reopen.archivesAfter).toEqual(run.reopen.archivesBefore);
		// The archive is not room storage: none of its records is counted in the room census, and it
		// stays within its own bound.
		for (const record of run.records) {
			expect(required(record.archive[2]).messages).toBeLessThanOrEqual(SMALL_ARCHIVE.maxMessages);
			for (const archive of record.archive) expect(archive.bytes).toBeLessThanOrEqual(1_048_576);
		}
	},
	TIMEOUT
);

it(
	"a crash between admitting a message and archiving it loses nothing while the message is in the window",
	async () => {
		const run = await chatWindowRoom();
		expect(run.crash).toEqual({
			message: run.crash.message,
			inArchiveBefore: false,
			inWindow: true,
			inArchiveAfter: true,
		});
	},
	TIMEOUT
);

it(
	"eviction is identical after a persisted reopen",
	async () => {
		const run = await chatWindowRoom();
		expect(run.reopen.stateAfter).toEqual(Array.from({ length: WRITERS }, () => run.reopen.stateBefore));
		// Every epoch after the reopen (and after the crashed Writer's reopen) still matches the
		// model's window on every peer (the agreement test checks every epoch's bytes).
		const after = run.agreement.filter(({ epoch }) => epoch > REOPEN_AT);
		expect(after.length).toBe(EPOCHS - REOPEN_AT);
		for (const { epoch, digests, model } of after) expect(digests, `epoch ${epoch}`).toEqual([model, model, model]);
	},
	TIMEOUT
);

it(
	"a joiner receives only the window",
	async () => {
		const run = await chatWindowRoom();
		expect(run.exported.length).toBeGreaterThanOrEqual(2);
		for (const { epoch, exported, model } of run.exported) {
			expect(exported, `successor export at epoch ${epoch}`).toBe(model);
			const state = decodeCanonical(Buffer.from(exported, "hex")) as { messages: ChatMessage[] };
			expect(state.messages.length, `export at epoch ${epoch} carries fewer messages than were sent`).toBeLessThan(
				epoch * SENDERS.length
			);
		}
	},
	TIMEOUT
);
