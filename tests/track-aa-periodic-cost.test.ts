import { Message, MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, it } from "vitest";

import { creatorDeliveryRoom, type Profile, sleep } from "./fixtures/track-aa/creator-delivery-room.js";
import { admitted, openAll, place, placedRows } from "./fixtures/track-aa/scenario.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
});

// This measures full-journal anti-entropy cost, not frame-rate suitability. Sequential
// issue/admit pairs avoid deliberately saturating the receiver; the quiet sample then
// counts every protocol Message byte over two peers, excluding transport framing.
describe.runIf(process.env.TRACK_AA_MEASURE_COST === "1").each<Profile>(["shipped", "settlement"])(
	"Track AA no-loss periodic cost, %s",
	(profile) => {
		it("reports latency and replay bytes for a 512-row current epoch", async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const peers = await openAll(fixture);
			const creator = required(peers[0]);
			const writer = required(peers[1]);
			const latencies: number[] = [];
			const issueMs: number[] = [];
			const publicationDrainMs: number[] = [];
			const admissionWaitMs: number[] = [];
			const populationStarted = performance.now();
			for (let index = 0; index < 512; index++) {
				const started = performance.now();
				const ids = await place(writer, `steady-${index}`, 1, index);
				const issuedAt = performance.now();
				await fixture.network.idle();
				const drainedAt = performance.now();
				const rows = placedRows(fixture, writer, ids);
				expect(
					await admitted(
						creator,
						rows.map(({ digest }) => digest)
					)
				).toMatchObject({ complete: true });
				const admittedAt = performance.now();
				latencies.push(admittedAt - started);
				issueMs.push(issuedAt - started);
				publicationDrainMs.push(drainedAt - issuedAt);
				admissionWaitMs.push(admittedAt - drainedAt);
				if ((index + 1) % 128 === 0)
					console.info(
						`TRACK_AA_POPULATE ${JSON.stringify({
							profile,
							rows: index + 1,
							elapsedMs: Math.round(admittedAt - populationStarted),
							issueMs: Math.round(issueMs.reduce((sum, value) => sum + value, 0)),
							publicationDrainMs: Math.round(publicationDrainMs.reduce((sum, value) => sum + value, 0)),
							admissionWaitMs: Math.round(admissionWaitMs.reduce((sum, value) => sum + value, 0)),
						})}`
					);
			}
			await fixture.network.idle();
			let requests = 0;
			let rows = 0;
			let bytes = 0;
			let measuring = true;
			fixture.network.observe(({ kind, message }) => {
				if (!measuring || kind !== "direct") return;
				bytes += Message.encode(message).finish().byteLength;
				if (message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE) rows++;
				else if (message.type === MessageType.MESSAGE_TYPE_CUSTOM) requests++;
			});
			const started = performance.now();
			await sleep(20_000);
			await fixture.network.idle();
			measuring = false;
			const durationMs = performance.now() - started;
			latencies.sort((a, b) => a - b);
			expect(requests).toBeGreaterThan(0);
			expect(rows).toBeGreaterThan(0);
			expect(creator.accepted.size).toBe(512);
			console.info(
				`TRACK_AA_COST ${JSON.stringify({
					profile,
					epochRows: 512,
					sampleMs: Math.round(durationMs),
					requests,
					replayRows: rows,
					messageBytes: bytes,
					bytesPerSecond: Math.round((bytes * 1000) / durationMs),
					populationPhasesMs: {
						issue: Math.round(issueMs.reduce((sum, value) => sum + value, 0)),
						publicationDrain: Math.round(publicationDrainMs.reduce((sum, value) => sum + value, 0)),
						remoteAdmissionWait: Math.round(admissionWaitMs.reduce((sum, value) => sum + value, 0)),
					},
					serialIssueToAdmissionMs: {
						p50: Math.round(required(latencies[255])),
						p95: Math.round(required(latencies[486])),
						max: Math.round(required(latencies.at(-1))),
					},
				})}`
			);
		}, 300_000);
	}
);
