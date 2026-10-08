import { expect, test } from "@playwright/test";

import { type NativeBrowserServer, startNativeBrowserServer } from "./browser-server.js";
import { nativeCases, type NativeObservation } from "./cases.js";
import type {} from "./browser-bootstrap.js";

let server: NativeBrowserServer;
test.beforeAll(async () => {
	server = await startNativeBrowserServer();
});
test.afterAll(async () => {
	await server.close();
});
for (const selected of nativeCases("indexeddb")) {
	test(`native IndexedDB provenance: ${selected.label}`, async ({ page }, info) => {
		await page.goto(server.origin);
		await page.waitForFunction(() => typeof window.runNativeProvenance === "function");
		const observation = (await page.evaluate(
			(selected) => window.runNativeProvenance(selected.boundary, selected.sentinel, selected.mode),
			selected
		)) as NativeObservation;
		await info.attach("native-provenance", {
			body: JSON.stringify({
				engine: info.project.name,
				selected,
				observation,
				ownerUrl: server.origin + "/owner.js",
				artifact: server.evidence,
			}),
			contentType: "application/json",
		});
		expect(Object.values(observation.controls).every(Boolean)).toBe(true);
		if (selected.mode === "fault")
			expect(
				{ code: observation.observed.code, sentinelRetained: observation.observed.sentinelRetained },
				"NATIVE_PROCESSING_MAPPING_GAP"
			).toEqual({ code: "storage-failed", sentinelRetained: true });
		else expect(observation.observed.code).toBe(selected.expected);
	});
}
