import { browserPort } from "./browser-port.js";
import { provisionLegacy } from "./integrity.js";
import { setup } from "./producer.js";
import { provePresentBytes } from "./proof.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
const realm = Math.random();
Object.assign(globalThis, {
	rollbackSetup: async (identity: string, config: { epoch: 0 | 1 | 2 | 3; settlement: boolean; legacy: boolean }) => {
		const owners = await browserOwners(identity);
		let report;
		try {
			report = await setup(
				identity,
				config.epoch,
				owners,
				config.settlement ? "creator-trusted-settlement-v1" : "creator-trusted-v1"
			);
		} finally {
			await owners.close();
		}
		const port = browserPort(identity);
		await port.writeFloor(report.floor);
		const integrity = config.legacy ? await provisionLegacy(port, report.bootstrap, report.floor) : undefined;
		const fresh = await browserOwners(identity);
		let precondition;
		try {
			precondition = await provePresentBytes(report.bootstrap, report.floor, fresh);
		} finally {
			await fresh.close();
		}
		return { realm, report, integrity, precondition };
	},
});
