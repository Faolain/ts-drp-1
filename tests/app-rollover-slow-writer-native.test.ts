/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// A slow (not silent) Writer, as the browser FPS gate's Grid member: it lags the creator and follows by
// installing a successor two epochs ahead (a reattachment checkpoint), making a move in each epoch it is
// at. Its rows reach the creator only while both are in the same epoch, so each lagging move is in an
// epoch the creator closed without it: retained work at the skip install, resolved from the creator's
// signed frontier and handed back. It must keep following, never refuse a plan write ("settlement plan
// references retired or absent issued work" ended a 100-epoch browser run), and every move must be
// admitted exactly once.
//
// Three skips: each skip install leaves the epoch the Writer departed from with no closed-membership
// carrier (the reattachment checkpoint holds only the Cut before its target), so that journal scope is
// never collectible, and the retirement's protected-scope bound (AHE maxObjectGenerations = 7) is
// reached after a few more. The second test pins that defect.
const SLOW_ROUNDS = Number(process.env.SLOW_WRITER_ROUNDS ?? 3);

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
const chain = (cause: unknown) => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 10; value = value.cause)
		parts.push(`${value.name}: ${value.message}`);
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
		throw new Error(`${stage}: ${chain(cause).join(" <- ")}`, { cause });
	}
}

/**
 * The scripted row wire: each side's rows reach the other only in the receiver's current epoch.
 * @param creator
 * @param writer
 */
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
		await wire.caughtUp(epoch, 60_000);
	} catch (error) {
		const member = await writer.successorDelivery?.();
		throw new Error(
			`the Writer stopped following at epoch ${member?.epoch} (creator ${epoch}): ${JSON.stringify(member?.lastError ?? null)}`,
			{ cause: error }
		);
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

type Status = Readonly<{ state: string; kept: readonly Record<string, unknown>[] }>;

/**
 * The Writer's settlement plan as stored (a separate read handle): entries and hand-back records.
 * @param directory
 * @param author
 */
async function planImage(directory: string, author: string) {
	const objectId = `creator:${Buffer.from(hashDomain("track-m-apps-object/v1", new TextEncoder().encode(directory)))
		.toString("hex")
		.slice(0, 32)}`;
	try {
		const store = await nodeHostFor("node", directory, true).observe.openIssuance("recipient");
		try {
			const plan = await store.readSettlementPlan({ objectId, author });
			if (plan === null) return null;
			const handBacks = (
				plan as { handBacks?: readonly { sourceSequence: number; intent: number; reissueSequence: number | null }[] }
			).handBacks;
			return {
				fence: plan.fenceSequence,
				entries: plan.entries.map((entry) => [
					entry.sourceSequence,
					entry.disposition,
					entry.replacementSequence,
					(entry as { sourceResolutionKind?: string }).sourceResolutionKind ??
						(entry.sourceContextDigest === undefined ? "-" : "ctx"),
				]),
				handBacks: handBacks?.map((record) => [record.sourceSequence, record.intent, record.reissueSequence]) ?? [],
			};
		} finally {
			await (store as unknown as { close?(): Promise<void> }).close?.();
		}
	} catch (cause) {
		return { readError: chain(cause) };
	}
}
const ownRows = async (writer: RoleEndpoint) =>
	(await writer.published(null)).map((row) => {
		const value = rowValue(row);
		return [
			row.authorSequence,
			value.epoch,
			(value.operation.id as string | undefined) ?? String(value.operation.action),
		];
	});

it("a slow Writer that follows by skip installs keeps following and every move is admitted exactly once", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-slow-writer-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory, false);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		const ids: string[] = [];
		let epoch = 0;
		let writerAuthor = "";
		try {
			let next = 100;
			for (let round = 0; round < SLOW_ROUNDS; round++) {
				// In step: a move the creator receives in the same epoch.
				await writer.issue(1, next);
				ids.push(moveId(next++));
				if (writerAuthor === "") writerAuthor = rowValue((await writer.published(null))[0]!).author;
				await rows.toCreator();
				// Lagging: the creator rolls while the Writer does not follow; its next move is made in the
				// epoch it is still at, which the creator has closed without it.
				await wire.pause();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await writer.issue(1, next);
				ids.push(moveId(next++));
				await rows.toCreator();
				// The creator rolls once more; the Writer follows by installing two epochs ahead.
				epoch = await rollCreator(creator, async () => undefined, ordinal);
				wire.resume();
				await follow(wire, writer, epoch);
				await rows.toWriter();
				// The skip install retained this epoch's rows as unknown work; the creator's frontier
				// proves each committed (the move made in step, before or after its epoch's fence) or
				// never admitted (the lagging move, given back), so none stays manual-review and the
				// author fence is not withheld.
				await waitFor(
					`round ${round}: the Writer resolves the work its skip install retained`,
					() => planImage(directory, writerAuthor),
					(plan) =>
						plan !== null && !("readError" in plan) && plan.entries.every((entry) => entry[1] !== "manual-review")
				);
				const status = (await writer.rolloverStatus?.()) as Status;
				const settlement = (await writer.settlementStatus?.()) as { unsettledEpochs: number; undelivered: unknown[] };
				process.stdout.write(
					`SLOW_WRITER_ROUND ${JSON.stringify({ round, epoch, writer: await writer.authorityEpoch(), state: status.state, kept: status.kept.length, unsettled: settlement.unsettledEpochs, undelivered: settlement.undelivered.length, counts: await acceptedCounts(creator, writerAuthor, ids), plan: await planImage(directory, writerAuthor), rows: (await ownRows(writer)).slice(-8) })}\n`
				);
			}
			// Caught up: both directions every epoch.
			let counts: number[] = [];
			for (let round = 0; round < 6; round++) {
				await rows.toCreator();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				await rows.toCreator();
				counts = await acceptedCounts(creator, writerAuthor, ids);
				const status = (await writer.rolloverStatus?.()) as Status;
				process.stdout.write(
					`SLOW_WRITER_CATCHUP ${JSON.stringify({ epoch, state: status.state, kept: status.kept.length, counts })}\n`
				);
				if (round >= 1 && status.kept.length === 0 && counts.every((count) => count >= 1)) break;
			}
			await waitFor(
				"the creator admits every move of the slow Writer",
				async () => {
					await rows.toCreator();
					return acceptedCounts(creator, writerAuthor, ids);
				},
				(value) => value.every((count) => count >= 1)
			);
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await follow(wire, writer, epoch);
			await rows.toWriter();
			await rows.toCreator();
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await follow(wire, writer, epoch);
			await rows.toWriter();
			expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
			expect(await writer.state()).toBe(await creator.state());
		} finally {
			process.stdout.write(`SLOW_WRITER_SUMMARY ${JSON.stringify({ member: await writer.successorDelivery?.() })}\n`);
			await wire.stop();
		}
	} finally {
		restore();
	}
}, 1_200_000);

// PINNED DEFECT (not fixed here; it needs a protocol decision). A skip install authenticates the target
// head from a reattachment checkpoint, whose material carries the Cut before the target only; the
// closed-membership carrier of the epoch the Writer departed from is recorded only on an adjacent
// install (creator-adoption's recordReceivedClosedMembership). That journal scope holds the creator's
// received rows, so it is never a collectible prefix ("unclassified-prefix" or
// "source-coverage-incomplete") and stays protected forever. With no lagging move at all (no retained
// work, no hand-back), six skips and a few adjacent epochs reach the protected-scope bound
// (LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes = AHE maxObjectGenerations = 7): the next install's journal
// retirement refuses "malformed-input" and the Writer's session closes. When this is fixed the test
// fails; replace it with one that asserts the Writer keeps following.
it("pinned defect: each skip install leaves its departed journal scope uncollectible, and past the 7-scope bound the Writer's journal retirement refuses", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-skip-scopes-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory, false);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let stopped: unknown;
		try {
			let next = 100;
			for (let round = 0; round < 6; round++) {
				await writer.issue(1, next++);
				await rows.toCreator();
				await wire.pause();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				epoch = await rollCreator(creator, async () => undefined, ordinal);
				wire.resume();
				await follow(wire, writer, epoch);
				await rows.toWriter();
			}
			for (let round = 0; round < 8 && stopped === undefined; round++) {
				await rows.toCreator();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				try {
					await follow(wire, writer, epoch);
					await rows.toWriter();
				} catch (error) {
					stopped = error;
				}
			}
			const member = (await writer.successorDelivery?.()) as { refusals?: readonly string[] } | undefined;
			process.stdout.write(`SKIP_SCOPES_SUMMARY ${JSON.stringify({ epoch, member })}\n`);
			expect(stopped).toBeDefined();
			expect(member?.refusals?.some((refusal) => refusal.includes("journal retirement refused: malformed-input"))).toBe(
				true
			);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}, 1_200_000);
