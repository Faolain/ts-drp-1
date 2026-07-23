import { describe, expect, it } from "vitest";

import type { PublicOnlyBudgetError, PublicOnlyConfig } from "../src/public-only/index.js";
import {
	assertPublicEndpointResolution,
	createBlockedPublicOnlyReport,
	createPublicOnlyBrowserInput,
	preflightPublicOnly,
	PUBLIC_ONLY_ACKNOWLEDGEMENT,
	PublicOnlyMilestoneSchema,
	PublicOnlyRunBudget,
	PublicOnlyVerdictSchema,
	sanitizePublicOnlyPreflight,
} from "../src/public-only/index.js";

describe("public-only bootstrap contract", () => {
	it("authorizes only the strict public-only shape with separate exact consent", () => {
		const preflight = preflightPublicOnly(validConfig(), PUBLIC_ONLY_ACKNOWLEDGEMENT);
		expect(preflight).toMatchObject({ authorized: true, blockers: [] });
	});

	it("fails closed before exact command-line consent", () => {
		const preflight = preflightPublicOnly(validConfig(), "proceed");
		expect(preflight).toMatchObject({
			authorized: false,
			blockers: [{ code: "missing-cli-consent" }],
		});
		expect(createBlockedPublicOnlyReport(preflight)).toMatchObject({
			milestones: [],
			publicRequests: 0,
			status: "blocked",
			terminal: "missing-consent",
		});
	});

	it.each(["registryUrl", "registries", "ownedRelay", "fallback", "drpPeerId", "drpAddress"])(
		"rejects forbidden anti-cheat input %s",
		(key) => {
			const preflight = preflightPublicOnly(
				{ ...validConfig(), [key]: key === "fallback" ? true : "forbidden" },
				PUBLIC_ONLY_ACKNOWLEDGEMENT
			);
			expect(preflight).toMatchObject({ authorized: false, blockers: [{ code: "invalid-config" }] });
		}
	);

	it.each([
		"http://delegated-ipfs.dev/routing/v1",
		"https://user:secret@delegated-ipfs.dev/routing/v1",
		"https://localhost/routing/v1",
		"https://127.0.0.1/routing/v1",
		"https://10.0.0.1/routing/v1",
		"https://192.168.1.2/routing/v1",
		"https://[::1]/routing/v1",
		"https://[::ffff:127.0.0.1]/routing/v1",
		"https://127.1/routing/v1",
		"https://delegated-ipfs.dev./routing/v1",
		"https://router.example.test/routing/v1",
		"https://example.com/routing/v1",
	])("rejects non-public delegated endpoint %s", (endpoint) => {
		const config = validConfig();
		const result = preflightPublicOnly({ ...config, delegatedEndpoints: [endpoint] }, PUBLIC_ONLY_ACKNOWLEDGEMENT);
		expect(result).toMatchObject({ authorized: false, blockers: [{ code: "invalid-config" }] });
	});

	it("accepts the documented IPFS Foundation delegated endpoint", () => {
		expect(preflightPublicOnly(validConfig(), PUBLIC_ONLY_ACKNOWLEDGEMENT)).toMatchObject({ authorized: true });
	});

	it("rejects request components that exceed the one total cap", () => {
		const config = validConfig();
		const result = preflightPublicOnly(
			{ ...config, limits: { ...config.limits, maxPublicRequests: 10 } },
			PUBLIC_ONLY_ACKNOWLEDGEMENT
		);
		expect(result.blockers[0]?.message).toContain("component request caps");
	});

	it("accepts only code-reviewed official DHT bootstrap addresses", () => {
		const config = validConfig();
		for (const address of [
			"/ip4/127.0.0.1/tcp/4001/p2p/QmPrivate",
			"/ip6/::ffff:127.0.0.1/tcp/4001/p2p/QmPrivate",
			"/ip4/192.168.1.4/tcp/4001/p2p/QmPrivate",
			"/dnsaddr/bootstrap.example.test/p2p/QmPlaceholder",
			"/dnsaddr/bootstrap.example.com/p2p/QmPublicButUnreviewed",
		]) {
			expect(
				preflightPublicOnly({ ...config, publicDhtBootstrap: [address] }, PUBLIC_ONLY_ACKNOWLEDGEMENT)
			).toMatchObject({ authorized: false, blockers: [{ code: "invalid-config" }] });
		}
	});

	it("rejects empty, private, mapped-loopback, and malformed fresh DNS answers", () => {
		for (const answers of [[], ["127.0.0.1"], ["::ffff:127.0.0.1"], ["192.168.1.8"], ["not-an-ip"]]) {
			expect(() => assertPublicEndpointResolution("https://delegated-ipfs.dev/routing/v1", answers)).toThrow();
		}
		expect(() =>
			assertPublicEndpointResolution("https://delegated-ipfs.dev/routing/v1", ["104.18.1.1", "2606:4700::1"])
		).not.toThrow();
	});

	it("rejects DNS checks for endpoints outside the reviewed allowlist", () => {
		expect(() => assertPublicEndpointResolution("https://example.com/routing/v1", ["104.18.1.1"])).toThrow();
	});

	it("projects the strict browser input without coordinator secrets or identities", () => {
		const input = createPublicOnlyBrowserInput(validConfig());
		const serialized = JSON.stringify(input);
		expect(Object.keys(input).sort()).toEqual([
			"delegatedEndpoints",
			"limits",
			"namespace",
			"objectId",
			"schemaVersion",
		]);
		expect(serialized).not.toContain("acknowledgement");
		expect(serialized).not.toContain("bootstrap.libp2p.io");
		expect(serialized).not.toContain("public-only-smoke-01");
	});

	it("freezes typed verdict and sanitized ordered milestone shapes", () => {
		expect(PublicOnlyVerdictSchema.options).toEqual(["success", "no-go", "blocked", "inconclusive"]);
		expect(
			PublicOnlyMilestoneSchema.parse({ elapsedMs: 10, order: 0, stage: "node-dht-bootstrap", status: "passed" })
		).toEqual({ elapsedMs: 10, order: 0, stage: "node-dht-bootstrap", status: "passed" });
	});

	it("exposes only a sanitized preflight projection", () => {
		const sanitized = sanitizePublicOnlyPreflight(preflightPublicOnly(validConfig(), PUBLIC_ONLY_ACKNOWLEDGEMENT));
		const serialized = JSON.stringify(sanitized);
		expect(sanitized).toEqual({
			authorized: true,
			blockers: [],
			endpointCount: 1,
			publicRequestCap: 24,
			runId: "public-only-smoke-01",
			totalDeadlineMs: 120_000,
		});
		expect(serialized).not.toContain("delegated-ipfs.dev");
		expect(serialized).not.toContain("bootstrap.libp2p.io");
		expect(serialized).not.toContain("opaque-room-2026");
		expect(serialized).not.toContain(PUBLIC_ONLY_ACKNOWLEDGEMENT);
	});

	it("shares one manual-clock deadline and one hard request ledger", () => {
		let now = 1_000;
		const budget = new PublicOnlyRunBudget(validConfig(), () => now);
		budget.consume("amino-bootstrap");
		budget.consume("dht-provide");
		expect(budget.snapshot()).toEqual({
			byKind: { "amino-bootstrap": 1, "dht-provide": 1 },
			consumed: 2,
			deadlineAtMs: 121_000,
			hardCap: 24,
			relayCandidates: { consumed: 0, hardCap: 6 },
			remainingMs: 120_000,
			reservationAttempts: { consumed: 0, hardCap: 6 },
		});
		now = 121_000;
		expect(() => budget.consume("delegated-provider-lookup")).toThrowError(
			expect.objectContaining<Partial<PublicOnlyBudgetError>>({ terminal: "deadline-exceeded" })
		);
		expect(budget.snapshot().consumed).toBe(2);
	});

	it("fails before request 25 without incrementing accounting", () => {
		const budget = new PublicOnlyRunBudget(validConfig(), () => 1_000);
		for (let index = 0; index < 6; index += 1) budget.consume("amino-bootstrap");
		for (let index = 0; index < 6; index += 1) budget.consume("delegated-provider-lookup");
		for (let index = 0; index < 4; index += 1) budget.consume("provider-dial");
		for (let index = 0; index < 8; index += 1) budget.consume("relay-dial");
		expect(() => budget.consume("relay-reserve")).toThrowError(
			expect.objectContaining<Partial<PublicOnlyBudgetError>>({ terminal: "request-budget-exhausted" })
		);
		expect(budget.snapshot()).toMatchObject({ consumed: 24, hardCap: 24 });
	});

	it("enforces the provider-dial category cap", () => {
		const budget = new PublicOnlyRunBudget(validConfig(), () => 1_000);
		for (let index = 0; index < 4; index += 1) budget.consume("provider-dial");
		expect(() => budget.consume("provider-dial")).toThrowError(
			expect.objectContaining<Partial<PublicOnlyBudgetError>>({ terminal: "request-budget-exhausted" })
		);
		expect(budget.snapshot()).toMatchObject({ consumed: 4, byKind: { "provider-dial": 4 } });
	});

	it("enforces relay-candidate and reservation-attempt caps independently", () => {
		const budget = new PublicOnlyRunBudget(validConfig(), () => 1_000);
		for (let index = 0; index < 6; index += 1) {
			budget.consumeRelayCandidate();
			budget.consumeReservationAttempt();
		}
		expect(() => budget.consumeRelayCandidate()).toThrowError(
			expect.objectContaining<Partial<PublicOnlyBudgetError>>({ terminal: "request-budget-exhausted" })
		);
		expect(() => budget.consumeReservationAttempt()).toThrowError(
			expect.objectContaining<Partial<PublicOnlyBudgetError>>({ terminal: "request-budget-exhausted" })
		);
		expect(budget.snapshot()).toMatchObject({
			relayCandidates: { consumed: 6, hardCap: 6 },
			reservationAttempts: { consumed: 6, hardCap: 6 },
		});
	});

	it("enforces category caps atomically before the total cap", () => {
		const config = validConfig();
		const budget = new PublicOnlyRunBudget(
			{ ...config, limits: { ...config.limits, maxDelegatedRequests: 1 } },
			() => 1_000
		);
		budget.consume("delegated-provider-lookup");
		expect(() => budget.consume("delegated-closest-peers")).toThrowError(
			expect.objectContaining<Partial<PublicOnlyBudgetError>>({ terminal: "request-budget-exhausted" })
		);
		expect(budget.snapshot()).toMatchObject({
			byKind: { "delegated-provider-lookup": 1 },
			consumed: 1,
		});
	});
});

function validConfig(): PublicOnlyConfig {
	return {
		consent: {
			acknowledgement: PUBLIC_ONLY_ACKNOWLEDGEMENT,
			grantedAt: "2026-07-20T12:00:00.000Z",
			grantedBy: "local-operator",
			operatorTermsReviewedAt: "2026-07-20T12:00:00.000Z",
		},
		delegatedEndpoints: ["https://delegated-ipfs.dev/routing/v1"],
		limits: {
			maxDelegatedRequests: 6,
			maxDhtRequests: 6,
			maxProviderRequests: 4,
			maxPublicRequests: 24,
			maxRelayCandidates: 6,
			maxRelayRequests: 8,
			maxReservationAttempts: 6,
			totalDeadlineMs: 120_000,
		},
		namespace: "opaque-room-2026",
		objectId: "opaque-grid-2026",
		publicDhtBootstrap: ["/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN"],
		runId: "public-only-smoke-01",
		schemaVersion: "1.0.0",
		transportProfile: "wss-only",
	} as const satisfies PublicOnlyConfig;
}
