import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { BoundedObservationLog, GridLastValueOracle } from "./fixtures/active-endurance/continued-play-observations.js";
import { ControlledRawBus } from "../packages/node/tests/fixtures/controlled-unreliable-webrtc.js";

it("rejects the previous value of an overwritten slot even when all 32 IDs survive", () => {
	const oracle = new GridLastValueOracle();
	for (let ordinal = 0; ordinal < 16; ordinal++) {
		// Opposite completion order is harmless because the authors own disjoint keys.
		const left = oracle.propose(0),
			right = oracle.propose(1);
		oracle.accept(right);
		oracle.accept(left);
	}
	const oldState = oracle.state();
	const changed = oracle.propose(1);
	oracle.accept(changed);
	expect(oracle.state()).toHaveLength(32);
	expect(oracle.matches(oldState)).toBe(false);
	expect(oracle.matches(oracle.state().toReversed())).toBe(true);
	const previous = oldState.find((block) => block.id === changed.id);
	if (previous === undefined) throw new Error("CONTROL_PREVIOUS_SLOT_MISSING");
	expect(() => oracle.accept(previous)).toThrow("GRID_ORACLE_WRITER_ORDER");
});

it("flushes every observation without retaining the whole run", () => {
	const filename = join(mkdtempSync(join(tmpdir(), "continued-play-observation-control-")), "observations.jsonl");
	const log = new BoundedObservationLog(filename, 7);
	for (let sequence = 0; sequence < 1000; sequence++) log.add({ sequence });
	expect(log.retained).toBeLessThan(7);
	expect(log.highWater).toBe(7);
	log.flush();
	expect(log.retained).toBe(0);
	expect(
		readFileSync(filename, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).sequence)
	).toEqual(Array.from({ length: 1000 }, (_, index) => index));
});

it("bounds raw sends, reconciliations, and closed route history while preserving live delivery", async () => {
	const bus = new ControlledRawBus(4);
	bus.connect("left", "right");
	const left = bus.owner("left"),
		right = bus.owner("right");
	let delivered = 0;
	for (let epoch = 0; epoch < 40; epoch++) {
		const route = `epoch-${epoch}`,
			sender = left.openUnreliableWebRtcRoute(route),
			receiver = right.openUnreliableWebRtcRoute(route);
		receiver.onMessage(() => delivered++);
		for (let tick = 0; tick < 9; tick++) {
			await sender.reconcile(["right"]);
			expect(await sender.send(["right"], new Uint8Array([epoch, tick]))).toBe(true);
		}
		expect(bus.history()).toMatchObject({ sends: 4, routes: 2, reconciliations: 4 });
		sender.close();
		receiver.close();
	}
	expect(delivered).toBe(360);
	expect(bus.sent).toBe(360);
});
