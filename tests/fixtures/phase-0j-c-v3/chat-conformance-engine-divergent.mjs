/* eslint-disable @typescript-eslint/explicit-function-return-type */

const engine = typeof document === "undefined" ? "node" : "browser";

const append = ({ state, operation }) => ({
	state: {
		engine,
		messages: [...state.messages, operation.arguments.value],
		settings: state.settings,
	},
	output: { engine, value: operation.arguments.value },
});

const set = ({ state, operation }) => ({
	state: {
		engine,
		messages: state.messages,
		settings: { ...state.settings, [operation.arguments.key]: operation.arguments.value },
	},
	output: { engine, key: operation.arguments.key },
});

const setMessage = ({ state, operation }) => ({
	state: {
		engine,
		messages: state.messages.map((message, index) =>
			index === operation.arguments.index ? operation.arguments.value : message
		),
		settings: state.settings,
	},
	output: { engine, index: operation.arguments.index },
});

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-engine-divergent@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append,
		set,
		set_message: setMessage,
	},
};
