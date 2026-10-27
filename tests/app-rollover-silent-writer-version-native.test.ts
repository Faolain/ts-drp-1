/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import { fromBase64, type RoleEndpoint, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Cross-version probe for the retained-source frontier resolution record
// (sourceResolutionKind "frontier", fix/silent-writer-catchup). One store directory, two
// processes: "stuck" leaves a move in flight, keeps the creator unreachable past the journal's
// protected scopes, and reconnects (the Writer installs more than one epoch ahead and retains its
// old epoch's rows); "continue" reopens the SAME directory and must settle that move exactly once.
// The driver runs each phase against a chosen build (c08d8680 or the fix), so upgrade and
// downgrade are real reopenings. Skipped unless SW_VERSION_PHASE is set.
const PHASE = process.env.SW_VERSION_PHASE;
const DIRECTORY = process.env.SW_VERSION_DIRECTORY;
const MAX_PROTECTED_SCOPES = 7;

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
});

type RowValue = { epoch: number; author: string; authorSequence: number; operation: Record<string, unknown> };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;
const moveId = (epoch: number) => `block-1-${epoch}`;
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};
const chain = (cause: unknown) => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 10; value = value.cause)
		parts.push(`${value.name}: ${value.message}`);
	if (cause instanceof AggregateError) for (const error of cause.errors) parts.push(`(aggregate) ${String(error)}`);
	let deepest: unknown = cause;
	while (deepest instanceof Error && deepest.cause instanceof Error) deepest = deepest.cause;
	if (deepest instanceof Error) parts.push(...(deepest.stack ?? "").split("\n").slice(1, 12).map((line) => line.trim()));
	return parts;
};

async function openPair(directory: string, reopen: boolean) {
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
	let stage = "open-creator";
	try {
		const creator = await openRole(options, 0, env);
		stage = "open-writer";
		const writer = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
		return { creator, writer };
	} catch (cause) {
		throw new Error(stage, { cause });
	}
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

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[]) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map((id) => vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length);
}

/** The Writer's own rows (still held) carrying the move that was in flight: [authorSequence, epoch]. */
async function ownMoves(writer: RoleEndpoint) {
	return (await writer.published(null))
		.filter((row) => rowValue(row).operation.id === moveId(50))
		.map((row) => [row.authorSequence, rowValue(row).epoch]);
}

/** The Writer's settlement plan as stored (a separate store handle): per entry disposition, resolution and kind. */
async function planImage(directory: string, author: string) {
	const objectId = `creator:${Buffer.from(hashDomain("track-m-apps-object/v1", new TextEncoder().encode(directory))).toString("hex").slice(0, 32)}`;
	try {
		const store = await nodeHostFor("node", directory, true).observe.openIssuance("recipient");
		try {
			const plan = await store.readSettlementPlan({ objectId, author });
			if (plan === null) return null;
			const handBacks = (plan as { handBacks?: readonly { sourceSequence: number; intent: number; reissueSequence: number | null }[] })
				.handBacks;
			return [
				...plan.entries.map((entry) => ({
					sequence: entry.sourceSequence,
					disposition: entry.disposition,
					resolved: entry.sourceResolutionDigest !== undefined,
					kind: (entry as { sourceResolutionKind?: string }).sourceResolutionKind ?? null,
				})),
				// Durable hand-back records (fix/silent-writer-catchup): [source, intent, reissue row or null].
				...(handBacks === undefined
					? []
					: [{ handBacks: handBacks.map((record) => [record.sourceSequence, record.intent, record.reissueSequence]) }]),
			];
		} finally {
			await (store as unknown as { close?: () => Promise<void> }).close?.();
		}
	} catch (cause) {
		return { readError: chain(cause) };
	}
}

it.runIf(PHASE === "stuck")(
	"stuck: a move in flight, the creator unreachable past the protected scopes, then reconnected",
	async () => {
		const directory = DIRECTORY!;
		const restore = await installEnvironment("node", () => undefined);
		const log: unknown[] = [];
		try {
			const { creator, writer } = await openPair(directory, false);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: 0 };
			let epoch = 0;
			try {
				while (epoch < 2) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 60_000);
					await rows.toWriter();
					await writer.issue(1, epoch);
					await rows.toCreator();
				}
				const writerAuthor = rowValue((await writer.published(null))[0]!).author;
				await writer.issue(1, 50);
				const original = (await writer.published(null)).find((row) => rowValue(row).operation.id === moveId(50));
				expect(original).toBeDefined();
				await wire.pause();
				await writer.setPeerConnected?.(false);
				const before = epoch;
				while (epoch < before + MAX_PROTECTED_SCOPES + 2) epoch = await rollCreator(creator, async () => undefined, ordinal);
				await writer.setPeerConnected?.(true);
				wire.resume();
				await wire.caughtUp(epoch, 60_000);
				await rows.toWriter();
				await rows.toCreator();
				log.push({ label: "reconnected", epoch, plan: await planImage(directory, writerAuthor), settlement: await writer.settlementStatus?.() });
				writeFileSync(
					join(directory, "stuck.json"),
					JSON.stringify({ epoch, ordinal: ordinal.next, writerAuthor, original, log })
				);
				console.info(`SW_VERSION stuck ${JSON.stringify(log.at(-1))}`);
			} finally {
				await wire.stop();
				await writer.close();
				await creator.close();
			}
		} finally {
			restore();
		}
	},
	300_000
);

it.runIf(PHASE === "continue")(
	"continue: reopen the same stores; the move in flight settles exactly once",
	async () => {
		const directory = DIRECTORY!;
		const stuck = JSON.parse(readFileSync(join(directory, "stuck.json"), "utf8")) as {
			epoch: number;
			ordinal: number;
			writerAuthor: string;
			original: WireRow;
		};
		const restore = await installEnvironment("node", () => undefined);
		const log: unknown[] = [];
		let ok = true;
		try {
			log.push({ label: "before-open", plan: await planImage(directory, stuck.writerAuthor) });
			let opened: Awaited<ReturnType<typeof openPair>> | undefined;
			try {
				opened = await openPair(directory, true);
				log.push({ label: "reopened", plan: await planImage(directory, stuck.writerAuthor), settlement: await opened.writer.settlementStatus?.(),
					ownMoves: await ownMoves(opened.writer) });
			} catch (cause) {
				ok = false;
				log.push({ label: "open", error: chain(cause) });
			}
			if (opened !== undefined) {
				const { creator, writer } = opened;
				const wire = successorWire(() => [creator, writer] as const);
				const rows = rowWire(creator, writer);
				const ordinal = { next: stuck.ordinal };
				let epoch = stuck.epoch;
				try {
					// The Writer's settlement lands at a close and its handed-back move is offered again after
					// it: a few closes, each followed, until the creator admits the move.
					let admitted = false;
					for (let round = 0; round < 4 && !admitted; round++) {
						epoch = await rollCreator(creator, rows.toWriter, ordinal);
						await wire.caughtUp(epoch, 60_000);
						await rows.toWriter();
						admitted = await waitFor(
							"the creator admits the move that was in flight",
							async () => {
								await rows.toCreator();
								return acceptedCounts(creator, stuck.writerAuthor, [moveId(50)]);
							},
							(counts) => counts[0]! >= 1,
							10_000
						).then(
							() => true,
							() => false
						);
						log.push({ label: `round-${round}`, epoch, admitted, settlement: await writer.settlementStatus?.(),
							status: await writer.rolloverStatus?.() });
					}
					if (!admitted) throw new Error("the creator never admitted the move that was in flight");
					await creator.inject([stuck.original]);
					await writer.issue(1, 52);
					await waitFor(
						"the creator admits the Writer's new move",
						async () => {
							await rows.toCreator();
							return acceptedCounts(creator, stuck.writerAuthor, [moveId(52)]);
						},
						(counts) => counts[0] === 1
					);
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 60_000);
					await rows.toWriter();
					const counts = await acceptedCounts(creator, stuck.writerAuthor, [moveId(50), moveId(52)]);
					const originalAccepted = (await creator.acceptance([stuck.original.digest]))[0];
					const same = (await writer.state()) === (await creator.state());
					log.push({ label: "settled", epoch, counts, originalAccepted, same, ownMoves: await ownMoves(writer), plan: await planImage(directory, stuck.writerAuthor),
						settlement: await writer.settlementStatus?.() });
					ok = counts.every((count) => count === 1) && originalAccepted === false && same;
				} catch (cause) {
					ok = false;
					log.push({ label: "continue", epoch, error: chain(cause), plan: await planImage(directory, stuck.writerAuthor),
						settlement: await writer.settlementStatus?.() });
				} finally {
					await wire.stop();
					await writer.close();
					await creator.close();
				}
			}
		} finally {
			restore();
		}
		writeFileSync(join(directory, `continue-${process.env.SW_VERSION_LABEL ?? "run"}.json`), JSON.stringify({ ok, log }));
		for (const row of log) console.info(`SW_VERSION continue ${JSON.stringify(row)}`);
		expect(ok).toBe(true);
	},
	300_000
);
