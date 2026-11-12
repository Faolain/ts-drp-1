import { expect, type CDPSession, type Page, test } from "@playwright/test";
import { resolve } from "node:path";
import type { V3ZoneApi as ProductZoneApi } from "../examples/grid/src/v3-zone";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";
import { installRealtimeProbe } from "./fixtures/realtime-probe/page-probe.js";
import { importWorkspacePackageExportFile } from "./fixtures/shared/workspace-package-export-file.mjs";

const { decodeCanonical } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../packages/canonical"),
	})
).module as Readonly<{ decodeCanonical(bytes: Uint8Array): unknown }>;

interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly blocks: readonly Readonly<{
		readonly id: string;
		readonly kind: string;
		readonly x: number;
		readonly y: number;
	}>[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly localPeerId: string;
	readonly outcomeContext: Readonly<{readonly epoch: number}> | null;
	readonly ready: boolean;
	readonly rawTransport: Readonly<{
		readonly fallbackCount: number;
		readonly received: number;
		readonly sent: number;
		readonly links: readonly Readonly<{
			readonly label: "ts-drp-ephemeral/1";
			readonly maxRetransmits: 0;
			readonly ordered: false;
			readonly peerId: string;
		}>[];
	}>;
	readonly transientPositions: Readonly<Record<string, Readonly<{ readonly x: number; readonly y: number }>>>;
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly zoneId: string;
}

interface ZoneApi extends Pick<ProductZoneApi, "sealEpoch" | "exportCreatorSuccessor" | "adoptCreatorSuccessor" | "installCreatorSuccessor"> {
	activateMigration(receipt: Awaited<ReturnType<ZoneApi["rehearseMigration"]>>): Promise<
		Readonly<{
			readonly activated: true;
			readonly activationDecisionDigest: string;
			readonly activationVertexDigest: string;
			readonly targetAnchorDigest: string;
		}>
	>;
	close(): Promise<void>;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	rehearseMigration(): Promise<
		Readonly<{
			readonly activated: false;
			readonly applicationStateDigest: string;
			readonly exactCanonicalRecordBytes: Uint8Array;
			readonly importedOperationCount: number;
			readonly recordDigest: string;
			readonly recordVertexDigest: string;
			readonly targetAnchorDigest: string;
		}>
	>;
	snapshot(): ZoneSnapshot;
}

interface NetworkSnapshot {
	readonly connectionBudget: Readonly<{
		readonly maxConnections: number;
		readonly maxParallelDials: number;
		readonly role: "browser";
	}>;
	readonly connections: readonly unknown[];
	readonly peerId: string;
}

declare global {
	interface Window {
		readonly __TS_DRP_GRID_SESSION__?: { snapshot(): NetworkSnapshot };
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
		readonly __TS_DRP_GRID_ROOM_WORKER__?: unknown;
	}
}

const DIGEST = /^[0-9a-f]{64}$/u;

test("bounded real Grid movement overlaps placement and observes healthy rollover without an authority bridge", async ({browser}, info) => {
	test.setTimeout(240_000);
	const contexts = [await browser.newContext(), await browser.newContext()];
	// Independent Writers own independent account floors. Joining the invited
	// genesis explicitly creates this NEW recipient account's native floor;
	// creator adoption must not advance a still-predecessor recipient's floor.
	await installGridRoomHeadAuthority([contexts[0]!]);
	await installGridRoomHeadAuthority([contexts[1]!], "__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__", "create");
	// rAF intervals, long tasks and ephemeral RTC entries come from the shared realtime probe
	// (tests/fixtures/realtime-probe/page-probe.ts), started and stopped with each phase below.
	for (const context of contexts) await installRealtimeProbe(context, {app: "none", injectBlockMs: 0, injectEveryFrames: 0, autoStart: false, heartbeatMs: 0});
	await Promise.all(contexts.map(context => context.addInitScript(() => {
		const nativePromise = globalThis.Promise;
		// Observe the existing product hook, retaining only bounded primitive
		// lifecycle diagnostics. Cumulative since page startup: readiness may have
		// completed before the first measured placement. No proof/bytes/authority.
		const finishingLimit = 128, finishingRows: Record<string, string | number | boolean>[] = [];
		let finishingDropped = 0;
		const finishingKinds = new Set(["ordinary-boundary-readiness", "ordinary-incremental-source-prime",
			"ordinary-source-native-control-mismatch",
			"ordinary-finishing-resource-program-build",
			"ordinary-incremental-hit", "ordinary-incremental-fallback", "ordinary-finishing-warm-hit",
			"ordinary-finishing-warm-fallback", "ordinary-finishing-template-compile", "ordinary-finishing-source-capture"]);
		if (Reflect.get(globalThis, "__warmProofEvent") !== undefined) throw Error("D9346_FINISHING_OBSERVER_ALREADY_OWNED");
		Reflect.set(globalThis, "__warmProofEvent", (event: Record<string, unknown>) => {
			if (!finishingKinds.has(event.kind as string)) return;
			if (finishingRows.length === finishingLimit) {finishingDropped++; return;}
			const row: Record<string, string | number | boolean> = {at: performance.now()};
			for (const key of ["kind", "epoch", "phase", "ok", "prepared", "reason", "received", "priorPresent", "present"]) {
				const value = event[key];
				if (typeof value === "string") row[key] = value.slice(0, 128);
				else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) row[key] = value;
			}
			finishingRows.push(row);
		});
		// Local test observations only: no packets, authorities, stores or handles
		// are retained. Original RTC calls/listeners and application rendering run.
		const limit = 128, rows: {kind: string; at: number; pending: boolean; detail?: string}[] = [];
		let active = false, pending = false, truncated = false, timer = 0, droppedRows = 0;
		const stageLimit = 16, stageRows: {stage: string; edge: "start" | "complete"; at: number}[] = [];
		let stage: string | undefined, droppedStageRows = 0;
		const probeLimit = 64;
		type Probe = {sequence: number; requestedPhase: string; expectedLeft: string; expectedTop: string; armedAt: number;
			inputAt?: number; inputStage?: string; positionObservedAt?: number; positionObservedStage?: string; lastRtcMessageEntryAt?: number; messageEntriesAtPosition?: number};
		const probes = new Map<number, Probe>();
		let armedProbe: number | undefined, droppedProbes = 0;
		let startedAt: number | undefined, completedAt: number | undefined;
		let input: {at: number; pending: boolean; key: string} | undefined;
		let keydownCount = 0;
		type ProbeTotals = {frameCallbacks: number; maxFrameIntervalMs: number; lastFrameAt: number | null; longTasks: number; longTaskMs: number;
			maxLongTaskMs: number; rtcSendEntries: number; rtcMessageEntries: number; lastRtcMessageEntryAt: number | null};
		const realtime = Reflect.get(globalThis, "__TS_DRP_REALTIME_PROBE__") as {start(): void; stop(): void; reset(): void; totals(): ProbeTotals;
			subscribe(listener: (kind: string, detail?: string) => void): () => void} | undefined;
		if (realtime === undefined) throw Error("D9346_REALTIME_PROBE_ABSENT");
		// Invocation counters only: never retain a request, transaction, key or result.
		// The enclosing evidence phase supplies placement/rollover identity; these
		// three buckets classify the call against the original pending marker.
		const getKeyStoreLimit = 32, getKeyStoreNameLimit = 128;
		const getKeyPhaseNames = ["before-operation", "pending-operation", "after-operation"] as const;
		const getKeyTotals = [0, 0, 0], getKeyOverflow = [0, 0, 0];
		const getKeyStores = new Map<string, number[]>();
		let getKeyNameTruncated = false;
		const nativeGetKey = IDBObjectStore.prototype.getKey;
		Object.defineProperty(IDBObjectStore.prototype, "getKey", {configurable: true, writable: true,
			value: function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getKey"]>) {
				if (active) {
					const phase = pending ? 1 : startedAt === undefined ? 0 : 2;
					getKeyTotals[phase] = (getKeyTotals[phase] ?? 0) + 1;
					let name = "<unavailable>";
					try {
						const originalName = this.name;
						getKeyNameTruncated ||= originalName.length > getKeyStoreNameLimit;
						name = originalName.slice(0, getKeyStoreNameLimit);
					} catch { /* Observation never substitutes the original native error. */ }
					let counts = getKeyStores.get(name);
					if (counts === undefined && getKeyStores.size < getKeyStoreLimit) {
						counts = [0, 0, 0]; getKeyStores.set(name, counts);
					}
					if (counts === undefined) getKeyOverflow[phase] = (getKeyOverflow[phase] ?? 0) + 1;
					else counts[phase] = (counts[phase] ?? 0) + 1;
				}
				// Exact original receiver/arguments/return/throw; no listeners, waits or retry.
				return Reflect.apply(nativeGetKey, this, args);
			}});
		const observedKinds = new Set<string>();
		let mutation: MutationObserver | undefined;
		const record = (kind: string, detail?: string): void => {
			if (!active) return;
			observedKinds.add(kind);
			if (rows.length < limit) rows.push({kind, at: performance.now(), pending, ...(detail === undefined ? {} : {detail})});
			else {truncated = true; droppedRows++;}
		};
		// Separate from the 128-row rendering prefix: native close ancestry must
		// survive a long recipient install. Test-private identities are page-local;
		// they are NOT libp2p Connection IDs, peer identities or authority evidence.
		const rtcLifecycleLimit = 32, rtcStackByteLimit = 2048;
		type RtcLifecycleKind = "pc-close-call" | "pc-state-event" | "channel-close-call" | "channel-close-event" | "channel-error-event";
		type RtcLifecycleRow = {kind: RtcLifecycleKind; at: number; pending: boolean; stage?: string;
			pcId?: number; channelId?: number; label?: string; nativeChannelId?: number | null;
			connectionState?: string; iceConnectionState?: string; signalingState?: string; readyState?: string;
			errorName?: string; errorMessage?: string; stack?: string; stackTruncated?: boolean};
		const rtcLifecycleRows: RtcLifecycleRow[] = [];
		const rtcLifecycleTotals: Record<RtcLifecycleKind, number> = {"pc-close-call": 0, "pc-state-event": 0,
			"channel-close-call": 0, "channel-close-event": 0, "channel-error-event": 0};
		const rtcLifecycleOverflow = {...rtcLifecycleTotals};
		const pcIdentities = new WeakMap<RTCPeerConnection, number>();
		const channelIdentities = new WeakMap<RTCDataChannel, {id: number; pcId?: number}>();
		let nextPcId = 0, nextChannelId = 0;
		const nativePcListen = RTCPeerConnection.prototype.addEventListener;
		const nativeChannelListen = RTCDataChannel.prototype.addEventListener;
		const lifecycle = (kind: RtcLifecycleKind, pc?: RTCPeerConnection, channel?: RTCDataChannel, error?: unknown): void => {
			// Diagnostics must never replace native return/throw or listener behavior.
			try {
				if (!active) return;
				rtcLifecycleTotals[kind]++;
				if (rtcLifecycleRows.length === rtcLifecycleLimit) {rtcLifecycleOverflow[kind]++; return;}
				const row: RtcLifecycleRow = {kind, at: performance.now(), pending, stage};
				if (pc !== undefined) {
					row.pcId = pcIdentities.get(pc); row.connectionState = pc.connectionState;
					row.iceConnectionState = pc.iceConnectionState; row.signalingState = pc.signalingState;
				}
				if (channel !== undefined) {
					const identity = channelIdentities.get(channel);
					row.channelId = identity?.id; row.pcId ??= identity?.pcId;
					row.label = channel.label.slice(0, 128); row.nativeChannelId = channel.id; row.readyState = channel.readyState;
				}
				if (error !== null && typeof error === "object") {
					const name = Reflect.get(error, "name"), message = Reflect.get(error, "message");
					if (typeof name === "string") row.errorName = name.slice(0, 128);
					if (typeof message === "string") row.errorMessage = message.slice(0, 512);
				}
				if (kind === "pc-close-call" || kind === "channel-close-call") {
					const bytes = new TextEncoder().encode(new Error("D9346_NATIVE_CLOSE_CALL").stack ?? "");
					// Streaming decode drops an incomplete final UTF-8 code point.
					row.stack = new TextDecoder().decode(bytes.subarray(0, rtcStackByteLimit), {stream: true});
					row.stackTruncated = bytes.byteLength > rtcStackByteLimit;
				}
				rtcLifecycleRows.push(row);
			} catch { /* Observation failure cannot change the native operation. */ }
		};
		const watchChannel = (channel: RTCDataChannel, pcId?: number): void => {
			const existing = channelIdentities.get(channel);
			if (existing !== undefined) {existing.pcId ??= pcId; return;}
			channelIdentities.set(channel, {id: ++nextChannelId, pcId});
			Reflect.apply(nativeChannelListen, channel, ["close", () => lifecycle("channel-close-event", undefined, channel)]);
			Reflect.apply(nativeChannelListen, channel, ["error", (event: RTCErrorEvent) => lifecycle("channel-error-event", undefined, channel, event.error)]);
		};
		const watchPc = (pc: RTCPeerConnection): number => {
			const existing = pcIdentities.get(pc); if (existing !== undefined) return existing;
			const id = ++nextPcId; pcIdentities.set(pc, id);
			Reflect.apply(nativePcListen, pc, ["datachannel", (event: RTCDataChannelEvent) => {try {watchChannel(event.channel, id);} catch { /* Native dispatch remains original. */ }}]);
			Reflect.apply(nativePcListen, pc, ["connectionstatechange", () => lifecycle("pc-state-event", pc)]);
			return id;
		};
		// Existing native creation/listener calls discover PCs before their original
		// callbacks; do not replace constructors, on* properties or app listeners.
		Object.defineProperty(RTCPeerConnection.prototype, "addEventListener", {configurable: true, writable: true,
			value: function (this: RTCPeerConnection, ...args: Parameters<RTCPeerConnection["addEventListener"]>) {
				try {watchPc(this);} catch { /* Preserve original brand/argument errors. */ }
				return Reflect.apply(nativePcListen, this, args);
			}});
		const nativeCreateChannel = RTCPeerConnection.prototype.createDataChannel;
		Object.defineProperty(RTCPeerConnection.prototype, "createDataChannel", {
			...Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "createDataChannel"),
			value: function (this: RTCPeerConnection, ...args: Parameters<RTCPeerConnection["createDataChannel"]>) {
				let pcId: number | undefined; try {pcId = watchPc(this);} catch { /* Native call remains original. */ }
				const channel = Reflect.apply(nativeCreateChannel, this, args) as RTCDataChannel;
				try {watchChannel(channel, pcId);} catch { /* Return the original channel. */ }
				return channel;
			}});
		const nativePcClose = RTCPeerConnection.prototype.close, nativeChannelClose = RTCDataChannel.prototype.close;
		Object.defineProperty(RTCPeerConnection.prototype, "close", {...Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "close"),
			value: function (this: RTCPeerConnection, ...args: Parameters<RTCPeerConnection["close"]>) {
				try {watchPc(this);} catch { /* Original native close still runs. */ }
				lifecycle("pc-close-call", this); return Reflect.apply(nativePcClose, this, args);
			}});
		Object.defineProperty(RTCDataChannel.prototype, "close", {...Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "close"),
			value: function (this: RTCDataChannel, ...args: Parameters<RTCDataChannel["close"]>) {
				try {watchChannel(this);} catch { /* Original native close still runs. */ }
				lifecycle("channel-close-call", undefined, this); return Reflect.apply(nativeChannelClose, this, args);
			}});
		// Shared probe events enter this phase trace exactly as the inline observers recorded them.
		const sharedKinds = new Set(["animation-frame-opportunity", "long-task", "rtc-send-entry", "rtc-message-entry"]);
		realtime.subscribe((kind, detail) => {if (sharedKinds.has(kind)) record(kind, detail);});
		window.addEventListener("keydown", event => {
			if (active) {
				keydownCount++; input = {at: performance.now(), pending, key: event.key};
				const probe = armedProbe === undefined ? undefined : probes.get(armedProbe);
				if (probe !== undefined) {probe.inputAt = input.at; probe.inputStage = stage; armedProbe = undefined;}
			}
			record("input-keydown", event.key);
		}, {capture: true});
		Reflect.set(globalThis, "__D9346MovementObservation", {
			nativeRuntime() {return {promiseUnchanged: globalThis.Promise === nativePromise,
				zoneInstalled: Reflect.get(globalThis, "Zone") !== undefined};},
			start(peerId: string) {
				rows.length = 0; truncated = false; droppedRows = 0; active = true; pending = false;
				rtcLifecycleRows.length = 0;
				for (const kind of Object.keys(rtcLifecycleTotals) as RtcLifecycleKind[]) {rtcLifecycleTotals[kind] = 0; rtcLifecycleOverflow[kind] = 0;}
				stageRows.length = 0; stage = undefined; droppedStageRows = 0;
				probes.clear(); armedProbe = undefined; droppedProbes = 0;
				startedAt = undefined; completedAt = undefined; input = undefined; keydownCount = 0; observedKinds.clear();
				getKeyTotals.fill(0); getKeyOverflow.fill(0); getKeyStores.clear(); getKeyNameTruncated = false;
				realtime.reset(); realtime.start();
				const grid = document.getElementById("grid");
				if (grid === null) throw Error("D9346_REAL_RENDERER_ABSENT");
				mutation = new MutationObserver(() => {
					const dot = [...grid.querySelectorAll<HTMLElement>("[data-glowing-peer-id]")].find(value => value.dataset.glowingPeerId === peerId);
					if (dot !== undefined) for (const probe of probes.values()) {
						if (probe.positionObservedAt === undefined && dot.style.left === probe.expectedLeft && dot.style.top === probe.expectedTop) {
							const shared = realtime.totals();
							probe.positionObservedAt = performance.now(); probe.positionObservedStage = stage; probe.lastRtcMessageEntryAt = shared.lastRtcMessageEntryAt ?? undefined;
							probe.messageEntriesAtPosition = shared.rtcMessageEntries;
						}
					}
					record("dom-update-observed", dot === undefined ? "absent" : `${dot.style.left};${dot.style.top}`);
				});
				mutation.observe(grid, {childList: true, subtree: true, attributes: true});
				let due = performance.now() + 50;
				timer = window.setInterval(() => {record("timer-drift", String(Math.max(0, performance.now() - due))); due = performance.now() + 50;}, 50);
			},
			begin() {startedAt = performance.now(); pending = true; record("durable-or-lifecycle-start");},
			complete() {completedAt = performance.now(); record("durable-or-lifecycle-complete"); pending = false;},
			stage(name: string, edge: "start" | "complete") {
				if (!active) return;
				if (stageRows.length < stageLimit) stageRows.push({stage: name, edge, at: performance.now()}); else droppedStageRows++;
				stage = edge === "start" ? name : undefined; record("lifecycle-stage-" + edge, name);
			},
			armProbe(sequence: number, requestedPhase: string, x: number, y: number) {
				if (!active) return;
				if (probes.size === probeLimit) {droppedProbes++; return;}
				probes.set(sequence, {sequence, requestedPhase, expectedLeft: `calc(50% + ${x * 24}px)`, expectedTop: `calc(50% - ${y * 24}px)`, armedAt: performance.now()});
				armedProbe = sequence;
			},
			get started() {return startedAt !== undefined;},
			stop() {const activeAtStop = active, stoppedAt = performance.now(); active = false; mutation?.disconnect(); realtime.stop(); clearInterval(timer);
				const shared = realtime.totals(), frameCount = shared.frameCallbacks, lastFrameAt = shared.lastFrameAt ?? undefined;
				const maximumObservedFrameGapMs = shared.maxFrameIntervalMs, rtcSendEntries = shared.rtcSendEntries, rtcMessageEntries = shared.rtcMessageEntries;
				const longTaskCount = shared.longTasks, longTaskMilliseconds = shared.longTaskMs, maximumLongTaskMilliseconds = shared.maxLongTaskMs;
				return {timeOrigin: performance.timeOrigin, visibility: document.visibilityState, rows: [...rows], truncated, droppedRows, limit, activeAtStop,
					nativeRtcLifecycle: {rows: [...rtcLifecycleRows], limit: rtcLifecycleLimit, stackByteLimit: rtcStackByteLimit,
						totals: {...rtcLifecycleTotals}, overflow: {...rtcLifecycleOverflow},
						qualification: "Separate bounded local-clock close calls/events and PC connection-state events. Close-call stack is captured before the original native method; events can be asynchronous and do not themselves name a close caller. WeakMap test-private PC/channel IDs correlate only within this page; channel native ID is not a libp2p Connection ID. Labels/states/errors/stacks only, no payloads/signatures/authority. Original methods, receivers, arguments, return/throw and application listeners are preserved. Added observers/stacks perturb scheduling; no retry or bridge. Failed selected libp2p connection can remain unidentified before metadata wrapping."},
					frameSummary: {frameCount, lastFrameAt, maximumObservedFrameGapMs,
						openFrameTailAtStopMs: lastFrameAt === undefined ? undefined : stoppedAt - lastFrameAt,
						coverage: "all observed complete callback intervals plus separate censored last-frame-to-stop tail; not physical presentation"},
					stages: {rows: [...stageRows], limit: stageLimit, droppedRows: droppedStageRows},
					movementProbes: {rows: [...probes.values()], limit: probeLimit, droppedRows: droppedProbes, rtcSendEntries, rtcMessageEntries,
						qualification: "Test sequence identifies a unique requested absolute position, not a decoded wire sequence. Matching DOM position is local-clock observation; last RTC message is only a nearby callback correlation, not authenticated packet identity or end-to-end latency. Unobserved positions may be dropped/coalesced/in flight; no old authority is bridged."},
					longTaskCount, longTaskMilliseconds, maximumLongTaskMilliseconds,
					finishing: {rows: finishingRows.map(row => ({...row})), limit: finishingLimit, droppedRows: finishingDropped,
						qualification: "Existing primitive product diagnostics, cumulative since page startup; repeated checkpoints overlap. No call-count or missing-event completeness claim; no authority, packets or encoded proof bytes retained."},
					idbGetKey: {phaseNames: getKeyPhaseNames, invocations: [...getKeyTotals],
						stores: [...getKeyStores].map(([name, counts]) => ({name, invocations: [...counts]})),
						overflowInvocations: [...getKeyOverflow], storeLimit: getKeyStoreLimit,
						storeNameLimit: getKeyStoreNameLimit, nameTruncated: getKeyNameTruncated,
						qualification: "Native getKey invocation attempts, including synchronous throws; not completions, keeper-only counts or durations. Object-store names aggregate across databases; overflow counts retain excess names only as totals. Instrumentation adds bounded counter and wrapper overhead."},
					startedAt, completedAt, input, keydownCount, observedKinds: [...observedKinds], stoppedAt,
					frameGapCoverage: "scalar maximum covers all observed rAF callbacks; trace rows remain bounded-prefix-only when truncated; neither measures physical presentation"};},
		});
	})));
	const creator = await contexts[0]!.newPage(), receiver = await contexts[1]!.newPage();
	const evidence: unknown[] = [];
	let profileSession: CDPSession | undefined;
	let processCpuSession: CDPSession | undefined;
	type ProcessCpuSnapshot = {requestedAt: number; completedAt: number;
		processes: {id: number; type: string; cpuTime: number}[]};
	let phaseCpuBefore: ProcessCpuSnapshot | undefined;
	const processCpuSnapshot = async (): Promise<ProcessCpuSnapshot> => {
		const requestedAt = performance.now();
		const value = await processCpuSession!.send("SystemInfo.getProcessInfo");
		return {requestedAt, completedAt: performance.now(), processes: value.processInfo.map(process =>
			({id: process.id, type: process.type, cpuTime: process.cpuTime}))};
	};
	let profileRequestedAt: number | undefined, profileStartedAt: number | undefined;
	type CreatorClock = Readonly<{now: number; timeOrigin: number}>;
	let profileStartCreatorBracket: Readonly<{before: CreatorClock; after: CreatorClock; uncertaintyMs: number}> | undefined;
	const creatorClock = async (session: CDPSession): Promise<CreatorClock> => {
		const result = await session.send("Runtime.evaluate", {
			expression: "({now: performance.now(), timeOrigin: performance.timeOrigin})", returnByValue: true,
		});
		const value = result.result.value as CreatorClock | undefined;
		if (result.exceptionDetails !== undefined || value === undefined ||
			!Number.isFinite(value.now) || !Number.isFinite(value.timeOrigin)) throw Error("D9346_CREATOR_CLOCK_UNAVAILABLE");
		return {now: value.now, timeOrigin: value.timeOrigin};
	};
	let commandRequests: {command: string; requestedAt: number; completedAt?: number}[] = [];
	let stopRolloverProbes = false, rolloverProbesTask: Promise<void> | undefined, rolloverProbeFailure: string | undefined;
	const request = (command: string) => {const value = {command, requestedAt: performance.now()} as {command: string; requestedAt: number; completedAt?: number}; commandRequests.push(value); return value;};
	try {
		processCpuSession = await browser.newBrowserCDPSession();
		await Promise.all([openGrid(creator), openGrid(receiver)]);
		const nativeRuntimes = await Promise.all([creator, receiver].map(page => page.evaluate(() =>
			Reflect.get(globalThis, "__D9346MovementObservation").nativeRuntime())));
		evidence.push({phase: "tracing-disabled-import", nativeRuntimes});
		for (const runtime of nativeRuntimes) expect(runtime).toEqual({promiseUnchanged: true, zoneInstalled: false});
		const [creatorEnrollment, receiverEnrollment] = await Promise.all([zone(creator), zone(receiver)]);
		await creator.fill("#zoneMemberEnrollment", receiverEnrollment.enrollment); await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		const created = await zone(creator);
		await receiver.fill("#gridInput", created.invite); await receiver.click("#joinGrid");
		await expect.poll(async () => (await zone(receiver)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		const joined = await zone(creator);
		await expectOneMeasuredRawMovement({acceptedOperationDigest: joined.acceptedOperationDigest,
			durableVertexCount: 2, key: "w", sender: creator, receiver,
			senderPeerId: creatorEnrollment.localPeerId, receiverPeerId: receiverEnrollment.localPeerId,
		});
		const before = await zone(creator);
		expect(before.outcomeContext?.epoch).toBe(0);
		if (process.env.D9346_PROFILE_REAL_MOVEMENT === "1") {
			profileSession = await contexts[0]!.newCDPSession(creator);
			await profileSession.send("Profiler.enable");
			await profileSession.send("Profiler.setSamplingInterval", {interval: 1000});
			profileRequestedAt = performance.now();
			const creatorBefore = await creatorClock(profileSession);
			await profileSession.send("Profiler.start");
			const creatorAfter = await creatorClock(profileSession);
			profileStartCreatorBracket = {before: creatorBefore, after: creatorAfter,
				uncertaintyMs: creatorAfter.now - creatorBefore.now};
			profileStartedAt = performance.now();
		}
		const start = async (): Promise<void> => {commandRequests = []; await Promise.all([creator, receiver].map(page => page.evaluate(peer =>
			Reflect.get(globalThis, "__D9346MovementObservation").start(peer), creatorEnrollment.localPeerId)));
			phaseCpuBefore = await processCpuSnapshot();};
		const stop = async (phase: string, placementDetail?: Readonly<Record<string, unknown>>): Promise<void> => {
			const cpuAfter = await processCpuSnapshot(), cpuBefore = phaseCpuBefore!;
			const matchedProcesses = cpuAfter.processes.flatMap(after => {
				const before = cpuBefore.processes.find(value => value.id === after.id && value.type === after.type);
				return before === undefined ? [] : [{id: after.id, type: after.type, cpuSeconds: after.cpuTime - before.cpuTime}];
			});
			const processCpu = {before: cpuBefore, after: cpuAfter, matchedProcesses,
				wallMilliseconds: cpuAfter.completedAt - cpuBefore.completedAt,
				qualification: "Actual cumulative CPU deltas for matched processes of this owned browser, not samples or product-only CPU. Window includes both clients' rendering, transport, assertions and bounded probes; it brackets rather than equals the product call. Snapshot request/completion brackets expose observation uncertainty; new/disappeared processes remain in raw snapshots and have no invented delta. Other host processes are excluded, but CPU frequency and scheduling still affect measurements. No extra wait or read occurs inside signing/admission/rollover."};
			const observations = await Promise.all([creator, receiver].map(page => page.evaluate(() => Reflect.get(globalThis, "__D9346MovementObservation").stop())));
			for (const observation of observations) {
				const lifecycle = observation.nativeRtcLifecycle;
				expect(lifecycle.rows.length).toBeLessThanOrEqual(lifecycle.limit);
				for (const [kind, total] of Object.entries(lifecycle.totals)) {
					expect(total).toBe(lifecycle.rows.filter((row: {kind: string}) => row.kind === kind).length + lifecycle.overflow[kind]);
				}
				for (const row of lifecycle.rows) if (row.stack !== undefined) expect(Buffer.byteLength(row.stack)).toBeLessThanOrEqual(lifecycle.stackByteLimit);
			}
			const sender = observations[0];
			const overlap = sender.input === undefined ? "input-not-observed" : sender.input.pending ? "keydown-during-pending-operation" :
				sender.completedAt !== undefined && sender.completedAt <= sender.input.at ? "no-overlap; operation-completed-before-keydown" : "no-overlap-at-keydown";
			evidence.push({phase, observations, overlap, processCpu, ...(placementDetail === undefined ? {} : {placementDetail}),
				overlapQualification: "overlap classifies only the last keydown; numbered movementProbes retain individual local input/stage observations",
				commandRequests: [...commandRequests], controllerTimeOrigin: performance.timeOrigin});
			// A successful fast call may finish before CDP dispatches the key. That
			// is classified, not a failed overlap requirement or a pending-wait timeout.
			expect(sender.input).toBeDefined();
			if (phase.startsWith("ordinary-placement-and-transient-movement")) {
				expect(sender.finishing.droppedRows, "ordinary construction observations must be complete").toBe(0);
				expect(sender.finishing.rows.filter((row: {kind: string; at: number}) =>
					row.kind === "ordinary-finishing-resource-program-build" &&
					row.at >= sender.startedAt && row.at <= sender.completedAt),
					"supported ordinary placement must not construct future resource programs").toEqual([]);
				expect(sender.keydownCount).toBe(1); expect(observations[1].keydownCount).toBe(0);
				expect(sender.observedKinds).toContain("rtc-send-entry");
				expect(observations[1].observedKinds).toContain("rtc-message-entry");
				expect(observations[1].observedKinds).toContain("dom-update-observed");
			}
			if (phase === "healthy-seal-export-adopt-install-authority-gap") {
				const count = placementDetail!.requestedProbes as number;
				expect(sender.keydownCount).toBe(count); expect(observations[1].keydownCount).toBe(0);
				for (const observation of observations) {
					expect(observation.movementProbes.rows.map((row: {sequence: number}) => row.sequence)).toEqual(Array.from({length: count}, (_, index) => index + 1));
					expect(observation.movementProbes.droppedRows).toBe(0); expect(observation.stages.droppedRows).toBe(0);
					expect(observation.truncated).toBe(observation.droppedRows > 0);
				}
				for (const probe of sender.movementProbes.rows) expect(probe.inputAt).toBeDefined();
				expect(sender.stages.rows.map((row: {stage: string; edge: string}) => `${row.stage}:${row.edge}`)).toEqual([
					"creator-seal:start", "creator-seal:complete", "creator-export:start", "creator-export:complete",
					"creator-adopt:start", "creator-adopt:complete", "post-recipient-adoption:start", "post-recipient-adoption:complete"]);
				expect(observations[1].stages.rows.map((row: {stage: string; edge: string}) => `${row.stage}:${row.edge}`)).toEqual([
					"recipient-install:start", "recipient-install:complete", "post-recipient-adoption:start", "post-recipient-adoption:complete"]);
			}
		};
		// Serial original issues, never a batch/coalesced call: first measured
		// placement versus two same-epoch repeats. Payload/input and resulting world stay identical;
		// durable history necessarily grows by one genuine issue each iteration.
		for (const ordinal of [1, 2, 3] as const) {
			const senderBefore = ordinal === 1 ? before : await zone(creator), receiverBefore = await zone(receiver);
			const position = senderBefore.transientPositions[creatorEnrollment.localPeerId]!;
			expect(receiverBefore.transientPositions[creatorEnrollment.localPeerId]).toEqual(position);
			expect(senderBefore.durableVertexCount).toBe(before.durableVertexCount + ordinal - 1);
			expect(receiverBefore.durableVertexCount).toBe(senderBefore.durableVertexCount);
			await start();
			const placementRequest = request("placeBlock-evaluate");
			const placing = creator.evaluate(async () => {
				const owner = Reflect.get(globalThis, "__D9346MovementObservation"); owner.begin();
				try {await window.__TS_DRP_V3_ZONE__!.placeBlock({id: "bounded-movement-load", kind: "stone", x: 7, y: 11});}
				finally {owner.complete();}
			});
			const placement = placing.then(() => ({ok: true}), error => ({ok: false, error: String(error)})).finally(() => {placementRequest.completedAt = performance.now();});
			await creator.waitForFunction(() => Reflect.get(globalThis, "__D9346MovementObservation").started);
			const placementInputRequest = request("keyboard-w");
			await creator.keyboard.press("w"); placementInputRequest.completedAt = performance.now(); expect(await placement).toEqual({ok: true});
			const expectedPosition = {x: position.x, y: position.y + 1};
			await expect.poll(async () => (await zone(receiver)).transientPositions[creatorEnrollment.localPeerId]).toEqual(expectedPosition);
			await expect.poll(async () => (await zone(receiver)).blocks).toEqual([{id: "bounded-movement-load", kind: "stone", x: 7, y: 11}]);
			const [senderAfter, receiverAfter] = await Promise.all([zone(creator), zone(receiver)]);
			for (const value of [senderAfter, receiverAfter]) {
				expect(value.durableVertexCount).toBe(before.durableVertexCount + ordinal);
				expect(value.outcomeContext?.epoch).toBe(0); expect(value.zoneId).toBe(before.zoneId);
				expect(value.transportPeerAuthors).toEqual(before.transportPeerAuthors);
				expect(value.blocks).toEqual([{id: "bounded-movement-load", kind: "stone", x: 7, y: 11}]);
				expect(value.transientPositions[creatorEnrollment.localPeerId]).toEqual(expectedPosition);
			}
			expect(senderAfter.acceptedOperationDigest).toBe(receiverAfter.acceptedOperationDigest);
			expect(senderAfter.acceptedOperationDigest).not.toBe(senderBefore.acceptedOperationDigest);
			expect(senderAfter.rawTransport.sent).toBeGreaterThan(senderBefore.rawTransport.sent);
			expect(receiverAfter.rawTransport.received).toBeGreaterThan(receiverBefore.rawTransport.received);
			await expectReciprocalRawUnreliableLinks(creator, receiver, creatorEnrollment.localPeerId, receiverEnrollment.localPeerId);
			await expect(creator.locator('[data-block-id="bounded-movement-load"]')).toBeVisible();
			await expect(receiver.locator('[data-block-id="bounded-movement-load"]')).toBeVisible();
			await stop(ordinal === 1 ? "ordinary-placement-and-transient-movement" : `ordinary-placement-and-transient-movement-${ordinal}`,
				{ordinal, temperature: ordinal === 1 ? "first-measured-placement" : "same-epoch-repeat",
					epoch: 0, placementCalls: 1, requestedKeydowns: 1,
					durableBefore: senderBefore.durableVertexCount, durableAfter: senderAfter.durableVertexCount,
					localMovementSteps: senderAfter.transientPositions[creatorEnrollment.localPeerId]!.y - position.y,
					remoteMovementSteps: receiverAfter.transientPositions[creatorEnrollment.localPeerId]!.y - receiverBefore.transientPositions[creatorEnrollment.localPeerId]!.y});
		}

		const rolloverPosition = (await zone(creator)).transientPositions[creatorEnrollment.localPeerId]!;
		const rolloverProbeLimit = 64, postInstallProbeCount = 3, requestedProbeIntervalMs = 50;
		let probeSequence = 0, probePhase = "creator-rollover", probeBudgetReached = false;
		const probeMovement = async (requestedPhase: string): Promise<void> => {
			const sequence = ++probeSequence;
			await Promise.all([creator, receiver].map(page => page.evaluate(({sequence, requestedPhase, x, y}) =>
				Reflect.get(globalThis, "__D9346MovementObservation").armProbe(sequence, requestedPhase, x, y),
				{sequence, requestedPhase, x: rolloverPosition.x + sequence, y: rolloverPosition.y})));
			const inputRequest = request("rollover-movement-d-" + sequence);
			await creator.keyboard.press("d"); inputRequest.completedAt = performance.now();
		};
		await start();
		const adoptionRequest = request("seal-export-adopt-evaluate");
		const adopting = creator.evaluate(async () => {
			const owner = Reflect.get(globalThis, "__D9346MovementObservation"), api = window.__TS_DRP_V3_ZONE__!;
			owner.begin();
			try {
				let close!: Awaited<ReturnType<typeof api.sealEpoch>>, offer!: Awaited<ReturnType<typeof api.exportCreatorSuccessor>>;
				owner.stage("creator-seal", "start");
				try {close = await api.sealEpoch();} finally {owner.stage("creator-seal", "complete");}
				if (!close.ok) throw Error("D9346_HEALTHY_CLOSE_REFUSED");
				owner.stage("creator-export", "start");
				try {offer = await api.exportCreatorSuccessor();} finally {owner.stage("creator-export", "complete");}
				owner.stage("creator-adopt", "start");
				try {await api.adoptCreatorSuccessor();} finally {owner.stage("creator-adopt", "complete");}
				// Lossless DTO only. The recipient verifies these ORIGINAL signed
				// offer bytes; array conversion grants no local/portable authority.
				return {close: {ok: close.ok, epoch: close.epoch, successorEpoch: close.successorEpoch}, offer: {exactCanonicalCutValueBytes: Array.from(offer.exactCanonicalCutValueBytes),
					exactCanonicalCommitQcBytes: Array.from(offer.exactCanonicalCommitQcBytes),
					exactCanonicalTrustStateRecordBytes: Array.from(offer.exactCanonicalTrustStateRecordBytes),
					exactCanonicalSnapshotManifestBytes: Array.from(offer.exactCanonicalSnapshotManifestBytes)}};
			} finally {owner.complete();}
		});
		const adoption = adopting.then(value => ({ok: true as const, value}), error => ({ok: false as const, error: String(error)})).finally(() => {adoptionRequest.completedAt = performance.now();});
		await creator.waitForFunction(() => Reflect.get(globalThis, "__D9346MovementObservation").started);
		await probeMovement(probePhase); // Retain the original early rollover keydown, now numbered.
		rolloverProbesTask = (async (): Promise<void> => {
			while (!stopRolloverProbes && probeSequence < rolloverProbeLimit - postInstallProbeCount) {
				await new Promise<void>(resolve => setTimeout(resolve, requestedProbeIntervalMs));
				if (!stopRolloverProbes) await probeMovement(probePhase);
			}
			probeBudgetReached = !stopRolloverProbes && probeSequence === rolloverProbeLimit - postInstallProbeCount;
		})().catch(error => {rolloverProbeFailure = String(error);});
		const outcome = await adoption; expect(outcome.ok).toBe(true); if (!outcome.ok) throw Error(outcome.error);
		expect(outcome.value.close).toMatchObject({ok: true, epoch: 0, successorEpoch: 1});
		probePhase = "recipient-install";
		const recipientInstallRequest = request("recipient-install-evaluate");
		await receiver.evaluate(async ({offer, peer}) => {
			const owner = Reflect.get(globalThis, "__D9346MovementObservation");
			owner.begin(); owner.stage("recipient-install", "start");
			try {await window.__TS_DRP_V3_ZONE__!.installCreatorSuccessor({peers: [peer], offer: {
				exactCanonicalCutValueBytes: new Uint8Array(offer.exactCanonicalCutValueBytes),
				exactCanonicalCommitQcBytes: new Uint8Array(offer.exactCanonicalCommitQcBytes),
				exactCanonicalTrustStateRecordBytes: new Uint8Array(offer.exactCanonicalTrustStateRecordBytes),
				exactCanonicalSnapshotManifestBytes: new Uint8Array(offer.exactCanonicalSnapshotManifestBytes)}});}
			catch (error) {
				// Playwright's remote Error bridge omits AggregateError children.
				// Preserve bounded terminal diagnostics without retrying or bypassing
				// the original transfer/admission owner.
				const detail = (value: unknown, depth = 0): unknown => {
					if (value === null || typeof value !== "object") return String(value);
					if (depth === 4) return String(value);
					const errors = Reflect.get(value, "errors"), cause = Reflect.get(value, "cause");
					return {name: Reflect.get(value, "name"), message: Reflect.get(value, "message"), code: Reflect.get(value, "code"),
						...(cause === undefined ? {} : {cause: detail(cause, depth + 1)}),
						...(Array.isArray(errors) ? {errors: errors.slice(0, 8).map(child => detail(child, depth + 1))} : {})};
				};
				throw new Error("D9346_ORIGINAL_TRANSFER_FAILURE " + JSON.stringify(detail(error)), {cause: error});
			}
			finally {owner.stage("recipient-install", "complete"); owner.complete();}
		}, {offer: outcome.value.offer, peer: creatorEnrollment.localPeerId});
		recipientInstallRequest.completedAt = performance.now();
		await expect.poll(async () => (await zone(receiver)).blocks).toEqual((await zone(creator)).blocks);
		stopRolloverProbes = true; await rolloverProbesTask; expect(rolloverProbeFailure).toBeUndefined();
		await Promise.all([creator, receiver].map(page => page.evaluate(() =>
			Reflect.get(globalThis, "__D9346MovementObservation").stage("post-recipient-adoption", "start"))));
		for (let count = 0; count < postInstallProbeCount; count++) {
			await probeMovement("post-recipient-adoption");
			await new Promise<void>(resolve => setTimeout(resolve, requestedProbeIntervalMs));
		}
		await Promise.all([creator, receiver].map(page => page.evaluate(() =>
			Reflect.get(globalThis, "__D9346MovementObservation").stage("post-recipient-adoption", "complete"))));
		expect((await zone(creator)).transientPositions[creatorEnrollment.localPeerId]).toEqual({x: rolloverPosition.x + probeSequence, y: rolloverPosition.y});
		await stop("healthy-seal-export-adopt-install-authority-gap", {requestedProbes: probeSequence, probeLimit: rolloverProbeLimit,
			postInstallProbeCount, requestedProbeIntervalMs, probeBudgetReached,
			qualification: "Controller-requested cadence and phase are not browser execution deadlines. Actual inputStage and each lifecycle bracket use that browser's own monotonic clock. Unique positions correlate delivery without decoding packets or synchronizing clocks. Unobserved/dropped positions during turnover are not acceptance failures; original post-install raw delivery assertion remains."});
		const after = await zone(creator);
		await expectOneMeasuredRawMovement({acceptedOperationDigest: after.acceptedOperationDigest, durableVertexCount: after.durableVertexCount,
			key: "w", sender: creator, receiver, senderPeerId: creatorEnrollment.localPeerId, receiverPeerId: receiverEnrollment.localPeerId});
		await receiver.evaluate(() => window.__TS_DRP_V3_ZONE__!.placeBlock({id: "bounded-post-rollover", kind: "wood", x: 13, y: 17}));
		await expect.poll(async () => (await zone(creator)).blocks.some(block => block.id === "bounded-post-rollover")).toBe(true);
	} finally {
		stopRolloverProbes = true; await rolloverProbesTask;
		if (profileSession !== undefined) {
			const stopRequestedAt = performance.now();
			try {
				const creatorBefore = await creatorClock(profileSession);
				const {profile} = await profileSession.send("Profiler.stop");
				const creatorAfter = await creatorClock(profileSession);
				const profileStopCreatorBracket = {before: creatorBefore, after: creatorAfter,
					uncertaintyMs: creatorAfter.now - creatorBefore.now};
				const body = Buffer.from(JSON.stringify(profile));
				if (body.byteLength > 16 * 1024 * 1024) throw Error("D9346_BOUNDED_CPU_PROFILE_TOO_LARGE");
				await info.attach("bounded-real-grid-creator-cpu", {body, contentType: "application/json"});
				evidence.push({phase: "test-only-cpu-profile", profileRequestedAt, profileStartedAt, stopRequestedAt,
					profileStartCreatorBracket, profileStopCreatorBracket,
					stoppedAt: performance.now(), bytes: body.byteLength, samples: profile.samples?.length ?? 0,
					qualification: "One creator renderer target; 1000-microsecond sampling, not call counts or product-only CPU. Start/stop are bracketed by Runtime.evaluate on this same target: each full bracket width is timing uncertainty, not an exact alignment of profiler and performance clocks. timeOrigin must remain identical before mapping sample offsets conservatively into creator long-task intervals. Includes original assertions, transport and observations. Samples cannot measure waits, GC duration or physical presentation. Paired unprofiled confirmation remains required."});
			} catch (error) {evidence.push({phase: "test-only-cpu-profile-failed", error: String(error)});}
			finally {await profileSession.detach();}
		}
		const terminal = await Promise.allSettled([creator, receiver].map(page => page.evaluate(() => Reflect.get(globalThis, "__D9346MovementObservation").stop())));
		if (terminal.some(row => row.status === "fulfilled" && row.value.activeAtStop)) evidence.push({phase: "in-flight-terminal-observation", terminal, commandRequests, controllerTimeOrigin: performance.timeOrigin});
		await info.attach("bounded-real-grid-movement-and-rollover", {body: Buffer.from(JSON.stringify({clients: 2, evidence,
			qualification: "Instrumented desktop-browser observation, not a 64-writer/FPS/device target. Three serial identical placements precede rollover: first measured placement versus same-epoch repeats, not cold-device versus warm-device isolation; durable history grows by one genuine issued operation each time. One requested/observed creator keydown and one local/remote movement step per placement; raw counters only establish advancement, not exact packet counts. Rollover adds at most64 numbered absolute-position probes at a controller-requested50 ms cadence, reserving3 after recipient installation; cadence is not a browser deadline, wire sequence or loss guarantee and adds observation/input workload. Creator seal/export/adopt and recipient install have separate browser-local stage brackets. Browser and controller monotonic timestamps have their own reported timeOrigin; do not subtract unaligned clocks. Actual input stage/pending state classifies each input; the headline overlap concerns only the last keydown. RTC send/message entries are raw handoff/receipt; matching DOM position is local observation, not physical presentation or authenticated packet identity. rAF is a frame opportunity; gaps include visibility/scheduling. Trace rows remain128 with exact dropped counts; separate bounded stage/probe records and rAF interval/tail scalars survive trace truncation, without claiming unseen presentation. Movement during the original authority gap may lawfully drop; unobserved probes are not delivery success and original genuine post-install delivery remains required. placeBlock completion includes publication ACK."})), contentType: "application/json"});
		await Promise.allSettled([creator, receiver].map(page => page.evaluate(() => window.__TS_DRP_V3_ZONE__?.close())));
		await Promise.allSettled(contexts.map(context => context.close()));
		await processCpuSession?.detach();
	}
});

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * D9346_ROOM_WORKER opts the two-client scenario's pages into the room worker (`?roomWorker`):
 * "both", or one role ("creator" or "joiner") for a main-thread tab beside a worker tab. Unset,
 * every page runs the zone on the main thread, as before.
 */
const ROOM_WORKER_ROLES = process.env.D9346_ROOM_WORKER ?? "";

async function openGrid(page: Page, role?: "creator" | "joiner"): Promise<void> {
	const worker = role !== undefined && (ROOM_WORKER_ROLES === "both" || ROOM_WORKER_ROLES === role);
	await page.goto(worker ? "/?roomWorker" : "/");
	if (worker) await page.waitForFunction(() => window.__TS_DRP_GRID_ROOM_WORKER__ !== undefined);
	await page.waitForFunction(() => window.__TS_DRP_GRID_SESSION__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined, undefined, { timeout: 10_000 });
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("D9346_V3_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function networkSnapshot(page: Page): Promise<NetworkSnapshot> {
	return page.evaluate(() => {
		const session = window.__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("D9346_GRID_NETWORK_SESSION_ABSENT");
		return session.snapshot();
	});
}

async function expectReciprocalRawUnreliableLinks(
	sender: Page,
	receiver: Page,
	senderPeerId: string,
	receiverPeerId: string
): Promise<void> {
	await expect
		.poll(async () => (await zone(sender)).rawTransport.links)
		.toEqual([{ label: "ts-drp-ephemeral/1", maxRetransmits: 0, ordered: false, peerId: receiverPeerId }]);
	await expect
		.poll(async () => (await zone(receiver)).rawTransport.links)
		.toEqual([{ label: "ts-drp-ephemeral/1", maxRetransmits: 0, ordered: false, peerId: senderPeerId }]);
	expect((await zone(sender)).rawTransport.fallbackCount).toBe(0);
	expect((await zone(receiver)).rawTransport.fallbackCount).toBe(0);
}

async function expectOneMeasuredRawMovement(input: {
	readonly acceptedOperationDigest: string;
	readonly durableVertexCount: number;
	readonly key: string;
	readonly receiver: Page;
	readonly receiverPeerId: string;
	readonly sender: Page;
	readonly senderPeerId: string;
}): Promise<void> {
	await expectReciprocalRawUnreliableLinks(input.sender, input.receiver, input.senderPeerId, input.receiverPeerId);
	await input.sender.evaluate(() => {
		const selected = document.activeElement;
		if (selected instanceof HTMLElement) selected.blur();
	});
	expect(
		await input.sender.evaluate(() => {
			const selected = document.activeElement;
			return !(
				selected instanceof HTMLInputElement ||
				selected instanceof HTMLTextAreaElement ||
				selected instanceof HTMLSelectElement
			);
		})
	).toBe(true);
	const [senderBefore, receiverBefore] = await Promise.all([zone(input.sender), zone(input.receiver)]);
	const positionBefore = receiverBefore.transientPositions[input.senderPeerId];
	await input.sender.keyboard.press(input.key);
	await expect
		.poll(async () => {
			const [senderAfter, receiverAfter] = await Promise.all([zone(input.sender), zone(input.receiver)]);
			return {
				positionChanged:
					JSON.stringify(receiverAfter.transientPositions[input.senderPeerId]) !== JSON.stringify(positionBefore),
				receivedAdvanced: receiverAfter.rawTransport.received > receiverBefore.rawTransport.received,
				sentAdvanced: senderAfter.rawTransport.sent > senderBefore.rawTransport.sent,
			};
		})
		.toEqual({ positionChanged: true, receivedAdvanced: true, sentAdvanced: true });
	for (const observed of await Promise.all([zone(input.sender), zone(input.receiver)])) {
		expect(observed.durableVertexCount).toBe(input.durableVertexCount);
		expect(observed.acceptedOperationDigest).toBe(input.acceptedOperationDigest);
	}
}

function expectWithinInstalledBudget(snapshot: NetworkSnapshot): void {
	expect(snapshot.connectionBudget).toEqual({ maxConnections: 48, maxParallelDials: 6, role: "browser" });
	expect(snapshot.connections.length).toBeLessThanOrEqual(snapshot.connectionBudget.maxConnections);
}

test("two real network clients recover and converge one durable v3 zone while movement stays transient", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext, joinerContext]);
	const creator = await creatorContext.newPage();
	let joiner = await joinerContext.newPage();
	try {
		await Promise.all([openGrid(creator, "creator"), openGrid(joiner, "joiner")]);
		const [creatorNetwork, joinerNetwork] = await Promise.all([networkSnapshot(creator), networkSnapshot(joiner)]);
		expectWithinInstalledBudget(creatorNetwork);
		expectWithinInstalledBudget(joinerNetwork);
		const creatorPeerId = creatorNetwork.peerId;
		const joinerPeerId = joinerNetwork.peerId;
		const [creatorEnrollment, joinerEnrollment] = await Promise.all([zone(creator), zone(joiner)]);
		expect(creatorEnrollment.ready).toBe(false);
		expect(joinerEnrollment.ready).toBe(false);
		expect(creatorEnrollment.localPeerId).toBe(creatorPeerId);
		expect(joinerEnrollment.localPeerId).toBe(joinerPeerId);
		expect(creatorEnrollment.localAuthor).toMatch(DIGEST);
		expect(joinerEnrollment.localAuthor).toMatch(DIGEST);
		expect(creatorEnrollment.enrollment).not.toBe(joinerEnrollment.enrollment);
		expect(creatorEnrollment.transientPositions).toEqual({});
		expect(joinerEnrollment.transientPositions).toEqual({});

		await creator.fill("#zoneMemberEnrollment", joinerEnrollment.enrollment);
		await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		const created = await zone(creator);
		expect(created.zoneId).toMatch(new RegExp(`^${escaped(creatorPeerId)}:[0-9a-f]{32}$`, "u"));
		expect(created.invite).toMatch(/^[0-9a-f]+$/u);
		expect(created.durableVertexCount).toBe(1);
		expect(created.transportPeerAuthors).toEqual([
			{ author: creatorEnrollment.localAuthor, peerId: creatorPeerId },
			{ author: joinerEnrollment.localAuthor, peerId: joinerPeerId },
		]);

		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(created.zoneId);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(joiner)).durableVertexCount).toBe(2);
		expect((await zone(joiner)).transportPeerAuthors).toEqual(created.transportPeerAuthors);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(creator)).rawTransport.fallbackCount).toBe(0);
		expect((await zone(joiner)).rawTransport.fallbackCount).toBe(0);

		await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "spawn", kind: "stone", x: 2, y: 3 }));
		await expect.poll(async () => (await zone(creator)).blocks).toEqual([{ id: "spawn", kind: "stone", x: 2, y: 3 }]);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual([{ id: "spawn", kind: "stone", x: 2, y: 3 }]);
		await expect(creator.locator('[data-block-id="spawn"]')).toBeVisible();
		await expect(joiner.locator('[data-block-id="spawn"]')).toBeVisible();

		const afterBlock = await zone(creator);
		const joinedAfterBlock = await zone(joiner);
		expect(afterBlock.acceptedOperationDigest).toMatch(DIGEST);
		expect(joinedAfterBlock.acceptedOperationDigest).toBe(afterBlock.acceptedOperationDigest);
		expect(afterBlock.durableVertexCount).toBe(3);
		expect(joinedAfterBlock.durableVertexCount).toBe(3);
		await expectOneMeasuredRawMovement({
			acceptedOperationDigest: afterBlock.acceptedOperationDigest,
			durableVertexCount: afterBlock.durableVertexCount,
			key: "w",
			receiver: joiner,
			receiverPeerId: joinerPeerId,
			sender: creator,
			senderPeerId: creatorPeerId,
		});
		await expectOneMeasuredRawMovement({
			acceptedOperationDigest: afterBlock.acceptedOperationDigest,
			durableVertexCount: afterBlock.durableVertexCount,
			key: "d",
			receiver: creator,
			receiverPeerId: creatorPeerId,
			sender: joiner,
			senderPeerId: joinerPeerId,
		});

		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "offline", kind: "wood", x: 5, y: 8 }));
		await expect.poll(async () => (await zone(creator)).blocks).toHaveLength(2);
		const afterOfflineProgress = await zone(creator);
		expect(afterOfflineProgress.durableVertexCount).toBe(afterBlock.durableVertexCount + 1);
		expect(afterOfflineProgress.acceptedOperationDigest).not.toBe(afterBlock.acceptedOperationDigest);
		await expect(creator.locator('[data-block-id="offline"]')).toBeVisible();

		joiner = await joinerContext.newPage();
		await openGrid(joiner, "joiner");
		const reopened = await zone(joiner);
		expect(reopened.enrollment).toBe(joinerEnrollment.enrollment);
		expect(reopened.localAuthor).toBe(joinerEnrollment.localAuthor);
		expect(reopened.localPeerId).toBe(joinerPeerId);
		expect(reopened.transientPositions).toEqual({});
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		expect((await zone(joiner)).rawTransport.fallbackCount).toBe(0);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(joiner)).transientPositions).toEqual({});
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount);
		await expect(joiner.locator('[data-block-id="offline"]')).toBeVisible();

		await expectOneMeasuredRawMovement({
			acceptedOperationDigest: afterOfflineProgress.acceptedOperationDigest,
			durableVertexCount: afterOfflineProgress.durableVertexCount,
			key: "a",
			receiver: joiner,
			receiverPeerId: joinerPeerId,
			sender: creator,
			senderPeerId: creatorPeerId,
		});

		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "rejoined", kind: "glass", x: 13, y: 21 }));
		await expect.poll(async () => (await zone(creator)).blocks).toHaveLength(3);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		expect((await zone(creator)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount + 1);
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount + 1);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(joiner)).acceptedOperationDigest).not.toBe(afterOfflineProgress.acceptedOperationDigest);
		await expect(creator.locator('[data-block-id="rejoined"]')).toBeVisible();
		await expect(joiner.locator('[data-block-id="rejoined"]')).toBeVisible();

		await expect(joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.rehearseMigration())).rejects.toThrow();
		const rehearsal = await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.rehearseMigration());
		expect(rehearsal).toMatchObject({ activated: false, importedOperationCount: 3 });
		expect(rehearsal?.applicationStateDigest).toMatch(DIGEST);
		expect(rehearsal?.recordDigest).toMatch(DIGEST);
		expect(rehearsal?.recordVertexDigest).toMatch(DIGEST);
		expect(rehearsal?.targetAnchorDigest).toMatch(DIGEST);
		if (rehearsal === undefined) throw new TypeError("zone migration rehearsal is absent");
		const record = decodeCanonical(rehearsal.exactCanonicalRecordBytes);
		const targetObjectId = Reflect.get(record as object, "targetObjectId");
		expect(targetObjectId).toMatch(/^.+:[0-9a-f]{32}$/u);
		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		const activation = await creator.evaluate(
			(receipt) => window.__TS_DRP_V3_ZONE__?.activateMigration(receipt),
			rehearsal
		);
		expect(activation).toMatchObject({
			activated: true,
			activationDecisionDigest: expect.stringMatching(DIGEST),
			activationVertexDigest: expect.stringMatching(DIGEST),
			targetAnchorDigest: rehearsal.targetAnchorDigest,
		});
		await expect.poll(async () => (await zone(creator)).zoneId).toBe(targetObjectId);
		joiner = await joinerContext.newPage();
		await openGrid(joiner, "joiner");
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(targetObjectId);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		await joiner.evaluate(() =>
			window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "target-suffix", kind: "gold", x: 34, y: 55 })
		);
		await expect
			.poll(async () => (await zone(creator)).blocks)
			.toContainEqual({
				id: "target-suffix",
				kind: "gold",
				x: 34,
				y: 55,
			});
		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		joiner = await joinerContext.newPage();
		await openGrid(joiner, "joiner");
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(targetObjectId);
		await expect
			.poll(async () => (await zone(joiner)).blocks)
			.toContainEqual({
				id: "target-suffix",
				kind: "gold",
				x: 34,
				y: 55,
			});
	} finally {
		await Promise.allSettled([
			creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
			joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
		]);
		await Promise.allSettled([creator.close(), joiner.close(), creatorContext.close(), joinerContext.close()]);
	}
});
