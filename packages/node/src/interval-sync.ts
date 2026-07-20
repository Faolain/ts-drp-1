import { IntervalRunner } from "@ts-drp/interval-runner";
import { creatorFromObjectID, HashGraph } from "@ts-drp/object";
import { IntervalRunnerState, type LoggerOptions } from "@ts-drp/types";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";

/**
 * While an object still has no non-root vertex (a joiner that has not yet
 * received the creator's history), SYNC is retried against a group peer this
 * often. Once real history is merged the fast retry self-terminates and
 * periodic anti-entropy takes over.
 */
export const INITIAL_SYNC_RETRY_INTERVAL_MS = 1_000;

export interface DRPIntervalSyncOptions {
	id: string;
	node: DRPNode;
	interval?: number;
	logConfig?: LoggerOptions;
}

/** Periodically probes one object peer with the full local vertex-hash inventory (O(|V|)). */
export class DRPIntervalSync {
	readonly type = "interval:sync";
	readonly id: string;
	readonly interval: number;

	private readonly node: DRPNode;
	private readonly intervalRunner: IntervalRunner;
	// Fast retry for the initial sync: while the object has no non-root history
	// and a group peer is visible, probe every INITIAL_SYNC_RETRY_INTERVAL_MS
	// instead of waiting a full anti-entropy interval. Self-terminates once the
	// first non-root vertex is merged. Only created when it would actually be
	// faster than the anti-entropy interval itself.
	private readonly initialSyncRunner?: IntervalRunner;
	private initialSyncWarmedUp = false;
	private peerCursor?: number;

	/**
	 * Current interval runner state.
	 * @returns Whether the runner is stopped or running
	 */
	get state(): IntervalRunnerState {
		return this.intervalRunner.state;
	}

	/**
	 * Create an interval sync for one object.
	 * @param options - Object, node, and interval configuration
	 */
	constructor(options: DRPIntervalSyncOptions) {
		const { id, node, interval, logConfig } = options;
		this.id = id;
		this.node = node;
		this.intervalRunner = new IntervalRunner({
			id,
			interval,
			logConfig,
			fn: this.run.bind(this),
			throwOnStop: false,
		});
		this.interval = this.intervalRunner.interval;
		// Only a joined replica (creator-bound id committing to somebody else's
		// peer id) fast-retries: its empty hashgraph means the creator's history
		// is still missing. A creator's empty object is legitimately empty, and
		// ids without a creator commitment predate the creator-bound model.
		const creator = creatorFromObjectID(id);
		const isJoinedReplica = creator !== undefined && creator !== node.networkNode.peerId;
		if (isJoinedReplica && this.interval > INITIAL_SYNC_RETRY_INTERVAL_MS) {
			this.initialSyncRunner = new IntervalRunner({
				id: `initial-sync::${id}`,
				interval: INITIAL_SYNC_RETRY_INTERVAL_MS,
				logConfig,
				fn: this.runInitialSync.bind(this),
				throwOnStop: false,
			});
		}
	}

	/** Start probing immediately, then at the configured interval. */
	start(): void {
		this.intervalRunner.start();
		if (this.initialSyncRunner?.state === IntervalRunnerState.Stopped) {
			this.initialSyncWarmedUp = false;
			this.initialSyncRunner.start();
		}
	}

	/** Stop future probes, including any pending initial-sync fast retry. */
	stop(): void {
		this.intervalRunner.stop();
		this.initialSyncRunner?.stop();
	}

	/**
	 * One fast-retry tick. Returning false stops the runner for good: the
	 * object is gone (unsubscribed) or holds real history (synced). The first
	 * tick never probes — start() already issues an immediate anti-entropy
	 * probe, so the fast path begins one short interval later.
	 * @returns Whether the fast retry should keep running
	 */
	private async runInitialSync(): Promise<boolean> {
		const object = this.node.get(this.id);
		if (!object) return false;
		if (object.vertices.some((vertex) => vertex.hash !== HashGraph.rootHash)) return false;
		if (!this.initialSyncWarmedUp) {
			this.initialSyncWarmedUp = true;
			return true;
		}
		try {
			const peer = this.nextPeer();
			if (peer === undefined) return true;
			await this.node.syncObject(this.id, peer);
		} catch (error) {
			log.error("::initialSync: Fast retry failed", error);
		}
		return true;
	}

	private async run(): Promise<boolean> {
		try {
			const peer = this.nextPeer();
			if (peer === undefined) return true;
			await this.node.syncObject(this.id, peer);
		} catch (error) {
			log.error("::intervalSync: Probe failed", error);
		}
		return true;
	}

	/**
	 * For a stable membership set, rotate through every peer before repeating
	 * one. A randomized starting offset prevents nodes created together from
	 * concentrating each tick on the same lexicographically first peer.
	 */
	private nextPeer(): string | undefined {
		const peers = this.node.networkNode.getGroupPeers(this.id).sort();
		if (peers.length === 0) return undefined;

		this.peerCursor ??= Math.floor(Math.random() * peers.length);
		const peer = peers[this.peerCursor % peers.length];
		// Advance before sending so one unreachable peer cannot stall the cycle;
		// a failed peer is retried after the remaining peers have been probed.
		this.peerCursor = (this.peerCursor + 1) % peers.length;
		return peer;
	}
}

/**
 * Create an interval sync for one object.
 * @param options - Object, node, and interval configuration
 * @returns A stoppable periodic sync runner
 */
export function createDRPIntervalSync(options: DRPIntervalSyncOptions): DRPIntervalSync {
	return new DRPIntervalSync(options);
}
