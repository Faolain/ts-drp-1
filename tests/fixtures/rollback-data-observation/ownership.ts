/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- One explicit context lifetime follows the accepted cleanup owner. */
import { type BrowserContext, test as originalTest, type Page } from "@playwright/test";
type Event = { event: string; time: number; [key: string]: unknown };
export interface Owner {
	register(identity: string, epochs: number): Promise<void>;
	closeWork(page: Page): Promise<void>;
}
interface Owned {
	ownership: { context: BrowserContext; owner: Owner };
	cleanupOwner: Owner;
}
async function within<T>(operation: Promise<T>, end: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(label + " pending at cleanup deadline")),
					Math.max(0, end - Date.now())
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
export function ownedTest(getOrigin: () => string) {
	return originalTest.extend<Owned>({
		ownership: async ({ browser }, use, info) => {
			const context = await browser.newContext(),
				events: Event[] = [],
				failures: unknown[] = [],
				closing = new Map<Page, Promise<void>>();
			let cleanup: Page | undefined, names: string[] | undefined;
			const mark = (event: string, fields: Record<string, unknown> = {}) => {
				events.push({ event, time: Date.now(), ...fields });
				console.log(
					"ROLLBACK_CLEANUP " + JSON.stringify({ engine: info.project.name, title: info.title, ...events.at(-1) })
				);
			};
			mark("context-created", { requestedOptions: {} });
			context.on("close", () => mark("context-close-event"));
			const closeWork = (page: Page) => {
				let promise = closing.get(page);
				if (!promise) {
					promise = (async () => {
						mark("work-close-entry", { alreadyClosed: page.isClosed() });
						try {
							await page.close();
							mark("work-close-settled");
						} catch (error) {
							failures.push(error);
							mark("work-close-error", { detail: String(error) });
						}
					})();
					closing.set(page, promise);
				}
				return promise;
			};
			const owner: Owner = {
				closeWork,
				register: async (identity, epochs) => {
					if (names) throw new Error("database ownership already registered");
					names = [
						identity + "--ahe",
						identity + "--drp-issuance-v1",
						identity + "--drp-live-journal-v1",
						identity + "--drp-snapshot-quarantine-v1",
						identity + "--host-floor",
						...Array.from({ length: epochs }, (_, k) => identity + "--seal-" + k),
					];
					mark("exact-names-registered", { names });
					await info.attach("rollback-early-ownership", {
						body: JSON.stringify({ names, origin: getOrigin(), events }),
						contentType: "application/json",
					});
				},
			};
			try {
				cleanup = await context.newPage();
				await cleanup.goto(getOrigin() + "/cleanup");
				await cleanup.waitForFunction(() => typeof Reflect.get(globalThis, "rollbackDelete") === "function");
				mark("cleanup-realm-ready");
				await use({ context, owner });
			} catch (error) {
				failures.push(error);
			} finally {
				const teardownEnd = Date.now() + info.timeout,
					nativeDeadline = teardownEnd - 5000;
				mark("outer-cleanup-entry", { status: info.status, teardownEnd, nativeDeadline, closeReserveMs: 5000 });
				const operation = (async () => {
					for (const page of context.pages()) if (page !== cleanup) await closeWork(page);
					await Promise.all(closing.values());
					if (failures.length) throw new AggregateError([...failures], "work closure failed");
					if (!names) return;
					if (!cleanup) throw new Error("no cleanup realm");
					mark("exact-delete-entry", { names });
					const receipt = await cleanup.evaluate(
						async (list) => Reflect.get(globalThis, "rollbackDelete")(list),
						names
					);
					mark("exact-native-delete-and-empty-inventory", { receipt });
				})();
				const observed = operation.then(
					() => mark("cleanup-operation-settled"),
					(error: unknown) => mark("cleanup-operation-rejected", { detail: String(error) })
				);
				try {
					await within(operation, nativeDeadline, "outer native cleanup");
				} catch (error) {
					failures.push(error);
					mark("cleanup-not-success", { detail: String(error) });
				} finally {
					try {
						mark("context-close-entry");
						await within(
							context.close().then(() => mark("context-close-settled")),
							teardownEnd,
							"context close"
						);
					} catch (error) {
						failures.push(error);
						mark("context-close-error", { detail: String(error) });
					} finally {
						try {
							await within(observed, teardownEnd, "cleanup eventual settlement");
							await within(
								info.attach("rollback-outer-cleanup", {
									body: JSON.stringify({ names, primaryErrors: info.errors, failures: failures.map(String), events }),
									contentType: "application/json",
								}),
								teardownEnd,
								"cleanup receipt"
							);
						} catch (error) {
							failures.push(error);
						}
					}
				}
			}
			if (failures.length) throw new AggregateError(failures, "outer rollback cleanup failed");
		},
		context: async ({ ownership }, use) => {
			await use(ownership.context);
		},
		cleanupOwner: async ({ ownership }, use) => {
			await use(ownership.owner);
		},
	});
}
