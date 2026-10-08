/* eslint-disable @typescript-eslint/no-non-null-assertion -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
import { nodePort } from "./node-port.js";
import { provePresentBytes } from "./proof.js";
import type { Bootstrap } from "./types.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
const b = JSON.parse(process.argv[2]!) as Bootstrap,
	owners = nodeOwners(b.identity),
	port = nodePort(b.identity);
try {
	const floor = await port.readFloor();
	if (!floor) throw new Error("REAL_HOST_FLOOR");
	const precondition = await provePresentBytes(b, floor, owners),
		t = precondition.targets[0]!;
	const selector = {
		objectId: b.objectId,
		epoch: t.epoch,
		anchor: t.closedAnchorDigest,
		manifestDigest: t.manifestDigest,
	};
	const value = await port.observe(async () => ({
		lookup: await owners.snapshot.lookupRecoveryDeclaration(selector),
		status: await owners.snapshot.recoveryStatus(),
	}));
	console.log(JSON.stringify({ pid: process.pid, precondition, selector, ...value }));
} finally {
	await owners.close();
}
