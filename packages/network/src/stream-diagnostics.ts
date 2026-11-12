// MEASUREMENT ONLY (track 46, network stream reuse): opt-in counters and timings for libp2p stream
// opens. Off unless `globalThis.__DRP_STREAM_DIAGNOSTICS__ === true` or the Node environment sets
// DRP_STREAM_DIAGNOSTICS=1; when off every hook is one boolean check. The store lives on globalThis so
// every DRPNetworkNode in one realm (several in-process peers, or one browser page) shares it; a page
// harness reads `globalThis.__drpStreamDiagnostics`, a Node harness sets DRP_STREAM_DIAGNOSTICS_OUT to a
// file path that is rewritten every 5 s and on `flushStreamDiagnostics()`.
//
// Times are `performance.timeOrigin + performance.now()` (ms), comparable across pages of one browser
// and across peers of one process. A message is matched sender -> receiver by an FNV-1a hash of its
// encoded bytes plus their length.
import type { Connection, Stream } from "@libp2p/interface";

const SAMPLE_CAP = 100_000;

export interface StreamSendSample {
	readonly local: string;
	readonly remote: string;
	readonly protocol: string;
	readonly cls: string;
	readonly caller: string;
	readonly hash: string;
	readonly bytes: number;
	/** sendMessage entry. */
	readonly t0: number;
	/** connection resolved (existing or dialled). */
	dialed?: number;
	/** newStream resolved: muxer stream created and multistream-select finished. */
	opened?: number;
	/** the length-prefixed frame was accepted by the stream. */
	written?: number;
	/** the writable end closed (WebRTC: FIN_ACK or timeout). */
	closed?: number;
	error?: string;
}

export interface StreamReceiveSample {
	readonly local: string;
	readonly remote: string;
	readonly protocol: string;
	readonly hash?: string;
	cls?: string;
	/** handler entered (stream negotiated at this peer). */
	readonly entered: number;
	/** the frame was read and decoded. */
	framed?: number;
	/** the message queue admitted it. */
	admitted?: number;
	/** the stream closed at this end. */
	closed?: number;
	error?: string;
}

export interface StreamOpenSample {
	readonly local: string;
	readonly remote: string;
	readonly protocol: string;
	readonly caller: string;
	readonly t0: number;
	readonly ms: number;
	readonly ok: boolean;
}

interface Store {
	readonly startedAt: number;
	readonly opens: Record<string, number>;
	readonly openSamples: StreamOpenSample[];
	readonly sends: StreamSendSample[];
	readonly receives: StreamReceiveSample[];
	readonly dropped: Record<string, number>;
}

type DiagnosticsGlobal = typeof globalThis & {
	__DRP_STREAM_DIAGNOSTICS__?: boolean;
	__drpStreamDiagnostics?: Store;
	process?: { env?: Record<string, string | undefined>; getBuiltinModule?: (id: string) => unknown };
};

const root = globalThis as DiagnosticsGlobal;

export const streamDiagnosticsEnabled: boolean =
	root.__DRP_STREAM_DIAGNOSTICS__ === true || root.process?.env?.DRP_STREAM_DIAGNOSTICS === "1";

export function diagnosticsNow(): number {
	return performance.timeOrigin + performance.now();
}

function store(): Store {
	let current = root.__drpStreamDiagnostics;
	if (current === undefined) {
		current = { startedAt: diagnosticsNow(), opens: {}, openSamples: [], sends: [], receives: [], dropped: {} };
		root.__drpStreamDiagnostics = current;
		const out = root.process?.env?.DRP_STREAM_DIAGNOSTICS_OUT;
		if (out !== undefined && out !== "") {
			const timer = setInterval(flushStreamDiagnostics, 5_000) as unknown as { unref?: () => void };
			timer.unref?.();
		}
	}
	return current;
}

function push<T>(samples: T[], sample: T, kind: string): void {
	if (samples.length < SAMPLE_CAP) samples.push(sample);
	else {
		const dropped = store().dropped;
		dropped[kind] = (dropped[kind] ?? 0) + 1;
	}
}

export function flushStreamDiagnostics(): void {
	const out = root.process?.env?.DRP_STREAM_DIAGNOSTICS_OUT;
	const current = root.__drpStreamDiagnostics;
	if (out === undefined || out === "" || current === undefined) return;
	const fs = root.process?.getBuiltinModule?.("node:fs") as
		| { writeFileSync(path: string, data: string): void; renameSync(from: string, to: string): void }
		| undefined;
	if (fs === undefined) return;
	fs.writeFileSync(`${out}.tmp`, JSON.stringify({ ...current, flushedAt: diagnosticsNow() }));
	fs.renameSync(`${out}.tmp`, out);
}

const SKIP =
	/stream-diagnostics|callerOf|countOpen|sendMessage \(|sendSyncMessage|sendSyncResponseMessage|submitNegotiatedSync|sendSelectedSync|instrumentedNewStream|newStream|new Promise|Array\.map|Promise\.then|processTicksAndRejections|<anonymous>\)?$/;

/**
 * The first stack frame outside the network send path, as `function@file:line`.
 * @param stack - An Error stack captured at the send entry.
 * @returns A short caller label.
 */
export function callerOf(stack: string | undefined): string {
	const lines = (stack ?? "").split("\n").slice(1);
	for (const raw of lines) {
		const line = raw.trim();
		if (SKIP.test(line)) continue;
		const match = /^at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
		if (match === null) continue;
		const fn = (match[1] ?? "<anon>").replace(/^Object\./, "");
		const file = (match[2] ?? "").split(/[\\/]/).pop()?.split("?")[0] ?? "";
		return `${fn}@${file}:${match[3]}`;
	}
	return "<unknown>";
}

export function hashBytes(bytes: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < bytes.length; index++) {
		hash ^= bytes[index];
		hash = Math.imul(hash, 0x01000193);
	}
	return `${(hash >>> 0).toString(16)}:${bytes.length}`;
}

export function recordSend(sample: StreamSendSample): StreamSendSample {
	const current = store();
	const key = `${sample.local}|out|${sample.protocol}|${sample.cls}`;
	current.opens[key] = (current.opens[key] ?? 0) + 1;
	push(current.sends, sample, "sends");
	return sample;
}

export function recordReceive(sample: StreamReceiveSample): StreamReceiveSample {
	push(store().receives, sample, "receives");
	return sample;
}

export function countReceiveClass(sample: StreamReceiveSample, cls: string): void {
	sample.cls = cls;
	const current = store();
	const key = `${sample.local}|in|${sample.protocol}|${cls}`;
	current.opens[key] = (current.opens[key] ?? 0) + 1;
}

const instrumented = new WeakSet<Connection>();

/**
 * Wrap one connection's newStream so every outbound protocol stream (every protocol, every caller) is
 * counted and timed from the request to the negotiated stream.
 * @param local - Local peer id.
 * @param connection - A libp2p connection.
 */
export function instrumentConnection(local: string, connection: Connection): void {
	if (!streamDiagnosticsEnabled || instrumented.has(connection)) return;
	instrumented.add(connection);
	const original = connection.newStream.bind(connection);
	const remote = connection.remotePeer.toString();
	const instrumentedNewStream: Connection["newStream"] = async (protocols, options) => {
		const caller = callerOf(new Error().stack);
		const t0 = diagnosticsNow();
		const requested = Array.isArray(protocols) ? protocols.join(",") : String(protocols);
		const current = store();
		try {
			const stream: Stream = await original(protocols, options);
			const key = `${local}|open|${stream.protocol}|${caller}`;
			current.opens[key] = (current.opens[key] ?? 0) + 1;
			push(
				current.openSamples,
				{ local, remote, protocol: stream.protocol, caller, t0, ms: diagnosticsNow() - t0, ok: true },
				"openSamples"
			);
			return stream;
		} catch (error) {
			const key = `${local}|open-failed|${requested}|${caller}|${error instanceof Error ? error.name : "error"}`;
			current.opens[key] = (current.opens[key] ?? 0) + 1;
			push(
				current.openSamples,
				{ local, remote, protocol: requested, caller, t0, ms: diagnosticsNow() - t0, ok: false },
				"openSamples"
			);
			throw error;
		}
	};
	connection.newStream = instrumentedNewStream;
}
