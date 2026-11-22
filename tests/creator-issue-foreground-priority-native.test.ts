import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { driveActiveAppEndurance } from "./fixtures/active-endurance/driver.js";
import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import type { RoleEndpoint } from "./fixtures/track-m-apps/long-room-driver.js";
import * as creatorAdoption from "../packages/node/src/creator-adoption.js";
import * as cooperativeWork from "../packages/node/src/internal/cooperative-work.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

type Attempt = { role: number; startedAt: number; completedAt: number; phase: string; outcome: string };
type EpochRecord = {
	epoch: number;
	lulls: readonly { kind: string }[];
	activity: { attempts: readonly Attempt[] };
};

// Both Chat peers share one Node event loop, as several rooms do on one host.
// In each maintenance-overlap phase the Writer runs its recovery-pool lull while
// the creator issues. Every host turn the creator's issue yields lets whatever
// else is runnable take one span; the pool maintenance of the co-located room is
// background work and must wait for the foreground issue instead of taking one
// span per creator yield. Counted in host turns, not wall time.
it("co-located recovery-pool maintenance defers its host turns behind an in-flight creator issue", async () => {
	const directory = mkdtempSync(join(tmpdir(), "foreground-priority-"));
	const track = {
		rooms: new Set<{ close(): Promise<void> }>(),
		heads: new Set<{ close(): Promise<void> }>(),
		ports: new Set<SnapshotChunkProtocolPort>(),
	};
	// Recipient pool maintenance host turns, by resume time. Test-only async context
	// marks every checkpoint created inside the recipient pool maintenance call.
	const resumes: number[] = [];
	const walk = new AsyncLocalStorage<true>();
	const maintain = creatorAdoption.maintainCreatorRecipientRecoveryPool;
	vi.spyOn(creatorAdoption, "maintainCreatorRecipientRecoveryPool").mockImplementation((input) =>
		walk.run(true, () => maintain(input))
	);
	const createCheckpoint = cooperativeWork.createWorkCheckpoint;
	vi.spyOn(cooperativeWork, "createWorkCheckpoint").mockImplementation(() => {
		const background = walk.getStore() === true;
		const checkpoint = createCheckpoint();
		return (): Promise<void> | undefined => {
			const turn = checkpoint();
			if (!background || turn === undefined) return turn;
			return turn.then(() => {
				resumes.push(performance.timeOrigin + performance.now());
			});
		};
	});
	const records: EpochRecord[] = [];
	const restore = await installEnvironment("node", () => undefined);
	try {
		const options = {
			app: "chat" as const,
			host: "node" as const,
			recipient: "writer" as const,
			creatorLull: false,
			epochs: 5,
			moves: 2,
			chatFormat: "shares" as const,
		};
		const host = nodeHostFor("node", directory, false);
		const env = {
			host,
			unique: directory,
			track,
			events: undefined,
			openFloor: (role: string): ReturnType<typeof createNodeRoomHeadAuthority> =>
				createNodeRoomHeadAuthority({
					filename: join(directory, `${role}-external-floor.sqlite`),
					initialization: { kind: "create" },
				}),
		};
		const creator = await openRole(options, 0, env);
		const recipient = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
		const peers: readonly [RoleEndpoint, RoleEndpoint] = [creator, recipient];
		await driveActiveAppEndurance({
			app: "chat",
			epochs: options.epochs,
			moves: options.moves,
			streamLimit: 4,
			peers,
			write: (record): void => {
				records.push(record as unknown as EpochRecord);
			},
		});
	} finally {
		vi.restoreAllMocks();
		const closed = await Promise.allSettled([...track.rooms].map((room) => room.close()));
		const heads = await Promise.allSettled([...track.heads].map((head) => head.close()));
		await Promise.all([...track.ports].map((port) => port.close()));
		restore();
		rmSync(directory, { recursive: true, force: true });
		expect([...closed, ...heads].filter((result) => result.status === "rejected")).toEqual([]);
	}
	const measured = records.flatMap((record) => {
		if (record.lulls[1]?.kind !== "maintained") return [];
		return record.activity.attempts
			.filter(
				(attempt) =>
					attempt.role === 0 && attempt.outcome === "accepted" && attempt.phase.endsWith("maintenance-overlap")
			)
			.map((attempt) => ({
				epoch: record.epoch,
				issueMs: Math.round(attempt.completedAt - attempt.startedAt),
				backgroundTurns: resumes.filter((at) => at > attempt.startedAt && at < attempt.completedAt).length,
			}));
	});
	console.log("FOREGROUND_PRIORITY", JSON.stringify({ measured, recipientMaintenanceTurns: resumes.length }));
	// The scenario is real: the Writer's pool maintenance ran and took host turns,
	// and overlapped creator issues in at least two epochs.
	expect(resumes.length).toBeGreaterThan(20);
	expect(measured.length).toBeGreaterThanOrEqual(2);
	// One background span may already be runnable when the issue registers, and an
	// idle window or the hard bound may release one more; never one per creator yield.
	for (const issue of measured) expect(issue.backgroundTurns, `epoch ${issue.epoch}`).toBeLessThanOrEqual(2);
}, 600_000);
