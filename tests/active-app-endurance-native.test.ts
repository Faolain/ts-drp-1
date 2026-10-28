/* eslint-disable @typescript-eslint/explicit-function-return-type -- Measurement fixture preserves native capability inference. */
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS, driveActiveAppEndurance } from "./fixtures/active-endurance/driver.js";
import { installEnvironment, nodeHostFor, sqliteFileCensus } from "./fixtures/track-m-apps/app-long-room.js";
import { genesisProfileFor } from "./fixtures/track-m-apps/genesis-profile.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import type { AppKind, RoleEndpoint } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Native SQLite, shipped compositions, signed successor material including full v2
// membership. Transport is scripted signed-byte loss/delay with explicit durable replay;
// real libp2p automatic repair is a separate gate.
const enabled = process.env.ACTIVE_ENDURANCE === "1";
const epochs = Number(process.env.ACTIVE_ENDURANCE_EPOCHS ?? 300);
const moves = Number(process.env.ACTIVE_ENDURANCE_MOVES ?? 2);
const streamLimit = Number(process.env.ACTIVE_ENDURANCE_STREAM ?? 4);
const reopenAt = Number(process.env.ACTIVE_ENDURANCE_REOPEN_AT ?? Math.min(30, Math.max(1, Math.floor(epochs / 2))));
const apps = (process.env.ACTIVE_ENDURANCE_APPS ?? "canvas,grid,chat").split(",");
for (const app of apps) if (!["canvas", "grid", "chat"].includes(app)) throw new Error(`ENDURANCE_APP:${app}`);
for (const value of [epochs, moves, streamLimit])
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("ENDURANCE_POSITIVE_INTEGER_REQUIRED");
if (!Number.isSafeInteger(reopenAt) || reopenAt < 1 || reopenAt > epochs)
	throw new Error("ENDURANCE_REOPEN_EPOCH_INVALID");
const output = process.env.ACTIVE_ENDURANCE_OUT ?? join(tmpdir(), `active-endurance-${Date.now()}`);
// Every app signs its own exported genesis profile (examples/<app>/src/profile.ts) by default.
// ACTIVE_ENDURANCE_PROFILE=trusted-v1 is the explicit opt-in override for Grid and Chat (the legacy
// trusted profile, which never prunes issued records); it is recorded in the configuration line.
// Canvas always follows its shipped profile.
const profile = process.env.ACTIVE_ENDURANCE_PROFILE;
if (profile !== undefined && profile !== "trusted-v1" && profile !== "settlement-v1")
	throw new Error(`ENDURANCE_PROFILE:${profile}`);
// ACTIVE_ENDURANCE_ROLLOVER=app: each app's own rollover policy (examples/<app>/src/rollover.ts) rolls
// the room over instead of the harness. ACTIVE_ENDURANCE_EPOCHS then counts adopted epochs (the
// creator room's authenticated epoch), not driver rounds. Successor offers travel by the pages' own
// delivery (examples/v3-room successor-delivery); the harness only carries its frames over the same
// scripted wire as signed rows, and harness offer passing is refused. Default "harness".
const rollover = process.env.ACTIVE_ENDURANCE_ROLLOVER ?? "harness";
if (rollover !== "harness" && rollover !== "app") throw new Error(`ENDURANCE_ROLLOVER:${rollover}`);
// App mode: the most a Writer's issue may take when it overlaps an automatic rollover (seal start
// to 1 s after adoption) before the run counts it starved (see APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS).
const memberRolloverIssueBoundMs = Number(
	process.env.ACTIVE_ENDURANCE_MEMBER_ROLLOVER_ISSUE_BOUND_MS ?? APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS
);
if (!(memberRolloverIssueBoundMs > 0)) throw new Error("ENDURANCE_MEMBER_ROLLOVER_ISSUE_BOUND");

it.skipIf(!enabled).each(apps)(
	"%s: active writers conserve work and native storage through endurance",
	async (name) => {
		const app = name as AppKind;
		mkdirSync(output, { recursive: true });
		const directory = mkdtempSync(join(output, `${app}-sqlite-`));
		const log = join(output, `${app}.jsonl`);
		const track = {
			rooms: new Set<{ close(): Promise<void> }>(),
			heads: new Set<{ close(): Promise<void> }>(),
			ports: new Set<SnapshotChunkProtocolPort>(),
		};
		const events: Readonly<Record<string, unknown>>[] = [];
		const restore = await installEnvironment("node", (event) => events.push(event));
		const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const sourceDiff = execFileSync("git", ["diff", "--no-ext-diff", "HEAD"], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		writeFileSync(join(output, `${app}-source.diff`), sourceDiff);
		const metadata = {
			kind: "configuration",
			app,
			sourceHead,
			dirtyTracked: sourceDiff.length !== 0,
			sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
			epochs,
			moves,
			streamLimit,
			reopenAt,
			genesisProfile: genesisProfileFor({
				app,
				...(profile === "trusted-v1" && app !== "canvas" ? { profile } : {}),
			}),
			profileOverride: profile === "trusted-v1" && app !== "canvas" ? "trusted-v1" : null,
			rollover,
			...(rollover === "app"
				? {
						epochsCount: "adopted epochs (the creator room's authenticated epoch), not driver rounds",
						successorOffers: "pages' own successor delivery over the scripted wire; harness offer passing refused",
						memberRolloverIssueBoundMs,
					}
				: {}),
			host: "SQLite",
			transport: "scripted signed-byte first-copy loss/delay and explicit durable replay",
			successorMembership: "v2 native journal point read",
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			load: loadavg(),
			directory,
		};
		appendFileSync(log, JSON.stringify(metadata) + "\n");
		try {
			const options = {
				app,
				host: "node" as const,
				recipient: "writer" as const,
				creatorLull: false,
				epochs,
				moves,
				chatFormat: "shares" as const,
				...(profile === "trusted-v1" && app !== "canvas" ? { profile: "trusted-v1" as const } : {}),
				...(rollover === "app" ? { rollover: "app" as const } : {}),
			};
			const openPeers = async (reopen: boolean): Promise<readonly [RoleEndpoint, RoleEndpoint]> => {
				const host = nodeHostFor("node", directory, reopen);
				const env = {
					host,
					unique: directory,
					track,
					events,
					openFloor: (role: string) =>
						createNodeRoomHeadAuthority({
							filename: join(directory, `${role}-external-floor.sqlite`),
							initialization: { kind: reopen ? "reopen" : "create" },
						}),
				};
				const creator = await openRole(options, 0, env);
				const recipient = await openRole(options, 1, {
					...env,
					events: undefined,
					relay: (request) => creator.dispatch(request),
				});
				return [creator, recipient];
			};
			const summary = await driveActiveAppEndurance({
				app,
				epochs,
				moves,
				streamLimit,
				peers: await openPeers(false),
				reopenAt: metadata.reopenAt,
				rollover,
				...(rollover === "app" ? { memberRolloverIssueBoundMs } : {}),
				reopen: async (peers) => {
					await Promise.all(peers.map((peer) => peer.close()));
					return openPeers(true);
				},
				write: (record) => {
					const files = readdirSync(directory)
						.map((name) => ({ name, stat: statSync(join(directory, name)) }))
						.filter(({ stat }) => stat.isFile())
						.map(({ name, stat }) => ({
							name,
							bytes: stat.size,
							kind: name.endsWith("-wal") ? "wal" : name.endsWith("-shm") ? "sharedMemory" : "primaryOrOther",
							tables: name.endsWith(".sqlite") ? sqliteFileCensus(join(directory, name)) : undefined,
						}));
					appendFileSync(
						log,
						JSON.stringify({
							...record,
							nativePhysical: {
								files: files.length,
								bytes: files.reduce((sum, file) => sum + file.bytes, 0),
								byKind: Object.fromEntries(
									["wal", "sharedMemory", "primaryOrOther"].map((kind) => [
										kind,
										files.filter((file) => file.kind === kind).reduce((sum, file) => sum + file.bytes, 0),
									])
								),
								byFile: files,
							},
							load: loadavg(),
						}) + "\n"
					);
					events.length = 0;
				},
			});
			writeFileSync(join(output, `${app}-summary.json`), JSON.stringify({ ...metadata, ...summary }, null, 2));
		} finally {
			const closed = await Promise.allSettled([...track.rooms].map((room) => room.close()));
			const heads = await Promise.allSettled([...track.heads].map((head) => head.close()));
			await Promise.all([...track.ports].map((port) => port.close()));
			restore();
			expect([...closed, ...heads].filter((result) => result.status === "rejected")).toEqual([]);
		}
	},
	Math.max(600_000, epochs * 120_000)
);
