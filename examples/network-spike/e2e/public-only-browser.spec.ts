import { expect, test } from "@playwright/test";
import type { PublicOnlyBrowserFixtureTrace } from "@ts-drp/network-spike/public-only/browser-fixture";

test.describe("public-only browser bootstrap", () => {
	test.describe.configure({ timeout: 30_000 });

	test("learns the provider only from delegated routing and independently reserves a real relay", async ({ page }) => {
		const requests: string[] = [];
		const webSockets: string[] = [];
		let preResponseCoordinatesVerified = false;
		page.on("request", (request) => requests.push(request.url()));
		page.on("websocket", (socket) => webSockets.push(socket.url()));
		await page.route("**/fixture/public-only-browser/primary/routing/v1/providers/**", async (route) => {
			const response = await route.fetch();
			const payload = (await response.json()) as {
				Providers?: Array<{ Addrs?: string[]; ID?: string }>;
			};
			const coordinates = (payload.Providers ?? []).flatMap(({ Addrs = [], ID }) => [
				...(ID === undefined ? [] : [ID]),
				...Addrs,
			]);
			const leaked = await page.evaluate(async (values) => {
				const resourceUrls = performance
					.getEntriesByType("resource")
					.filter(
						(entry): entry is PerformanceResourceTiming =>
							entry instanceof PerformanceResourceTiming && entry.initiatorType === "script"
					)
					.map(({ name }) => name)
					.filter((url) => new URL(url).origin === location.origin);
				const sources = await Promise.all(
					resourceUrls.map(async (url) => fetch(url).then(async (item) => item.text()))
				);
				const state = [
					location.href,
					document.documentElement.outerHTML,
					...Object.values(localStorage),
					...Object.values(sessionStorage),
					...sources,
				].join("\n");
				return values.filter((value) => state.includes(value));
			}, coordinates);
			expect(leaked, "provider identity/address existed in browser state before delegated response").toEqual([]);
			preResponseCoordinatesVerified = true;
			await route.fulfill({ body: JSON.stringify(payload), response });
		});
		await page.goto("/public-only-browser");
		const status = page.locator("[data-public-only-status]");
		await expect(status).not.toHaveAttribute("data-public-only-status", "starting", { timeout: 20_000 });
		const raw = await page.locator("[data-public-only-trace]").textContent();
		if (raw === null) throw new Error("public-only browser trace missing");
		const trace = JSON.parse(raw) as PublicOnlyBrowserFixtureTrace;
		expect(await status.getAttribute("data-public-only-status"), JSON.stringify(trace, undefined, 2)).toBe("ready");
		expect(trace).toMatchObject({
			bootstrapInputKeys: ["namespace"],
			configuredProviderInputFields: 0,
			result: {
				providerLookup: {
					providers: [{ provenance: "untrusted-public-provider" }],
					terminal: "provider-visible",
				},
				terminal: "ready",
			},
			relayRouting: {
				operation: "get-closest-peers",
				terminal: "success",
			},
		});
		expect(preResponseCoordinatesVerified).toBe(true);
		expect(trace.providerResponsePeerIds).toEqual(trace.result.providerLookup.providers.map(({ peerId }) => peerId));
		expect(trace.result.relay.fallback).toBeUndefined();
		expect(trace.result.relay.reservations).toHaveLength(1);
		expect(trace.result.relay.attempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ hopAdvertised: true, reservationStatus: 100, status: "reserved" }),
			])
		);

		const contacted = requests
			.map((value) => new URL(value))
			.filter(({ protocol }) => protocol === "http:" || protocol === "https:");
		expect(new Set(contacted.map(({ origin }) => origin))).toEqual(
			new Set(["http://127.0.0.1:4174", "http://127.0.0.1:4175"])
		);
		const delegatedPaths = contacted
			.filter(({ origin }) => origin === "http://127.0.0.1:4175")
			.map(({ pathname }) => pathname);
		expect(delegatedPaths).toHaveLength(2);
		expect(delegatedPaths.some((path) => path.includes("/routing/v1/providers/"))).toBe(true);
		expect(delegatedPaths.some((path) => path.includes("/routing/v1/dht/closest/peers/"))).toBe(true);
		expect([...requests, ...webSockets].some((value) => /grid-registry|dnsaddr|:5100[0246]/u.test(value))).toBe(false);
		expect(webSockets.some((value) => new URL(value).port === "50000")).toBe(true);
		expect(webSockets.every((value) => ["4174", "50000", "50002"].includes(new URL(value).port))).toBe(true);
	});
});
