interface AddOperation {
	value: number;
}

interface CounterState {
	total: number;
}

interface ReducerInput {
	operation: AddOperation;
	state: CounterState;
}

export function add({ state, operation }: ReducerInput): { output: number; state: CounterState } {
	const total = state.total + operation.value;
	return { output: total, state: { total } };
}

export function optionalValue(value: number | undefined): number {
	return value === undefined ? 0 : value;
}
