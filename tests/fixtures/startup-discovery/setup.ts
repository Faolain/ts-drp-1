import { requireValue } from "./assert.js";
import { floorControl, state } from "./floor.js";
import { control, trace } from "./observation.js";
import { bootstrap, durableHead, message, openRoom } from "./room.js";
import type { Scenario, SetupReport } from "./types.js";

Object.assign(globalThis, {
	startupSetup: async (identity: string, scenario: Scenario): Promise<SetupReport> => {
		const b = await bootstrap(identity),
			room = await openRoom(b, "create");
		const genesis = requireValue(await state(identity), "STARTUP_FIXTURE_PRECONDITION");
		const epochs = Number(scenario.at(-1)) || 0;
		const pending = scenario.startsWith("pending");
		const interruptedCommit = scenario === "lost-commit-1" || scenario === "failed-reread-1";
		let priorStable = genesis,
			interrupted: string | null = null;
		try {
			await room.issue(message("zero"));
			for (let n = 1; n <= epochs; n++) {
				priorStable = requireValue(await state(identity), "STARTUP_FIXTURE_PRECONDITION");
				await room.sealEpoch();
				if ((pending || interruptedCommit) && n === epochs) {
					if (interruptedCommit)
						floorControl.fault = scenario === "lost-commit-1" ? "commit-lost-response" : "reread-unavailable";
					else if (scenario.includes("old")) control.publicationFault = true;
					else floorControl.fault = "commit-unavailable";
					try {
						await room.adoptCreatorSuccessor();
					} catch (error) {
						interrupted = error instanceof Error ? error.message : String(error);
					}
				} else {
					await room.adoptCreatorSuccessor();
					await room.issue(message("epoch-" + n));
				}
			}
			const hot = room.projection();
			// An interrupted attempt has not installed its next snapshot-derived projection.
			// The recovery oracle is the exact next authenticated application base: its canonical
			// message identities/text survive, while live vertex metadata becomes snapshot provenance.
			// This value stays in Playwright; only trusted bootstrap crosses into recovery.
			const expectedProjection =
				pending || interruptedCommit
					? {
							...hot,
							accepted: hot.accepted.map(({ clientOperationId, text }) => ({
								clientOperationId,
								provenance: "authenticated-snapshot",
								text,
							})),
						}
					: hot;
			return {
				bootstrap: b,
				expectedProjection,
				floor: requireValue(await state(identity), "STARTUP_FIXTURE_PRECONDITION"),
				genesis,
				priorStable,
				durableHead: await durableHead(b),
				interrupted,
				trace: [...trace],
			};
		} finally {
			// Unpublished staged candidates are intentionally not gracefully closed: page termination
			// is the real interruption and closes every native client before a fresh recovery realm.
			if (!pending && !interruptedCommit) await room.close();
		}
	},
});
