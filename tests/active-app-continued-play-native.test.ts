/* eslint-disable @typescript-eslint/explicit-function-return-type -- Opt-in measurement fixture. */
import type { EphemeralChannel } from "@ts-drp/ephemeral";
import { MessageType } from "@ts-drp/types";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Session, type Profiler } from "node:inspector";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance as nodePerformance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import {
	creatorDeliveryRoom,
	envelopeDigest,
	envelopeVertex,
	eventually,
	sleep,
} from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery } from "./fixtures/track-m/settlement-room.js";

const enabled = process.env.ACTIVE_CONTINUED_PLAY === "1";
const output = process.env.ACTIVE_CONTINUED_PLAY_OUT ?? join(tmpdir(), `active-continued-play-${Date.now()}`);
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");

async function joined<Value>(jobs: readonly Promise<Value>[]): Promise<Value[]> {
	const results = await Promise.allSettled(jobs);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	return results.map((result) => (result as PromiseFulfilledResult<Value>).value);
}

it.skipIf(!enabled)(
	"real durable transport conserves accepted work and measures continued play through native transitions",
	async () => {
		mkdirSync(output, { recursive: true });
		const log = join(output, "continued-play.jsonl");
		const record = (value: Readonly<Record<string, unknown>>) => appendFileSync(log, JSON.stringify(value) + "\n");
		const diff = execFileSync("git", ["diff", "--no-ext-diff", "HEAD"], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		writeFileSync(join(output, "source.diff"), diff);
		record({
			kind: "configuration",
			sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			sourceDiffSha256: createHash("sha256").update(diff).digest("hex"),
			load: loadavg(),
			durable: "real localhost WebSocket/libp2p, 20ms delayed genuine ingress",
			ephemeral:
				"controlled raw datagrams; production room authority, codec, queue and sequence filter; not real WebRTC or FPS",
			tickIntervalMs: 10,
			successor: "signed native export over scripted chunk/material transport",
			epochs: 3,
			cpuProfiles: process.env.ACTIVE_CONTINUED_PLAY_PROFILE === "1",
		});
		const network = await nativePlayNetwork();
		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		eventLoop.enable();
		let phase = "startup";
		const remote: { phase: string; at: number; receiver: number; digest: string }[] = [];
		const samples: {
			phase: string;
			at: number;
			receiver: number;
			sequence: number;
			latencyMs: number;
			gapMs: number;
		}[] = [];
		const attempts: { phase: string; at: number; peer: number; accepted?: boolean; error?: string }[] = [];
		const pendingTicks = new Set<Promise<void>>();
		const timerGaps: number[] = [];
		const steps: Readonly<Record<string, unknown>>[] = [];
		const busyTicks = new Set<number>();
		let timer: ReturnType<typeof setInterval> | undefined;
		let lastTimer = performance.now();
		let tick = 0;
		const channels = new Map<number, EphemeralChannel>();
		const channelHistory = new Set<EphemeralChannel>();
		const subscriptions = new Map<number, () => void>();
		const lastReceived = new Map<number, number>();
		const expected = new Map<string, { id: string; kind: string; x: number; y: number }>();
		let failure: unknown;
		let profiler: Session | undefined;
		try {
			if (process.env.ACTIVE_CONTINUED_PLAY_PROFILE === "1") {
				profiler = new Session();
				profiler.connect();
				await new Promise<void>((resolve, reject) =>
					required(profiler).post("Profiler.enable", (error) => (error ? reject(error) : resolve()))
				);
				await new Promise<void>((resolve, reject) =>
					required(profiler).post("Profiler.setSamplingInterval", { interval: 1000 }, (error) =>
						error ? reject(error) : resolve()
					)
				);
			}
			const fixture = await creatorDeliveryRoom({
				profile: "settlement",
				network,
				peerIds: network.peerIds,
				onAccepted: (receiver, digest, author) => {
					if (author !== fixture.identities[receiver]?.author)
						remote.push({ phase, at: performance.now(), receiver, digest });
				},
			});
			const peers = [await fixture.open(0), await fixture.open(1)] as const;
			const [creator, writer] = peers;
			const channelFor = (index: number) => {
				const channel = required(peers[index]).room.openEphemeral({
					maxMessageBytes: 512,
					maxSequencedKeys: 1,
					maxSequencedSenders: 2,
				});
				if (channels.get(index) !== channel) {
					subscriptions.get(index)?.();
					channels.set(index, channel);
					channelHistory.add(channel);
					subscriptions.set(
						index,
						channel.subscribe((frame) => {
							const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { sequence: number; sent: number };
							const now = performance.now();
							samples.push({
								phase,
								at: now,
								receiver: index,
								sequence: payload.sequence,
								latencyMs: now - payload.sent,
								gapMs: now - (lastReceived.get(index) ?? now),
							});
							lastReceived.set(index, now);
						})
					);
				}
				return channel;
			};
			channelFor(0);
			channelFor(1);
			lastTimer = performance.now();
			timer = setInterval(() => {
				const now = performance.now();
				timerGaps.push(now - lastTimer);
				lastTimer = now;
				for (let index = 0; index < 2; index++) {
					if (busyTicks.has(index)) continue;
					busyTicks.add(index);
					const sample = { phase, at: now, peer: index };
					const sequence = ++tick;
					const job = (async () => {
						try {
							const accepted = await channelFor(index).publish({
								class: "unreliable-sequenced",
								key: "movement",
								payload: new TextEncoder().encode(JSON.stringify({ sequence, sent: now })),
							});
							attempts.push({ ...sample, accepted });
						} catch (cause) {
							attempts.push({ ...sample, error: String(cause) });
						}
					})();
					pendingTicks.add(job);
					void job.then(() => {
						pendingTicks.delete(job);
						busyTicks.delete(index);
					});
				}
			}, 10);
			const issue = async (index: number, id: string, x: number) => {
				const block = { id, kind: "stone", x, y: index };
				const started = performance.now();
				await required(peers[index]).room.issue({ action: "placeBlock", ...block });
				expected.set(id, block);
				record({ kind: "issue", phase, peer: index, id, ms: performance.now() - started });
			};
			const converged = async () => {
				const blocks = [...expected.values()].sort((a, b) => a.id.localeCompare(b.id));
				expect(
					await eventually(
						() =>
							peers.every(
								({ room }) =>
									JSON.stringify([...room.projection().blocks].sort((a, b) => a.id.localeCompare(b.id))) ===
									JSON.stringify(blocks)
							),
						20_000
					),
					`durable convergence in ${phase}`
				).toBe(true);
			};
			const step = async <Value>(name: string, work: () => Promise<Value>): Promise<Value> => {
				phase = name;
				const profiled = profiler !== undefined && /^(seal|adopt|install)-/.test(name);
				if (profiled)
					await new Promise<void>((resolve, reject) =>
						required(profiler).post("Profiler.start", (error) => (error ? reject(error) : resolve()))
					);
				const started = performance.now(),
					cpuBefore = process.cpuUsage(),
					utilizationBefore = nodePerformance.eventLoopUtilization(),
					ticksBefore = timerGaps.length,
					receivedBefore = samples.length,
					remoteBefore = remote.length,
					authorityEpochsBefore = peers.map(({ room }) => room.authority()?.epoch ?? 0),
					mismatchBefore = [...channelHistory].reduce((sum, channel) => sum + channel.stats().authorityMismatch, 0);
				try {
					return await work();
				} finally {
					const cpu = process.cpuUsage(cpuBefore);
					const measurement = {
						kind: "step",
						phase: name,
						ms: performance.now() - started,
						cpuUserMs: cpu.user / 1000,
						cpuSystemMs: cpu.system / 1000,
						eventLoop: nodePerformance.eventLoopUtilization(utilizationBefore),
						timerCallbacks: timerGaps.length - ticksBefore,
						ephemeralReceived: samples.length - receivedBefore,
						remoteAccepted: remote.length - remoteBefore,
						authorityEpochsBefore,
						authorityEpochsAfter: peers.map(({ room }) => room.authority()?.epoch ?? 0),
						authorityMismatch:
							[...channelHistory].reduce((sum, channel) => sum + channel.stats().authorityMismatch, 0) - mismatchBefore,
					};
					steps.push(measurement);
					record(measurement);
					if (profiled) {
						const captured = await new Promise<Profiler.StopReturnType>((resolve, reject) =>
							required(profiler).post("Profiler.stop", (error, result) => (error ? reject(error) : resolve(result)))
						);
						writeFileSync(join(output, `${name}.cpuprofile`), JSON.stringify(captured.profile));
					}
				}
			};
			await joined([issue(0, "warm-0", 0), issue(1, "warm-1", 1)]);
			await converged();
			await sleep(16_000); // Exhaust all startup requests before testing periodic repair.
			await step("baseline-before", () => sleep(2000));
			expect(samples.filter((sample) => sample.receiver === 0).length).toBeGreaterThan(500);
			expect(samples.filter((sample) => sample.receiver === 1).length).toBeGreaterThan(500);
			phase = "automatic-repair";
			let requests = 0,
				lostGossip = 0,
				lostAnswers = 0;
			let missing: string | undefined;
			const unobserve = network.observe(({ from, to, message }) => {
				if (
					from === creator.peerId &&
					to === writer.peerId &&
					message.type === MessageType.MESSAGE_TYPE_CUSTOM &&
					Buffer.from(message.data).equals(Buffer.from(HISTORY_REQUEST))
				)
					requests++;
			});
			const allow = network.lose(({ kind, from, to, message }) => {
				if (
					from !== writer.peerId ||
					to !== creator.peerId ||
					(envelopeVertex(message)?.operation as { id?: string } | undefined)?.id !== "quiet-final"
				)
					return false;
				missing = envelopeDigest(message);
				if (kind === "gossip") {
					lostGossip++;
					return true;
				}
				if (requests <= 1) {
					lostAnswers++;
					return true;
				}
				return false;
			});
			const repairStarted = performance.now();
			await issue(1, "quiet-final", 2);
			expect(await eventually(() => missing !== undefined && creator.accepted.has(missing), 20_000)).toBe(true);
			expect(lostGossip).toBeGreaterThan(0);
			expect(lostAnswers).toBeGreaterThan(0);
			expect(requests).toBeGreaterThan(1);
			record({
				kind: "automatic-repair",
				ms: performance.now() - repairStarted,
				requests,
				lostGossip,
				lostAnswers,
				missing,
			});
			allow();
			unobserve();
			await converged();
			for (let epoch = 1; epoch <= 3; epoch++) {
				phase = `seal-adopt-${epoch}`;
				const stale = required(network.raw.sends.findLast((send) => send.sender === writer.peerId));
				const start = performance.now(),
					sampleStart = samples.length,
					remoteStart = remote.length;
				const writes = (async () => {
					for (let ordinal = 0; ordinal < 4; ordinal++)
						await issue(1, `stream-${epoch}-${ordinal}`, epoch * 10 + ordinal);
				})();
				const rollover = (async () => {
					const sealed = await step(`seal-${epoch}`, () => creator.room.sealEpoch());
					expect(sealed).toMatchObject({ ok: true });
					await step(`adopt-${epoch}`, () => creator.room.adoptCreatorSuccessor());
					const transfer = await step(`export-${epoch}`, () => settlementDelivery(fixture));
					Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
					await step(`install-${epoch}`, () =>
						writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers })
					);
				})();
				await joined([writes, rollover]);
				record({
					kind: "transition",
					epoch,
					ms: performance.now() - start,
					ephemeralReceived: samples.length - sampleStart,
					remoteAccepted: remote.length - remoteStart,
				});
				phase = `settled-${epoch}`;
				await converged();
				channelFor(0);
				channelFor(1);
				const beforeStale = samples.length,
					authorityBefore = required(channels.get(0)).stats().authorityMismatch;
				network.raw.inject(creator.peerId, stale.routeId, writer.peerId, stale.bytes);
				expect(samples.length).toBe(beforeStale);
				expect(required(channels.get(0)).stats().authorityMismatch).toBe(authorityBefore + 1);
				await step(`maintenance-${epoch}`, async () => {
					const maintenanceStart = performance.now(),
						maintenanceRemote = remote.length;
					const maintenance = joined(peers.map(({ room }) => room.maintainRecoveryPool()));
					await joined([
						maintenance.then((results) => {
							record({
								kind: "maintenance",
								epoch,
								results,
								ms: performance.now() - maintenanceStart,
								remoteAccepted: remote.length - maintenanceRemote,
							});
						}),
						issue(0, `maintenance-${epoch}-0`, epoch * 100),
						issue(1, `maintenance-${epoch}-1`, epoch * 100 + 1),
					]);
				});
				await converged();
				const received = peers.map((_, receiver) => samples.filter((sample) => sample.receiver === receiver).length);
				await step(`baseline-after-${epoch}`, () => sleep(1000));
				for (let receiver = 0; receiver < peers.length; receiver++)
					expect(
						samples.filter((sample) => sample.receiver === receiver).length - required(received[receiver]),
						`receiver ${receiver} after transition ${epoch}`
					).toBeGreaterThan(25);
			}
			const phases = [...new Set(attempts.map((sample) => sample.phase))].map((name) => {
				const sent = attempts.filter((sample) => sample.phase === name),
					received = samples.filter((sample) => sample.phase === name);
				return {
					phase: name,
					attempted: sent.length,
					published: sent.filter((sample) => sample.accepted).length,
					rejected: sent.filter((sample) => sample.error).length,
					received: [0, 1].map((receiver) => received.filter((sample) => sample.receiver === receiver).length),
					maxReceiveGapMs: Math.max(0, ...received.map((sample) => sample.gapMs)),
					maxLatencyMs: Math.max(0, ...received.map((sample) => sample.latencyMs)),
					remoteAccepted: remote.filter((sample) => sample.phase === name).length,
				};
			});
			const summary = {
				kind: "summary",
				expectedBlocks: expected.size,
				phases,
				steps,
				timerMaxGapMs: Math.max(...timerGaps),
				eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
				eventLoopMaxMs: eventLoop.max / 1e6,
			};
			record(summary);
			writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
			writeFileSync(
				join(output, "samples.json.gz"),
				gzipSync(JSON.stringify({ attempts, samples, remote, timerGaps }))
			);
		} catch (cause) {
			failure = cause;
			record({ kind: "failure", phase, error: String(cause) });
		} finally {
			if (timer !== undefined) clearInterval(timer);
			await Promise.allSettled([...pendingTicks]);
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			eventLoop.disable();
			profiler?.disconnect();
			const fixtureFailures = await closeFixtures();
			const networkFailures = await network.close();
			if (fixtureFailures.length + networkFailures.length > 0)
				failure = new AggregateError(
					[...(failure === undefined ? [] : [failure]), ...fixtureFailures, ...networkFailures],
					"continued play joined cleanup failed"
				);
		}
		if (failure !== undefined) throw failure;
	},
	300_000
);
