/* eslint-disable @typescript-eslint/explicit-function-return-type */

const thenable = {
	then(resolve) {
		resolve({ output: null, state: { messages: [], settings: {} } });
	},
};

const append = () => thenable;

const unchanged = ({ state }) => ({ state, output: null });

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-thenable@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append,
		set: unchanged,
		set_message: unchanged,
	},
};
