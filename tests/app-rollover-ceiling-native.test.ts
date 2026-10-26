/* eslint-disable @typescript-eslint/explicit-function-return-type -- Measurement fixture preserves native capability inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import type { AppKind, RecipientMode, RoleEndpoint, WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

const rowValue = (row: WireRow) =>
	decodeCanonical(Buffer.from(row.preimage, "base64")) as { epoch: number; operation: { action: string } };
const rowEpoch = (row: WireRow): number => rowValue(row).epoch;
const rowAction = (row: WireRow): string => rowValue(row).operation.action;

// Measurement (app rollover policy, step 1): the real per-epoch admission ceiling of each
// shipped app on its shipped profile with its long-room move shape, on native SQLite. One
// epoch is filled until the first refusal; nothing seals inside the measured epoch. With
// APP_ROLLOVER_CEILING_PRIOR=<n>, n ordinary rolled epochs come first, so
// a later epoch's ceiling can be compared with epoch 0's; APP_ROLLOVER_CEILING_PRIOR_MOVES sets
// how many moves per role those epochs hold (for example a policy's budget).
//
// Creator moves and Writer moves alternate; every published row is delivered to the other
// role and its acceptance polled (a capacity refusal of a remote copy is silent, so a
// bounded poll stands in for the long-room driver's joined receive). The first refusal of
// an own issue, or a remote copy not accepted within the poll window, ends the fill.
const enabled = process.env.APP_ROLLOVER_CEILING === "1";
const apps = (process.env.APP_ROLLOVER_CEILING_APPS ?? "canvas,chat,grid").split(",") as AppKind[];
const recipients = (process.env.APP_ROLLOVER_CEILING_RECIPIENTS ?? "receive-only,writer").split(",") as RecipientMode[];
const limit = Number(process.env.APP_ROLLOVER_CEILING_LIMIT ?? 600);
const prior = Number(process.env.APP_ROLLOVER_CEILING_PRIOR ?? 0);
const priorMoves = Number(process.env.APP_ROLLOVER_CEILING_PRIOR_MOVES ?? 2);
const pollMs = Number(process.env.APP_ROLLOVER_CEILING_POLL_MS ?? 10_000);
const output = process.env.APP_ROLLOVER_CEILING_OUT ?? join(tmpdir(), `app-rollover-ceiling-${Date.now()}`);
for (const app of apps) if (!["canvas", "chat", "grid"].includes(app)) throw new Error(`CEILING_APP:${app}`);
for (const mode of recipients)
	if (mode !== "receive-only" && mode !== "writer") throw new Error(`CEILING_RECIPIENT:${mode}`);

const cases = apps.flatMap((app) => recipients.map((recipient) => [app, recipient] as const));

it.skipIf(!enabled).each(cases)(
	"%s with a %s recipient: one epoch's admission ceiling",
	async (app, recipient) => {
		mkdirSync(output, { recursive: true });
		const directory = mkdtempSync(join(tmpdir(), `app-ceiling-${app}-`));
		const track = {
			rooms: new Set<{ close(): Promise<void> }>(),
			heads: new Set<{ close(): Promise<void> }>(),
			ports: new Set<SnapshotChunkProtocolPort>(),
		};
		const events: Readonly<Record<string, unknown>>[] = [];
		const restore = await installEnvironment("node", (event) => events.push(event));
		const writer = recipient === "writer";
		const log = (record: Readonly<Record<string, unknown>>) =>
			appendFileSync(
				join(output, `ceiling.jsonl`),
				`${JSON.stringify({ app, recipient, prior, priorMoves, ...record })}\n`
			);
		try {
			const options = {
				app,
				host: "node" as const,
				recipient,
				creatorLull: false,
				epochs: 1,
				moves: 1,
				chatFormat: "shares" as const,
			};
			const host = nodeHostFor("node", directory);
			const env = {
				host,
				unique: directory,
				track,
				events,
				openFloor: (role: string) =>
					createNodeRoomHeadAuthority({
						filename: join(directory, `${role}-external-floor.sqlite`),
						initialization: { kind: "create" as const },
					}),
			};
			const creator = await openRole(options, 0, env);
			const other = await openRole(options, 1, {
				...env,
				events: undefined,
				relay: (request) => creator.dispatch(request),
			});
			const peers = [creator, other] as const satisfies readonly [RoleEndpoint, RoleEndpoint];
			const delivered: (number | null)[] = [null, null];
			// Delivers every new published row of `from` in the receiver's current epoch (control rows
			// included); true when the last delivered one is accepted.
			const deliver = async (from: 0 | 1): Promise<boolean> => {
				const rows: WireRow[] = await peers[from].published(delivered[from]);
				const last = rows.at(-1);
				if (last === undefined) return true;
				const receiver = peers[from === 0 ? 1 : 0];
				const current = (await receiver.authorityEpoch()) ?? 0;
				const live = rows.filter((row) => rowEpoch(row) === current);
				delivered[from] = last.authorSequence;
				if (live.length === 0) return true;
				await receiver.inject(live);
				// Control rows ($drp.*) are not application acceptance; join the last ordinary move.
				const final = live.findLast((row) => !rowAction(row).startsWith("$drp."));
				if (final === undefined) return true;
				const deadline = performance.now() + pollMs;
				for (;;) {
					const [accepted] = await receiver.acceptance([final.digest]);
					if (accepted === true) return true;
					if (performance.now() > deadline) return false;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			};
			for (let epoch = 0; epoch < prior; epoch++) {
				for (let ordinal = 0; ordinal < priorMoves; ordinal++) {
					await creator.issue(epoch, ordinal);
					expect(await deliver(0)).toBe(true);
					if (!writer) continue;
					await other.issue(epoch, ordinal);
					expect(await deliver(1)).toBe(true);
				}
				await creator.seal(epoch);
				await creator.adopt();
				const exported = await creator.exportOffer();
				await other.install(exported.offer);
				for (const peer of peers) await peer.lull();
				// The successor's own rows (and any row the install left) go out in the new epoch.
				expect(await deliver(0)).toBe(true);
				expect(await deliver(1)).toBe(true);
			}
			const epoch = prior;
			const accepted = { creator: 0, writer: 0 };
			const issueMs: number[] = [];
			// Each role fills until its own first refusal; a remote copy the other role does not
			// accept within the poll window ends the whole fill.
			const refusals: { role: string; stage: string; ordinal: number; reason: string }[] = [];
			const refused = new Set<string>();
			let stalled = false;
			const started = performance.now();
			const roles = writer ? ([0, 1] as const) : ([0] as const);
			for (let ordinal = 0; ordinal < limit && !stalled && refused.size < roles.length; ordinal++) {
				for (const role of roles) {
					const name = role === 0 ? "creator" : "writer";
					if (refused.has(name)) continue;
					try {
						issueMs.push(await peers[role].issue(epoch, ordinal));
					} catch (error) {
						refusals.push({ role: name, stage: "issue", ordinal, reason: String(error) });
						refused.add(name);
						continue;
					}
					accepted[name]++;
					if (!(await deliver(role))) {
						refusals.push({
							role: role === 0 ? "writer" : "creator",
							stage: "remote",
							ordinal,
							reason: "not-accepted",
						});
						stalled = true;
						break;
					}
				}
				if ((ordinal + 1) % 25 === 0)
					process.stdout.write(
						`CEILING ${app}/${recipient} ordinal=${ordinal + 1} creator=${accepted.creator} writer=${accepted.writer} last=${issueMs.at(-1)?.toFixed(0)}ms\n`
					);
			}
			const refusal = refusals.length === 0 ? null : refusals;
			const census = { creator: await creator.census(), recipient: await other.census() };
			const sorted = [...issueMs].sort((a, b) => a - b);
			const record = {
				kind: "ceiling",
				epoch,
				limit,
				accepted,
				total: accepted.creator + accepted.writer,
				refusal,
				elapsedMs: Math.round(performance.now() - started),
				issueMs: {
					p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
					last10: issueMs.slice(-10).map((value) => Math.round(value)),
					max: sorted.at(-1) ?? 0,
				},
				census,
			};
			log(record);
			process.stdout.write(
				`CEILING_RESULT ${JSON.stringify({ app, recipient, prior, priorMoves, ...record, census: undefined })}\n`
			);
			// After the refusal a seal must still succeed (the fill never strands the epoch).
			const sealStarted = performance.now();
			let sealOutcome = "ok";
			try {
				await creator.seal(epoch);
			} catch (error) {
				sealOutcome = String(error);
			}
			log({ kind: "seal-after-ceiling", epoch, sealMs: Math.round(performance.now() - sealStarted), sealOutcome });
			process.stdout.write(
				`CEILING_SEAL ${app}/${recipient} ${sealOutcome} ${Math.round(performance.now() - sealStarted)}ms\n`
			);
		} finally {
			const closed = await Promise.allSettled([...track.rooms].map((room) => room.close()));
			const heads = await Promise.allSettled([...track.heads].map((head) => head.close()));
			await Promise.all([...track.ports].map((port) => port.close()));
			restore();
			rmSync(directory, { recursive: true, force: true });
			expect([...closed, ...heads].filter((result) => result.status === "rejected")).toEqual([]);
		}
	},
	3_600_000
);
