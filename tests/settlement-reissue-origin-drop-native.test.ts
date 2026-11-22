/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

// A reissued given-back move's reissueOrigins entry is dropped once the creator's signed frontier in
// the installed settlement capability admits its chain's last carrier (track 46,
// settlementReissueOriginsUnsettled). Until then the entry is a pending move of the Writer's local
// backlog (settlementBacklogMoves), counted on a row that no creator row of a later epoch reaches, so
// an entry that is never dropped holds one backlog slot for good. Measured (slow member,
// .logs/realtime-resume-2026-11-10/verify-slowab28b): 64 such entries filled V3_ROOM_LOCAL_BACKLOG_LIMIT
// and every later move of the member was refused at the bound, kept and never sent, while the creator
// played on until its Grid state passed the 32 KiB bound.
//
// Here the plan holds one entry: a silent Writer's move is given back (the window) and offered again
// (the entry), the Writer reconnects, the creator admits the move's newest row, and later installs
// carry a frontier past it. The entry must be gone. Every drop that empties the entries must be written, not only a drop that leaves
// another entry behind.

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
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TARGET = "block-1-1";

type ReissueOrigin = { reissueSequence: number; originSequence: number };
type HandBack = { sourceSequence: number; intent: number; originSequence?: number; reissueSequence: number | null };
/**
 * The Writer's durable plan fields this test reads, straight from its SQLite issuance file.
 * @param directory - The test's storage directory.
 * @param author - The Writer's author.
 * @returns The plan's revision, entries, hand-back records and reissue origins.
 */
function writerPlan(directory: string, author: string) {
	const file = join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["issuance", "recipient"]))
			.digest("hex")}.sqlite.drp-issuance-v1.sqlite`
	);
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const row = db.prepare("SELECT entries_json FROM settlement_plans WHERE author=?").get(author) as
			| { entries_json: string }
			| undefined;
		if (row === undefined)
			return { revision: null, entries: [], handBacks: [] as HandBack[], reissueOrigins: [] as ReissueOrigin[] };
		const decoded = JSON.parse(row.entries_json) as unknown;
		if (Array.isArray(decoded)) return { revision: null, entries: decoded, handBacks: [], reissueOrigins: [] };
		const plan = decodeCanonical(new Uint8Array(Buffer.from((decoded as { bytes: string }).bytes, "base64"))) as {
			revision: number;
			entries: { sourceSequence: number; disposition: string; replacementSequence: number | null }[];
			handBacks?: HandBack[];
			reissueOrigins?: ReissueOrigin[];
		};
		return {
			revision: plan.revision,
			entries: plan.entries.map(
				(entry) => [entry.sourceSequence, entry.disposition, entry.replacementSequence] as const
			),
			handBacks: (plan.handBacks ?? []).map(({ sourceSequence, intent, originSequence, reissueSequence }) => ({
				sourceSequence,
				intent,
				originSequence,
				reissueSequence,
			})),
			reissueOrigins: (plan.reissueOrigins ?? []).map(({ reissueSequence, originSequence }) => ({
				reissueSequence,
				originSequence,
			})),
		};
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

/**
 * The scripted row wire: each side's rows reach the other only in the receiver's current epoch.
 * @param creator - The creator.
 * @param writer - The Writer.
 * @param silent - Whether the Writer's rows are lost now.
 * @returns The two carries.
 */
function rowWire(creator: RoleEndpoint, writer: RoleEndpoint, silent: () => boolean) {
	const cursor = { creator: null as number | null, writer: null as number | null };
	const carry = async (from: RoleEndpoint, to: RoleEndpoint, key: "creator" | "writer") => {
		const published = await from.published(cursor[key]);
		if (published.length === 0) return;
		const current = (await to.authorityEpoch()) ?? 0;
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		if (rows.length === 0) return;
		// Silent: the Writer's rows of this stretch are lost (never delivered later).
		await to.inject(rows.filter((row) => rowValue(row).epoch === current && !(key === "writer" && silent())));
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

async function acceptedCount(role: RoleEndpoint, author: string, id: string) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length;
}

type Status = Readonly<{ state: string; kept: readonly Record<string, unknown>[] }>;

it("a reissued move's origin entry is dropped once the signed frontier admits it, also when it is the plan's only entry", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "settlement-reissue-origin-drop-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		let silent = true;
		const rows = rowWire(creator, writer, () => silent);
		const ordinal = { next: 0 };
		let epoch = 0;
		try {
			// Silent: the creator's rows and successors reach the Writer; the Writer's rows reach no one.
			// One move, in epoch 1; the window (4) gives it back a few epochs later and the application offers
			// it again at once (a given-back move is offered whatever the member's lag): the reissue's own
			// issuance consumes the record and adds the plan's only reissueOrigins entry. Its row is lost too.
			let author = "";
			let entry: ReissueOrigin | undefined;
			for (let roll = 0; roll < 12 && entry === undefined; roll++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 60_000);
				await rows.toWriter();
				if (epoch === 1) {
					await writer.issue(1, 1);
					const [first] = await writer.published(null);
					if (first === undefined) throw new Error("the Writer published no row");
					author = rowValue(first).author;
				}
				await sleep(500);
				entry = writerPlan(directory, author).reissueOrigins[0];
			}
			const reissued = writerPlan(directory, author);
			const status = (await writer.rolloverStatus?.()) as Status;
			process.stdout.write(
				`REISSUE_ORIGIN_DROP_REISSUED ${JSON.stringify({ epoch, kept: status.kept.map((operation) => operation.id), plan: reissued })}\n`
			);
			expect(reissued.reissueOrigins, "the given-back move was offered again: one origin entry").toHaveLength(1);

			// Reconnected: the Writer's rows reach the creator; the move's newest row (the reissue, or a
			// replacement of it) is admitted.
			silent = false;
			await rows.toCreator();
			let admittedAt: number | undefined;
			const trail: unknown[] = [];
			for (let round = 0; round < 10; round++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 60_000);
				await rows.toWriter();
				await rows.toCreator();
				await sleep(1_000);
				await rows.toCreator();
				const plan = writerPlan(directory, author);
				const count = await acceptedCount(creator, author, TARGET);
				if (count > 0) admittedAt ??= epoch;
				trail.push({ epoch, count, reissueOrigins: plan.reissueOrigins, handBacks: plan.handBacks });
				// Three installs past the admission: each carries a signed frontier past the reissued row.
				if (admittedAt !== undefined && epoch >= admittedAt + 3) break;
			}
			const plan = writerPlan(directory, author);
			process.stdout.write(`REISSUE_ORIGIN_DROP ${JSON.stringify({ epoch, entry, admittedAt, trail, plan })}\n`);
			expect(admittedAt, "the creator admitted the reissued move").toBeDefined();
			expect(await acceptedCount(creator, author, TARGET), "the move lands exactly once").toBe(1);
			expect(plan.handBacks, "no hand-back record left").toEqual([]);
			// The entry's job ended with the admission: the plan write that saw it admitted drops it, even
			// though it was the only entry (nothing else keeps a backlog slot for this move).
			expect(plan.reissueOrigins, "the admitted reissue's origin entry").toEqual([]);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}, 600_000);
