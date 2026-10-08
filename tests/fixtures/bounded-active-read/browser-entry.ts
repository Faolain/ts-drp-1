import { environment, request } from "./browser-owner.js";
import { type Case, precondition, run, setup } from "./contract.js";

Object.assign(globalThis, {
	boundedAheSetup: async (name: string, selected: Case): Promise<unknown> => {
		const env = environment(name);
		await setup(selected, env);
		return precondition(selected, env);
	},
	boundedAheRun: (name: string, selected: Case): Promise<unknown> => run(selected, environment(name)),
	boundedAheDelete: (name: string): Promise<unknown> => request(indexedDB.deleteDatabase(name)),
});
