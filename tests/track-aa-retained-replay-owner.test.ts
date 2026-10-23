/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local helpers retain native fixture types. */
import type * as V3LiveModule from "@ts-drp/node/v3-live";
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
} from "@ts-drp/storage";
import { MessageType } from "@ts-drp/types";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { creatorDeliveryRoom, envelopeDigest, eventually, sleep } from "./fixtures/track-aa/creator-delivery-room.js";
import { place, placedRows } from "./fixtures/track-aa/scenario.js";
import { closeFixtures, directories, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	deactivateV3LivePlaneJoined,
	readV3RuntimeOwnerCensus,
	republishV3RetainedTo,
	requestV3RetainedRepair,
} from "../packages/node/src/v3-live.js";

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

async function retainedSender(count = 1, withRecipient = false, measurePopulation = false) {
	const fixture = await creatorDeliveryRoom();
	const creator = await fixture.open(0);
	const recipient = withRecipient ? await fixture.open(1) : undefined;
	const receiver = fixture.bare("slow-reader");
	const plane = required(planes.get(creator.peerId));
	const census = () => required(readV3RuntimeOwnerCensus(plane));
	if (!measurePopulation) await place(creator, "retained", count);
	else {
		const started = performance.now();
		for (let index = 0; index < count; index++) {
			try {
				await creator.room.issue({
					action: "placeBlock",
					id: `retained-${index}`,
					kind: "stone",
					x: index % 10,
					y: Math.floor(index / 10),
				});
			} catch (error) {
				console.info(
					`TRACK_AA_REPLAY_POPULATION_FAILURE ${JSON.stringify({ requestedRows: count, completedIssues: index, acceptedRows: creator.accepted.size, elapsedMs: performance.now() - started, census: census(), error: String(error) })}`
				);
				if (process.env.TRACK_AA_PROBE_CAPACITY_FINISH === "1") {
					const finishingStarted = performance.now();
					try {
						const seal = await creator.room.sealEpoch();
						console.info(
							`TRACK_AA_CAPACITY_SEAL ${JSON.stringify({ elapsedMs: performance.now() - finishingStarted, seal })}`
						);
						if (seal.ok) {
							console.info("TRACK_AA_CAPACITY_ADOPT_START", JSON.stringify({ status: creator.room.status() }));
							const adoption = await creator.room.adoptCreatorSuccessor();
							console.info("TRACK_AA_CAPACITY_ADOPT", JSON.stringify({ adoption, status: creator.room.status() }));
							console.info("TRACK_AA_CAPACITY_NEXT_ISSUE_START", JSON.stringify({ status: creator.room.status() }));
							try {
								await place(creator, "after-capacity-refusal", 1, 1000);
							} catch (nextError) {
								console.info(
									"TRACK_AA_CAPACITY_NEXT_ISSUE_FAILURE",
									JSON.stringify({ error: String(nextError), status: creator.room.status() })
								);
								const maintenance = await creator.room.maintainRecoveryPool();
								console.info(
									"TRACK_AA_CAPACITY_MAINTENANCE",
									JSON.stringify({ maintenance, status: creator.room.status() })
								);
								await place(creator, "after-capacity-maintenance", 1, 1001);
							}
							console.info(
								"TRACK_AA_CAPACITY_FINISH",
								JSON.stringify({ elapsedMs: performance.now() - finishingStarted, nextIssue: "completed" })
							);
						}
					} catch (finishError) {
						console.info(
							"TRACK_AA_CAPACITY_FINISH",
							JSON.stringify({ elapsedMs: performance.now() - finishingStarted, error: String(finishError) })
						);
					}
				}
				throw error;
			}
			if ((index + 1) % 32 === 0)
				console.info(
					`TRACK_AA_REPLAY_POPULATION ${JSON.stringify({ requestedRows: count, completedIssues: index + 1, acceptedRows: creator.accepted.size, elapsedMs: performance.now() - started })}`
				);
		}
	}
	await fixture.network.idle();
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
	return { fixture, creator, receiver, recipient, plane, census, release, signals };
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

it.each(["targeted", "requested"])(
	"a held native %s retained send leaves durable issue schedulable while its replay slot remains charged",
	async (mode) => {
		const sender = await retainedSender(2);
		const recipient = await sender.fixture.open(1);
		const initial = placedRows(sender.fixture, sender.creator, ["retained-0", "retained-1"]);
		expect(
			await eventually(
				() =>
					initial.every(({ digest }) => recipient.accepted.has(digest)) &&
					sender.census().admittedEgressControlJobs === 0,
				5_000
			)
		).toBe(true);
		const replay =
			mode === "targeted"
				? republishV3RetainedTo(sender.plane, sender.receiver.peerId)
				: requestV3RetainedRepair(sender.plane, () => undefined, sender.receiver.peerId);
		let issue: Promise<unknown> | undefined;
		let issued = false;
		try {
			expect(await eventually(() => sender.signals.length > 0, 5_000)).toBe(true);
			issue = place(sender.creator, "during-held-replay", 1, 1).then(() => {
				issued = true;
			});
			expect(await eventually(() => issued, 2_000), "durable issue proceeds before native send release").toBe(true);
			await sender.fixture.network.idle();
			const digest = required(placedRows(sender.fixture, sender.creator, ["during-held-replay-0"])[0]).digest;
			expect(
				await eventually(() => recipient.accepted.has(digest), 5_000),
				"the healthy native recipient admits the new issue"
			).toBe(true);
			expect(sender.census().admittedEgressControlJobs).toBe(1);
			expect(sender.census()).toMatchObject({
				retainedReplayBufferedRows: 1,
				retainedReplayNativeSends: 1,
				retainedReplayReadJobs: 0,
			});
			expect(sender.signals).toHaveLength(1);
		} finally {
			sender.release();
			await Promise.all([replay, issue]);
		}
	},
	30_000
);

it("a slow target cannot hold another target's ordered replay or grow its captured prefix after concurrent issue", async () => {
	const sender = await retainedSender(3);
	const healthy = sender.fixture.bare("healthy-reader");
	const expected = sender.fixture.sentBy(sender.creator.peerId).map(({ digest }) => digest);
	const received: string[] = [];
	sender.fixture.network.observe(({ kind, to, message }) => {
		const digest = envelopeDigest(message);
		if (kind === "direct" && to === healthy.peerId && digest !== undefined) received.push(digest);
	});
	const slow = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
	let healthyReplay: Promise<unknown> | undefined;
	let healthyDone = false;
	try {
		expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
		healthyReplay = republishV3RetainedTo(sender.plane, healthy.peerId).then(() => {
			healthyDone = true;
		});
		await place(sender.creator, "after-healthy-prefix", 1, 1);
		expect(await eventually(() => healthyDone, 2_000), "healthy target progresses before slow native join").toBe(true);
		expect(received).toEqual(expected);
		expect(sender.census().retainedReplayPeakBufferedRows).toBeLessThanOrEqual(2);
		expect(sender.census().retainedReplayPeakReadJobs).toBeLessThanOrEqual(2);
	} finally {
		sender.release();
		await Promise.all([slow, healthyReplay]);
	}
	expect(sender.census()).toMatchObject({
		retainedReplayBufferedRows: 0,
		retainedReplayNativeSends: 0,
		retainedReplayReadJobs: 0,
	});
}, 30_000);

it("retirement aborts the shared replay but keeps its native slot charged until the actual send settles", async () => {
	const sender = await retainedSender(2);
	const jobs = [republishV3RetainedTo(sender.plane, sender.receiver.peerId)];
	let joined = false;
	let teardown: Promise<void> | undefined;
	try {
		expect(await eventually(() => sender.signals.length > 0, 5_000)).toBe(true);
		for (let index = 0; index < 64; index++) {
			const peer = sender.fixture.bare(`reader-${index}`);
			jobs.push(republishV3RetainedTo(sender.plane, peer.peerId));
		}
		expect(sender.census()).toMatchObject({ admittedEgressControlJobs: 32, replayableEgressKeys: 32 });
		expect(
			republishV3RetainedTo(sender.plane, sender.receiver.peerId),
			"duplicates still join at the target bound"
		).toBe(jobs[0]);
		teardown = deactivateV3LivePlaneJoined(sender.plane).then(() => {
			joined = true;
		});
		expect(required(sender.signals[0]).aborted).toBe(true);
		expect(sender.census()).toMatchObject({ active: 0, admittedEgressControlJobs: 32, replayableEgressKeys: 32 });
		await sleep(25);
		expect(joined, "native teardown waits for the actual send despite cancellation").toBe(false);
	} finally {
		sender.release();
		await Promise.all([...jobs, teardown]);
	}
	expect(sender.signals, "no later row is sent after revocation").toHaveLength(1);
	expect(sender.census()).toMatchObject({ admittedEgressControlJobs: 0, replayableEgressKeys: 0 });
}, 30_000);

it("32 held target sends bound buffers and native work without filling the durable input pool", async () => {
	const sender = await retainedSender(2);
	sender.release();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const signals: AbortSignal[] = [];
	const send = sender.creator.networkNode.sendMessage.bind(sender.creator.networkNode);
	Object.assign(sender.creator.networkNode, {
		sendMessage: async (...args: Parameters<typeof send>) => {
			if (args[1].type === MessageType.MESSAGE_TYPE_V3_ENVELOPE) {
				signals.push(required(args[2]?.signal));
				await held;
			}
			return send(...args);
		},
	});
	const targets = Array.from({ length: 64 }, (_, index) => sender.fixture.bare(`bounded-reader-${index}`));
	const jobs = targets.map((peer) => republishV3RetainedTo(sender.plane, peer.peerId));
	try {
		expect(await eventually(() => signals.length === 32, 5_000)).toBe(true);
		expect(sender.census()).toMatchObject({
			admittedEgressControlJobs: 32,
			replayableEgressKeys: 32,
			admittedInputJobs: 0,
			retainedReplayBufferedRows: 32,
			retainedReplayNativeSends: 32,
			retainedReplayReadJobs: 0,
			retainedReplayPeakBufferedRows: 32,
			retainedReplayPeakNativeSends: 32,
			retainedReplayPrefixRows: 3,
		});
		let issued = false;
		const issue = place(sender.creator, "all-targets-held", 1, 1).then(() => {
			issued = true;
		});
		expect(await eventually(() => issued, 2_000)).toBe(true);
		await issue;
		expect(republishV3RetainedTo(sender.plane, required(targets[0]).peerId)).toBe(jobs[0]);
		expect(await jobs[32]).toMatchObject({ ok: false, kind: "admission-rejected" });
		sender.plane.deactivate();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(sender.census().retainedReplayNativeSends).toBe(32);
		expect(sender.census()).toMatchObject({ retainedReplayPrefixRows: 0, retainedReplayPrefixBytes: 0 });
	} finally {
		release();
		await Promise.all(jobs);
	}
	expect(signals).toHaveLength(32);
	expect(sender.census()).toMatchObject({
		admittedEgressControlJobs: 0,
		retainedReplayBufferedRows: 0,
		retainedReplayBufferedBytes: 0,
		retainedReplayNativeSends: 0,
	});
}, 30_000);

it("a held broadcast replay releases durable issue and joins later prefix demand without another stream", async () => {
	const sender = await retainedSender(2);
	sender.release();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = false;
	const published: string[] = [];
	const publish = sender.creator.networkNode.publishMessage.bind(sender.creator.networkNode);
	Object.assign(sender.creator.networkNode, {
		publishMessage: async (...args: Parameters<typeof publish>) => {
			const digest = envelopeDigest(args[1]);
			if (digest !== undefined) {
				published.push(digest);
				if (!entered) {
					entered = true;
					await held;
				}
			}
			return publish(...args);
		},
	});
	const replay = sender.plane.republishRetained();
	let issue: Promise<unknown> | undefined;
	let duplicate: Promise<unknown> | undefined;
	let issued = false;
	try {
		expect(await eventually(() => entered, 5_000)).toBe(true);
		issue = place(sender.creator, "during-broadcast", 1, 1).then(() => {
			issued = true;
		});
		duplicate = sender.plane.republishRetained();
		expect(await eventually(() => issued, 2_000), "the held broadcast leaves issue schedulable").toBe(true);
		expect(duplicate).not.toBe(replay);
		expect(sender.plane.republishRetained()).toBe(duplicate);
		expect(sender.census().admittedEgressControlJobs).toBe(1);
	} finally {
		release();
		await Promise.all([replay, issue, duplicate]);
	}
	await sender.fixture.network.idle();
	const digest = required(placedRows(sender.fixture, sender.creator, ["during-broadcast-0"])[0]).digest;
	expect(published.filter((value) => value === digest)).toHaveLength(2);
}, 30_000);

it("a legitimately sealed predecessor still serves retained data before adoption", async () => {
	const sender = await retainedSender(3);
	sender.release();
	expect(await sender.creator.room.sealEpoch()).toMatchObject({ ok: true, lifecycle: "successor-pending-adoption" });
	expect(sender.census()).toMatchObject({ active: 1, terminal: 1 });
	expect(await republishV3RetainedTo(sender.plane, sender.receiver.peerId)).toMatchObject({ ok: true });
	expect(sender.signals).toHaveLength(4);
}, 30_000);

it.each(["qc", "ancestry", "head"])(
	"sealed replay rejects native %s mutation after its first send",
	async (mutation) => {
		const sender = await retainedSender(3);
		const sealed = await sender.creator.room.sealEpoch();
		if (!sealed.ok) throw new Error("seal failed");
		const directory = required([...directories][0]);
		let selected: DatabaseSync | undefined;
		for (const name of readdirSync(directory).filter((name) => name.endsWith(".sqlite"))) {
			const database = new DatabaseSync(join(directory, name));
			if (
				database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='objects'").get() !== undefined
			) {
				selected = database;
				break;
			}
			database.close();
		}
		const foreign = required(selected);
		const replay = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
		let restore: (() => void) | undefined;
		try {
			expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
			const rawHead = foreign
				.prepare("SELECT head_record FROM objects WHERE object_id=?")
				.get(sender.fixture.objectId)?.head_record;
			if (!(rawHead instanceof Uint8Array)) throw new Error("native head missing");
			const head = decodeHeadRecordV1(rawHead);
			if (!head.ok || head.value.kind !== "present") throw new Error("native head invalid");
			if (mutation === "qc") {
				const raw = foreign.prepare("SELECT bytes FROM blobs WHERE digest=?").get(sealed.commitQcRef.digest)?.bytes;
				if (!(raw instanceof Uint8Array)) throw new Error("native QC missing");
				restore = () => {
					foreign.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(raw, sealed.commitQcRef.digest);
				};
				foreign.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(Uint8Array.of(0), sealed.commitQcRef.digest);
			} else if (mutation === "ancestry") {
				const raw = foreign
					.prepare("SELECT record FROM generations WHERE object_id=? AND generation_id=?")
					.get(sender.fixture.objectId, head.value.generationId)?.record;
				if (!(raw instanceof Uint8Array)) throw new Error("native generation missing");
				const generation = decodeGenerationRecordV1(raw);
				if (!generation.ok) throw new Error("native generation invalid");
				const mutated = encodeGenerationRecordV1({
					...generation.value,
					baseExpectedHead: { kind: "none", objectId: generation.value.objectId },
				});
				restore = () => {
					foreign
						.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?")
						.run(raw, sender.fixture.objectId, head.value.generationId);
				};
				foreign
					.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?")
					.run(mutated, sender.fixture.objectId, head.value.generationId);
			} else {
				const mutated = encodeHeadRecordV1({
					...head.value,
					revision: (head.value.revision + 1) as typeof head.value.revision,
				});
				restore = () => {
					foreign.prepare("UPDATE objects SET head_record=? WHERE object_id=?").run(rawHead, sender.fixture.objectId);
				};
				foreign.prepare("UPDATE objects SET head_record=? WHERE object_id=?").run(mutated, sender.fixture.objectId);
			}
			sender.release();
			expect(await replay).toMatchObject({ ok: false });
			expect(sender.signals).toHaveLength(1);
		} finally {
			restore?.();
			foreign.close();
			sender.release();
			await replay;
		}
	},
	30_000
);

it("sealed replay joins deactivation of held native sends", async () => {
	const sender = await retainedSender(3);
	expect(await sender.creator.room.sealEpoch()).toMatchObject({ ok: true });
	const replay = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
	let joined = false;
	let teardown: Promise<void> | undefined;
	try {
		expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
		teardown = deactivateV3LivePlaneJoined(sender.plane).then(() => {
			joined = true;
		});
		expect(sender.census()).toMatchObject({ retainedReplayPrefixRows: 0, retainedReplayNativeSends: 1 });
		await sleep(25);
		expect(joined).toBe(false);
	} finally {
		sender.release();
		await Promise.all([replay, teardown]);
	}
	expect(sender.signals).toHaveLength(1);
}, 30_000);

it("sealed replay refuses a foreign floor advance while its native send is held", async () => {
	const sender = await retainedSender(3);
	expect(await sender.creator.room.sealEpoch()).toMatchObject({ ok: true });
	const replay = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
	try {
		expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
		const scope = {
			objectId: sender.fixture.objectId,
			pinnedGenesisAnchorDigest: sender.fixture.invite.pinnedGenesisAnchorDigest,
		};
		const current = await sender.creator.floor.read({ scope });
		if (!current.ok || current.state === null) throw new Error("native floor missing");
		const next = { ...current.state.stable, epoch: 1, currentAnchorDigest: "f".repeat(64) };
		const pending = await sender.creator.floor.begin({ scope, expected: current.state, next });
		if (!pending.ok) throw new Error("native floor begin failed");
		expect(await sender.creator.floor.commit({ scope, expected: pending.state })).toMatchObject({ ok: true });
		sender.release();
		expect(await replay).toMatchObject({ ok: false });
		expect(sender.signals).toHaveLength(1);
	} finally {
		sender.release();
		await replay;
	}
}, 30_000);

it("a peer joining during a broadcast receives the full pending round", async () => {
	const sender = await retainedSender(3);
	sender.release();
	const expected = sender.fixture.sentBy(sender.creator.peerId).map(({ digest }) => digest);
	let release!: () => void;
	const held = new Promise<void>((done) => {
		release = done;
	});
	let sends = 0;
	const publish = sender.creator.networkNode.publishMessage.bind(sender.creator.networkNode);
	Object.assign(sender.creator.networkNode, {
		publishMessage: async (...args: Parameters<typeof publish>) => {
			if (envelopeDigest(args[1]) !== undefined && ++sends === 2) await held;
			return publish(...args);
		},
	});
	const first = sender.plane.republishRetained();
	let pending: Promise<unknown> | undefined;
	const received: string[] = [];
	try {
		expect(await eventually(() => sends === 2, 5_000)).toBe(true);
		const late = sender.fixture.bare("late-broadcast-reader");
		sender.fixture.network.observe(({ to, message }) => {
			const digest = envelopeDigest(message);
			if (to === late.peerId && digest !== undefined) received.push(digest);
		});
		pending = sender.plane.republishRetained();
		expect(sender.plane.republishRetained()).toBe(pending);
		expect(sender.census().admittedEgressControlJobs).toBe(1);
	} finally {
		release();
		await Promise.all([first, pending]);
	}
	await sender.fixture.network.idle();
	expect(new Set(received)).toEqual(new Set(expected));
}, 30_000);

it("broadcast callers finish their own full round under continuous later demand", async () => {
	const sender = await retainedSender(2);
	sender.release();
	const rows = sender.fixture.sentBy(sender.creator.peerId).length;
	const requests: Promise<unknown>[] = [];
	let sends = 0,
		resolvedAt = -1,
		pendingResolvedAt = -1,
		inject = true;
	const publish = sender.creator.networkNode.publishMessage.bind(sender.creator.networkNode);
	Object.assign(sender.creator.networkNode, {
		publishMessage: async (...args: Parameters<typeof publish>) => {
			if (envelopeDigest(args[1]) !== undefined) {
				sends++;
				if (inject) {
					const request = sender.plane.republishRetained();
					if (requests.length === 0)
						void request.then(() => {
							pendingResolvedAt = sends;
						});
					requests.push(request);
				}
				await sleep(2);
			}
			return publish(...args);
		},
	});
	const first = sender.plane.republishRetained();
	void first.then(() => {
		resolvedAt = sends;
	});
	try {
		expect(await eventually(() => resolvedAt >= 0, 5_000)).toBe(true);
		expect(resolvedAt).toBe(rows);
		expect(sender.census().admittedEgressControlJobs).toBe(1);

		expect(await eventually(() => pendingResolvedAt >= 0, 5_000)).toBe(true);
		expect(pendingResolvedAt).toBe(2 * rows);
		expect(new Set(requests.slice(0, rows)).size).toBe(1);
		expect(sender.census().retainedReplayPeakNativeSends).toBe(1);
	} finally {
		inject = false;
		await Promise.all([first, ...requests]);
	}
}, 30_000);

it.each([0, 2048])(
	"transport replacement with %i bytes releases the original encoded charge",
	async (replacementBytes) => {
		const sender = await retainedSender(1);
		sender.release();
		const send = sender.creator.networkNode.sendMessage.bind(sender.creator.networkNode);
		Object.assign(sender.creator.networkNode, {
			sendMessage: async (...args: Parameters<typeof send>) => {
				await send(...args);
				if (args[0] === sender.receiver.peerId) args[1].data = new Uint8Array(replacementBytes);
			},
		});
		expect(await republishV3RetainedTo(sender.plane, sender.receiver.peerId)).toMatchObject({ ok: true });
		expect(sender.census()).toMatchObject({ retainedReplayBufferedBytes: 0, retainedReplayBufferedRows: 0 });
	},
	30_000
);

it("a failed suffix capture preserves only the prior validated prefix", async () => {
	const sender = await retainedSender(1);
	const oldDigests = sender.fixture.sentBy(sender.creator.peerId).map(({ digest }) => digest);
	const slowDigests: string[] = [];
	const healthyDigests: string[] = [];
	const healthy = sender.fixture.bare("failed-suffix-reader");
	sender.fixture.network.observe(({ kind, to, message }) => {
		const digest = envelopeDigest(message);
		if (kind !== "direct" || digest === undefined) return;
		if (to === sender.receiver.peerId) slowDigests.push(digest);
		if (to === healthy.peerId) healthyDigests.push(digest);
	});
	const slow = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
	let foreign: DatabaseSync | undefined;
	try {
		expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
		const prefixBytes = sender.census().retainedReplayPrefixBytes;
		expect(sender.census().retainedReplayPrefixRows).toBe(2);
		await place(sender.creator, "new-suffix", 2, 10);
		const original = StatementSync.prototype.all;
		let failed = false;
		const spy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
			this: StatementSync,
			...args: Parameters<typeof original>
		) {
			if (
				this.sourceSQL.includes("FROM accepted_entries") &&
				this.sourceSQL.includes("ORDER BY journal_sequence LIMIT") &&
				args[3] === 2
			) {
				failed = true;
				throw new Error("temporary page read failure after one suffix row");
			}
			return original.apply(this, args);
		});
		try {
			expect(await republishV3RetainedTo(sender.plane, healthy.peerId)).toMatchObject({ ok: false });
		} finally {
			spy.mockRestore();
		}
		expect(failed).toBe(true);
		expect(sender.census()).toMatchObject({ retainedReplayPrefixRows: 2, retainedReplayPrefixBytes: prefixBytes });
		expect(healthyDigests).toEqual([]);
		const directory = required([...directories][0]);
		const name = required(readdirSync(directory).find((name) => name.endsWith(".drp-live-journal-v1.sqlite")));
		foreign = new DatabaseSync(join(directory, name));
		foreign.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
		foreign.exec(
			"UPDATE accepted_entries SET local_author_sequence=local_author_sequence+100 WHERE journal_sequence=2"
		);
		expect(await republishV3RetainedTo(sender.plane, healthy.peerId)).toMatchObject({
			ok: false,
			kind: "record-rejected",
		});
		await sender.fixture.network.idle();
		expect(healthyDigests).toEqual(oldDigests);
		sender.release();
		expect(await slow).toMatchObject({ ok: true });
		await sender.fixture.network.idle();
		expect(slowDigests).toEqual(oldDigests);
	} finally {
		foreign?.exec(
			"UPDATE accepted_entries SET local_author_sequence=local_author_sequence-100 WHERE journal_sequence=2"
		);
		foreign?.close();
		sender.release();
		await slow;
	}
}, 30_000);

it("native callbacks cannot mutate shared received-row bytes", async () => {
	const sender = await retainedSender(1, true);
	const writer = required(sender.recipient);
	await place(writer, "received-copy", 1, 1);
	await sender.fixture.network.idle();
	const wanted = required(placedRows(sender.fixture, writer, ["received-copy-0"])[0]).digest;
	expect(await eventually(() => sender.creator.accepted.has(wanted), 5_000)).toBe(true);
	const healthy = sender.fixture.bare("copy-reader");
	const healthyDigests: string[] = [];
	sender.fixture.network.observe(({ kind, to, message }) => {
		const digest = envelopeDigest(message);
		if (kind === "direct" && to === healthy.peerId && digest !== undefined) healthyDigests.push(digest);
	});
	let release!: () => void;
	const held = new Promise<void>((done) => {
		release = done;
	});
	let mutated = false;
	const send = sender.creator.networkNode.sendMessage.bind(sender.creator.networkNode);
	Object.assign(sender.creator.networkNode, {
		sendMessage: async (...args: Parameters<typeof send>) => {
			if (args[0] === sender.receiver.peerId && args[1].type === MessageType.MESSAGE_TYPE_V3_ENVELOPE) {
				const digest = envelopeDigest(args[1]);
				args[1].data.fill(0);
				if (digest === wanted) {
					mutated = true;
					await held;
				}
				return;
			}
			return send(...args);
		},
	});
	const replay = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
	try {
		expect(await eventually(() => mutated, 5_000)).toBe(true);
		expect(await republishV3RetainedTo(sender.plane, healthy.peerId)).toMatchObject({ ok: true });
		await sender.fixture.network.idle();
		expect(healthyDigests).toContain(wanted);
	} finally {
		release();
		sender.release();
		await replay;
	}
}, 30_000);

it("foreign journal mutation cannot alter captured rows and is rejected by the next replay demand", async () => {
	const sender = await retainedSender(3);
	const expected = sender.fixture.sentBy(sender.creator.peerId).map(({ digest }) => digest);
	const replayed: string[] = [];
	sender.fixture.network.observe(({ kind, to, message }) => {
		const digest = envelopeDigest(message);
		if (kind === "direct" && to === sender.receiver.peerId && digest !== undefined) replayed.push(digest);
	});
	const replay = republishV3RetainedTo(sender.plane, sender.receiver.peerId);
	let foreign: DatabaseSync | undefined;
	try {
		expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
		const directory = required([...directories][0]);
		const name = required(readdirSync(directory).find((name) => name.endsWith(".drp-live-journal-v1.sqlite")));
		foreign = new DatabaseSync(join(directory, name));
		foreign.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
		foreign.exec("UPDATE accepted_entries SET vertex_digest='malformed' WHERE journal_sequence=2");
		sender.release();
		expect(await replay).toMatchObject({ ok: true });
		await sender.fixture.network.idle();
		expect(replayed).toEqual(expected);
		expect(await republishV3RetainedTo(sender.plane, sender.receiver.peerId)).toMatchObject({ ok: false });
	} finally {
		sender.release();
		await replay;
		foreign?.close();
	}
}, 30_000);

it.each([1, 3])(
	"a native floor advance during a held replay of %i rows prevents stale continuation and success",
	async (count) => {
		const sender = await retainedSender(count);
		const repair = requestV3RetainedRepair(sender.plane, () => undefined, sender.receiver.peerId);
		try {
			expect(await eventually(() => sender.signals.length === 1, 5_000)).toBe(true);
			const scope = {
				objectId: sender.fixture.objectId,
				pinnedGenesisAnchorDigest: sender.fixture.invite.pinnedGenesisAnchorDigest,
			};
			const current = await sender.creator.floor.read({ scope });
			if (!current.ok || current.state === null) throw new Error("native floor is unavailable");
			const next = { ...current.state.stable, epoch: 1, currentAnchorDigest: "f".repeat(64) };
			const pending = await sender.creator.floor.begin({ scope, expected: current.state, next });
			if (!pending.ok || pending.state === null) throw new Error("native floor transition is unavailable");
			expect(await sender.creator.floor.commit({ scope, expected: pending.state })).toMatchObject({ ok: true });
		} finally {
			sender.release();
		}
		await expect(repair).rejects.toThrow();
		expect(sender.signals).toHaveLength(1);
	},
	30_000
);

// Isolated telemetry: real native issue/admission, in-memory transport, one slow
// target. Replay wall time and FIFO read-turn time are different measurements.
it.runIf(process.env.TRACK_AA_MEASURE_REPLAY_STALL === "1")(
	"measures a single slow replay's retained gate and durable issue stall",
	async () => {
		const populationStarted = performance.now();
		const sender = await retainedSender(80, true);
		console.info("TRACK_AA_REPLAY_POPULATED", Math.round(performance.now() - populationStarted));
		const recipient = required(sender.recipient);
		sender.release();
		await sleep(16_000);
		const initial = placedRows(
			sender.fixture,
			sender.creator,
			Array.from({ length: 80 }, (_, index) => `retained-${index}`)
		);
		expect(await eventually(() => initial.every(({ digest }) => recipient.accepted.has(digest)), 20_000)).toBe(true);
		console.info("TRACK_AA_REPLAY_WARMED", Math.round(performance.now() - populationStarted));
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
		void replay.then(() => {
			clearInterval(poll);
		});
		const issueMs: number[] = [];
		const receiverMs: number[] = [];
		const percentiles = (values: readonly number[]) => {
			const sorted = [...values].sort((a, b) => a - b);
			const at = (p: number) => Math.round(required(sorted[Math.ceil(p * sorted.length) - 1]) * 100) / 100;
			return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
		};
		try {
			for (let index = 0; index < 20; index++) {
				const started = performance.now();
				const ids = await place(sender.creator, `during-replay-${index}`, 1, 20 + index);
				issueMs.push(performance.now() - started);
				await sender.fixture.network.idle();
				const digest = required(placedRows(sender.fixture, sender.creator, ids)[0]).digest;
				expect(await eventually(() => recipient.accepted.has(digest), 5_000, 1)).toBe(true);
				receiverMs.push(performance.now() - started);
			}
			await replay;
			expect(maxJobs).toBeLessThanOrEqual(2);
			console.info(
				`TRACK_AA_REPLAY_STALL ${JSON.stringify({
					seedOperationRows: 80,
					replayRows: sender.signals.length,
					successfulSendDelayMs: 100,
					duplicateRequests: requests,
					maxNativeReplays: maxJobs,
					replayWallMs: Math.round(replayMs),
					firstDurableIssueWaitMs: Math.round(required(issueMs[0])),
					issueSamples: issueMs.length,
					durableIssueMs: percentiles(issueMs),
					receiverObservedMs: percentiles(receiverMs),
					rawDurableIssueMs: issueMs,
					rawReceiverObservedMs: receiverMs,
					receivedNewRows: receiverMs.length,
					census: sender.census(),
				})}`
			);
		} finally {
			clearInterval(poll);
		}
	},
	180_000
);

it.runIf(process.env.TRACK_AA_MEASURE_REPLAY_SCALE === "1").each([128, 512])(
	"measures a quiet %i-row replay's native scan and buffer costs",
	async (count) => {
		const populationStarted = performance.now();
		const sender = await retainedSender(count, false, true);
		sender.release();
		const populationMs = performance.now() - populationStarted;
		const expectedRows = sender.fixture.sentBy(sender.creator.peerId).length;
		console.info("TRACK_AA_REPLAY_SCALE_START", JSON.stringify({ count, expectedRows, populationMs }));
		let fullScans = 0;
		let fullScanRows = 0;
		let pageReads = 0;
		let pageRows = 0;
		const original = StatementSync.prototype.all;
		const spy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
			this: StatementSync,
			...args: Parameters<typeof original>
		) {
			const rows = original.apply(this, args);
			if (this.sourceSQL.includes("FROM accepted_entries") && this.sourceSQL.includes("ORDER BY journal_sequence")) {
				if (this.sourceSQL.includes("LIMIT")) {
					pageReads++;
					pageRows += rows.length;
				} else {
					fullScans++;
					fullScanRows += rows.length;
				}
			}
			return rows;
		});
		const started = performance.now();
		try {
			expect(await republishV3RetainedTo(sender.plane, sender.receiver.peerId)).toMatchObject({ ok: true });
		} finally {
			spy.mockRestore();
		}
		const replayMs = performance.now() - started;
		console.info(
			`TRACK_AA_REPLAY_SCALE ${JSON.stringify({ count, expectedRows, actualRows: sender.signals.length, populationMs, replayMs, fullScans, fullScanRows, pageReads, pageRows, census: sender.census() })}`
		);
		expect(sender.signals).toHaveLength(expectedRows);
		expect(fullScanRows, "unchanged native prefix is not rescanned for every row").toBeLessThanOrEqual(expectedRows);
		expect(pageRows).toBeLessThanOrEqual(2 * expectedRows);
	},
	180_000
);

it.runIf(process.env.TRACK_AA_MEASURE_REPLAY_APPEND === "1")(
	"measures native replay scans when every send overlaps a new durable append",
	async () => {
		const sender = await retainedSender(64, false, true);
		sender.release();
		let appended = 0;
		let replayFullScans = 0;
		let replayFullScanRows = 0;
		let allFullScans = 0;
		let allFullScanRows = 0;
		const originalAll = StatementSync.prototype.all;
		const spy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
			this: StatementSync,
			...args: Parameters<typeof originalAll>
		) {
			const rows = originalAll.apply(this, args);
			if (
				this.sourceSQL.includes("FROM accepted_entries") &&
				this.sourceSQL.includes("ORDER BY journal_sequence") &&
				!this.sourceSQL.includes("LIMIT")
			) {
				allFullScans++;
				allFullScanRows += rows.length;
				// Profiling attribution only: never admission or proof authority.
				if (new Error().stack?.includes("readRetainedReplayMessage") === true) {
					replayFullScans++;
					replayFullScanRows += rows.length;
				}
			}
			return rows;
		});
		const send = sender.creator.networkNode.sendMessage.bind(sender.creator.networkNode);
		Object.assign(sender.creator.networkNode, {
			sendMessage: async (...args: Parameters<typeof send>) => {
				if (
					args[0] === sender.receiver.peerId &&
					args[1].type === MessageType.MESSAGE_TYPE_V3_ENVELOPE &&
					appended < 64
				) {
					const index = appended++;
					await place(sender.creator, `overlap-${index}`, 1, 100 + index);
				}
				return send(...args);
			},
		});
		const started = performance.now();
		try {
			expect(await republishV3RetainedTo(sender.plane, sender.receiver.peerId)).toMatchObject({ ok: true });
		} finally {
			spy.mockRestore();
		}
		console.info(
			`TRACK_AA_REPLAY_APPEND ${JSON.stringify({ seedRows: 64, replayRows: sender.signals.length, appended, elapsedMs: performance.now() - started, replayFullScans, replayFullScanRows, allFullScans, allFullScanRows, census: sender.census() })}`
		);
		expect(appended).toBe(64);
		expect(replayFullScanRows, "fixed replay does not rescan after each concurrent append").toBe(0);
	},
	180_000
);
