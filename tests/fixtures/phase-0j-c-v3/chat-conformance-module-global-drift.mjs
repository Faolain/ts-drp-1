/* eslint-disable @typescript-eslint/explicit-function-return-type */

let moduleGlobalOrdinal = 0;

const append = ({ state, operation }) => {
	moduleGlobalOrdinal += 1;
	return {
		state: {
			messages: [...state.messages, operation.arguments.value],
			settings: state.settings,
		},
		output: { moduleGlobalOrdinal },
	};
};

const unchanged = ({ state }) => ({ state, output: null });

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-module-global-drift@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append,
		set: unchanged,
		set_message: unchanged,
	},
};
