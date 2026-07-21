import { describe, expect, it } from "vitest";

import { createRegistryFixture } from "../src/registry/fixture.js";

const INVITE = "fixture-invite-token-32-characters";

describe("registry comparison fixture", () => {
	it("matches every deterministic oracle and emits no credential fields", async () => {
		const fixture = await createRegistryFixture();
		expect(fixture.cases).toHaveLength(10);
		expect(fixture.cases.every(({ passed }) => passed)).toBe(true);
		expect(fixture.admission.map(({ mode, registrationResult }) => [mode, registrationResult])).toEqual([
			["invite", "accepted"],
			["allowlist", "accepted"],
			["open", "accepted"],
			["proof-of-work", "accepted"],
		]);
		expect(fixture.privateCredentialFields).toBe(0);
		expect(fixture.comparison.every(({ dependencyHops, operationMs }) => dependencyHops > 0 && operationMs >= 0)).toBe(
			true
		);
		expect(JSON.stringify(fixture)).not.toContain(INVITE);
		expect(fixture.comparison).toHaveLength(2);
		expect(fixture.digest).toMatch(/^sha256:[A-Za-z0-9_-]{16}$/u);
	});
});
