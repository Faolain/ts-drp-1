const thenableReducer = () => ({
	then(resolve) {
		resolve({ output: null, state: 0 });
	},
});
const unchangedReducer = ({ state }) => ({ output: null, state });
