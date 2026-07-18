import { IntervalRunner } from "@ts-drp/interval-runner";
import { type IntervalRunnerState, type LoggerOptions } from "@ts-drp/types";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";

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
	}

	/** Start probing immediately, then at the configured interval. */
	start(): void {
		this.intervalRunner.start();
	}

	/** Stop future probes. */
	stop(): void {
		this.intervalRunner.stop();
	}

	private async run(): Promise<boolean> {
		try {
			const peers = this.node.networkNode.getGroupPeers(this.id);
			if (peers.length === 0) return true;

			const peer = peers[Math.floor(Math.random() * peers.length)];
			await this.node.syncObject(this.id, peer);
		} catch (error) {
			log.error("::intervalSync: Probe failed", error);
		}
		return true;
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
