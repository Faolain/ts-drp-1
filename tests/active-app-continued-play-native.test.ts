/* eslint-disable @typescript-eslint/explicit-function-return-type -- Opt-in bounded measurement fixture. */
import type { EphemeralChannel } from "@ts-drp/ephemeral";
import { MessageType } from "@ts-drp/types";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { type Profiler, Session } from "node:inspector";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance as nodePerformance } from "node:perf_hooks";
import { expect, it } from "vitest";

import {
	BoundedObservationLog,
	type GridBlock,
	GridLastValueOracle,
} from "./fixtures/active-endurance/continued-play-observations.js";
import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import {
	creatorDeliveryRoom,
	envelopeDigest,
	envelopeVertex,
	eventually,
	sleep,
} from "./fixtures/track-aa/creator-delivery-room.js";
import {
	closeFixtures,
	directories,
	heads,
	ports,
	required,
	rooms,
} from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery } from "./fixtures/track-m/settlement-room.js";
import { sqliteFileCensus } from "./fixtures/track-m-apps/app-long-room.js";

const enabled = process.env.ACTIVE_CONTINUED_PLAY === "1";
const output = process.env.ACTIVE_CONTINUED_PLAY_OUT ?? join(tmpdir(), `active-continued-play-${Date.now()}`);
const epochs = Number(process.env.ACTIVE_CONTINUED_PLAY_EPOCHS ?? 3);
const warmRows = Number(process.env.ACTIVE_CONTINUED_PLAY_WARM_ROWS ?? 0);
const repairEvery = Number(process.env.ACTIVE_CONTINUED_PLAY_REPAIR_EVERY ?? 25);
const reopenAt = Number(
	process.env.ACTIVE_CONTINUED_PLAY_REOPEN_AT ?? Math.min(30, Math.max(1, Math.floor(epochs / 2)))
);
const requireProgress = process.env.ACTIVE_CONTINUED_PLAY_REQUIRE_PROGRESS === "1";
for (const value of [epochs, repairEvery, reopenAt])
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("CONTINUED_PLAY_POSITIVE_INTEGER");
if (reopenAt > epochs || !Number.isSafeInteger(warmRows) || warmRows < 0)
	throw new Error("CONTINUED_PLAY_CONFIGURATION");
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");

async function joined<Value>(jobs: readonly Promise<Value>[]): Promise<Value[]> {
	const results = await Promise.allSettled(jobs);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	return results.map((result) => (result as PromiseFulfilledResult<Value>).value);
}

function physicalCensus(directory: string) {
	const byFile = readdirSync(directory)
		.sort()
		.flatMap((name) => {
			const path = join(directory, name),
				stat = statSync(path);
			return stat.isFile()
				? [
						{
							name,
							bytes: stat.size,
							kind: name.endsWith("-wal") ? "wal" : name.endsWith("-shm") ? "sharedMemory" : "primaryOrOther",
							tables: name.endsWith(".sqlite") ? sqliteFileCensus(path) : undefined,
						},
					]
				: [];
		});
	return {
		files: byFile.length,
		bytes: byFile.reduce((sum, file) => sum + file.bytes, 0),
		byFile,
		byKind: Object.fromEntries(
			["wal", "sharedMemory", "primaryOrOther"].map((kind) => [
				kind,
				byFile.filter((file) => file.kind === kind).reduce((sum, file) => sum + file.bytes, 0),
			])
		),
	};
}

type Quantum = { started: number; stopped: number; wallMs: number; cpuUserMs: number; cpuSystemMs: number };

it.skipIf(!enabled)(
	"real durable transport conserves bounded Grid state through sustained native transitions",
	async () => {
		mkdirSync(output, { recursive: true });
		const directory = mkdtempSync(join(output, "grid-sqlite-"));
		const record = (value: Readonly<Record<string, unknown>>) =>
			appendFileSync(join(output, "continued-play.jsonl"), JSON.stringify(value) + "\n");
		const observations = new BoundedObservationLog(join(output, "observations.jsonl"));
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
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			epochs,
			warmRows,
			repairEvery,
			reopenAt,
			requireProgress,
			directory,
			durable: "real localhost WebSocket/libp2p, 20ms delayed genuine ingress",
			ephemeral:
				"controlled raw datagrams; production room authority, codec, queue and sequence filter; not real WebRTC or FPS",
			tickIntervalMs: 10,
			offeredHzPerPeer: 100,
			stateSlots: 32,
			slotOwnership: "16 disjoint slots per author",
			successor: "signed native export over scripted chunk/material transport",
			cpuProfiles: process.env.ACTIVE_CONTINUED_PLAY_PROFILE === "1",
			observationBufferLimit: 512,
			rawHistoryLimit: 64,
			taskQuantumHistoryLimit: 256,
		});
		const network = await nativePlayNetwork();
		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		eventLoop.enable();
		const counters = {
			timerCallbacks: 0,
			offered: [0, 0],
			busy: [0, 0],
			unavailable: [0, 0],
			published: [0, 0],
			rejected: [0, 0],
			received: [0, 0],
			remote: [0, 0],
		};
		const phaseStats = new Map<
			string,
			{ received: number[]; remote: number[]; maxReceiveGapMs: number; maxLatencyMs: number }
		>();
		const phases = () => [...phaseStats].map(([phase, stats]) => ({ phase, ...stats }));
		let phase = "startup",
			completedEpochs = 0,
			repaired = 0,
			reopened = 0,
			sequence = 0,
			paused = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		let lastTimer = performance.now(),
			timerMaxGapMs = 0,
			failure: unknown,
			profiler: Session | undefined;
		const pendingTicks = new Set<Promise<void>>(),
			busy = new Set<number>();
		const channels = new Map<number, EphemeralChannel>(),
			subscriptions = new Map<number, () => void>();
		const lastReceived = [0, 0],
			retiredMismatch = [0, 0];
		const oracle = new GridLastValueOracle();
		const count = (values: readonly number[], index: number) => values[index] ?? 0;
		const delta = (after: readonly number[], before: readonly number[]) =>
			after.map((value, index) => value - count(before, index));
		const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
		const phaseStatsFor = () => {
			let stats = phaseStats.get(phase);
			if (stats === undefined) {
				stats = { received: [0, 0], remote: [0, 0], maxReceiveGapMs: 0, maxLatencyMs: 0 };
				phaseStats.set(phase, stats);
			}
			return stats;
		};
		let activeStep:
			| {
					lastAt: number;
					lastCpu: NodeJS.CpuUsage;
					maxTaskGapMs: number;
					maxTaskCpuMs: number;
					quantumCount: number;
					quanta: Quantum[];
			  }
			| undefined;
		const quantum = (at: number, cpu: NodeJS.CpuUsage) => {
			if (activeStep === undefined) return;
			const value = {
				started: activeStep.lastAt,
				stopped: at,
				wallMs: at - activeStep.lastAt,
				cpuUserMs: (cpu.user - activeStep.lastCpu.user) / 1000,
				cpuSystemMs: (cpu.system - activeStep.lastCpu.system) / 1000,
			};
			activeStep.lastAt = at;
			activeStep.lastCpu = cpu;
			activeStep.quantumCount++;
			activeStep.maxTaskGapMs = Math.max(activeStep.maxTaskGapMs, value.wallMs);
			activeStep.maxTaskCpuMs = Math.max(activeStep.maxTaskCpuMs, value.cpuUserMs + value.cpuSystemMs);
			if (activeStep.quanta.length === 256) activeStep.quanta.shift();
			activeStep.quanta.push(value);
			observations.add({ kind: "task-quantum", phase, ...value });
		};
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
				directory,
				network,
				peerIds: network.peerIds,
				onAccepted: (receiver, digest, author) => {
					if (author === fixture.identities[receiver]?.author) return;
					counters.remote[receiver] = count(counters.remote, receiver) + 1;
					const stats = phaseStatsFor();
					stats.remote[receiver] = count(stats.remote, receiver) + 1;
					observations.add({ kind: "remote", phase, at: performance.now(), receiver, digest });
				},
			});
			directories.delete(directory); // Preserve exact native artifacts after joined owner shutdown.
			// Recipient signing is normally first needed by later recovery maintenance.
			// Materialize its empty store during initial setup so even an epoch-1
			// reopen can keep every acquisition strictly noncreating thereafter.
			const recipientSigning = await fixture.host.storageHost.openSealVote("peer-1");
			await recipientSigning.close();
			let peers = [await fixture.open(0), await fixture.open(1)];
			const originalPeerIds = peers.map((peer) => peer.peerId);
			const retireChannel = (index: number) => {
				retiredMismatch[index] = count(retiredMismatch, index) + (channels.get(index)?.stats().authorityMismatch ?? 0);
				subscriptions.get(index)?.();
				subscriptions.delete(index);
				channels.delete(index);
			};
			const mismatch = () =>
				sum(retiredMismatch) +
				[...channels.values()].reduce((total, channel) => total + channel.stats().authorityMismatch, 0);
			const channelFor = (index: number) => {
				const channel = required(peers[index]).room.openEphemeral({
					maxMessageBytes: 512,
					maxSequencedKeys: 1,
					maxSequencedSenders: 2,
				});
				if (channels.get(index) !== channel) {
					retireChannel(index);
					channels.set(index, channel);
					subscriptions.set(
						index,
						channel.subscribe((frame) => {
							const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { sequence: number; sent: number };
							const at = performance.now(),
								gapMs = at - (lastReceived[index] || at),
								latencyMs = at - payload.sent;
							lastReceived[index] = at;
							counters.received[index] = count(counters.received, index) + 1;
							const stats = phaseStatsFor();
							stats.received[index] = count(stats.received, index) + 1;
							stats.maxReceiveGapMs = Math.max(stats.maxReceiveGapMs, gapMs);
							stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs);
							observations.add({
								kind: "receive",
								phase,
								at,
								receiver: index,
								sequence: payload.sequence,
								latencyMs,
								gapMs,
							});
						})
					);
				}
				return channel;
			};
			channelFor(0);
			channelFor(1);
			lastTimer = performance.now();
			timer = setInterval(() => {
				const at = performance.now(),
					gapMs = at - lastTimer,
					cpu = process.cpuUsage();
				lastTimer = at;
				timerMaxGapMs = Math.max(timerMaxGapMs, gapMs);
				counters.timerCallbacks++;
				quantum(at, cpu);
				observations.add({ kind: "timer", phase, at, gapMs, cpu });
				for (let peer = 0; peer < 2; peer++) {
					counters.offered[peer] = count(counters.offered, peer) + 1;
					if (paused || busy.has(peer)) {
						const values = paused ? counters.unavailable : counters.busy;
						values[peer] = count(values, peer) + 1;
						observations.add({ kind: "offer", phase, at, peer, disposition: paused ? "reopen-unavailable" : "busy" });
						continue;
					}
					busy.add(peer);
					const sentSequence = ++sequence;
					const job = (async () => {
						try {
							const accepted = await channelFor(peer).publish({
								class: "unreliable-sequenced",
								key: "movement",
								payload: new TextEncoder().encode(JSON.stringify({ sequence: sentSequence, sent: at })),
							});
							if (accepted) counters.published[peer] = count(counters.published, peer) + 1;
							observations.add({ kind: "offer", phase, at, peer, accepted });
						} catch (cause) {
							counters.rejected[peer] = count(counters.rejected, peer) + 1;
							observations.add({ kind: "offer", phase, at, peer, error: String(cause) });
						}
					})();
					pendingTicks.add(job);
					void job.then(() => {
						pendingTicks.delete(job);
						busy.delete(peer);
					});
				}
			}, 10);
			const issue = async (peer: number, label: string, block = oracle.propose(peer)) => {
				const started = performance.now();
				await required(peers[peer]).room.issue({ action: "placeBlock", ...block });
				oracle.accept(block);
				const stopped = performance.now();
				record({ kind: "issue", phase, peer, label, block, started, stopped, ms: stopped - started });
			};
			const exactState = () => {
				const state = peers.map(({ room }) => [...room.projection().blocks].sort((a, b) => a.id.localeCompare(b.id)));
				for (const [peer, blocks] of state.entries())
					expect(blocks, `exact state peer ${peer} in ${phase}`).toEqual(oracle.state());
				return { expected: oracle.state(), receivers: state };
			};
			const converged = async () => {
				expect(
					await eventually(() => peers.every(({ room }) => oracle.matches(room.projection().blocks)), 20_000),
					`durable convergence in ${phase}`
				).toBe(true);
				return exactState();
			};
			const step = async <Value>(
				name: string,
				work: () => Promise<Value>
			): Promise<{ value: Value; measurement: Readonly<Record<string, unknown>> }> => {
				phase = name;
				const profiled = profiler !== undefined && /^(seal|adopt|install|maintenance)-/.test(name);
				if (profiled)
					await new Promise<void>((resolve, reject) =>
						required(profiler).post("Profiler.start", (error) => (error ? reject(error) : resolve()))
					);
				const started = performance.now(),
					hrtimeStartedUs = Number(process.hrtime.bigint() / 1000n),
					cpuBefore = process.cpuUsage(),
					utilizationBefore = nodePerformance.eventLoopUtilization(),
					ticksBefore = counters.timerCallbacks,
					receivedBefore = [...counters.received],
					remoteBefore = [...counters.remote],
					mismatchBefore = mismatch(),
					authorityEpochsBefore = peers.map(({ room }) => room.authority()?.epoch ?? 0);
				activeStep = {
					lastAt: started,
					lastCpu: cpuBefore,
					maxTaskGapMs: 0,
					maxTaskCpuMs: 0,
					quantumCount: 0,
					quanta: [],
				};
				let measurement: Readonly<Record<string, unknown>> = {};
				let value!: Value;
				try {
					value = await work();
				} finally {
					const stopped = performance.now(),
						cpuAfter = process.cpuUsage();
					quantum(stopped, cpuAfter);
					measurement = {
						kind: "step",
						phase: name,
						started,
						stopped,
						hrtimeStartedUs,
						ms: stopped - started,
						cpuUserMs: (cpuAfter.user - cpuBefore.user) / 1000,
						cpuSystemMs: (cpuAfter.system - cpuBefore.system) / 1000,
						eventLoop: nodePerformance.eventLoopUtilization(utilizationBefore),
						timerCallbacks: counters.timerCallbacks - ticksBefore,
						maxTaskGapMs: activeStep.maxTaskGapMs,
						maxTaskCpuMs: activeStep.maxTaskCpuMs,
						taskQuantumCount: activeStep.quantumCount,
						taskQuanta: activeStep.quanta,
						ephemeralReceivedByPeer: delta(counters.received, receivedBefore),
						ephemeralReceived: sum(delta(counters.received, receivedBefore)),
						remoteAcceptedByPeer: delta(counters.remote, remoteBefore),
						remoteAccepted: sum(delta(counters.remote, remoteBefore)),
						authorityEpochsBefore,
						authorityEpochsAfter: peers.map(({ room }) => room.authority()?.epoch ?? 0),
						authorityMismatch: mismatch() - mismatchBefore,
					};
					activeStep = undefined;
					record(measurement);
					if (profiled) {
						const captured = await new Promise<Profiler.StopReturnType>((resolve, reject) =>
							required(profiler).post("Profiler.stop", (error, result) => (error ? reject(error) : resolve(result)))
						);
						writeFileSync(join(output, `${name}.cpuprofile`), JSON.stringify(captured.profile));
					}
				}
				return { value, measurement };
			};
			const baseline = async (name: string, ms = 1000) => {
				const before = [...counters.received];
				await step(name, () => sleep(ms));
				for (const [peer, received] of delta(counters.received, before).entries())
					expect(received, `receiver ${peer} during ${name}`).toBeGreaterThan(25);
			};
			const automaticRepair = async (epoch: number) => {
				phase = `automatic-repair-${epoch}`;
				const creator = required(peers[0]),
					writer = required(peers[1]),
					block = oracle.propose(1);
				let requests = 0,
					lostGossip = 0,
					lostAnswers = 0,
					missing: string | undefined;
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
					const operation = envelopeVertex(message)?.operation as GridBlock | undefined;
					if (from !== writer.peerId || to !== creator.peerId || operation?.id !== block.id || operation.x !== block.x)
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
				const started = performance.now();
				try {
					await issue(1, `quiet-final-${epoch}`, block);
					expect(
						await eventually(() => missing !== undefined && creator.accepted.has(missing), 20_000),
						`automatic repair exact new digest epoch ${epoch}`
					).toBe(true);
					expect(lostGossip).toBeGreaterThan(0);
					expect(lostAnswers).toBeGreaterThan(0);
					expect(requests).toBeGreaterThan(1);
					await converged();
					repaired++;
					record({
						kind: "automatic-repair",
						epoch,
						ms: performance.now() - started,
						requests,
						lostGossip,
						lostAnswers,
						missing,
						block,
					});
				} finally {
					allow();
					unobserve();
				}
			};
			const flushEpoch = (epoch: number) => {
				observations.flush();
				record({
					kind: "epoch",
					epoch,
					acceptedIssues: oracle.accepted,
					expectedBlocks: oracle.state().length,
					counters,
					phases: phases(),
					nativePhysical: physicalCensus(directory),
					exactState: exactState(),
					load: loadavg(),
					memory: process.memoryUsage(),
					bounded: {
						observationRetained: observations.retained,
						observationHighWater: observations.highWater,
						channels: channels.size,
						fixtureSent: peers.map((peer) => fixture.sentBy(peer.peerId).length),
						accepted: peers.map((peer) => peer.accepted.size),
						raw: network.raw.history(),
						pendingTicks: pendingTicks.size,
						snapshotPorts: ports.size,
					},
					rawSent: network.raw.sent,
					rawRecent: network.raw.sends.map((send) => ({ ...send, bytes: Buffer.from(send.bytes).toString("base64") })),
				});
				fixture.clearObservations();
				phaseStats.clear();
			};
			await step("warm-population", async () => {
				for (let ordinal = 0; ordinal < 16; ordinal++) await joined([issue(0, "warm-slot"), issue(1, "warm-slot")]);
				for (let ordinal = 0; ordinal < warmRows; ordinal++) await issue(1, "extra-census-row");
			});
			await step("warm-convergence", converged);
			for (const [peer, accepted] of counters.remote.entries())
				expect(accepted, `remote admission observer ${peer}`).toBeGreaterThan(0);
			await step("startup-repair-settle", () => sleep(16_000)); // Exhaust startup requests before the periodic-only probe.
			await baseline("baseline-start", 2000);
			await automaticRepair(0);
			flushEpoch(0);
			for (let epoch = 1; epoch <= epochs; epoch++) {
				await baseline(`baseline-before-${epoch}`);
				phase = `transition-${epoch}`;
				const creator = required(peers[0]),
					writer = required(peers[1]);
				const stale = required(network.raw.sends.findLast((send) => send.sender === writer.peerId));
				const started = performance.now(),
					receivedBefore = [...counters.received],
					remoteBefore = [...counters.remote];
				const transitionSteps: Readonly<Record<string, unknown>>[] = [];
				const writes = (async () => {
					for (let ordinal = 0; ordinal < 4; ordinal++) await issue(1, `stream-${epoch}-${ordinal}`);
				})();
				const rollover = (async () => {
					const sealed = await step(`seal-${epoch}`, () => creator.room.sealEpoch());
					transitionSteps.push(sealed.measurement);
					expect(sealed.value).toMatchObject({ ok: true });
					transitionSteps.push((await step(`adopt-${epoch}`, () => creator.room.adoptCreatorSuccessor())).measurement);
					const transfer = (await step(`export-${epoch}`, () => settlementDelivery(fixture))).value;
					Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
					try {
						transitionSteps.push(
							(
								await step(`install-${epoch}`, () =>
									writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers })
								)
							).measurement
						);
					} finally {
						await joined(
							[...ports].map(async (port) => {
								await port.close();
								ports.delete(port);
							})
						);
					}
				})();
				await joined([writes, rollover]);
				if (requireProgress)
					for (const transition of transitionSteps) {
						expect(transition.timerCallbacks, `${transition.phase}: host timer progress`).toBeGreaterThan(0);
						for (const [peer, received] of (transition.ephemeralReceivedByPeer as number[]).entries())
							expect(received, `${transition.phase}: current-authority receive ${peer}`).toBeGreaterThan(0);
					}
				record({
					kind: "transition",
					epoch,
					ms: performance.now() - started,
					ephemeralReceivedByPeer: delta(counters.received, receivedBefore),
					remoteAcceptedByPeer: delta(counters.remote, remoteBefore),
				});
				phase = `settled-${epoch}`;
				await converged();
				channelFor(0);
				channelFor(1);
				const staleReceived = sum(counters.received),
					authorityBefore = required(channels.get(0)).stats().authorityMismatch;
				network.raw.inject(creator.peerId, stale.routeId, writer.peerId, stale.bytes);
				expect(sum(counters.received)).toBe(staleReceived);
				expect(required(channels.get(0)).stats().authorityMismatch).toBe(authorityBefore + 1);
				const maintenanceBefore = [...counters.remote];
				await step(`maintenance-${epoch}`, () =>
					joined([
						joined(peers.map(({ room }) => room.maintainRecoveryPool())).then((results) => {
							record({ kind: "maintenance", epoch, results });
						}),
						issue(0, `maintenance-${epoch}-0`),
						issue(1, `maintenance-${epoch}-1`),
					])
				);
				await converged();
				for (const [peer, accepted] of delta(counters.remote, maintenanceBefore).entries())
					expect(accepted, `remote admission receiver ${peer} after maintenance ${epoch}`).toBeGreaterThan(0);
				if (epoch % repairEvery === 0) {
					// Successor activation also starts repair requests. Exhaust those before
					// claiming that quiet periodic repair recovered the withheld final value.
					await step(`repair-startup-settle-${epoch}`, () => sleep(16_000));
					await automaticRepair(epoch);
				}
				await baseline(`baseline-after-${epoch}`);
				if (epoch === reopenAt) {
					phase = `reopen-${epoch}`;
					const stateBefore = exactState(),
						oldPeers = peers,
						oldChannels = [...channels.values()],
						reopenStarted = performance.now();
					paused = true;
					await joined([...pendingTicks]);
					for (let peer = 0; peer < 2; peer++) retireChannel(peer);
					await joined(
						oldPeers.map(async (peer) => {
							await peer.room.close();
							rooms.delete(peer.room);
							await peer.floor.close();
							heads.delete(peer.floor);
						})
					);
					await network.idle();
					peers = [await fixture.open(0, { reopen: true }), await fixture.open(1, { reopen: true })];
					expect(peers.map((peer) => peer.peerId)).toEqual(originalPeerIds);
					for (let peer = 0; peer < 2; peer++) {
						expect(required(peers[peer]).room).not.toBe(required(oldPeers[peer]).room);
						expect(channelFor(peer)).not.toBe(oldChannels[peer]);
					}
					const stateAfter = exactState();
					paused = false;
					reopened++;
					record({
						kind: "reopen",
						epoch,
						ms: performance.now() - reopenStarted,
						peerIds: originalPeerIds,
						stateBefore,
						stateAfter,
						nativePhysical: physicalCensus(directory),
					});
					await baseline(`baseline-reopened-${epoch}`);
					// Reopen restarts automatic requests; age them out before a later periodic-only loss probe.
					await step(`reopen-startup-settle-${epoch}`, () => sleep(16_000));
				}
				completedEpochs = epoch;
				flushEpoch(epoch);
			}
			expect(counters.rejected, "ephemeral publication exceptions").toEqual([0, 0]);
			record({
				kind: "complete",
				completedEpochs,
				repaired,
				reopened,
				acceptedIssues: oracle.accepted,
				exactState: exactState(),
			});
		} catch (cause) {
			failure = cause;
			record({ kind: "failure", phase, completedEpochs, error: String(cause) });
		} finally {
			if (timer !== undefined) clearInterval(timer);
			await Promise.allSettled([...pendingTicks]);
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			eventLoop.disable();
			profiler?.disconnect();
			const fixtureFailures = await closeFixtures(),
				networkFailures = await network.close();
			if (fixtureFailures.length + networkFailures.length > 0)
				failure = new AggregateError(
					[...(failure === undefined ? [] : [failure]), ...fixtureFailures, ...networkFailures],
					"continued play joined cleanup failed"
				);
			observations.flush();
			const summary = {
				kind: "summary",
				status: failure === undefined ? "passed" : "failed",
				completedEpochs,
				epochs,
				repaired,
				reopened,
				acceptedIssues: oracle.accepted,
				expectedBlocks: oracle.state().length,
				counters,
				timerMaxGapMs,
				eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
				eventLoopMaxMs: eventLoop.max / 1e6,
				observationRows: observations.rows,
				observationFlushes: observations.flushes,
				observationHighWater: observations.highWater,
				raw: network.raw.history(),
				nativeAfterClose: physicalCensus(directory),
			};
			record(summary);
			writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
		}
		if (failure !== undefined) throw failure;
	},
	Math.max(300_000, epochs * 120_000)
);
