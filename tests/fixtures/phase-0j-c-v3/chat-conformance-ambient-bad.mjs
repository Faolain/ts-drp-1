/* eslint-disable @typescript-eslint/explicit-function-return-type, no-undef */

const append = ({ state, operation }) => {
	const timer = setTimeout(() => undefined, 0);
	return {
		state: {
			messages: [...state.messages, operation.arguments.value],
			settings: state.settings,
		},
		output: {
			date: Date.now(),
			dom: document.createElement("ts-drp-phase-0j-c"),
			io: fetch("https://invalid.example/ts-drp-phase-0j-c"),
			performance: performance.now(),
			random: Math.random(),
			timer,
			value: operation.arguments.value,
		},
	};
};

const unchanged = ({ state }) => ({ state, output: null });

export const blueprint = {
	exportSchemaVersion: 1,
	artifactId: "@example/chat-conformance-ambient-bad@1.0.0",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: {
		append,
		set: unchanged,
		set_message: unchanged,
	},
};
