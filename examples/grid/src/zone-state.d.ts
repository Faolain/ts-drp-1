import type { OutcomeCommitAdmissionOperation } from "@ts-drp/outcome-commit";

export interface ZoneState {
	readonly version: 1;
	readonly blocks: readonly Readonly<{
		readonly id: string;
		readonly kind: string;
		readonly x: number;
		readonly y: number;
	}>[];
	readonly outcomes: readonly OutcomeCommitAdmissionOperation[];
	readonly roster: readonly Readonly<{ readonly author: string; readonly peerId: string; readonly order: number }>[];
}

export interface ZoneStateKernel {
	apply(
		state: ZoneState,
		operation: Readonly<Record<string, unknown>>,
		author?: string
	): Readonly<{ readonly state: ZoneState; readonly output: unknown }>;
	captureState(value: unknown): ZoneState;
	blockForOperation(operation: unknown): ZoneState["blocks"][number] | undefined;
	readonly reducers: Readonly<
		Record<
			string,
			(
				input: Readonly<{
					readonly state: ZoneState;
					readonly operation: Readonly<Record<string, unknown>>;
					readonly executionContext?: Readonly<{ readonly author: string }>;
				}>
			) => Readonly<{ readonly state: ZoneState; readonly output: unknown }>
		>
	>;
}

export function createZoneStateKernel(creatorAuthor: string, creatorPeerId: string): ZoneStateKernel;
export function emptyZoneState(): ZoneState;
