/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local helpers retain native fixture types. */
import type * as V3LiveModule from "@ts-drp/node/v3-live";
import { MessageType } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import { creatorDeliveryRoom, eventually, sleep } from "./fixtures/track-aa/creator-delivery-room.js";
import { place } from "./fixtures/track-aa/scenario.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readV3RuntimeOwnerCensus, republishV3RetainedTo } from "../packages/node/src/v3-live.js";

const planes = vi.hoisted(() => new Map<string, V3LiveModule.V3PlaneHandle>());
vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const real = await importOriginal<typeof V3LiveModule>();
	return {
		...real,
		activateV3LivePlane: (...args: Parameters<typeof real.activateV3LivePlane>) => {
			const result = real.activateV3LivePlane(...args);
			if (result.ok) planes.set(args[0].networkNode.peerId, result.handle);
			return result;
		},
	};
});

afterEach(async () => {
	planes.clear();
	expect(await closeFixtures()).toEqual([]);
});

async function retainedSender(count = 1) {
	const fixture = await creatorDeliveryRoom();
	const creator = await fixture.open(0);
	const receiver = fixture.bare("slow-reader");
	await place(creator, "retained", count);
	await fixture.network.idle();
	const plane = required(planes.get(creator.peerId));
	const census = () => required(readV3RuntimeOwnerCensus(plane));
	expect(await eventually(() => census().admittedEgressControlJobs === 0, 5_000)).toBe(true);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const signals: AbortSignal[] = [];
	const send = creator.networkNode.sendMessage.bind(creator.networkNode);
	Object.assign(creator.networkNode, {
		sendMessage: async (...args: Parameters<typeof send>) => {
			if (args[0] === receiver.peerId && args[1].type === MessageType.MESSAGE_TYPE_V3_ENVELOPE) {
				signals.push(required(args[2]?.signal));
				await held;
			}
			return send(...args);
		},
	});
	return { fixture, creator, receiver, plane, census, release, signals };
}

it("duplicate targeted requests join the native active replay instead of reserving queued snapshots", async () => {
	const sender = await retainedSender();
	const jobs: Promise<unknown>[] = [];
	try {
		for (let index = 0; index < 100; index++) jobs.push(republishV3RetainedTo(sender.plane, sender.receiver.peerId));
		expect(sender.census().admittedEgressControlJobs).toBe(1);
		expect(new Set(jobs).size).toBe(1);
		expect(await eventually(() => sender.signals.length > 0, 5_000)).toBe(true);
		expect(sender.signals).toHaveLength(1);
	} finally {
		sender.release();
		await Promise.all(jobs);
	}
	expect(sender.census()).toMatchObject({ admittedEgressControlJobs: 0, replayableEgressKeys: 0 });
}, 30_000);

it("retirement aborts the shared replay but keeps its native slot charged until the actual send settles", async () => {
	const sender = await retainedSender();
	const jobs = [republishV3RetainedTo(sender.plane, sender.receiver.peerId)];
	try {
		expect(await eventually(() => sender.signals.length > 0, 5_000)).toBe(true);
		for (let index = 0; index < 64; index++) {
			const peer = sender.fixture.bare(`reader-${index}`);
			jobs.push(republishV3RetainedTo(sender.plane, peer.peerId));
		}
		expect(sender.census()).toMatchObject({ admittedEgressControlJobs: 32, replayableEgressKeys: 32 });
		sender.plane.deactivate();
		expect(required(sender.signals[0]).aborted).toBe(true);
		expect(sender.census()).toMatchObject({ active: 0, admittedEgressControlJobs: 32, replayableEgressKeys: 32 });
	} finally {
		sender.release();
		await Promise.all(jobs);
	}
	expect(sender.census()).toMatchObject({ admittedEgressControlJobs: 0, replayableEgressKeys: 0 });
}, 30_000);

// Opt-in telemetry for the separate whole-journal FIFO streaming limitation.
it.runIf(process.env.TRACK_AA_MEASURE_REPLAY_STALL === "1")(
	"measures a single slow replay's retained gate and durable issue stall",
	async () => {
		const sender = await retainedSender(80);
		sender.release();
		await sleep(16_000);
		const send = sender.creator.networkNode.sendMessage.bind(sender.creator.networkNode);
		Object.assign(sender.creator.networkNode, {
			sendMessage: async (...args: Parameters<typeof send>) => {
				if (args[0] === sender.receiver.peerId && args[1].type === MessageType.MESSAGE_TYPE_V3_ENVELOPE)
					await sleep(100);
				return send(...args);
			},
		});
		const replayStarted = performance.now();
		const replay = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
		let replayMs = 0;
		void replay.then(() => {
			replayMs = performance.now() - replayStarted;
		});
		expect(await eventually(() => sender.signals.length > 0, 5_000)).toBe(true);
		let maxJobs = 0;
		let requests = 1;
		const poll = setInterval(() => {
			requests++;
			void republishV3RetainedTo(sender.plane, sender.receiver.peerId);
			maxJobs = Math.max(maxJobs, required(sender.census().admittedEgressControlJobs));
		}, 100);
		const issueStarted = performance.now();
		try {
			await place(sender.creator, "during-replay", 1);
			await replay;
			expect(maxJobs).toBe(1);
			console.info(
				`TRACK_AA_REPLAY_STALL ${JSON.stringify({
					rows: 80,
					successfulSendDelayMs: 100,
					duplicateRequests: requests,
					maxNativeReplays: maxJobs,
					retainedGateMs: Math.round(replayMs),
					durableIssueWaitMs: Math.round(performance.now() - issueStarted),
				})}`
			);
		} finally {
			clearInterval(poll);
		}
	},
	60_000
);
