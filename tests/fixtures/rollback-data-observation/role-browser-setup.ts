import { browserPort } from "./browser-port.js";
import { setup } from "./producer.js";
import type { RoleConfig } from "./role-assertions.js";
import { census, preparePublishedEquivalentFixture, prepareRoleFixture } from "./role-recovery.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
const realm = Math.random();
Object.assign(globalThis, {
	roleSetup: async (identity: string, config: RoleConfig) => {
		const owners = await browserOwners(identity);
		let report;
		try {
			report = await setup(
				identity,
				config.epoch,
				owners,
				config.profile,
				config.stagePublishedEquivalent ? "before-publication" : config.stop
			);
		} finally {
			await owners.close();
		}
		const port = browserPort(identity);
		await port.writeFloor(report.floor);
		const { profileId: _profile, ...bootstrap } = report.bootstrap;
		const fresh = await browserOwners(identity);
		try {
			if (config.setupFault) await prepareRoleFixture(bootstrap, fresh, port);
			let oracle = await census(bootstrap, fresh, port);
			if (config.stagePublishedEquivalent)
				oracle = await preparePublishedEquivalentFixture(bootstrap, fresh, port, oracle);
			return {
				realm,
				bootstrap,
				oracle,
				cleanup: { producerClosed: true, censusClosed: true },
			};
		} finally {
			await fresh.close();
		}
	},
});
