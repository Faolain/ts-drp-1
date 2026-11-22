import { availabilityProbe } from "./availability-probe.js";
import { browserMutations } from "./browser-mutations.js";
import { browserOwners } from "./browser-owners.js";
import { withNativeOwner } from "./cleanup.js";
import { probe } from "./probe.js";
import type { OwnerCase, ProbeInput } from "./types.js";
Object.assign(globalThis, {
	pendingProbe: async (input: ProbeInput, mode: OwnerCase) => {
		const owners = await browserOwners(input.bootstrap.identity);
		return withNativeOwner(owners, async () => {
			const mutations = browserMutations(input.bootstrap.identity);
			const report = await probe(input, mode, owners, mutations);
			if (mode === "verified") report.availability = await availabilityProbe(input, owners, mutations);
			return report;
		});
	},
});
