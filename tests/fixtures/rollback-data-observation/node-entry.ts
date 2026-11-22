import "fake-indexeddb/auto";
import { mkdirSync } from "node:fs";

import { provisionLegacy } from "./integrity.js";
import { nodePort } from "./node-port.js";
import { setup } from "./producer.js";
import { provePresentBytes } from "./proof.js";
import type { Bootstrap } from "./types.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
const [mode, identity, input] = process.argv.slice(2);
if (!identity || !input) throw new Error("DRIVER_ARGUMENT");
const port = nodePort(identity);
if (mode === "setup") {
	mkdirSync(identity, { recursive: true });
	const config = JSON.parse(input) as { epoch: 0 | 1 | 2 | 3; settlement: boolean; legacy: boolean };
	const owners = nodeOwners(identity);
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
	await port.writeFloor(report.floor);
	const integrity = config.legacy ? await provisionLegacy(port, report.bootstrap, report.floor) : undefined;
	const fresh = nodeOwners(identity);
	let precondition;
	try {
		precondition =
			config.epoch === 3 && !config.legacy
				? { physicalRows: (await port.image()).generations.length }
				: await provePresentBytes(report.bootstrap, report.floor, fresh);
	} finally {
		await fresh.close();
	}
	console.log(JSON.stringify({ pid: process.pid, report, integrity, precondition }));
} else {
	const b = JSON.parse(input) as Bootstrap,
		owners = nodeOwners(identity);
	try {
		const floor = await port.readFloor();
		if (!floor) throw new Error("HOST_FLOOR_MISSING");
		const precondition = await provePresentBytes(b, floor, owners);
		console.log(JSON.stringify({ pid: process.pid, precondition }));
	} finally {
		await owners.close();
	}
}
