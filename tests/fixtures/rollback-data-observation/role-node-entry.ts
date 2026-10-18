import "fake-indexeddb/auto";
import { mkdirSync } from "node:fs";

import { nodePort } from "./node-port.js";
import { setup } from "./producer.js";
import type { RoleBootstrap, RoleConfig } from "./role-assertions.js";
import { census, preparePublishedEquivalentFixture, prepareRoleFixture } from "./role-recovery.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
const [identity, text] = process.argv.slice(2);
if (!identity || !text) throw Error("ROLE_SETUP_ARGUMENTS");
const config = JSON.parse(text) as RoleConfig;
mkdirSync(identity, { recursive: true });
const owners = nodeOwners(identity);
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
const port = nodePort(identity);
await port.writeFloor(report.floor);
const { profileId: _profile, ...bootstrap } = report.bootstrap;
const fresh = nodeOwners(identity);
try {
	if (config.setupFault) await prepareRoleFixture(bootstrap, fresh, port);
	let oracle = await census(bootstrap, fresh, port);
	if (config.stagePublishedEquivalent) oracle = await preparePublishedEquivalentFixture(bootstrap, fresh, port, oracle);
	console.log(
		JSON.stringify({
			pid: process.pid,
			bootstrap: bootstrap satisfies RoleBootstrap,
			oracle,
			cleanup: { producerClosed: true, censusClosed: true },
		})
	);
} finally {
	await fresh.close();
}
