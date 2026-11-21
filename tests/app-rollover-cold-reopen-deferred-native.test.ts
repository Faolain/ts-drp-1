/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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

// fix/browser-rollover-member-stall, after box m35 (blocker d): a member cold-restarts (SIGKILL, then a
// reopen of the same directory) between an install and the replacements rule R deferred into it.
//
// The time-driven chain model of app-rollover-replacement-chain-native (same ticks, same trigger): the
// first gated install (2 -> 3) issues its author fence, replaces three rows, and is stopped by rule R
// when the creator seals epoch 3 mid-chunk. The two epoch-2 rows it did not replace stay owed below the
// fence, which the creator admits. The second install (3 -> 4) reaches epoch 4; its drain owes them,
// and the creator's frontier now calls them terminal (fence - 1). The process is killed at that drain's
// first signature request: the plane of epoch 4 is durable, the rows are still owed, nothing is signed.
//
// After the reopen every move must still be admitted by the creator exactly once (G3), and the member's
// state must equal the creator's. Live, the owed rows of epoch 2 are replaced at epoch 4 under the
// source authority the successor kept from its live predecessor (keptDisplacedSources). A cold reopen
// has no live predecessor; its plane keeps only the closed epoch's (3) authority.
const INNER = process.env.RUN_COLD_REOPEN_DEFERRED === "1";
const PERIOD = 20;
const INSTALL_BASE = 12;
const ROW_COST = 2;
const BURST = 5;
const MOVES_PER_INSTALL = 3;
// The process dies at the first drain signature of this gated install (0-based).
const DIE_AT_INSTALL = 1;

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
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RowValue = { epoch: number; author: string; authorSequence: number; operation: Record<string, unknown> };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const movesOf = (operation: unknown): string[] => {
	if (operation === null || typeof operation !== "object") return [];
	const id = Reflect.get(operation, "id");
	if (typeof id === "string") return [id];
	const entries = Reflect.get(Reflect.get(operation, "batch") ?? {}, "entries");
	return Array.isArray(entries) ? entries.flatMap((entry) => movesOf(Reflect.get(entry, "operation"))) : [];
};
const issuanceFile = (directory: string, name: string) =>
	join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["issuance", name]))
			.digest("hex")}.sqlite.drp-issuance-v1.sqlite`
	);

type PlanEntry = { disposition: string; sourceSequence: number; replacementSequence: number | null };
/**
 * The member's own rows (sequence, epoch, fence or not) and its settlement plan, read from its SQLite file.
 * @param file - The member's issuance store file.
 * @param author - The member.
 * @returns Its own rows, plan entries and plan fence.
 */
function memberIssuance(file: string, author: string) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT author_sequence, canonical_preimage FROM issued_records WHERE author=? ORDER BY author_sequence")
			.all(author)
			.map((row) => {
				const value = decodeCanonical(new Uint8Array(row.canonical_preimage as Uint8Array)) as RowValue;
				return {
					sequence: row.author_sequence as number,
					epoch: value.epoch,
					fence: value.operation.action === "$drp.author-fence.v1",
				};
			});
		const planRow = db
			.prepare("SELECT entries_json, fence_sequence FROM settlement_plans WHERE author=?")
			.get(author) as { entries_json: string; fence_sequence: number | null } | undefined;
		let entries: PlanEntry[] = [];
		if (planRow !== undefined) {
			const decoded = JSON.parse(planRow.entries_json) as unknown;
			entries = Array.isArray(decoded)
				? (decoded as PlanEntry[])
				: (
						decodeCanonical(new Uint8Array(Buffer.from((decoded as { bytes: string }).bytes, "base64"))) as {
							entries: PlanEntry[];
						}
					).entries;
		}
		return { rows, entries, fence: planRow?.fence_sequence ?? null };
	} finally {
		db.close();
	}
}

async function openPair(directory: string, reopen: boolean, member: Pick<RoleEnvironment, "deliveryRoom" | "sign">) {
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
		host: nodeHostFor("node", directory, reopen),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: reopen ? ("reopen" as const) : ("create" as const) },
			}),
	};
	const creator = await openRole(options, 0, env);
	const writer = await openRole(options, 1, {
		...env,
		...(member.deliveryRoom === undefined ? {} : { deliveryRoom: member.deliveryRoom }),
		...(member.sign === undefined ? {} : { sign: member.sign }),
		relay: (request) => creator.dispatch(request),
	});
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
	let carrying: Promise<void> = Promise.resolve();
	const serial = (run: () => Promise<void>) => (carrying = carrying.then(run, run));
	return {
		toWriter: () => serial(() => carry(creator, writer, "creator")),
		toCreator: () => serial(() => carry(writer, creator, "writer")),
	};
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

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 3000)}`);
		await sleep(50);
	}
}

type Death = {
	writerAuthor: string;
	ids: string[];
	ordinal: number;
	installs: { index: number; from: number; drainSigns: number }[];
	memberEpoch: number;
	creatorEpoch: number;
	rows: { sequence: number; epoch: number; fence: boolean }[];
	entries: PlanEntry[];
	fence: number | null;
	// What the creator had admitted of the member when it died (its in-memory record does not survive).
	creatorAdmitted: { authorSequence: number; moves: string[] }[];
};

it.runIf(INNER)(
	"the member dies at the first drain signature of the install after a deferral",
	async () => {
		const directory = process.env.COLD_REOPEN_DEFERRED_DIRECTORY ?? "";
		if (directory === "") throw Error("COLD_REOPEN_DEFERRED_DIRECTORY is not set");
		const restore = await installEnvironment("node", () => undefined);
		type Install = { index: number; from: number; drainSigns: number; baseCharged: boolean; drainOpen: boolean };
		const clock = { tick: 0, nextRoll: PERIOD };
		const installs: Install[] = [];
		const pending: Promise<unknown>[] = [];
		const ids = ["block-1-0", "block-1-1"];
		let gating = false;
		let writerOrdinal = 10;
		let writerAuthor = "";
		let creatorEpoch = 0;
		let memberRoom: { authority(): { epoch: number } | null | undefined } | undefined;
		let creatorEndpoint: RoleEndpoint | undefined;
		let rollNow: ((carry?: boolean) => Promise<void>) | undefined;
		let makeMoves: (() => void) | undefined;
		const ordinal = { next: 0 };
		const advance = async (ticks: number) => {
			clock.tick += ticks;
			while (clock.tick >= clock.nextRoll) await rollNow?.();
		};
		try {
			const { creator, writer } = await openPair(directory, false, {
				deliveryRoom: (room) => {
					memberRoom = room;
					return {
						authority: () => room.authority(),
						connectedPeers: () => room.connectedPeers(),
						installCreatorSuccessor: async (request) => {
							if (!gating) return room.installCreatorSuccessor(request);
							const record: Install = {
								index: installs.length,
								from: room.authority()?.epoch ?? 0,
								drainSigns: 0,
								baseCharged: false,
								drainOpen: true,
							};
							installs.push(record);
							try {
								await room.installCreatorSuccessor(request);
							} finally {
								record.drainOpen = false;
								await Promise.allSettled(pending.splice(0));
							}
						},
					};
				},
				sign: async (_digest, sign) => {
					const install = gating ? installs.at(-1) : undefined;
					const memberEpoch = memberRoom?.authority()?.epoch ?? 0;
					const drain = install !== undefined && install.drainOpen && memberEpoch > install.from;
					if (drain && install.index === DIE_AT_INSTALL) {
						const file = issuanceFile(directory, "recipient");
						const creatorAdmitted = ((await creatorEndpoint?.acceptedVertices?.()) ?? [])
							.filter((vertex) => vertex.author === writerAuthor)
							.map((vertex) => ({
								authorSequence: vertex.authorSequence,
								moves: movesOf(JSON.parse(vertex.operation)),
							}));
						writeFileSync(
							join(directory, "death.json"),
							JSON.stringify({
								writerAuthor,
								ids,
								ordinal: ordinal.next,
								installs: installs.map(({ index, from, drainSigns }) => ({ index, from, drainSigns })),
								memberEpoch,
								creatorEpoch,
								...memberIssuance(file, writerAuthor),
								creatorAdmitted,
							} satisfies Death)
						);
						process.kill(process.pid, "SIGKILL");
						throw Error("SIGKILL_DID_NOT_TERMINATE");
					}
					if (drain && !install.baseCharged) {
						install.baseCharged = true;
						makeMoves?.();
						await advance(INSTALL_BASE);
					}
					const signature = await sign();
					if (drain) {
						install.drainSigns++;
						await advance(ROW_COST);
					}
					return signature;
				},
			});
			creatorEndpoint = creator;
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const deliverOffer = async (epoch: number) => {
				const deadline = performance.now() + 30_000;
				for (;;) {
					const down = (await creator.successorFrames?.()) ?? [];
					const up = (await writer.successorFrames?.()) ?? [];
					if (down.length) await writer.deliverSuccessorFrames?.(down);
					if (up.length) await creator.deliverSuccessorFrames?.(up);
					const offered = down.some((frame) => {
						try {
							const value = decodeCanonical(fromBase64(frame)) as { kind?: unknown; successorEpoch?: unknown };
							return value.kind === "ts-drp-v3-successor-offer" && Number(value.successorEpoch) >= epoch;
						} catch {
							return false;
						}
					});
					if (offered) return;
					if (performance.now() > deadline) throw new Error(`the creator's offer for epoch ${epoch} never arrived`);
					await sleep(20);
				}
			};
			rollNow = async (carry = true) => {
				if (carry) await rows.toCreator();
				creatorEpoch = await rollCreator(creator, () => Promise.resolve(), ordinal);
				clock.nextRoll += PERIOD;
				await deliverOffer(creatorEpoch);
			};
			makeMoves = () => {
				for (let n = 0; n < MOVES_PER_INSTALL; n++) {
					ids.push(`block-1-${writerOrdinal}`);
					pending.push(writer.issue(0, writerOrdinal++).catch(() => undefined));
				}
			};
			for (let n = 0; n < 2; n++) {
				const epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n);
				await rows.toCreator();
			}
			const [firstOwn] = await writer.published(null);
			if (firstOwn === undefined) throw Error("the member has no first row");
			writerAuthor = rowValue(firstOwn).author;
			await wire.pause();
			creatorEpoch = (await creator.rollover?.())?.epoch ?? 0;
			gating = true;
			// The trigger: the creator has the member's rows of its epoch; then the burst, each move its own
			// row, all signed before the seal and none carried to the creator before it.
			await rows.toCreator();
			clock.tick = clock.nextRoll;
			for (let n = 0; n < BURST; n++) {
				ids.push(`block-1-${writerOrdinal}`);
				await writer.issue(0, writerOrdinal++);
			}
			await rollNow(false);
			// The member installs back to back from here; the process dies inside the second install.
			await sleep(600_000);
			throw Error(`COLD_REOPEN_DEFERRED_NOT_REACHED ${JSON.stringify({ installs, clock, creatorEpoch })}`);
		} finally {
			restore();
		}
	},
	900_000
);

it.skipIf(INNER)(
	"a member cold-restarted between an install and the replacements rule R deferred into it lands every move exactly once",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-rollover-cold-reopen-deferred-"));
		directories.push(directory);
		const child = spawn(
			"npx",
			["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
			{
				env: { ...process.env, RUN_COLD_REOPEN_DEFERRED: "1", COLD_REOPEN_DEFERRED_DIRECTORY: directory },
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile))
			throw new Error(`the member did not die in its second install:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Death;
		// The state this test is about: the plan owes a replacement of a row of an earlier epoch that sits
		// below the member's own fence of a later epoch (the fence the deferring drain issued first).
		const fences = death.rows.filter((row) => row.fence);
		const owedBelowFence = death.entries
			.filter(
				(entry) =>
					(entry.disposition === "rebase" || entry.disposition === "transform") && entry.replacementSequence === null
			)
			.map((entry) => death.rows.find((row) => row.sequence === entry.sourceSequence))
			.filter(
				(row) =>
					row !== undefined &&
					fences.some(
						(fence) => fence.sequence > row.sequence && fence.epoch > row.epoch && fence.epoch < death.memberEpoch
					)
			);
		process.stdout.write(`COLD_REOPEN_DEFERRED_DEATH ${JSON.stringify({ death, owedBelowFence })}\n`);
		expect(death.memberEpoch, "the member died after reaching its second install's epoch").toBeGreaterThan(
			death.installs[DIE_AT_INSTALL]?.from ?? Infinity
		);
		expect(owedBelowFence.length, "rows still owed below the member's own earlier fence at death").toBeGreaterThan(0);
		// The deferring drain's fence reached the creator, and was admitted, before the member died: the
		// member's own merge at the epoch it died in resolved it as committed (the creator's signed frontier
		// reaches it). The creator's application record holds moves only, not control rows.
		expect(
			fences.filter(
				(fence) =>
					owedBelowFence.some((row) => row !== undefined && row.sequence < fence.sequence) &&
					death.entries.some((entry) => entry.sourceSequence === fence.sequence && entry.disposition === "committed")
			).length,
			"an admitted own fence above the owed rows"
		).toBeGreaterThan(0);
		const admittedBefore = death.ids.map(
			(id) => death.creatorAdmitted.flatMap((vertex) => vertex.moves).filter((move) => move === id).length
		);

		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, true, {});
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: death.ordinal + 1_000 };
			const admitted = async () =>
				((await creator.acceptedVertices?.()) ?? [])
					.filter((vertex) => vertex.author === death.writerAuthor)
					.flatMap((vertex) => movesOf(JSON.parse(vertex.operation)));
			// Admitted before the death plus admitted since the reopen.
			const counts = async () => {
				const moves = await admitted();
				return death.ids.map((id, index) => (admittedBefore[index] ?? 0) + moves.filter((move) => move === id).length);
			};
			try {
				let epoch = (await creator.rollover?.())?.epoch ?? 0;
				await waitFor(
					"the creator admits every move of the member after its cold restart",
					async () => {
						epoch = await rollCreator(creator, rows.toWriter, ordinal);
						await wire.caughtUp(epoch, 120_000).catch(() => undefined);
						await rows.toWriter();
						await rows.toCreator();
						return {
							counts: await counts(),
							creator: epoch,
							member: await writer.authorityEpoch(),
							memberErrors: (await writer.rollover?.())?.errors?.slice(-3),
							// Observation only: what the member's delivery and settlement report while it does not follow.
							delivery: await writer.successorDelivery?.(),
							settlement: await writer.settlementStatus?.(),
						};
					},
					(state) => state.counts.every((count) => count >= 1),
					600_000
				);
				for (let round = 0; round < 2; round++) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 120_000);
					await rows.toWriter();
					await rows.toCreator();
				}
				expect(await counts(), "each move admitted by the creator once").toEqual(death.ids.map(() => 1));
				expect(await writer.state()).toBe(await creator.state());
			} finally {
				await wire.stop();
			}
		} finally {
			restore();
		}
	},
	1_500_000
);
