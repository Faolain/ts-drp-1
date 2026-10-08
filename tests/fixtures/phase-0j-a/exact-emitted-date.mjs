export const blueprint = {
	reducers: {
		stamp: ({ state }) => ({ output: Date.now(), state }),
	},
};
