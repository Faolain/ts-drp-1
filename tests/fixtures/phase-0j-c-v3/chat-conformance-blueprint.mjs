/* eslint-disable @typescript-eslint/explicit-function-return-type */

const append = ({ state, operation }) => {
	const arguments_ = operation.arguments;
	return {
		state: {
			detachmentProbe: -0,
			keyOrderProbe: { aa: 1, z: 2 },
			messages: [...state.messages, arguments_.value],
			settings: state.settings,
		},
		output: {
			nested: arguments_.nested ?? null,
			normalizedNegativeZero: arguments_.requestOrdinal === 0 && 1 / arguments_.requestOrdinal === Infinity,
			outputDetachmentProbe: -0,
			requestOrdinal: arguments_.requestOrdinal ?? null,
		},
	};
};

const set = ({ state, operation }) => {
	const nestedKeyOrder = [];
	for (const key in state.keyOrderProbe) nestedKeyOrder.push(key);
	return {
		state: {
			detachmentProbe: state.detachmentProbe,
			keyOrderProbe: state.keyOrderProbe,
			messages: state.messages,
			settings: { ...state.settings, [operation.arguments.key]: operation.arguments.value },
		},
		output: {
			key: operation.arguments.key,
			receivedCanonicalNestedKeyOrder: nestedKeyOrder.join(",") === "z,aa",
			receivedStateDetachmentProbe: state.detachmentProbe === 0 && 1 / state.detachmentProbe === Infinity,
			value: operation.arguments.value,
		},
	};
};

const setMessage = ({ state, operation }) => ({
	state: {
		detachmentProbe: state.detachmentProbe,
		keyOrderProbe: state.keyOrderProbe,
		messages: state.messages.map((message, index) =>
			index === operation.arguments.index ? operation.arguments.value : message
		),
		settings: state.settings,
	},
	output: { index: operation.arguments.index, value: operation.arguments.value },
});

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-blueprint@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append,
		set,
		set_message: setMessage,
	},
};
