const closedState = (state, changes) => ({
	map: Object.hasOwn(changes, "map") ? changes.map : state.map,
	set: Object.hasOwn(changes, "set") ? changes.set : state.set,
	total: Object.hasOwn(changes, "total") ? changes.total : state.total,
});

const addMul = ({ operation, state }) => {
	const total = (state.total + operation.add) * operation.multiplier;
	return { state: closedState(state, { total }), output: total };
};

const emit = ({ operation, state }) => ({ state, output: operation.value });

const malformedAccessor = ({ state }) =>
	Object.defineProperty({ output: null }, "state", { enumerable: true, get: () => state });

const malformedExtra = ({ state }) => ({ extra: true, output: null, state });

const malformedInherited = ({ state }) => Object.assign(Object.create({ output: null }), { state });

const malformedSymbol = ({ state }) => ({ output: null, state, [Symbol("extra")]: true });

const mapSet = ({ operation, state }) => {
	const map = { ...state.map, [operation.key]: operation.value };
	return { state: closedState(state, { map }), output: operation.value };
};

const mutateBytes = ({ operation, state }) => {
	operation.value.bytes[0] = 255;
	return { state, output: operation.value };
};

const mutateBytesThenThrow = ({ operation }) => {
	operation.value.bytes[0] = 255;
	throw new Error("fixture byte-carrier mutation failure");
};

const mutateInputs = ({ operation, state }) => {
	state.total = operation.value;
	operation.value = -1;
	return { state: closedState(state, { total: state.total }), output: state.total };
};

const mutateThenThrow = ({ operation, state }) => {
	state.total = operation.value;
	operation.value = -1;
	throw new Error("fixture mutate-then-throw failure");
};

const replaceState = ({ operation }) => ({ state: operation.value, output: null });

const returnPromise = ({ state }) => Promise.resolve({ state, output: null });

const returnThenable = ({ state }) => ({ state, output: null, then() {} });

const setAdd = ({ operation, state }) => {
	const set = state.set.includes(operation.value) ? state.set : [...state.set, operation.value];
	return { state: closedState(state, { set }), output: operation.value };
};

const throwSync = () => {
	throw new Error("fixture reducer failure");
};

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/phase-4a-blueprint@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		add_mul: addMul,
		emit,
		malformed_accessor: malformedAccessor,
		malformed_extra: malformedExtra,
		malformed_inherited: malformedInherited,
		malformed_symbol: malformedSymbol,
		map_set: mapSet,
		mutate_bytes: mutateBytes,
		mutate_bytes_then_throw: mutateBytesThenThrow,
		mutate_inputs: mutateInputs,
		mutate_then_throw: mutateThenThrow,
		replace_state: replaceState,
		return_promise: returnPromise,
		return_thenable: returnThenable,
		set_add: setAdd,
		throw_sync: throwSync,
	},
};
