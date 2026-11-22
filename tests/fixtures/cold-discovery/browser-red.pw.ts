import { expect, test } from "@playwright/test";

import { assertRecovery } from "./assertions.js";
import { browserServer } from "./browser-server.js";
import { cases, type RecoveryCase, type RecoveryReport, type SetupReport } from "./types.js";

declare global {
	interface Window {
		coldSetup?(identity: string, epochs: 1 | 2): Promise<SetupReport>;
		coldRecover?(bootstrap: SetupReport["bootstrap"], mode: RecoveryCase): Promise<RecoveryReport>;
	}
}
let server: Awaited<ReturnType<typeof browserServer>>;
test.beforeAll(async () => {
	const artifacts = process.env.COLD_ARTIFACTS;
	if (artifacts === undefined) throw new Error("REQUIRE_BUILT_BROWSER_ARTIFACTS");
	server = await browserServer(artifacts);
});
test.afterAll(async () => {
	await server?.close();
});
for (const epoch of [1, 2] as const)
	for (const mode of cases) {
		test(`native IndexedDB fresh page epoch ${epoch}: ${mode}`, async ({ context }, info) => {
			const identity = `cold-${info.project.name}-${epoch}-${mode}-${crypto.randomUUID()}`;
			const setupPage = await context.newPage();
			let recoveryPage: Awaited<ReturnType<typeof context.newPage>> | undefined;
			let primary: unknown;
			try {
				await setupPage.goto(`${server.origin}/setup`);
				await setupPage.waitForFunction(() => typeof window.coldSetup === "function");
				const setup = await setupPage.evaluate(
					async ({ identity, epoch }) => {
						if (window.coldSetup === undefined) throw new Error("SETUP_ENTRY_MISSING");
						return window.coldSetup(identity, epoch);
					},
					{ identity, epoch }
				);
				expect(setup.bootstrap.expectedRoomHead.epoch).toBe(epoch);
				expect(setup.oracle.closeEpochs).toEqual(epoch === 1 ? [0] : [0, 1]);
				expect(setupPage.workers()).toHaveLength(0);
				await setupPage.close();
				expect(setupPage.isClosed()).toBe(true);
				recoveryPage = await context.newPage();
				await recoveryPage.goto(`${server.origin}/recovery`);
				await recoveryPage.waitForFunction(() => typeof window.coldRecover === "function");
				expect(await recoveryPage.evaluate(() => typeof window.coldSetup)).toBe("undefined");
				// Only the bootstrap is passed; setup.oracle stays in this Node test controller.
				const report = await recoveryPage.evaluate(
					async ({ bootstrap, mode }) => {
						if (window.coldRecover === undefined) throw new Error("RECOVERY_ENTRY_MISSING");
						return window.coldRecover(bootstrap, mode);
					},
					{ bootstrap: setup.bootstrap, mode }
				);
				await info.attach("native-restart", {
					body: JSON.stringify({
						engine: info.project.name,
						epoch,
						mode,
						artifactsSha256: server.artifactsSha256,
						setup,
						report,
						setupPageClosedBeforeRecovery: true,
					}),
					contentType: "application/json",
				});
				console.log(
					JSON.stringify({
						engine: info.project.name,
						epoch,
						mode,
						classification: report.classification,
						result: report.result,
						effects: report.effects,
					})
				);
				assertRecovery(report, setup);
			} catch (error) {
				primary = error;
			}
			try {
				await setupPage.close();
				await recoveryPage?.close();
				const cleanup = await context.newPage();
				try {
					await cleanup.goto(`${server.origin}/recovery`);
					await cleanup.evaluate(async (prefix) => {
						for (const database of await indexedDB.databases()) {
							if (database.name === undefined || !database.name.startsWith(prefix)) continue;
							await new Promise<void>((resolve, reject) => {
								const request = indexedDB.deleteDatabase(database.name as string);
								request.onsuccess = (): void => resolve();
								request.onerror = (): void => reject(request.error);
								request.onblocked = (): void => reject(new Error("NATIVE_CLEANUP_BLOCKED"));
							});
						}
					}, identity);
				} finally {
					await cleanup.close();
				}
			} catch (error) {
				await info.attach("cleanup-failure", { body: String(error), contentType: "text/plain" });
				if (primary === undefined) primary = error;
			}
			if (primary !== undefined) throw primary;
		});
	}
