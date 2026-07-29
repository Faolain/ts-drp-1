/* eslint-disable @typescript-eslint/explicit-function-return-type */

const append = ({ state, operation }) => {
	if (operation.arguments.value !== "start😀") return { state, output: null };
	const sparse = [];
	sparse[1] = "present";
	return {
		state: {
			messages: state.messages,
			settings: state.settings,
			sparseIntermediate: sparse,
		},
		output: null,
	};
};

const set = ({ state, operation }) => ({
	state: {
		messages: state.messages,
		settings: { ...state.settings, [operation.arguments.key]: operation.arguments.value },
	},
	output: { sparseIntermediateRemoved: state.sparseIntermediate?.length === 2 },
});

const setMessage = ({ state, operation }) => ({
	state: {
		messages: state.messages.map((message, index) =>
			index === operation.arguments.index ? operation.arguments.value : message
		),
		settings: state.settings,
	},
	output: null,
});

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-sparse-intermediate@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append,
		set,
		set_message: setMessage,
	},
};
