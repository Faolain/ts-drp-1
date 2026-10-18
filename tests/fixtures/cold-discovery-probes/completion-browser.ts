import { completionControl, type CompletionMode } from "./completion-control.js";
import { browserMutations } from "../cold-discovery/browser-mutations.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
import type { SetupReport } from "../cold-discovery/types.js";

Object.assign(globalThis, {
	directCompletionControl: async (setup: SetupReport, mode: CompletionMode) => {
		const owners = await browserOwners(setup.bootstrap.identity);
		try {
			return await completionControl(setup, mode, owners, browserMutations(setup.bootstrap.identity));
		} finally {
			await owners.close();
		}
	},
});
