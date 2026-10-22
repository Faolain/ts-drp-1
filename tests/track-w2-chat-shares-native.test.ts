/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import {
	type ChatSharesPeer,
	chatSharesRoomFixture,
	closeChatSharesRooms,
	hex,
	required,
} from "./fixtures/chat-membership-shares/room.js";
import { type StoreCensus } from "./fixtures/chat-rolling-window/chat-long-room.js";
import {
	createShippingChatSharesGenesisStateBytes,
	restoreShippingChatSharesState,
	type ShippingChatShares,
	shippingChatShareUpdate,
} from "../examples/chat/src/v3-chat-shares.js";

// Track W2: a shipped Chat room of the v5 format (rolling window, membership-aware shares) runs
// W2_NATIVE_EPOCHS (default 300) genuine transitions on genuine SQLite owners while its members
// change. Peer 0 is the creator (admin); peer 1 a genesis Writer; peers 2 and 3 open receive-only
// (the shipped page's joiners) and follow the room. At chosen epochs:
// - the creator grants peer 2 Writer (JOIN_2), and later peer 3 (JOIN_3): the creator's page issues
//   the share update at the next checkpoint, and from the checkpoint after it the joiner's page
//   reopens as a Writer on its first Send and speaks every epoch;
// - the creator revokes peer 1 (LEAVE_1), and later peer 2 (LEAVE_2): each stops at once (its page
//   closes), the share update drops its row, and its messages stay until the window needs room;
// - every peer stops and reopens over the same databases mid-epoch (CRASH_AT), after that epoch's
//   messages were admitted and before the seal: each replays to the same state.
// Every epoch every following peer's state bytes equal the creator's, and the window equals an
// independent model of the rule (tests/track-w2-chat-shares-rule.test.ts states it).
// W2_NATIVE_OUT=<dir> writes one JSONL line per epoch (latency, state bytes, store census).

const EPOCHS = Number(process.env.W2_NATIVE_EPOCHS ?? 300);
const at = (fraction: number): number => Math.floor(EPOCHS * fraction);
const JOIN_2 = at(1 / 15);
const LEAVE_1 = at(1 / 3);
const CRASH_AT = at(1 / 2);
const JOIN_3 = at(3 / 5);
const LEAVE_2 = at(5 / 6);
const STATE_LIMIT = 32_768;
const T = 1_791_662_400_000;

afterAll(async () => {
	expect(await closeChatSharesRooms(), "native admitted work and owners join").toEqual([]);
});

interface ChatMessage {
	readonly author: string;
	readonly clientOperationId: string;
	readonly displayTimeMs: number;
	readonly text: string;
}
const size = (message: ChatMessage): number =>
	encodeCanonical({
		author: message.author,
		clientOperationId: message.clientOperationId,
		displayTimeMs: message.displayTimeMs,
		text: message.text,
	}).byteLength;

// Deterministic text lengths between 40 and 300 characters.
function textFor(sender: number, epoch: number, ordinal: number): string {
	const seed = (epoch * 7919 + ordinal * 104_729 + sender * 1_299_709) % 261;
	return `e${epoch} p${sender} o${ordinal} ` + "x".repeat(40 + seed);
}

/**
 * The window as the owner chose it, kept independently of the product: departed members'
 * messages leave first, oldest first, and only when the window needs room; after them, the
 * oldest message of a holder above its guarantee.
 */
class SharesModel {
	messages: ChatMessage[] = [];
	readonly evicted: { epoch: number; author: string; kind: "departed" | "surplus" }[] = [];
	constructor(public capacity: ShippingChatShares) {}
	private reclaim(epoch: number): void {
		const charge = new Map<string, number>();
		for (const message of this.messages) charge.set(message.author, (charge.get(message.author) ?? 0) + size(message));
		let total = this.messages.reduce((sum, message) => sum + size(message), 0);
		const guarantee = new Map(this.capacity.allocations.map(([author, bytes]) => [author, bytes]));
		while (total > this.capacity.windowBytes) {
			let index = this.messages.findIndex((message) => !guarantee.has(message.author));
			let kind: "departed" | "surplus" = "departed";
			if (index < 0) {
				kind = "surplus";
				index = this.messages.findIndex(
					(message) => (charge.get(message.author) ?? 0) > required(guarantee.get(message.author))
				);
			}
			const [removed] = this.messages.splice(index, 1);
			if (removed === undefined) throw new TypeError("W2_NATIVE_MODEL_RECLAIM");
			total -= size(removed);
			charge.set(removed.author, required(charge.get(removed.author)) - size(removed));
			this.evicted.push({ epoch, author: removed.author, kind });
		}
	}
	message(epoch: number, message: ChatMessage): void {
		this.messages.push(message);
		this.reclaim(epoch);
	}
	share(epoch: number, capacity: ShippingChatShares): void {
		this.capacity = capacity;
		this.reclaim(epoch);
	}
}

interface EpochRecord {
	readonly epoch: number;
	readonly following: readonly number[];
	readonly holders: readonly string[];
	readonly stateBytes: number;
	readonly windowBytes: number;
	readonly windowMessages: number;
	readonly departedMessages: number;
	readonly census: readonly (StoreCensus | null)[];
	readonly latency: Readonly<{
		issue: readonly number[];
		promote: number | null;
		seal: number;
		adopt: number;
		install: readonly number[];
		lull: readonly number[];
	}>;
	readonly lullKinds: readonly string[];
	readonly event?: string;
}

interface NativeRun {
	readonly authors: readonly string[];
	readonly records: readonly EpochRecord[];
	readonly agreement: readonly Readonly<{ epoch: number; digests: readonly string[]; model: string }>[];
	readonly firstSpoken: ReadonlyMap<number, number>;
	readonly sinceEpochs: ReadonlyMap<number, number>;
	readonly crash: readonly Readonly<{ peer: number; before: string; after: string }>[];
	readonly evicted: SharesModel["evicted"];
	readonly departedGone: ReadonlyMap<number, number>;
}

const latencyOf = async <Value>(task: () => Promise<Value>) => {
	const started = performance.now();
	const value = await task();
	return { value, ms: performance.now() - started };
};

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

async function runNativeRoom(): Promise<NativeRun> {
	const f = await chatSharesRoomFixture({
		members: ["genesis", "late", "late"],
		format: "shares",
		genesisStateBytes: createShippingChatSharesGenesisStateBytes,
	});
	const authors = f.identities.map(({ author }) => author);
	const peers: (ChatSharesPeer | undefined)[] = [
		await f.open(0),
		await f.open(1),
		await f.open(2, { receiveOnly: true }),
		await f.open(3, { receiveOnly: true }),
	];
	// Writers that speak every epoch (the creator twice); receive-only peers until promoted.
	const writer = new Set([0, 1]);
	const receiveOnly = new Set([2, 3]);
	// delivered[from][to]: the last author sequence of `from` that `to` has received.
	const delivered = peers.map(() => peers.map((): number | null => null));
	const deliver = async (from: number) => {
		for (let to = 0; to < peers.length; to++) {
			const peer = peers[to];
			if (to === from || peer === undefined) continue;
			const fresh = await f.issuedAfter(from, required(delivered[from])[to] ?? null);
			if (fresh.length === 0) continue;
			expect(await peer.receive(fresh, from), `delivery ${from} -> ${to}`).toBe(true);
			required(delivered[from])[to] = required(fresh.at(-1)).commit.authorSequence;
		}
	};
	const creator = () => required(peers[0]);
	const shares = (peer: ChatSharesPeer) => restoreShippingChatSharesState(peer.stateBytes()).capacity;
	const model = new SharesModel(shares(creator()));
	const records: EpochRecord[] = [];
	const agreement: { epoch: number; digests: string[]; model: string }[] = [];
	const firstSpoken = new Map<number, number>();
	const sinceEpochs = new Map<number, number>();
	const crash: { peer: number; before: string; after: string }[] = [];
	const departedGone = new Map<number, number>();
	const departed = new Set<number>();
	const digest = (bytes: Uint8Array) => hex(hashDomain("ts-drp/state/v3", bytes));
	const modelBytes = () => encodeCanonical({ version: 5, messages: model.messages, capacity: model.capacity });

	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		const events: string[] = [];
		// The admin's page: one share update per checkpoint whose rows differ from the formula.
		const update = shippingChatShareUpdate({
			capacity: shares(creator()),
			exactCanonicalLatchedAclBytes: encodeCanonical(creator().room.previewLatchedAcl().current),
		});
		if (update !== undefined) {
			await creator().room.issue(update);
			model.share(epoch, update.capacity);
			for (const [author, , since] of update.capacity.allocations) {
				const index = authors.indexOf(author);
				if (!sinceEpochs.has(index)) sinceEpochs.set(index, since);
			}
			await deliver(0);
			events.push(`share update: ${update.capacity.allocations.length} holders`);
		}
		// A joiner whose share is in force: its page reopens as a Writer on its first Send.
		let promote: number | null = null;
		for (const index of [...receiveOnly]) {
			const since = sinceEpochs.get(index);
			if (since === undefined || since > epoch) continue;
			const peer = required(peers[index]);
			const reopened = await latencyOf(async () => {
				await f.stop(peer);
				return f.open(index, { promote: true });
			});
			peers[index] = reopened.value;
			promote = reopened.ms;
			receiveOnly.delete(index);
			writer.add(index);
			firstSpoken.set(index, epoch);
			events.push(`peer ${index} speaks`);
		}
		// This epoch's messages: the creator twice, every other Writer once.
		const issueMs: number[] = [];
		const senders = [0, ...[...writer].filter((index) => index !== 0).sort(), 0];
		for (let ordinal = 0; ordinal < senders.length; ordinal++) {
			const sender = required(senders[ordinal]);
			const operation = {
				action: "message" as const,
				clientOperationId: `m-${sender}-${epoch}-${ordinal}`,
				displayTimeMs: T + epoch * 1000 + ordinal,
				text: textFor(sender, epoch, ordinal),
			};
			const issued = await latencyOf(() => required(peers[sender]).room.issue(operation));
			issueMs.push(issued.ms);
			model.message(epoch, {
				author: required(authors[sender]),
				clientOperationId: operation.clientOperationId,
				displayTimeMs: operation.displayTimeMs,
				text: operation.text,
			});
			await deliver(sender);
		}
		// Membership changes, issued by the creator in this checkpoint (they latch at the next).
		const change = (kind: "grant" | "revoke", index: number) =>
			creator().room.issue({ action: "acl", kind, group: "writer", target: required(authors[index]) });
		if (epoch === JOIN_2 || epoch === JOIN_3) {
			const index = epoch === JOIN_2 ? 2 : 3;
			await change("grant", index);
			await deliver(0);
			events.push(`grant ${index}`);
		}
		if (epoch === LEAVE_1 || epoch === LEAVE_2) {
			const index = epoch === LEAVE_1 ? 1 : 2;
			await change("revoke", index);
			await deliver(0);
			events.push(`revoke ${index}`);
		}
		if (epoch === CRASH_AT) {
			// Every peer stops mid-epoch, after admitting this epoch's work and before the seal, and
			// reopens over the same databases: each replays to the same state.
			for (let index = peers.length - 1; index >= 0; index--) {
				const peer = peers[index];
				if (peer === undefined) continue;
				const before = hex(peer.stateBytes());
				await f.stop(peer);
				peers[index] = await f.open(index, { reopen: true, ...(receiveOnly.has(index) ? { receiveOnly: true } : {}) });
				crash.push({ peer: index, before, after: hex(required(peers[index]).stateBytes()) });
			}
			events.push("every peer reopened mid-epoch");
		}
		// The checkpoint: seal and adopt on the creator; every other following peer installs.
		const seal = await latencyOf(() => creator().room.sealEpoch());
		expect(seal.value, `seal at epoch ${epoch}`).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		const adopt = await latencyOf(() => creator().room.adoptCreatorSuccessor());
		// A revoked member's page closes once the revocation latches; it no longer follows.
		if (epoch === LEAVE_1 || epoch === LEAVE_2) {
			const index = epoch === LEAVE_1 ? 1 : 2;
			await f.stop(required(peers[index]));
			peers[index] = undefined;
			writer.delete(index);
			departed.add(index);
		}
		const install: number[] = [];
		for (let index = 1; index < peers.length; index++) {
			const peer = peers[index];
			if (peer === undefined) continue;
			const installed = await latencyOf(() => f.install(peer));
			install.push(installed.ms);
			expect(peer.room.authority(), `install of peer ${index} at epoch ${epoch}`).toMatchObject({
				epoch: epoch + 1,
				lifecycle: "active",
			});
		}
		const following = peers.flatMap((peer, index) => (peer === undefined ? [] : [index]));
		const states = following.map((index) => required(peers[index]).stateBytes());
		agreement.push({ epoch: epoch + 1, digests: states.map(digest), model: digest(modelBytes()) });
		// Fail fast on a long run: every following peer and the model agree now.
		expect(
			states.map((bytes) => hex(bytes)),
			`state at epoch ${epoch + 1}`
		).toEqual(states.map(() => hex(modelBytes())));
		for (const index of departed)
			if (!departedGone.has(index) && !model.messages.some((message) => message.author === authors[index]))
				departedGone.set(index, epoch + 1);
		// The idle lull between checkpoints, as Track W's native room measures it: every following
		// peer maintains its recovery pool, so the next seal does not carry that work inline.
		const lull: number[] = [];
		const lullKinds: string[] = [];
		for (const index of following) {
			const result = await latencyOf(() => required(peers[index]).room.maintainRecoveryPool());
			lull.push(result.ms);
			const value = result.value as Readonly<{ kind: string; reason?: string }>;
			lullKinds.push(value.reason === undefined ? value.kind : `${value.kind}:${value.reason}`);
		}
		const record: EpochRecord = {
			epoch: epoch + 1,
			following,
			holders: model.capacity.allocations.map(([author]) => author.slice(0, 8)),
			stateBytes: required(states[0]).byteLength,
			windowBytes: model.messages.reduce((sum, message) => sum + size(message), 0),
			windowMessages: model.messages.length,
			departedMessages: model.messages.filter((message) => departed.has(authors.indexOf(message.author))).length,
			census: peers.map((peer, index) => (peer === undefined ? null : f.census(index))),
			latency: { issue: issueMs, promote, seal: seal.ms, adopt: adopt.ms, install, lull },
			lullKinds,
			...(events.length > 0 ? { event: events.join("; ") } : {}),
		};
		records.push(record);
		const out = process.env.W2_NATIVE_OUT;
		if (out !== undefined) {
			mkdirSync(out, { recursive: true });
			appendFileSync(
				join(out, "chat-shares-native.jsonl"),
				`${JSON.stringify({ ...record, census: record.census.map((value) => (value === null ? null : totals(value))) })}\n`
			);
		}
	}
	return { authors, records, agreement, firstSpoken, sinceEpochs, crash, evicted: model.evicted, departedGone };
}

let nativeRoom: Promise<NativeRun> | undefined;
const run = (): Promise<NativeRun> => (nativeRoom ??= runNativeRoom());
const TIMEOUT = 4 * 60 * 60 * 1000;

it(
	`a v5 Chat room runs ${EPOCHS} epochs with joins and leaves, and every following peer's state equals the creator's and the rule's every epoch`,
	async () => {
		const value = await run();
		expect(value.records.map((record) => record.epoch)).toEqual(
			Array.from({ length: EPOCHS }, (_, epoch) => epoch + 1)
		);
		for (const { epoch, digests, model } of value.agreement)
			expect(digests, `state digests at epoch ${epoch}`).toEqual(digests.map(() => model));
	},
	TIMEOUT
);

it(
	"a joiner speaks from the checkpoint after its share update, and a departed member's messages leave only when needed, before anyone's surplus",
	async () => {
		const value = await run();
		// Granted in checkpoint J, Writer from J + 1, share from J + 2: it speaks then.
		expect(value.sinceEpochs.get(2)).toBe(JOIN_2 + 2);
		expect(value.sinceEpochs.get(3)).toBe(JOIN_3 + 2);
		expect(value.firstSpoken.get(2)).toBe(JOIN_2 + 2);
		expect(value.firstSpoken.get(3)).toBe(JOIN_3 + 2);
		// Each departed member's messages all left in time, and while any of them remained, no
		// other member's message was evicted (the model, which the product equals every epoch).
		for (const [index, leave] of [
			[1, LEAVE_1],
			[2, LEAVE_2],
		] as const) {
			const gone = value.departedGone.get(index);
			expect(gone, `member ${index}'s messages all left before the run ended (about 300 epochs)`).toBeDefined();
			expect(required(gone)).toBeGreaterThan(leave + 1);
			const author = required(value.authors[index]);
			// From the first eviction after the leave to the departed member's last one, in order,
			// every eviction is a departed member's.
			const first = value.evicted.findIndex(({ epoch }) => epoch > leave);
			let last = -1;
			value.evicted.forEach((eviction, position) => {
				if (eviction.author === author) last = position;
			});
			expect(first).toBeGreaterThanOrEqual(0);
			expect(last).toBeGreaterThanOrEqual(first);
			for (const eviction of value.evicted.slice(first, last + 1))
				expect(eviction, `eviction at epoch ${eviction.epoch} while member ${index}'s messages remain`).toMatchObject({
					kind: "departed",
				});
		}
	},
	TIMEOUT
);

it(
	"state bytes stay under 32 KiB, and every room store stays flat once the window is full",
	async () => {
		const value = await run();
		for (const record of value.records)
			expect(record.stateBytes, `state bytes at epoch ${record.epoch}`).toBeLessThanOrEqual(STATE_LIMIT);
		const full = value.records.findIndex((record) => value.evicted.some(({ epoch }) => epoch < record.epoch));
		expect(full, "the window filled during the run (about 300 epochs)").toBeGreaterThan(0);
		const steady = value.records.slice(full + 10);
		expect(steady.length).toBeGreaterThanOrEqual(Math.floor(EPOCHS / 2));
		// The creator follows every epoch: its stores keep no row per message or per epoch.
		const series = steady.map((record) => [record.epoch, totals(required(record.census[0]))] as const);
		const first = required(series[0])[1];
		for (const [epoch, census] of series) {
			expect(census.rows, `creator store rows at epoch ${epoch}`).toBeLessThanOrEqual(first.rows + 16);
			expect(census.bytes, `creator store bytes at epoch ${epoch}`).toBeLessThanOrEqual(first.bytes + 16_384);
		}
		// Every peer that follows ends no larger than the creator's band.
		const last = required(value.records.at(-1));
		for (const census of last.census)
			if (census !== null) expect(totals(census).rows).toBeLessThanOrEqual(first.rows + 64);
	},
	TIMEOUT
);

it(
	"every peer that stops mid-epoch replays to the same state",
	async () => {
		const value = await run();
		expect(value.crash.length).toBeGreaterThanOrEqual(3);
		for (const { peer, before, after } of value.crash) expect(after, `peer ${peer}`).toBe(before);
	},
	TIMEOUT
);
