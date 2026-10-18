/* eslint-disable @typescript-eslint/explicit-function-return-type */

const originalMap = Array.prototype.map;

Object.defineProperty(Array.prototype, "map", {
	configurable: true,
	enumerable: false,
	value: function phase0jCReplacementMap(...arguments_) {
		return originalMap.call(this, ...arguments_);
	},
	writable: true,
});

const unchanged = ({ state }) => ({ state, output: null });

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-intrinsic-mutating@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append: unchanged,
		set: unchanged,
		set_message: unchanged,
	},
};
