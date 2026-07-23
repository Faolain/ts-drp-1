import { RELAY_TRANSPORT_PROFILES } from "@ts-drp/relay-policy";
import { describe, expect, it } from "vitest";

import { createRelayFixture } from "../src/relay/fixture.js";

describe("relay browser fixture", () => {
	it.each([
		["mixed", "broad-browser", "reserved", 2],
		["mixed", "wss-only", "exhausted", 1],
		["all-refused", "broad-browser", "owned-fallback", 0],
		["stale-fallback", "broad-browser", "exhausted", 0],
	] as const)("matches %s / %s deterministic evidence", async (scenario, profile, terminal, reservationCount) => {
		const result = await createRelayFixture(
			scenario,
			profile === "wss-only" ? RELAY_TRANSPORT_PROFILES.wssOnly : RELAY_TRANSPORT_PROFILES.broadBrowser
		);
		expect(result.assertions.filter(({ passed }) => !passed)).toEqual([]);
		expect(result).toMatchObject({ privateIdentifierFields: 0, reservationCount, terminal });
	});
});
