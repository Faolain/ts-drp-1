type ReducerInput = { readonly arguments: { readonly value?: number }; readonly state: number };

function addReducer(input: ReducerInput): { readonly output: number; readonly state: number } {
	const value = input.arguments.value ?? 1;
	const state = input.state + value;
	return { output: state, state };
}

function readReducer(input: ReducerInput): { readonly output: number; readonly state: number } {
	return { output: input.state, state: input.state };
}

function setReducer(input: ReducerInput): { readonly output: number; readonly state: number } {
	const state = input.arguments.value ?? 0;
	return { output: state, state };
}
