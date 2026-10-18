interface Phase2hAInertObservation {
	readonly campaign: "phase-2h-a/inert/v1";
	readonly emittedRecords: 0;
}

const observation: Phase2hAInertObservation = Object.freeze({
	campaign: "phase-2h-a/inert/v1",
	emittedRecords: 0,
});
Reflect.set(globalThis, "phase2hAInertCampaign", observation);

export {};
