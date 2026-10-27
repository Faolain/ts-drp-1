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
import { expect, it, vi } from "vitest";

import {
	BoundedObservationLog,
	DurationDistribution,
	type GridBlock,
	GridLastValueOracle,
} from "./fixtures/active-endurance/continued-play-observations.js";
import { APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS } from "./fixtures/active-endurance/driver.js";
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
import { GRID_ROLLOVER_BUDGET } from "../examples/grid/src/rollover.js";
import {
	createV3RoomRolloverPolicy,
	type V3RoomRolloverEvent,
	type V3RoomRolloverPolicy,
} from "../examples/v3-room/src/rollover.js";
import {
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";
import * as cooperativeWork from "../packages/node/src/internal/cooperative-work.js";

const enabled = process.env.ACTIVE_CONTINUED_PLAY === "1";
const output = process.env.ACTIVE_CONTINUED_PLAY_OUT ?? join(tmpdir(), `active-continued-play-${Date.now()}`);
const sourceRoot = process.env.ACTIVE_CONTINUED_PLAY_SOURCE_ROOT ?? process.cwd();
const epochs = Number(process.env.ACTIVE_CONTINUED_PLAY_EPOCHS ?? 3);
const warmRows = Number(process.env.ACTIVE_CONTINUED_PLAY_WARM_ROWS ?? 0);
const traceWork = process.env.ACTIVE_CONTINUED_PLAY_TRACE_WORK === "1";
const repairEvery = Number(process.env.ACTIVE_CONTINUED_PLAY_REPAIR_EVERY ?? 25);
const reopenAt = Number(
	process.env.ACTIVE_CONTINUED_PLAY_REOPEN_AT ?? Math.min(30, Math.max(1, Math.floor(epochs / 2)))
);
const starvationAlarmMs = Number(process.env.ACTIVE_CONTINUED_PLAY_STARVATION_ALARM_MS ?? 1000);
// "harness" (default): each transition seals, adopts and exports. "app": the creator runs the shipped
// Grid rollover policy (examples/grid/src/rollover.ts); each transition streams Writer moves until the
// creator's policy has rolled the room over. Successor offers travel by the pages' own delivery
// (examples/v3-room successor-delivery) over the genuine libp2p direct streams, and the Writer's
// delivery installs each one with material fetched from the creator over libp2p; harness offer
// passing (settlementDelivery) is refused. ACTIVE_CONTINUED_PLAY_EPOCHS then counts adopted epochs
// (the creator room's authenticated epoch), not transitions.
const rolloverMode = process.env.ACTIVE_CONTINUED_PLAY_ROLLOVER ?? "harness";
if (rolloverMode !== "harness" && rolloverMode !== "app") throw new Error(`CONTINUED_PLAY_ROLLOVER:${rolloverMode}`);
/** Harness mode: Writer moves issued concurrently with each seal, adoption and install. */
const streamMoves = Number(process.env.ACTIVE_CONTINUED_PLAY_STREAM ?? 4);
const convergeMs = Number(process.env.ACTIVE_CONTINUED_PLAY_CONVERGE_MS ?? 20_000);
/** App mode: a transition whose Writer stream has not triggered a rollover after this many moves stranded. */
const APP_ROLLOVER_MAX_MOVES = 64;
/** App mode: the window around each automatic rollover runs from its seal start to this long after adoption. */
const APP_ROLLOVER_WINDOW_TAIL_MS = 1_000;
/**
 * App mode: the most a Writer's issue overlapping a rollover's window may take before it counts as
 * starved; the same bound and reasoning as the endurance driver's APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS.
 */
const memberRolloverIssueBoundMs = Number(
	process.env.ACTIVE_CONTINUED_PLAY_MEMBER_ROLLOVER_ISSUE_BOUND_MS ?? APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS
);
/** App mode: how long the Writer's delivery may take to install the creator's latest successor. */
const APP_DELIVERY_DEADLINE_MS = 60_000;
if (!(memberRolloverIssueBoundMs > 0)) throw new Error("CONTINUED_PLAY_MEMBER_ROLLOVER_ISSUE_BOUND");
if (!Number.isFinite(starvationAlarmMs) || starvationAlarmMs <= 0) throw new Error("CONTINUED_PLAY_STARVATION_ALARM");
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

function worstSummary(values: readonly number[]) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
	return { p50: at(0.5), p95: at(0.95), max: at(1), windows: values.length };
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
			cwd: sourceRoot,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		writeFileSync(join(output, "source.diff"), diff);
		record({
			kind: "configuration",
			sourceRoot,
			sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
			sourceDiffSha256: createHash("sha256").update(diff).digest("hex"),
			load: loadavg(),
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			epochs,
			warmRows,
			traceWork,
			repairEvery,
			reopenAt,
			starvationAlarmMs,
			rollover: rolloverMode,
			...(rolloverMode === "app"
				? {
						epochsCount: "adopted epochs (the creator room's authenticated epoch), not transitions",
						successorOffers:
							"pages' own successor delivery over genuine libp2p direct streams; harness offer passing refused",
						memberRolloverIssueBoundMs,
						rolloverWindowTailMs: APP_ROLLOVER_WINDOW_TAIL_MS,
					}
				: {}),
			starvationAlarmMeaning: "coarse starvation regression only; not a smoothness or real-time completion criterion",
			percentiles: "HDR microseconds, three significant figures; exact observed maxima",
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
			{
				received: number[];
				remote: number[];
				maxReceiveGapMs: number;
				maxLatencyMs: number;
				timerGaps: DurationDistribution;
				receiveGaps: DurationDistribution[];
			}
		>();
		const phases = () =>
			[...phaseStats].map(([phase, stats]) => ({
				phase,
				...stats,
				timerGaps: stats.timerGaps.summary(),
				receiveGaps: stats.receiveGaps.map((value) => value.summary()),
			}));
		const timerGaps = new DurationDistribution(),
			rawReceiveGaps = [new DurationDistribution(), new DurationDistribution()],
			validAuthorityReceiveGaps = [new DurationDistribution(), new DurationDistribution()];
		let receiveWindow:
			| { authorityJsonByPeer: string[]; authorityChanged: boolean; last: number[]; gaps: DurationDistribution[] }
			| undefined;
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
				stats = {
					received: [0, 0],
					remote: [0, 0],
					maxReceiveGapMs: 0,
					maxLatencyMs: 0,
					timerGaps: new DurationDistribution(),
					receiveGaps: [new DurationDistribution(), new DurationDistribution()],
				};
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
					gapDistribution: DurationDistribution;
					cpuDistribution: DurationDistribution;
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
			activeStep.gapDistribution.add(value.wallMs);
			activeStep.cpuDistribution.add(value.cpuUserMs + value.cpuSystemMs);
			activeStep.maxTaskGapMs = Math.max(activeStep.maxTaskGapMs, value.wallMs);
			activeStep.maxTaskCpuMs = Math.max(activeStep.maxTaskCpuMs, value.cpuUserMs + value.cpuSystemMs);
			if (activeStep.quanta.length === 256) activeStep.quanta.shift();
			activeStep.quanta.push(value);
			observations.add({ kind: "task-quantum", phase, ...value });
		};
		let nextWalkId = 0;
		let floorTransitionObservationCount = 0;
		const walks: {
			id: number;
			phase: string;
			calls: number;
			yields: number;
			interiorTimerCallbacks: number;
			interiorReceives: number;
			lastYieldCall: number;
			owner: string[];
		}[] = [];
		const floorTransitionObservations: unknown[] = [];
		const diagnosticRestores: (() => void)[] = [];
		if (traceWork) {
			const originalYield = cooperativeWork.yieldToHost;
			diagnosticRestores.push(
				vi.spyOn(cooperativeWork, "yieldToHost").mockImplementation(() => {
					record({
						kind: "host-yield",
						phase,
						at: performance.now(),
						stack: new Error().stack?.split("\n").slice(2, 8),
					});
					return originalYield();
				}).mockRestore
			);
			const originalFactory = cooperativeWork.createWorkCheckpoint;
			diagnosticRestores.push(
				vi.spyOn(cooperativeWork, "createWorkCheckpoint").mockImplementation(() => {
					const checkpoint = originalFactory();
					const walk = {
						id: nextWalkId++,
						phase,
						calls: 0,
						yields: 0,
						interiorTimerCallbacks: 0,
						interiorReceives: 0,
						lastYieldCall: 0,
						owner: new Error().stack?.split("\n").slice(2, 12) ?? [],
					};
					walks.push(walk);
					return () => {
						walk.calls++;
						const pending = checkpoint();
						if (pending === undefined) return;
						const beforeTicks = counters.timerCallbacks,
							beforeReceives = counters.received.reduce((sum, n) => sum + n, 0),
							at = performance.now();
						walk.yields++;
						walk.lastYieldCall = walk.calls;
						return pending.then(() => {
							const timers = counters.timerCallbacks - beforeTicks,
								receives = counters.received.reduce((sum, n) => sum + n, 0) - beforeReceives;
							if (walk.calls > 1) {
								walk.interiorTimerCallbacks += timers;
								walk.interiorReceives += receives;
							}
							record({
								kind: "census-yield",
								phase,
								walk: walk.id,
								call: walk.calls,
								at,
								resumed: performance.now(),
								timers,
								receives,
							});
						});
					};
				}).mockRestore
			);
		}
		// App mode: the pages' successor delivery for the creator and the Writer, rebound after a
		// reopen, and the real chapters: every automatic rollover by trigger, with the issue-latency
		// window around each one (bounded: windows are evaluated and dropped at each epoch flush).
		const deliveries: (V3RoomSuccessorDelivery | undefined)[] = [undefined, undefined];
		const deliveryRefusals: string[] = [];
		const rolloversByTrigger: Record<string, number> = {};
		const pendingWindows: { closed: number; trigger: string; start: number; end: number; ms: number }[] = [];
		const recentIssues: { peer: number; started: number; stopped: number }[] = [];
		const memberWorstByWindow: number[] = [];
		const creatorWorstByWindow: number[] = [];
		let worstMemberWindow: Readonly<Record<string, unknown>> | undefined;
		let transitions = 0;
		const evaluateWindows = (all = false) => {
			const now = performance.now();
			const ready = pendingWindows.filter((window) => all || window.end + APP_ROLLOVER_WINDOW_TAIL_MS < now);
			for (const window of ready) pendingWindows.splice(pendingWindows.indexOf(window), 1);
			const evaluated = ready.map((window) => {
				const until = window.end + APP_ROLLOVER_WINDOW_TAIL_MS;
				const overlapping = recentIssues.filter((issue) => issue.started <= until && issue.stopped >= window.start);
				const worstMs = [0, 1].map((peer) => {
					const values = overlapping
						.filter((issue) => issue.peer === peer)
						.map((issue) => issue.stopped - issue.started);
					return values.length === 0 ? null : Math.max(...values);
				});
				const issues = [0, 1].map((peer) => overlapping.filter((issue) => issue.peer === peer).length);
				if (worstMs[0] !== null && worstMs[0] !== undefined) creatorWorstByWindow.push(worstMs[0]);
				const member = worstMs[1];
				if (member !== null && member !== undefined) {
					memberWorstByWindow.push(member);
					if (worstMemberWindow === undefined || member > Number(worstMemberWindow.memberWorstMs))
						worstMemberWindow = { ...window, memberWorstMs: member };
				}
				return { ...window, issues, worstMs };
			});
			// Issues older than every window still pending are no longer needed.
			const oldest = Math.min(now - 60_000, ...pendingWindows.map((window) => window.start));
			while (recentIssues.length > 0 && required(recentIssues[0]).stopped < oldest) recentIssues.shift();
			for (const window of evaluated) {
				const member = window.worstMs[1];
				expect(
					member ?? 0,
					`member issue starved around the rollover closing epoch ${window.closed} (bound ${memberRolloverIssueBoundMs} ms)`
				).toBeLessThanOrEqual(memberRolloverIssueBoundMs);
			}
			return evaluated;
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
			// App mode: the creator's rollover policy, rebound after a reopen. Declared before the room
			// fixture so its acceptance observer can feed it.
			let policy: V3RoomRolloverPolicy | undefined;
			const rolloverEvents: V3RoomRolloverEvent[] = [];
			const rolloverErrors: string[] = [];
			const fixture = await creatorDeliveryRoom({
				profile: "settlement",
				directory,
				network,
				peerIds: network.peerIds,
				onAccepted: (receiver, digest, author) => {
					// The creator's policy counts every vertex its room accepts (the shipped page's onAcceptedVertex).
					if (receiver === 0 && policy !== undefined)
						policy.observe({ author, epoch: required(peers[0]).room.authority()?.epoch ?? 0 });
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
			const openPolicy = (): void => {
				if (rolloverMode !== "app") return;
				policy?.close();
				for (const delivery of deliveries) delivery?.close();
				// The pages' delivery on each peer's genuine node; the scripted peer ids are not the
				// object's creator routing hint, so the creator's peer is named.
				const creatorPeer = required(peers[0]).peerId;
				for (let index = 0; index < 2; index++) {
					const delivery = createV3RoomSuccessorDelivery({
						role: index === 0 ? "creator" : "member",
						objectId: fixture.objectId,
						creatorPeer,
						channel: createV3RoomSuccessorChannel(
							network.successorNode(required(peers[index]).peerId),
							fixture.objectId
						),
						hooks: {
							onRefused: (error) => deliveryRefusals.push(String(error)),
						},
					});
					deliveries[index] = delivery;
				}
				policy = createV3RoomRolloverPolicy({
					role: "creator",
					budget: GRID_ROLLOVER_BUDGET,
					hooks: {
						publishSuccessor: (offer, successorEpoch) => required(deliveries[0]).publish(offer, successorEpoch),
						onRollover: (event) => {
							const end = performance.now();
							rolloverEvents.push(event);
							rolloversByTrigger[event.trigger] = (rolloversByTrigger[event.trigger] ?? 0) + 1;
							pendingWindows.push({
								closed: event.epoch,
								trigger: event.trigger,
								start: end - event.ms,
								end,
								ms: event.ms,
							});
						},
						onError: (error) => rolloverErrors.push(String(error)),
					},
				});
				policy.bind(required(peers[0]).room);
				for (let index = 0; index < 2; index++) required(deliveries[index]).bind(required(peers[index]).room);
			};
			// Harness mode only: the harness exports the creator's successor and hands it to the Writer.
			const harnessOffer = () => {
				if (rolloverMode === "app") throw new Error("CONTINUED_PLAY_APP_MODE_HARNESS_OFFER_PASSING");
				return settlementDelivery(fixture);
			};
			// App mode: waits until the Writer's own delivery has installed the creator's epoch.
			const deliveredTo = async (epoch: number) => {
				const deadline = performance.now() + APP_DELIVERY_DEADLINE_MS;
				const writer = () => required(peers[1]).room;
				while ((writer().authority()?.epoch ?? 0) < epoch) {
					if (performance.now() > deadline)
						throw new Error(
							`CONTINUED_PLAY_APP_DELIVERY_STALLED epoch=${epoch} writer=${writer().authority()?.epoch ?? 0} member=${JSON.stringify(deliveries[1]?.stats())} creator=${JSON.stringify(deliveries[0]?.stats())}`
						);
					// The Writer asks for the creator's latest (rate limited) and its install joins.
					deliveries[1]?.request();
					await deliveries[1]?.idle();
					await sleep(20);
				}
			};
			openPolicy();
			const originalPeerIds = peers.map((peer) => peer.peerId);
			const authoritySnapshot = (index: number) => {
				const peer = required(peers[index]),
					channel = required(channels.get(index));
				return {
					localChannelGeneration: required(channel.authorityGeneration?.()),
					successor: peer.room.authority(),
					pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
					latchedAcl: peer.room.previewLatchedAcl(),
				};
			};
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
							required(stats.receiveGaps[index]).add(gapMs);
							required(rawReceiveGaps[index]).add(gapMs);
							if (receiveWindow !== undefined) {
								receiveWindow.authorityChanged ||= peers.some(
									(_peer, peer) => JSON.stringify(authoritySnapshot(peer)) !== receiveWindow?.authorityJsonByPeer[peer]
								);
								const windowGap = at - required(receiveWindow.last[index]);
								receiveWindow.last[index] = at;
								required(receiveWindow.gaps[index]).add(windowGap);
								required(validAuthorityReceiveGaps[index]).add(windowGap);
							}
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
				timerGaps.add(gapMs);
				phaseStatsFor().timerGaps.add(gapMs);
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
							if (traceWork) {
								// The floor and installed E2 authority have distinct lifetimes.
								// Record their relationship without inventing a pending-floor gate.
								const target = required(peers[peer]);
								const native = await target.floor.read({
									scope: {
										objectId: fixture.objectId,
										pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
									},
								});
								const epoch = target.room.authority()?.epoch ?? 0;
								if (
									!native.ok ||
									native.state === null ||
									native.state.pending !== null ||
									native.state.stable.epoch !== epoch
								) {
									floorTransitionObservationCount++;
									if (floorTransitionObservations.length < 8)
										floorTransitionObservations.push({ phase, at: performance.now(), peer, epoch, native });
								}
							}
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
				const operation = { action: "placeBlock", ...block };
				if (peer === 0 && policy !== undefined) await policy.issue(operation);
				else await required(peers[peer]).room.issue(operation);
				oracle.accept(block);
				const stopped = performance.now();
				if (policy !== undefined) recentIssues.push({ peer, started, stopped });
				record({ kind: "issue", phase, peer, label, block, started, stopped, ms: stopped - started });
			};
			const exactState = () => {
				const state = peers.map(({ room }) => [...room.projection().blocks].sort((a, b) => a.id.localeCompare(b.id)));
				for (const [peer, blocks] of state.entries())
					expect(blocks, `exact state peer ${peer} in ${phase}`).toEqual(oracle.state());
				return { expected: oracle.state(), receivers: state };
			};
			const converged = async () => {
				const matches = () => peers.every(({ room }) => oracle.matches(room.projection().blocks));
				let matched: boolean;
				if (policy === undefined) matched = await eventually(matches, convergeMs);
				else {
					// App mode: the Writer's settlement replays its moves into the successor, and the
					// creator's policy may roll over again on them; the Writer follows as a host would.
					const deadline = performance.now() + convergeMs;
					for (let round = 0; ; round++) {
						await followRollover(`${phase}-converge-${round}`);
						matched = await eventually(matches, Math.min(2_000, Math.max(0, deadline - performance.now())));
						if (matched || performance.now() >= deadline) break;
					}
				}
				// A miss reports the exact per-peer difference first.
				if (!matched) exactState();
				expect(matched, `durable convergence in ${phase}`).toBe(true);
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
					gapDistribution: new DurationDistribution(),
					cpuDistribution: new DurationDistribution(),
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
						taskGapDistribution: activeStep.gapDistribution.summary(),
						taskCpuDistribution: activeStep.cpuDistribution.summary(),
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
			const checkStarvation = () => {
				const pendingTimerAgeMs = performance.now() - lastTimer;
				const maximum = Math.max(timerMaxGapMs, pendingTimerAgeMs);
				expect(
					maximum,
					`coarse starvation regression alarm (${starvationAlarmMs} ms; not smoothness)`
				).toBeLessThanOrEqual(starvationAlarmMs);
			};
			const baseline = async (name: string, ms = 1000) => {
				const before = [...counters.received],
					started = performance.now();
				// These windows follow completed public convergence. Each local binding is
				// observed independently; only the room/genesis/ACL scope is comparable.
				exactState();
				const authorities = peers.map((_peer, peer) => authoritySnapshot(peer));
				const scopes = authorities.map(({ successor, pinnedGenesisAnchorDigest, latchedAcl }) => ({
					successor,
					pinnedGenesisAnchorDigest,
					latchedAcl,
				}));
				for (const authority of authorities)
					if (authority.successor !== null) expect(authority.successor.lifecycle).toBe("active");
				expect(scopes[1]).toEqual(scopes[0]);
				for (let peer = 0; peer < 2; peer++)
					expect(required(channels.get(peer)).authorizedPeers()).toContain(required(peers[1 - peer]).peerId);
				const window = {
					authorityJsonByPeer: authorities.map((authority) => JSON.stringify(authority)),
					authorityChanged: false,
					last: [started, started],
					gaps: [new DurationDistribution(), new DurationDistribution()],
				};
				receiveWindow = window;
				try {
					await step(name, () => sleep(ms));
				} finally {
					receiveWindow = undefined;
					const stopped = performance.now();
					for (let peer = 0; peer < 2; peer++) {
						const tail = stopped - required(window.last[peer]);
						required(window.gaps[peer]).add(tail);
						required(validAuthorityReceiveGaps[peer]).add(tail);
					}
					record({
						kind: "valid-authority-receive-window",
						phase: name,
						started,
						stopped,
						publicScope: scopes[0],
						localAuthorityObservations: authorities,
						authorityChanged: window.authorityChanged,
						receivedByPeer: delta(counters.received, before),
						gapsIncludingWindowBoundariesByPeer: window.gaps.map((gap) => gap.summary()),
					});
				}
				expect(window.authorityChanged, `stable authority during ${name}`).toBe(false);
				for (let peer = 0; peer < 2; peer++) expect(authoritySnapshot(peer)).toEqual(authorities[peer]);
				exactState();
				for (const [peer, received] of delta(counters.received, before).entries())
					expect(received, `receiver ${peer} during ${name}`).toBeGreaterThan(25);
				checkStarvation();
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
				checkStarvation();
				fixture.clearObservations();
				phaseStats.clear();
			};
			// App mode, outside a transition: a rollover the creator's policy started joins and the Writer's
			// own delivery installs it (one at a time: each move pair is followed before the next).
			const followRollover = async (label: string): Promise<void> => {
				if (policy === undefined) return;
				await policy.settled();
				expect(rolloverErrors).toEqual([]);
				const creator = required(peers[0]),
					writer = required(peers[1]);
				if ((writer.room.authority()?.epoch ?? 0) >= (creator.room.authority()?.epoch ?? 0)) return;
				// Called inside a step (steps do not nest), so it times itself.
				const started = performance.now();
				await deliveredTo(creator.room.authority()?.epoch ?? 0);
				expect(writer.room.authority()?.epoch).toBe(creator.room.authority()?.epoch);
				record({ kind: "app-follow", label, ms: performance.now() - started, rollovers: rolloverEvents.splice(0) });
			};
			await step("warm-population", async () => {
				for (let ordinal = 0; ordinal < 16; ordinal++) {
					await joined([issue(0, "warm-slot"), issue(1, "warm-slot")]);
					await followRollover(`warm-${ordinal}`);
				}
				for (let ordinal = 0; ordinal < warmRows; ordinal++) {
					await issue(1, "extra-census-row");
					await followRollover(`warm-row-${ordinal}`);
				}
			});
			await step("warm-convergence", converged);
			for (const [peer, accepted] of counters.remote.entries())
				expect(accepted, `remote admission observer ${peer}`).toBeGreaterThan(0);
			await step("startup-repair-settle", () => sleep(16_000)); // Exhaust startup requests before the periodic-only probe.
			await baseline("baseline-start", 2000);
			await automaticRepair(0);
			flushEpoch(0);
			const adoptedEpochs = () => required(peers[0]).room.authority()?.epoch ?? 0;
			let reopenDone = false;
			// Harness mode: one transition per epoch. App mode: transitions until `epochs` epochs were
			// adopted (warm-up and maintenance rollovers count; they are real chapters too).
			for (let epoch = 1; rolloverMode === "app" ? adoptedEpochs() < epochs : epoch <= epochs; epoch++) {
				transitions = epoch;
				await baseline(`baseline-before-${epoch}`);
				phase = `transition-${epoch}`;
				const creator = required(peers[0]),
					writer = required(peers[1]);
				const stale = required(network.raw.sends.findLast((send) => send.sender === writer.peerId));
				const started = performance.now(),
					receivedBefore = [...counters.received],
					remoteBefore = [...counters.remote];
				const closing = creator.room.authority()?.epoch ?? 0;
				const writes = (async () => {
					if (rolloverMode === "app") {
						// Until the creator's own policy has counted its budget (then its rollover runs while
						// the Writer's last moves are in flight) or has already adopted a successor.
						const counting = required(policy);
						for (
							let ordinal = 0;
							(creator.room.authority()?.epoch ?? 0) === closing &&
							counting.stats().moves < GRID_ROLLOVER_BUDGET.movesPerAuthor;
							ordinal++
						) {
							if (ordinal >= APP_ROLLOVER_MAX_MOVES) throw new Error("CONTINUED_PLAY_APP_ROLLOVER_NOT_TRIGGERED");
							await issue(1, `stream-${epoch}-${ordinal}`);
						}
						// The Writer keeps playing while the creator's rollover runs (as harness mode streams
						// moves through seal, adoption and install), so its issue latency around the rollover
						// is measured (evaluateWindows), up to the harness stream's length.
						const settling = counting.settled();
						let rolled = false;
						void settling.then(
							() => (rolled = true),
							() => (rolled = true)
						);
						for (let extra = 0; !rolled && extra < streamMoves; extra++)
							await issue(1, `stream-${epoch}-during-${extra}`);
						await settling;
						if ((creator.room.authority()?.epoch ?? 0) === closing)
							throw new Error("CONTINUED_PLAY_APP_ROLLOVER_NOT_TRIGGERED");
						return;
					}
					for (let ordinal = 0; ordinal < streamMoves; ordinal++) await issue(1, `stream-${epoch}-${ordinal}`);
				})();
				const rollover = (async () => {
					if (rolloverMode === "app") {
						await writes;
						await step(`policy-rollover-${epoch}`, () => required(policy).settled());
						expect(rolloverErrors).toEqual([]);
					} else {
						const sealed = await step(`seal-${epoch}`, () => creator.room.sealEpoch());
						expect(sealed.value).toMatchObject({ ok: true });
						await step(`adopt-${epoch}`, () => creator.room.adoptCreatorSuccessor());
					}
					if (rolloverMode === "app") {
						// The creator's delivery announced the offer; the Writer's delivery installs it.
						await step(`install-${epoch}`, () => deliveredTo(creator.room.authority()?.epoch ?? 0));
						return;
					}
					const transfer = (await step(`export-${epoch}`, () => harnessOffer())).value;
					Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
					try {
						await step(`install-${epoch}`, () =>
							writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers })
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
				record({
					kind: "transition",
					epoch,
					ms: performance.now() - started,
					...(rolloverMode === "app" ? { rollovers: rolloverEvents.splice(0) } : {}),
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
				await followRollover(`maintenance-${epoch}`);
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
				if (rolloverMode === "app" ? !reopenDone && adoptedEpochs() >= reopenAt : epoch === reopenAt) {
					reopenDone = true;
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
					openPolicy();
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
				for (const walk of walks.splice(0)) record({ kind: "cooperative-walk", ...walk });
				completedEpochs = rolloverMode === "app" ? adoptedEpochs() : epoch;
				if (rolloverMode === "app")
					record({
						kind: "chapters",
						transition: epoch,
						adoptedEpochs: adoptedEpochs(),
						writerEpoch: required(peers[1]).room.authority()?.epoch ?? 0,
						rolloversByTrigger: { ...rolloversByTrigger },
						rolloverWindows: evaluateWindows(),
					});
				flushEpoch(epoch);
			}
			if (rolloverMode === "app") record({ kind: "rollover-windows", rolloverWindows: evaluateWindows(true) });
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
			for (const delivery of deliveries) delivery?.close();
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
			for (const restore of diagnosticRestores) restore();
			for (const walk of walks.splice(0)) record({ kind: "cooperative-walk", ...walk });
			observations.flush();
			const summary = {
				floorTransitionObservationCount,
				floorTransitionObservations,
				kind: "summary",
				status: failure === undefined ? "passed" : "failed",
				completedEpochs,
				epochs,
				...(rolloverMode === "app"
					? {
							chapters: {
								target: epochs,
								adoptedEpochs: completedEpochs,
								transitions,
								rolloversByTrigger,
								rolloversTotal: Object.values(rolloversByTrigger).reduce((total, value) => total + value, 0),
							},
							rolloverIssueWorstMs: {
								creator: worstSummary(creatorWorstByWindow),
								member: worstSummary(memberWorstByWindow),
								worstMemberWindow,
								memberBoundMs: memberRolloverIssueBoundMs,
								windowTailMs: APP_ROLLOVER_WINDOW_TAIL_MS,
							},
							successorDelivery: {
								creator: deliveries[0]?.stats(),
								member: deliveries[1]?.stats(),
								refusals: deliveryRefusals.slice(-8),
								refusalCount: deliveryRefusals.length,
							},
						}
					: {}),
				repaired,
				reopened,
				acceptedIssues: oracle.accepted,
				expectedBlocks: oracle.state().length,
				counters,
				timerMaxGapMs,
				timerGapDistribution: timerGaps.summary(),
				rawReceiveGapDistributionByPeer: rawReceiveGaps.map((gap) => gap.summary()),
				validAuthorityReceiveGapsIncludingWindowBoundariesByPeer: validAuthorityReceiveGaps.map((gap) => gap.summary()),
				starvationAlarmMs,
				starvationAlarmMeaning: "coarse regression only; not smoothness or real-time completion",
				eventLoopP95Ms: eventLoop.percentile(95) / 1e6,
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
