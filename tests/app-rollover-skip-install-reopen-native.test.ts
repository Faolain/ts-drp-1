/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import { fromBase64, type RoleEndpoint, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// A Writer reopened right after installing a successor more than one epoch ahead (a user who
// reconnects after a gap and refreshes the page).
//
// Before the fix (c08d8680, and through dff7d4ed): the reopen refused to open with
// "creator successor native predecessor is unavailable" (creator-adoption
// readCreatorSuccessorExportMaterial <- readCreatorSuccessorExport <- v3-room serveSuccessor <-
// serveAvailableSuccessor at startup). A skip install is a reattachment checkpoint: its native
// closure keeps the compact point proof only, never a predecessor generation, so the export could
// not re-verify the transition it would serve, and startup serving threw a plain TypeError.
//
// The fix: a checkpoint head is not a successor-material source (CreatorSuccessorExportUnavailable,
// which startup serving already treats as "nothing to serve"); the creator, and any Writer that
// installed adjacently, still serve. After the Writer's next adjacent install its head has the
// checkpoint generation as predecessor and is an export source again.
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

/** Connected epochs, then `gap` creator epochs the Writer does not follow, then it follows; reopen. */
async function reopenAfterGap(gap: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-skip-install-reopen-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory, false);
		let wire = successorWire(() => [creator, writer] as const);
		let rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let writerAuthor = "";
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 60_000);
				await rows.toWriter();
				await writer.issue(1, epoch);
				await rows.toCreator();
			}
			writerAuthor = rowValue((await writer.published(null))[0]!).author;
			await wire.pause();
			const before = epoch;
			while (epoch < before + gap) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch, 60_000);
			await rows.toWriter();
			await rows.toCreator();
			expect(await writer.authorityEpoch()).toBe(epoch);
		} finally {
			await wire.stop();
			await writer.close();
			await creator.close();
		}
		// The page is refreshed: both reopen the same directory.
		const reopened = await openPair(directory, true);
		wire = successorWire(() => [reopened.creator, reopened.writer] as const);
		rows = rowWire(reopened.creator, reopened.writer);
		try {
			expect(await reopened.writer.authorityEpoch()).toBe(epoch);
			// It follows the next epoch and writes again.
			epoch = await rollCreator(reopened.creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 60_000);
			await rows.toWriter();
			await reopened.writer.issue(1, 90);
			await waitFor(
				"the creator admits the reopened Writer's move",
				async () => {
					await rows.toCreator();
					return acceptedCounts(reopened.creator, writerAuthor, [moveId(90)]);
				},
				(counts) => counts[0] === 1
			);
			epoch = await rollCreator(reopened.creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 60_000);
			await rows.toWriter();
			expect(await reopened.writer.state()).toBe(await reopened.creator.state());
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("a Writer reopened right after installing a successor three epochs ahead opens and writes again", () =>
	reopenAfterGap(3), 300_000);

it("a Writer reopened after an adjacent install opens and writes again (control)", () => reopenAfterGap(1), 300_000);
