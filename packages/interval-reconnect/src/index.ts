import { IntervalRunner } from "@ts-drp/interval-runner";
import {
	type DRPIntervalReconnectOptions,
	type DRPNetworkNode,
	type IDRPIntervalReconnectBootstrap,
	type IntervalRunnerState,
} from "@ts-drp/types";

/**
 * DRPIntervalReconnectBootstrap is a class that implements interval bootstrap reconnecting for the DRP network node.
 * It provides methods to start and stop the reconnect bootstrap.
 */
export class DRPIntervalReconnectBootstrap implements IDRPIntervalReconnectBootstrap {
	readonly type = "interval:reconnect";
	/** Network node instance used for peer communication */
	readonly networkNode: DRPNetworkNode;

	/** Delegate to handle the actual interval running */
	private _intervalRunner: IntervalRunner;

	/**
	 * Get the id of the interval runner
	 * @returns The id of the interval runner
	 */
	get id(): string {
		return this._intervalRunner.id;
	}

	/**
	 * Get the interval of the interval runner
	 * @returns The interval of the interval runner
	 */
	get interval(): number {
		return this._intervalRunner.interval;
	}

	/**
	 * Get the state of the interval runner
	 * @returns The state of the interval runner
	 */
	get state(): IntervalRunnerState {
		return this._intervalRunner.state;
	}

	/**
	 * Constructor for DRPIntervalReconnectBootstrap
	 * @param opts - The configuration for the reconnect bootstrap
	 */
	constructor(opts: DRPIntervalReconnectOptions) {
		this._intervalRunner = new IntervalRunner({
			...opts,
			fn: this._runDRPReconnect.bind(this),
			throwOnStop: false,
		});
		this.networkNode = opts.networkNode;
	}

	/**
	 * Start the reconnect bootstrap
	 * @param _args - The arguments to pass to the interval runner
	 */
	start(_args?: [] | undefined): void {
		this._intervalRunner.start();
	}

	/**
	 * Stop the reconnect bootstrap
	 */
	stop(): void {
		this._intervalRunner.stop();
	}

	private async _runDRPReconnect(): Promise<boolean> {
		await this.networkNode.connectToBootstraps();
		return true;
	}
}

/**
 * Create a new DRPIntervalReconnectBootstrap
 * @param opts - The configuration for the reconnect bootstrap
 * @returns A new DRPIntervalReconnectBootstrap instance
 */
export function createDRPReconnectBootstrap(opts: DRPIntervalReconnectOptions): DRPIntervalReconnectBootstrap {
	return new DRPIntervalReconnectBootstrap(opts);
}
