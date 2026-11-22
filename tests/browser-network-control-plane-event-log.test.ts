import { describe, expect, it } from "vitest";

import {
	CONTROL_PLANE_EVENT_LOG_CAP,
	createControlPlaneEventLog,
} from "../examples/browser-network/src/control-plane-event-log.js";

/**
 * The modular browser session's diagnostics keep the control-plane events it saw. A game session runs
 * for hours, so the log keeps the newest events up to a fixed cap and counts what it dropped: memory
 * stays bounded in either mode, and the diagnostics still say how many events there were.
 */
describe("browser network: the control-plane event log is bounded", () => {
	it("keeps the newest events up to the cap and counts the dropped ones", () => {
		const log = createControlPlaneEventLog<number>(4);
		for (let index = 0; index < 10; index++) log.push(index);
		expect(log.events()).toEqual([6, 7, 8, 9]);
		expect(log.dropped).toBe(6);
	});

	it("drops nothing below the cap, and the session's cap is 256", () => {
		const log = createControlPlaneEventLog<string>(CONTROL_PLANE_EVENT_LOG_CAP);
		log.push("a");
		log.push("b");
		expect(log.events()).toEqual(["a", "b"]);
		expect(log.dropped).toBe(0);
		expect(CONTROL_PLANE_EVENT_LOG_CAP).toBe(256);
		for (let index = 0; index < 1_000; index++) log.push(String(index));
		expect(log.events()).toHaveLength(256);
		expect(log.events().at(-1)).toBe("999");
		expect(log.dropped).toBe(1_002 - 256);
	});

	it("returns a copy, not the live buffer", () => {
		const log = createControlPlaneEventLog<number>(2);
		log.push(1);
		const copy = log.events();
		log.push(2);
		expect(copy).toEqual([1]);
	});
});
