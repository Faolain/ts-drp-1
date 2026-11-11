/* eslint-disable @typescript-eslint/explicit-function-return-type -- Opt-in measurement harness; native capability inference. */
// Real-time scorecard: a fixed offered durable move rate through the shipped Grid rollover policy.
//
// One creator and SCORECARD_WRITERS Writers of a settlement-profile Grid zone room on native SQLite,
// every peer on a genuine libp2p node (localhost WebSocket, full mesh, 20 ms delayed ingress) with the
// production room transport. Every peer runs the page's own composition: the shipped rollover policy
// (GRID_ROLLOVER_BUDGET; creator seals/adopts/exports, Writers re-offer refused moves) and the page's
// successor delivery. Nothing here seals, installs or replays by hand. The driver offers moves at a fixed
// total rate (round robin over the peers), never waiting for earlier moves, and measures:
//   - each move's local issue latency (the policy's issue promise) and its outcome / refusal class;
//   - the creator's admission of each Writer move and every other peer's acceptance (offer -> accepted);
//   - every rollover's seal / adoption / export / publish and each Writer's install (authority change);
//   - 10 ms timer gaps and event-loop utilisation by phase; optional ephemeral movement at a fixed Hz.
// HARNESS LIMIT: all peers share ONE single-threaded Node process, so CPU of the creator and of every
// Writer adds up on one event loop; on separate devices each peer would only pay its own share.
import type { EphemeralChannel } from "@ts-drp/ephemeral";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { type Profiler, Session } from "node:inspector";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, join as join_ } from "node:path";
import { monitorEventLoopDelay, performance as nodePerformance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";

import { DurationDistribution } from "./fixtures/active-endurance/continued-play-observations.js";
import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import { creatorDeliveryRoom, sleep } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, directories, required } from "./fixtures/track-m/room-retention-fixture.js";
import * as scheduledLullModule from "../packages/node/src/internal/recovery-pool-scheduled.js";

const originalFactory = scheduledLullModule.createScheduledRecoveryPoolLull;
import { GRID_ROLLOVER_BUDGET } from "../examples/grid/src/rollover.js";
import { createV3RoomRolloverPolicy, type V3RoomRolloverPolicy } from "../examples/v3-room/src/rollover.js";
import {
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";

const env = process.env;
const enabled = env.SCORECARD === "1";
const output = env.SCORECARD_OUT ?? join(tmpdir(), `realtime-scorecard-${Date.now()}`);
const writers = Number(env.SCORECARD_WRITERS ?? 3);
const offeredOps = Number(env.SCORECARD_OPS ?? 5);
const targetRollovers = Number(env.SCORECARD_ROLLOVERS ?? 40);
const maxSeconds = Number(env.SCORECARD_MAX_S ?? 900);
const burstOps = Number(env.SCORECARD_BURST_OPS ?? 0);
const burstSeconds = Number(env.SCORECARD_BURST_S ?? 10);
const burstAtSeconds = Number(env.SCORECARD_BURST_AT_S ?? 60);
const ephemeralHz = Number(env.SCORECARD_EPHEMERAL_HZ ?? 0);
const ephemeralOnlySeconds = Number(env.SCORECARD_EPHEMERAL_ONLY_S ?? (ephemeralHz > 0 ? 10 : 0));
const lull = env.SCORECARD_LULL ?? "scheduled";
const slots = Number(env.SCORECARD_SLOTS ?? 16);
const cpuProfileSeconds = Number(env.SCORECARD_CPU_PROFILE_S ?? 0);
const cpuProfileAtSeconds = Number(env.SCORECARD_CPU_PROFILE_AT_S ?? 30);
const netDelayMs = Number(env.SCORECARD_NET_DELAY_MS ?? 20);
const drainSeconds = Number(env.SCORECARD_DRAIN_S ?? 180);
// Cold join / zone enter: extra roster Writers (in the genesis ACL) whose room is first opened, on empty
// storage, once this many rollovers have completed; each is timed to its install and first issued move.
const lateJoins = (env.SCORECARD_LATE_JOINS ?? "")
	.split(",")
	.filter((value) => value.trim() !== "")
	.map(Number);
if (!["scheduled", "none"].includes(lull)) throw new Error(`SCORECARD_LULL:${lull}`);
for (const value of [writers, targetRollovers, maxSeconds, slots])
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("SCORECARD_POSITIVE_INTEGER");
if (!(offeredOps >= 0)) throw new Error("SCORECARD_OPS");

const TICK_MS = 10;
const FRAME_MS = 1000 / 60;
const LONG_EPHEMERAL_GAP_MS = 100;

const q = (sorted: readonly number[], p: number) =>
	sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null);
function percentiles(values: readonly number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: q(sorted, 0.5),
		p95: q(sorted, 0.95),
		p99: q(sorted, 0.99),
		max: sorted.length === 0 ? null : sorted[sorted.length - 1],
	};
}
function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}${error.cause ? ` <- ${errorText(error.cause)}` : ""}`;
	return String(error);
}
function refusalClass(error: unknown): string {
	const name = error instanceof Error ? error.name : "";
	const text = errorText(error);
	for (const known of [
		"V3RoomNotReachingHost",
		"V3RoomSuccessorUnavailable",
		"V3RoomReadOnly",
		"V3RoomLocalBacklogFull",
		"close-pending",
		"not-active",
		"MAINTENANCE_",
		"proof capacity refused",
		"not yet current",
	])
		if (name === known || text.includes(known)) return known;
	return text.slice(0, 160);
}

interface IssueRecord {
	peer: number;
	slot: number;
	seq: number;
	key: string;
	offeredAt: number;
	completedAt?: number;
	outcome?: string;
	epochAtOffer: number;
	creatorAdmittedAt?: number;
	acceptedBy: Record<number, number>;
}
interface RolloverRecord {
	closing: number;
	successorEpoch?: number;
	trigger?: string;
	sealStart: number;
	sealEnd?: number;
	adoptEnd?: number;
	exportEnd?: number;
	publishEnd?: number;
	installedAt: Record<number, number>;
}

it.skipIf(!enabled)(
	"realtime scorecard: fixed-rate durable Grid play through the shipped rollover policy",
	async () => {
		mkdirSync(output, { recursive: true });
		const directory = mkdtempSync(join(output, "grid-sqlite-"));
		const record = (value: Readonly<Record<string, unknown>>) =>
			appendFileSync(join(output, "scorecard.jsonl"), JSON.stringify(value) + "\n");
		const peersCount = writers + 1;
		const totalPeers = peersCount + lateJoins.length;
		const configuration = {
			kind: "configuration",
			sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			writers,
			peers: peersCount,
			offeredOps,
			targetRollovers,
			maxSeconds,
			burst: burstOps > 0 ? { ops: burstOps, seconds: burstSeconds, atSeconds: burstAtSeconds } : null,
			ephemeralHz,
			ephemeralOnlySeconds,
			lateJoins,
			lull,
			slotsPerAuthor: slots,
			netDelayMs,
			budget: GRID_ROLLOVER_BUDGET,
			profile: "creator-trusted-settlement-v1",
			directory,
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			load: loadavg(),
			harnessLimit: "creator and every Writer share one single-threaded Node process",
		};
		record(configuration);
		const network = await nativePlayNetwork(netDelayMs, totalPeers);
		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		const issues: IssueRecord[] = [];
		const byKey = new Map<string, IssueRecord>();
		const rollovers: RolloverRecord[] = [];
		const authorityChanges: { peer: number; epoch: number; at: number }[] = [];
		const refusals: Record<string, number> = {};
		const errors: string[] = [];
		const deliveryRefusals: string[] = [];
		const backlogSkips = Array.from({ length: peersCount }, () => 0);
		const uncertainSlots = new Set<string>();
		const latest = new Map<string, { id: string; kind: string; x: number; y: number }>();
		let acceptedVertexCount = 0;
		let censusWindow: Record<string, number> | undefined;
		const windowCensus: Record<string, Record<string, number>> = {};
		let lullActive = 0;
		let lullRuns = 0;
		const lullSpans: { peer: number; start: number; end: number; result: string }[] = [];
		// The session is frozen; its scheduled lull is observed through the lull factory instead.
		const lullSpy = vi
			.spyOn(scheduledLullModule, "createScheduledRecoveryPoolLull")
			.mockImplementation((input) => {
				const original = originalFactory(input);
				return Object.freeze({
					...original,
					run: async (scheduled: boolean, run: () => Promise<never>) => {
						const start = performance.now();
						lullActive++;
						lullRuns++;
						let result = "error";
						try {
							const value = await original.run(scheduled, run);
							result = `${scheduled ? "scheduled" : "explicit"}:${String((value as { kind?: string }).kind)}`;
							return value;
						} finally {
							lullActive--;
							lullSpans.push({ peer: -1, start, end: performance.now(), result });
						}
					},
				}) as never;
			});
		let creatorStage: "idle" | "seal" | "adopt" | "export" | "publish" = "idle";
		let policies: (V3RoomRolloverPolicy | undefined)[] = [];
		const deliveries: (V3RoomSuccessorDelivery | undefined)[] = [];
		const epochOf: number[] = Array.from({ length: totalPeers }, () => 0);
		const joins: Record<string, unknown>[] = [];
		const t0 = performance.now();
		let failure: unknown;
		let timer: ReturnType<typeof setInterval> | undefined;
		let profiler: Session | undefined;
		const fixture = await creatorDeliveryRoom({
			profile: "settlement",
			directory,
			network: network as never,
			peerIds: network.peerIds,
			writers: writers + lateJoins.length,
			...(lull === "scheduled" ? { sessionOptions: { recoveryPoolScheduledLull: true } } : {}),
			onAccepted: (receiver, _digest, author, vertex) => {
				acceptedVertexCount++;
				const at = performance.now();
				if (censusWindow !== undefined) {
					const action = `${receiver}:${String((vertex?.operation as { action?: string } | undefined)?.action)}`;
					censusWindow[action] = (censusWindow[action] ?? 0) + 1;
				}
				if (vertex !== undefined) policies[receiver]?.observe({ ...(vertex as object), author, epoch: vertex.epoch } as never);
				const operation = vertex?.operation as { action?: string; id?: string; x?: number } | undefined;
				if (operation?.action !== "placeBlock") return;
				const issue = byKey.get(`${operation.id}:${operation.x}`);
				if (issue === undefined || issue.peer === receiver || issue.acceptedBy[receiver] !== undefined) return;
				if (receiver >= peersCount) return;
				issue.acceptedBy[receiver] = at;
				if (receiver === 0) issue.creatorAdmittedAt = at;
			},
		});
		directories.delete(directory);
		const peers: Awaited<ReturnType<typeof fixture.open>>[] = [];
		for (let index = 0; index < peersCount; index++) peers.push(await fixture.open(index));
		const openedCount = () => peers.length;
		const creatorPeer = required(peers[0]).peerId;
		// The page's composition on every peer: successor delivery and the shipped rollover policy.
		const timed =
			(name: "seal" | "adopt" | "export", work: () => Promise<unknown>) =>
			async (): Promise<never> => {
				creatorStage = name;
				const now = performance.now();
				if (name === "seal") rollovers.push({ closing: epochOf[0] ?? 0, sealStart: now, installedAt: {} });
				const current = required(rollovers.at(-1));
				try {
					return (await work()) as never;
				} finally {
					const end = performance.now();
					if (name === "seal") current.sealEnd = end;
					if (name === "adopt") current.adoptEnd = end;
					if (name === "export") {
						current.exportEnd = end;
						creatorStage = "publish";
					} else creatorStage = name === "seal" ? "adopt" : "export";
				}
			};
		const compose = (peer: (typeof peers)[number], index: number) => {
			const role = index === 0 ? "creator" : "member";
			const delivery = createV3RoomSuccessorDelivery({
				role,
				objectId: fixture.objectId,
				creatorPeer,
				channel: createV3RoomSuccessorChannel(network.successorNode(peer.peerId), fixture.objectId),
				hooks: { onRefused: (error) => deliveryRefusals.push(errorText(error)) },
			});
			deliveries[index] = delivery;
			const room = peer.room;
			const policy = createV3RoomRolloverPolicy({
				role,
				budget: GRID_ROLLOVER_BUDGET,
				hooks: {
					publishSuccessor: async (offer, successorEpoch) => {
						try {
							await delivery.publish(offer, successorEpoch);
						} finally {
							const current = rollovers.at(-1);
							if (current !== undefined) current.publishEnd = performance.now();
							creatorStage = "idle";
						}
					},
					requestSuccessor: () => delivery.request(),
					creatorReachable: () => delivery.creatorReachable(),
					onRollover: (event) => {
						const current = rollovers.at(-1);
						if (current !== undefined) {
							current.successorEpoch = event.successorEpoch;
							current.trigger = event.trigger;
							current.closing = event.epoch;
						}
					},
					onError: (error) => errors.push(errorText(error)),
				},
			});
			const bound =
				index === 0
					? {
							authority: () => room.authority(),
							issue: (operation: Readonly<Record<string, unknown>>, options?: never) => room.issue(operation, options),
							settlementStatus: () => room.settlementStatus(),
							sealEpoch: timed("seal", () => room.sealEpoch()),
							adoptCreatorSuccessor: timed("adopt", () => room.adoptCreatorSuccessor()),
							exportCreatorSuccessor: timed("export", () => room.exportCreatorSuccessor()),
						}
					: room;
			policy.bind(bound as never);
			delivery.bind(room);
			return policy;
		};
		policies = peers.map((peer, index) => compose(peer, index));
		// Ephemeral movement channels (re-read every tick: a room may hand out a new channel).
		const channels = new Map<number, EphemeralChannel>();
		const unsubscribe = new Map<number, () => void>();
		const ephemeral = {
			published: Array.from({ length: peersCount }, () => 0),
			publishRefused: Array.from({ length: peersCount }, () => 0),
			publishErrors: 0,
			received: Array.from({ length: peersCount }, () => Array.from({ length: peersCount }, () => 0)),
			last: Array.from({ length: peersCount }, () => Array.from({ length: peersCount }, () => 0)),
			latency: new DurationDistribution(),
			latencyValues: [] as number[],
			gaps: new DurationDistribution(),
			gapsByPhase: new Map<string, DurationDistribution>(),
			longGaps: [] as Record<string, unknown>[],
			longGapCount: 0,
			durableVerticesDuringEphemeralOnly: null as number | null,
		};
		let phaseNow = "startup";
		const phase = () => {
			if (creatorStage !== "idle") return creatorStage;
			const creatorEpoch = epochOf[0] ?? 0;
			if (epochOf.slice(0, openedCount()).some((epoch) => epoch < creatorEpoch)) return "install";
			if (lullActive > 0) return "lull";
			return "steady";
		};
		const channelFor = (index: number) => {
			const channel = required(peers[index]).room.openEphemeral({
				maxMessageBytes: 512,
				maxSequencedKeys: 1,
				maxSequencedSenders: peersCount,
			});
			if (channels.get(index) !== channel) {
				unsubscribe.get(index)?.();
				channels.set(index, channel);
				unsubscribe.set(
					index,
					channel.subscribe((frame) => {
						const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { s: number; t: number };
						const at = performance.now();
						const latency = at - payload.t;
						ephemeral.latency.add(latency);
						if (ephemeral.latencyValues.length < 400_000) ephemeral.latencyValues.push(latency);
						const row = required(ephemeral.received[index]);
						row[payload.s] = (row[payload.s] ?? 0) + 1;
						const lastRow = required(ephemeral.last[index]);
						const previous = lastRow[payload.s] ?? 0;
						lastRow[payload.s] = at;
						if (previous > 0) {
							const gap = at - previous;
							ephemeral.gaps.add(gap);
							const name = phaseNow;
							let distribution = ephemeral.gapsByPhase.get(name);
							if (distribution === undefined) ephemeral.gapsByPhase.set(name, (distribution = new DurationDistribution()));
							distribution.add(gap);
							if (gap > LONG_EPHEMERAL_GAP_MS) {
								ephemeral.longGapCount++;
								if (ephemeral.longGaps.length < 2000)
									ephemeral.longGaps.push({ receiver: index, sender: payload.s, from: previous, to: at, gap, phaseAtEnd: name, epochs: [...epochOf] });
							}
						}
					})
				);
			}
			return channel;
		};
		if (ephemeralHz > 0) for (let index = 0; index < peersCount; index++) channelFor(index);
		// Timer: offers durable moves at the configured rate, ephemeral frames at the configured Hz,
		// tracks authority changes, timer gaps and event-loop utilisation by phase.
		const timerGaps = new DurationDistribution();
		const timerGapsByPhase = new Map<string, DurationDistribution>();
		const frameBusy: number[] = [];
		const frameBusyByPhase = new Map<string, number[]>();
		const phaseTime = new Map<string, number>();
		let lastTick = performance.now();
		let lastElu = nodePerformance.eventLoopUtilization();
		let durableStart = Number.POSITIVE_INFINITY;
		let durableStop = Number.POSITIVE_INFINITY;
		let durableCredit = 0;
		const ephemeralCredit = Array.from({ length: peersCount }, () => 0);
		const nextSeq = Array.from({ length: peersCount }, () => 0);
		const busySlots = Array.from({ length: peersCount }, () => new Set<number>());
		let roundRobin = 0;
		let ephemeralSequence = 0;
		let offering = true;
		const offer = (peer: number) => {
			let slot = -1;
			for (let candidate = 0; candidate < slots; candidate++) {
				const index = (nextSeq[peer]! + candidate) % slots;
				if (!required(busySlots[peer]).has(index) && !uncertainSlots.has(`slot-${peer}-${index}`)) {
					slot = index;
					break;
				}
			}
			if (slot < 0) {
				backlogSkips[peer] = (backlogSkips[peer] ?? 0) + 1;
				return;
			}
			const seq = nextSeq[peer]!;
			nextSeq[peer] = seq + 1;
			const block = Object.freeze({ id: `slot-${peer}-${slot}`, kind: "stone", x: seq, y: peer });
			const issue: IssueRecord = {
				peer,
				slot,
				seq,
				key: `${block.id}:${seq}`,
				offeredAt: performance.now(),
				epochAtOffer: epochOf[peer] ?? 0,
				acceptedBy: {},
			};
			issues.push(issue);
			byKey.set(issue.key, issue);
			required(busySlots[peer]).add(slot);
			required(policies[peer])
				.issue({ action: "placeBlock", ...block })
				.then(
					() => {
						issue.outcome = "accepted";
						const previous = latest.get(block.id);
						if (previous === undefined || previous.x < block.x) latest.set(block.id, block);
					},
					(error: unknown) => {
						issue.outcome = refusalClass(error);
						refusals[issue.outcome] = (refusals[issue.outcome] ?? 0) + 1;
						// A refused move may be kept and offered again later by the policy: its slot is no longer exact.
						uncertainSlots.add(block.id);
						if (errors.length < 200) errors.push(`issue ${issue.key}: ${errorText(error)}`);
					}
				)
				.finally(() => {
					issue.completedAt = performance.now();
					required(busySlots[peer]).delete(slot);
				});
		};
		eventLoop.enable();
		timer = setInterval(() => {
			const at = performance.now();
			const gap = at - lastTick;
			lastTick = at;
			const elu = nodePerformance.eventLoopUtilization(lastElu);
			lastElu = nodePerformance.eventLoopUtilization();
			for (let index = 0; index < openedCount(); index++) {
				const epoch = required(peers[index]).room.authority()?.epoch ?? 0;
				if (epoch !== epochOf[index]) {
					epochOf[index] = epoch;
					authorityChanges.push({ peer: index, epoch, at });
				}
			}
			const name = phase();
			phaseNow = name;
			timerGaps.add(gap);
			let distribution = timerGapsByPhase.get(name);
			if (distribution === undefined) timerGapsByPhase.set(name, (distribution = new DurationDistribution()));
			distribution.add(gap);
			phaseTime.set(name, (phaseTime.get(name) ?? 0) + gap);
			// Busy main-thread ms per 60 Hz frame (estimate): the interval's utilisation times a frame,
			// a whole frame when one task spanned more than a frame.
			const busy = gap > FRAME_MS ? FRAME_MS : elu.utilization * FRAME_MS;
			frameBusy.push(busy);
			let byPhase = frameBusyByPhase.get(name);
			if (byPhase === undefined) frameBusyByPhase.set(name, (byPhase = []));
			byPhase.push(busy);
			if (ephemeralHz > 0 && offering)
				for (let index = 0; index < peersCount; index++) {
					ephemeralCredit[index] = (ephemeralCredit[index] ?? 0) + (gap * ephemeralHz) / 1000;
					if ((ephemeralCredit[index] ?? 0) < 1) continue;
					// Unreliable sequenced: a frame that waited past the next one is superseded; one per tick.
					ephemeralCredit[index] = Math.min(1, (ephemeralCredit[index] ?? 0) - 1);
					const channel = channelFor(index);
					const sent = ++ephemeralSequence;
					channel
						.publish({
							class: "unreliable-sequenced",
							key: "movement",
							payload: new TextEncoder().encode(JSON.stringify({ s: index, q: sent, t: at })),
						})
						.then(
							(ok) => {
								if (ok) ephemeral.published[index] = (ephemeral.published[index] ?? 0) + 1;
								else ephemeral.publishRefused[index] = (ephemeral.publishRefused[index] ?? 0) + 1;
							},
							() => {
								ephemeral.publishErrors++;
							}
						);
				}
			if (offering && at >= durableStart && at < durableStop) {
				const elapsed = (at - durableStart) / 1000;
				const rate =
					burstOps > 0 && elapsed >= burstAtSeconds && elapsed < burstAtSeconds + burstSeconds ? burstOps : offeredOps;
				durableCredit += (gap * rate) / 1000;
				while (durableCredit >= 1) {
					durableCredit -= 1;
					offer(roundRobin % peersCount);
					roundRobin++;
				}
			}
		}, TICK_MS);
		const progress = setInterval(() => {
			const accepted = issues.filter((issue) => issue.outcome === "accepted").length;
			const outstanding = issues.filter((issue) => issue.completedAt === undefined).length;
			console.log(
				`SCORECARD ${Math.round((performance.now() - t0) / 1000)}s offered=${issues.length} accepted=${accepted} outstanding=${outstanding} rollovers=${rollovers.filter((r) => r.publishEnd !== undefined).length} epochs=${epochOf.join(",")} refusals=${JSON.stringify(refusals)} skips=${backlogSkips.join(",")} errors=${errors.length}`
			);
		}, 30_000);
		let measuredFrom = 0;
		let measuredTo = 0;
		let converged: Record<string, unknown> = {};
		try {
			if (ephemeralHz > 0 && ephemeralOnlySeconds > 0) {
				// Control first: the same length with no traffic at all (startup rows still settling), then
				// ephemeral movement only. Every accepted vertex in each window is counted by action.
				offering = false;
				phaseNow = "quiet-control";
				censusWindow = {};
				await sleep(ephemeralOnlySeconds * 1000);
				windowCensus.quietControl = censusWindow;
				offering = true;
				phaseNow = "ephemeral-only";
				censusWindow = {};
				const before = acceptedVertexCount;
				await sleep(ephemeralOnlySeconds * 1000);
				windowCensus.ephemeralOnly = censusWindow;
				censusWindow = undefined;
				ephemeral.durableVerticesDuringEphemeralOnly = acceptedVertexCount - before;
			}
			if (cpuProfileSeconds > 0) {
				profiler = new Session();
				profiler.connect();
				const post = (method: string, params?: object) =>
					new Promise<unknown>((resolve, reject) =>
						required(profiler).post(method as never, params as never, (error: unknown, result: unknown) =>
							error ? reject(error) : resolve(result)
						)
					);
				await post("Profiler.enable");
				await post("Profiler.setSamplingInterval", { interval: 500 });
				setTimeout(() => {
					void post("Profiler.start").then(() =>
						setTimeout(() => {
							void post("Profiler.stop").then((result) => {
								writeFileSync(
									join(output, "scorecard.cpuprofile"),
									JSON.stringify((result as Profiler.StopReturnType).profile)
								);
								record({ kind: "cpu-profile", atSeconds: cpuProfileAtSeconds, seconds: cpuProfileSeconds });
							});
						}, cpuProfileSeconds * 1000)
					);
				}, cpuProfileAtSeconds * 1000);
			}
			measuredFrom = performance.now();
			durableStart = measuredFrom;
			durableStop = measuredFrom + maxSeconds * 1000;
			const completedRollovers = () => rollovers.filter((r) => r.publishEnd !== undefined).length;
			const joinAt = [...lateJoins];
			const joining: Promise<void>[] = [];
			const join = async (index: number, atRollovers: number) => {
				const started = performance.now();
				const creatorEpochAtStart = epochOf[0] ?? 0;
				const peer = await fixture.open(index);
				const openedMs = performance.now() - started;
				peers[index] = peer;
				policies[index] = compose(peer, index);
				let installedMs: number | null = null;
				const deadline = started + 120_000;
				while (performance.now() < deadline) {
					if ((peer.room.authority()?.epoch ?? 0) >= creatorEpochAtStart && creatorEpochAtStart > 0) {
						installedMs = performance.now() - started;
						break;
					}
					await sleep(10);
				}
				let firstIssueMs: number | null = null;
				let firstIssueError: string | null = null;
				const block = Object.freeze({ id: `join-${index}`, kind: "stone", x: 1, y: index });
				try {
					await required(policies[index]).issue({ action: "placeBlock", ...block });
					firstIssueMs = performance.now() - started;
					latest.set(block.id, block);
				} catch (error) {
					firstIssueError = errorText(error);
					uncertainSlots.add(block.id);
				}
				let creatorAdmittedMs: number | null = null;
				while (performance.now() < deadline + 60_000) {
					if (required(peers[0]).room.projection().blocks.some((value) => value.id === block.id)) {
						creatorAdmittedMs = performance.now() - started;
						break;
					}
					await sleep(10);
				}
				const files = readdirSync(directory).filter((name) => name.startsWith(`peer-${index}`) || name.includes(`peer-${index}-`));
				const storageBytes = files.reduce((sum, name) => sum + statSync(join_(directory, name)).size, 0);
				const value = {
					kind: "late-join",
					index,
					atRollovers,
					creatorEpochAtStart,
					epochAfter: peer.room.authority()?.epoch ?? 0,
					openedMs,
					installedMs,
					firstIssueMs,
					firstIssueError,
					creatorAdmittedMs,
					storageFiles: files,
					storageBytes,
					largestOfferBytes: deliveries[0]?.stats().largestOfferBytes,
					memberDelivery: deliveries[index]?.stats(),
				};
				joins.push(value);
				record(value);
			};
			while (performance.now() < durableStop && completedRollovers() < targetRollovers) {
				const due = joinAt[0];
				if (due !== undefined && completedRollovers() >= due) {
					joinAt.shift();
					const index = peersCount + (lateJoins.length - joinAt.length - 1);
					joining.push(join(index, completedRollovers()).catch((error: unknown) => {
						joins.push({ kind: "late-join", index, error: errorText(error) });
					}));
				}
				await sleep(250);
			}
			await Promise.all(joining);
			durableStop = performance.now();
			measuredTo = durableStop;
			record({ kind: "offering-stopped", atMs: measuredTo - t0, offered: issues.length });
			// Drain: every offered move completes (bounded), then every peer reaches the creator's epoch and
			// the exact last value of every slot no refusal touched.
			const drainDeadline = performance.now() + drainSeconds * 1000;
			while (issues.some((issue) => issue.completedAt === undefined) && performance.now() < drainDeadline)
				await sleep(100);
			const drainedMs = performance.now() - measuredTo;
			let matched = false;
			let mismatch: unknown;
			while (performance.now() < drainDeadline) {
				await required(policies[0]).settled();
				for (const delivery of deliveries.slice(1)) delivery?.request();
				const creatorEpoch = required(peers[0]).room.authority()?.epoch ?? 0;
				const expected = [...latest.values()]
					.filter((block) => !uncertainSlots.has(block.id))
					.sort((a, b) => a.id.localeCompare(b.id));
				const states = peers.filter(Boolean).map(({ room }) =>
					[...room.projection().blocks]
						.filter((block) => !uncertainSlots.has(block.id))
						.sort((a, b) => a.id.localeCompare(b.id))
				);
				const epochs = peers.filter(Boolean).map(({ room }) => room.authority()?.epoch ?? 0);
				matched =
					epochs.every((epoch) => epoch === creatorEpoch) &&
					states.every((state) => JSON.stringify(state) === JSON.stringify(expected));
				if (matched) break;
				const actual = states[0] ?? [];
				const expectedById = new Map(expected.map((block) => [block.id, block]));
				mismatch = {
					epochs,
					samples: states.map((state) =>
						state
							.filter((block) => JSON.stringify(expectedById.get(block.id)) !== JSON.stringify(block))
							.slice(0, 4)
							.map((block) => ({ actual: block, expected: expectedById.get(block.id) ?? null }))
					),
					missing: expected.filter((block) => !actual.some((value) => value.id === block.id)).slice(0, 4),
					expected: expected.length,
					differing: states.map(
						(state) =>
							state.filter((block, index) => JSON.stringify(block) !== JSON.stringify(expected[index])).length +
							Math.abs(state.length - expected.length)
					),
				};
				await sleep(500);
			}
			converged = {
				outstandingAfterDrain: issues.filter((issue) => issue.completedAt === undefined).length,
				drainedMs,
				convergedMs: performance.now() - measuredTo,
				matched,
				mismatch: matched ? null : mismatch,
				uncertainSlots: [...uncertainSlots],
			};
			record({ kind: "converged", ...converged });
		} catch (cause) {
			failure = cause;
			record({ kind: "failure", error: errorText(cause), stack: (cause as Error).stack });
		} finally {
			offering = false;
			clearInterval(progress);
			if (timer !== undefined) clearInterval(timer);
			eventLoop.disable();
			for (const stop of unsubscribe.values()) stop();
			for (const policy of policies) policy?.close();
			for (const delivery of deliveries) delivery?.close();
			profiler?.disconnect();
			lullSpy.mockRestore();
		}
		// Summary.
		const seconds = (measuredTo - measuredFrom) / 1000;
		const done = issues.filter((issue) => issue.completedAt !== undefined);
		const acceptedIssues = done.filter((issue) => issue.outcome === "accepted");
		const issueMs = (list: readonly IssueRecord[]) =>
			percentiles(list.map((issue) => required(issue.completedAt) - issue.offeredAt));
		const completedRollovers = rollovers.filter((r) => r.successorEpoch !== undefined);
		for (const rollover of completedRollovers)
			for (let peer = 1; peer < peersCount; peer++) {
				const change = authorityChanges.find(
					(value) => value.peer === peer && value.epoch >= required(rollover.successorEpoch) && value.at >= rollover.sealStart
				);
				if (change !== undefined) rollover.installedAt[peer] = change.at;
			}
		// A rollover window: seal start until the last Writer installed the successor.
		const windows = completedRollovers.map((rollover) => ({
			start: rollover.sealStart,
			end: Math.max(
				rollover.publishEnd ?? rollover.exportEnd ?? rollover.sealStart,
				...Object.values(rollover.installedAt)
			),
		}));
		const inWindow = (issue: IssueRecord) =>
			windows.some((window) => issue.offeredAt <= window.end && required(issue.completedAt) >= window.start);
		const byRole = (list: readonly IssueRecord[], role: "creator" | "member") =>
			list.filter((issue) => (role === "creator" ? issue.peer === 0 : issue.peer !== 0));
		const memberAdmitted = acceptedIssues.filter((issue) => issue.peer !== 0 && issue.creatorAdmittedAt !== undefined);
		const remote = acceptedIssues.flatMap((issue) =>
			Object.entries(issue.acceptedBy).map(([, at]) => at - issue.offeredAt)
		);
		const peerVisibleAll = acceptedIssues.flatMap((issue) => {
			const others = Array.from({ length: peersCount }, (_, index) => index).filter((index) => index !== issue.peer);
			if (!others.every((index) => issue.acceptedBy[index] !== undefined)) return [];
			return [Math.max(...others.map((index) => required(issue.acceptedBy[index]))) - issue.offeredAt];
		});
		const neverSeenByAll = acceptedIssues.filter((issue) => {
			const others = Array.from({ length: peersCount }, (_, index) => index).filter((index) => index !== issue.peer);
			return !others.every((index) => issue.acceptedBy[index] !== undefined);
		}).length;
		const span = (list: readonly number[]) => percentiles(list);
		const rolloverPhases = {
			sealMs: span(completedRollovers.flatMap((r) => (r.sealEnd === undefined ? [] : [r.sealEnd - r.sealStart]))),
			adoptMs: span(
				completedRollovers.flatMap((r) => (r.adoptEnd === undefined || r.sealEnd === undefined ? [] : [r.adoptEnd - r.sealEnd]))
			),
			exportMs: span(
				completedRollovers.flatMap((r) => (r.exportEnd === undefined || r.adoptEnd === undefined ? [] : [r.exportEnd - r.adoptEnd]))
			),
			publishMs: span(
				completedRollovers.flatMap((r) =>
					r.publishEnd === undefined || r.exportEnd === undefined ? [] : [r.publishEnd - r.exportEnd]
				)
			),
			creatorSealToAdoptedMs: span(
				completedRollovers.flatMap((r) => (r.adoptEnd === undefined ? [] : [r.adoptEnd - r.sealStart]))
			),
			memberInstallAfterAdoptMs: span(
				completedRollovers.flatMap((r) =>
					r.adoptEnd === undefined ? [] : Object.values(r.installedAt).map((at) => at - required(r.adoptEnd))
				)
			),
			authoritySplitMs: span(
				completedRollovers.flatMap((r) =>
					r.adoptEnd === undefined || Object.keys(r.installedAt).length === 0
						? []
						: [Math.max(...Object.values(r.installedAt)) - required(r.adoptEnd)]
				)
			),
			windowMs: span(windows.map((window) => window.end - window.start)),
			betweenSealStartsMs: span(
				completedRollovers.slice(1).map((r, index) => r.sealStart - required(completedRollovers[index]).sealStart)
			),
		};
		const frames = (list: readonly number[]) => {
			const summary = percentiles(list);
			return { ...summary, over2ms: list.filter((value) => value > 2).length / Math.max(1, list.length) };
		};
		const pairs: Record<string, unknown>[] = [];
		for (let receiver = 0; receiver < peersCount; receiver++)
			for (let sender = 0; sender < peersCount; sender++)
				if (receiver !== sender)
					pairs.push({ receiver, sender, received: ephemeral.received[receiver]?.[sender] ?? 0 });
		const publishedTotal = ephemeral.published.reduce((a, b) => a + b, 0);
		const receivedTotal = ephemeral.received.flat().reduce((a, b) => a + b, 0);
		const physical = readdirSync(directory)
			.map((name) => statSync(join(directory, name)))
			.filter((stat) => stat.isFile())
			.reduce((sum, stat) => sum + stat.size, 0);
		const summary = {
			kind: "summary",
			status: failure === undefined ? "passed" : "failed",
			failure: failure === undefined ? null : errorText(failure),
			...configuration,
			measuredSeconds: seconds,
			offered: issues.length,
			offeredPerSecond: issues.length / Math.max(1e-9, seconds),
			accepted: acceptedIssues.length,
			acceptedPerSecond: acceptedIssues.length / Math.max(1e-9, seconds),
			creatorAdmittedMemberMoves: memberAdmitted.length,
			memberMovesAccepted: acceptedIssues.filter((issue) => issue.peer !== 0).length,
			refusals,
			backlogSkips,
			uncertainSlots: uncertainSlots.size,
			converged,
			rollovers: completedRollovers.length,
			rolloversPerMinute: completedRollovers.length / Math.max(1e-9, seconds / 60),
			rolloversByTrigger: completedRollovers.reduce<Record<string, number>>((all, r) => {
				all[String(r.trigger)] = (all[String(r.trigger)] ?? 0) + 1;
				return all;
			}, {}),
			acceptedPerRollover: acceptedIssues.length / Math.max(1, completedRollovers.length),
			issueMs: {
				all: issueMs(acceptedIssues),
				creator: issueMs(byRole(acceptedIssues, "creator")),
				member: issueMs(byRole(acceptedIssues, "member")),
				inRolloverWindow: issueMs(acceptedIssues.filter(inWindow)),
				outsideRolloverWindow: issueMs(acceptedIssues.filter((issue) => !inWindow(issue))),
				creatorInWindow: issueMs(byRole(acceptedIssues, "creator").filter(inWindow)),
				creatorOutside: issueMs(byRole(acceptedIssues, "creator").filter((issue) => !inWindow(issue))),
				memberInWindow: issueMs(byRole(acceptedIssues, "member").filter(inWindow)),
				memberOutside: issueMs(byRole(acceptedIssues, "member").filter((issue) => !inWindow(issue))),
				refused: issueMs(done.filter((issue) => issue.outcome !== "accepted")),
			},
			creatorAdmissionOfMemberMovesMs: percentiles(
				memberAdmitted.map((issue) => required(issue.creatorAdmittedAt) - issue.offeredAt)
			),
			remoteAcceptMs: span(remote),
			visibleToAllPeersMs: span(peerVisibleAll),
			acceptedNeverSeenByAllPeers: neverSeenByAll,
			rolloverPhases,
			lateJoins: joins,
			lull: {
				mode: lull,
				runs: lullRuns,
				ms: span(lullSpans.map((value) => value.end - value.start)),
				results: lullSpans.reduce<Record<string, number>>((all, value) => {
					all[value.result] = (all[value.result] ?? 0) + 1;
					return all;
				}, {}),
			},
			eventLoop: {
				p50Ms: eventLoop.percentile(50) / 1e6,
				p95Ms: eventLoop.percentile(95) / 1e6,
				p99Ms: eventLoop.percentile(99) / 1e6,
				maxMs: eventLoop.max / 1e6,
			},
			timerGaps: timerGaps.summary(),
			timerGapsByPhase: Object.fromEntries([...timerGapsByPhase].map(([name, value]) => [name, value.summary()])),
			phaseSeconds: Object.fromEntries([...phaseTime].map(([name, ms]) => [name, ms / 1000])),
			frameBusyMsEstimate: {
				all: frames(frameBusy),
				byPhase: Object.fromEntries([...frameBusyByPhase].map(([name, list]) => [name, frames(list)])),
			},
			ephemeral:
				ephemeralHz > 0
					? {
							hzPerPeer: ephemeralHz,
							published: ephemeral.published,
							publishRefused: ephemeral.publishRefused,
							publishErrors: ephemeral.publishErrors,
							receivedTotal,
							expectedDeliveries: publishedTotal * (peersCount - 1),
							deliveryRatio: receivedTotal / Math.max(1, publishedTotal * (peersCount - 1)),
							pairs,
							latencyMs: percentiles(ephemeral.latencyValues),
							gaps: ephemeral.gaps.summary(),
							gapsByPhase: Object.fromEntries([...ephemeral.gapsByPhase].map(([name, value]) => [name, value.summary()])),
							gapsOver100ms: ephemeral.longGapCount,
							durableVerticesDuringEphemeralOnly: ephemeral.durableVerticesDuringEphemeralOnly,
							acceptedVertexCensusByWindow: windowCensus,
							channelStats: [...channels].map(([index, channel]) => ({ index, ...channel.stats() })),
						}
					: null,
			successorDelivery: deliveries.map((delivery) => delivery?.stats()),
			deliveryRefusals: deliveryRefusals.slice(-10),
			deliveryRefusalCount: deliveryRefusals.length,
			policyErrors: errors.slice(0, 40),
			policyErrorCount: errors.length,
			physicalBytes: physical,
			memory: process.memoryUsage(),
			loadAfter: loadavg(),
		};
		writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
		writeFileSync(
			join(output, "issues.jsonl"),
			issues
				.map((issue) =>
					JSON.stringify({
						...issue,
						offeredAt: issue.offeredAt - t0,
						completedAt: issue.completedAt === undefined ? null : issue.completedAt - t0,
						creatorAdmittedAt: issue.creatorAdmittedAt === undefined ? null : issue.creatorAdmittedAt - t0,
						acceptedBy: Object.fromEntries(Object.entries(issue.acceptedBy).map(([k, v]) => [k, v - t0])),
						inWindow: issue.completedAt === undefined ? null : inWindow(issue),
					})
				)
				.join("\n") + "\n"
		);
		const rel = (value: number | undefined) => (value === undefined ? null : value - t0);
		writeFileSync(
			join(output, "rollovers.jsonl"),
			rollovers
				.map((r) =>
					JSON.stringify({
						closing: r.closing,
						successorEpoch: r.successorEpoch ?? null,
						trigger: r.trigger ?? null,
						sealStart: rel(r.sealStart),
						sealEnd: rel(r.sealEnd),
						adoptEnd: rel(r.adoptEnd),
						exportEnd: rel(r.exportEnd),
						publishEnd: rel(r.publishEnd),
						installedAt: Object.fromEntries(Object.entries(r.installedAt).map(([k, v]) => [k, v - t0])),
					})
				)
				.join("\n") + "\n"
		);
		writeFileSync(
			join(output, "timeline.json"),
			JSON.stringify({
				t0,
				authorityChanges: authorityChanges.map((value) => ({ ...value, at: value.at - t0 })),
				lullSpans: lullSpans.map((value) => ({ ...value, start: value.start - t0, end: value.end - t0 })),
				ephemeralLongGaps: ephemeral.longGaps.map((value) => ({
					...value,
					from: Number(value.from) - t0,
					to: Number(value.to) - t0,
				})),
			})
		);
		const cleanup = [...(await closeFixtures()), ...(await network.close())];
		if (failure !== undefined) throw failure;
		expect(cleanup.length, cleanup.map(String).join("; ")).toBe(0);
	},
	(maxSeconds + drainSeconds + 600) * 1000
);
