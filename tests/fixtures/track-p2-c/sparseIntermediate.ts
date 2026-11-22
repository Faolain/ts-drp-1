const sparseReducer = ({ state }) => {
	const sparse = [];
	sparse[1] = state;
	return { output: null, state: sparse };
};
const unchangedReducer = ({ state }) => ({ output: null, state });
