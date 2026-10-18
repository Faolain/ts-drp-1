export const blueprint = {
	reducers: {
		add: ({ state, operation }) => {
			const total = state.total + operation.value;
			return { output: total, state: { total } };
		},
	},
};
