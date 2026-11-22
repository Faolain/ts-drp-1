/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type * as FrontiersModule from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import type * as V3LiveModule from "@ts-drp/node/v3-live";
import type * as AdvanceModule from "../packages/node/src/internal/creator-transition-advance.js";
import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// SAFETY question (catch-up dumps: the member's plan marks seq 5, epoch 2, "expire" resolved by the
// frontier while the creator accepted [5, 2] live in epoch 2, before its epoch-2 seal): is a row in the
// creator's Cut ever handed back on the member? A frontier resolution writes "expire" for BOTH verdicts
// ("committed" and "never-admitted"); only a never-admitted row's move may be handed back. Pinned here:
// the creator's signed frontier tuple per closed epoch, the member's installed frontier identities, the
// member's per-row verdicts, and every hand-back record.

const observed = vi.hoisted(() => ({
	creatorFrontiers: [] as { closedEpoch: number; frontiers: readonly (readonly [string, number, number | null])[] }[],
	memberFrontiers: new Map<
		string,
		{
			author: string;
			admissionEpoch?: number;
			admittedAuthorSequence: number | null;
			closedEpoch: number;
			successorEpoch: number;
		}
	>(),
	verdicts: [] as {
		sourceSequence: number;
		sourceEpoch: number;
		frontier: string | undefined;
		resolved: boolean;
		unproven: string | undefined;
	}[],
}));
vi.mock("@ts-drp/protocol-v3/creator-author-issuance-frontiers", async (importOriginal) => {
	const real = await importOriginal<typeof FrontiersModule>();
	return {
		...real,
		prepareCreatorAuthorSettlement: (input: unknown) => {
			const value = input as {
				currentTrust?: { currentEpoch?: number };
				frontiers?: readonly (readonly [string, number, number | null])[];
			};
			if (typeof value?.currentTrust?.currentEpoch === "number" && Array.isArray(value.frontiers))
				observed.creatorFrontiers.push({
					closedEpoch: value.currentTrust.currentEpoch,
					frontiers: value.frontiers.map((tuple) => [...tuple] as const),
				});
			return real.prepareCreatorAuthorSettlement(input);
		},
	};
});
vi.mock("../packages/node/src/internal/creator-transition-advance.js", async (importOriginal) => {
	const real = await importOriginal<typeof AdvanceModule>();
	return {
		...real,
		resolveVerifiedCreatorHistoricalIssuance: (
			...args: Parameters<typeof real.resolveVerifiedCreatorHistoricalIssuance>
		) => {
			const identity = real.resolveVerifiedCreatorHistoricalIssuance(...args);
			if (identity !== undefined) {
				const row = {
					author: identity.author,
					admissionEpoch: identity.admissionEpoch,
					admittedAuthorSequence: identity.admittedAuthorSequence,
					closedEpoch: identity.closedEpoch,
					successorEpoch: identity.successorEpoch,
				};
				observed.memberFrontiers.set(JSON.stringify(row), row);
			}
			return identity;
		},
	};
});
vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const real = await importOriginal<typeof V3LiveModule>();
	return {
		...real,
		inspectV3RetainedWorkFrontier: async (...args: Parameters<typeof real.inspectV3RetainedWorkFrontier>) => {
			const work = await real.inspectV3RetainedWorkFrontier(...args);
			for (const item of work)
				observed.verdicts.push({
					sourceSequence: item.sourceSequence,
					sourceEpoch: item.sourceEpoch,
					frontier: item.frontier,
					resolved: item.resolved,
					unproven: item.unproven,
				});
			return work;
		},
	};
});

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
type PlanDump = {
	revision?: number;
	handBackRecords: readonly (readonly [number, number, number | null])[];
	entries: readonly { s: number; e?: number | null; d: string; r: number | null; res?: string }[];
};

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

/** The scripted row wire of the catch-up test: rows reach the other side only in its current epoch. */
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

// The catch-up test's own schedule up to reconnection: two connected epochs (block-1-0 in epoch 1,
// block-1-1 in epoch 2, both carried to the creator), then `moves` moves made while the member's rows
// never reach the creator, the member skip-installing every two creator epochs for `epochs` epochs.
async function committedRowsAreNeverHandedBack(moves: number, epochs: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-frontier-committed-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let n = 0;
		const refused: string[] = [];
		const issue = async () => {
			try {
				await writer.issue((await writer.authorityEpoch()) ?? 0, n++);
			} catch (error) {
				refused.push(String(error).slice(0, 120));
			}
		};
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await issue();
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			const steps = Math.max(1, Math.floor(epochs / 2));
			const records = new Map<string, readonly [number, number, number | null]>();
			const plans: PlanDump[] = [];
			const snapshot = async () => {
				const plan = (await writer.settlementPlanDump?.()) as PlanDump;
				plans.push(plan);
				for (const record of plan.handBackRecords) records.set(`${record[0]}:${record[1]}`, record);
			};
			for (let step = 0; step < steps; step++) {
				const quota = Math.round(((step + 1) * moves) / steps) - Math.round((step * moves) / steps);
				for (let k = 0; k < quota; k++) await issue();
				await wire.pause();
				for (let roll = 0; roll < 2; roll++) epoch = await rollCreator(creator, rows.toWriter, ordinal);
				wire.resume();
				await wire.caughtUp(epoch, 600_000);
				await snapshot();
			}
			// Admitted rows of the member: the creator accepted them live in their own epoch, before it sealed
			// that epoch (the row wire injects only into the creator's current epoch), so each is in that Cut.
			const accepted = ((await creator.acceptedVertices?.()) ?? [])
				.filter((vertex) => vertex.author === writerAuthor)
				.map((vertex) => [vertex.authorSequence, vertex.epoch] as const);
			const signed = observed.creatorFrontiers
				.map(
					({ closedEpoch, frontiers }) => [closedEpoch, frontiers.find((tuple) => tuple[0] === writerAuthor)] as const
				)
				.filter(([, tuple]) => tuple !== undefined);
			const memberFrontiers = [...observed.memberFrontiers.values()].filter((row) => row.author === writerAuthor);
			const final = plans.at(-1)!;
			const handedBack = [...records.values()];
			const verdictOf = (sequence: number) => [
				...new Set(
					observed.verdicts
						.filter((item) => item.sourceSequence === sequence)
						.map((item) => `${item.frontier ?? `unproven:${item.unproven}`}${item.resolved ? "(resolved)" : ""}`)
				),
			];
			const neverAdmitted = new Set(
				observed.verdicts.filter((item) => item.frontier === "never-admitted").map((item) => item.sourceSequence)
			);
			const status = (await writer.settlementStatus?.()) as { deferred?: number; undelivered?: unknown[] } | null;
			process.stdout.write(
				`FRONTIER_SAFETY ${JSON.stringify({
					epoch,
					accepted,
					refused: refused.length,
					signedFrontierByClosedEpoch: [...new Map(signed.map(([closed, tuple]) => [closed, tuple])).entries()].slice(
						0,
						8
					),
					memberFrontiers: memberFrontiers.slice(0, 12),
					seq5: {
						entry:
							final.entries.find((entry) => entry.s === 5) ??
							plans.map((plan) => plan.entries.find((entry) => entry.s === 5)).find(Boolean),
						verdicts: verdictOf(5),
						records: handedBack.filter((record) => record[0] === 5),
					},
					expiredByFrontier: plans
						.flatMap((plan) => plan.entries)
						.filter((entry) => entry.d === "expire" && entry.res === "frontier").length,
					neverAdmitted: neverAdmitted.size,
					handBackRecords: handedBack.length,
					deferred: status?.deferred,
					undelivered: status?.undelivered?.length,
				})}\n`
			);
			// 1. No row the creator admitted is ever handed back, and the frontier never calls one never-admitted.
			for (const [sequence] of accepted) {
				expect(
					handedBack.filter((record) => record[0] === sequence),
					`hand-back records of admitted row ${sequence}`
				).toEqual([]);
				expect(
					verdictOf(sequence).filter((verdict) => verdict.startsWith("never-admitted")),
					`verdict of admitted row ${sequence}`
				).toEqual([]);
			}
			// 2. Every row the frontier proved never admitted, once its expiry is written, has a hand-back
			//    record for its move: an expiry without a record would drop the move silently.
			const expiredSequences = new Set(
				final.entries.filter((entry) => entry.d === "expire" && entry.res === "frontier").map((entry) => entry.s)
			);
			const recorded = new Set(handedBack.map((record) => record[0]));
			const silentlyDropped = [...neverAdmitted].filter(
				(sequence) => expiredSequences.has(sequence) && !recorded.has(sequence)
			);
			expect(silentlyDropped, "never-admitted rows expired without a hand-back record").toEqual([]);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it(
	"a row in the creator's epoch-2 Cut is never handed back by a far-behind member (4 epochs, 25 moves)",
	() => committedRowsAreNeverHandedBack(25, 4),
	900_000
);
it(
	"a row in the creator's Cut is never handed back, and no never-admitted move expires without a record (16 epochs, 100 moves)",
	() => committedRowsAreNeverHandedBack(100, 16),
	1_800_000
);
