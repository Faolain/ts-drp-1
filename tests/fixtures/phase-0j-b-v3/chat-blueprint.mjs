/* eslint-disable @typescript-eslint/explicit-function-return-type */

const unchanged = ({ state }) => ({ state, output: null });

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-blueprint@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append: unchanged,
		set: unchanged,
		set_message: unchanged,
	},
};
