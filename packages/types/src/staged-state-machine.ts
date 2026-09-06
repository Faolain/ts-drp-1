/**
 * A deterministic state machine whose changes remain isolated until adoption.
 *
 * Implementations must return detached snapshots and forks. Adoption is an
 * explicit, implementation-defined one-use transition.
 */
export interface IStagedStateMachine<Snapshot, Operation, Output> {
	adopt(staged: IStagedStateMachine<Snapshot, Operation, Output>): Snapshot;
	apply(operation: Operation): Output;
	fork(): IStagedStateMachine<Snapshot, Operation, Output>;
	snapshot(): Snapshot;
}
