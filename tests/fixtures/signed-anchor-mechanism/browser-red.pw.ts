import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { server } from "./browser-server.js";
import type { Case } from "./exercise.js";
import { ownedTest } from "../rollback-data-observation/ownership.js";
import type { Bootstrap } from "../rollback-data-observation/types.js";
const directory = process.env.SIGNED_ANCHOR_ARTIFACTS;
if (!directory) throw new Error("FROZEN_BUNDLES_REQUIRED");
let local: Awaited<ReturnType<typeof server>>;
const test = ownedTest(() => local.origin).extend<{ recipientCleanup(identity: string): void }>({
	recipientCleanup: async ({ context, cleanupOwner }, use, info) => {
		const originalCleanup = new Set(context.pages()),
			cleanup = await context.newPage();
		let names: string[] = [];
		try {
			await cleanup.goto(local.origin + "/cleanup");
			await use((identity) => {
				if (names.length) throw new Error("RECIPIENT_NAMES_ALREADY_REGISTERED");
				names = [identity + "--recipient--drp-live-journal-v1"];
			});
		} finally {
			try {
				for (const page of context.pages())
					if (page !== cleanup && !originalCleanup.has(page)) await cleanupOwner.closeWork(page);
				const receipt = await cleanup.evaluate(async (list) => {
					const results = [];
					for (const name of list) {
						await new Promise<void>((resolve, reject) => {
							const request = indexedDB.deleteDatabase(name);
							request.onsuccess = (): void => resolve();
							request.onerror = (): void => reject(request.error);
							request.onblocked = (): void => reject(new Error("owned recipient delete blocked:" + name));
						});
						results.push({ name, terminal: "success" });
					}
					return results;
				}, names);
				await info.attach("exact-recipient-native-delete", {
					body: JSON.stringify({ names, receipt }),
					contentType: "application/json",
				});
			} finally {
				await cleanupOwner.closeWork(cleanup);
			}
		}
	},
});
test.beforeAll(async () => {
	local = await server(directory);
});
test.afterAll(async () => {
	await local.close();
});
for (const mode of [
	"baseline",
	"in-place",
	"empty-import",
	"zero-nonnumeric",
	"orphan-nonnumeric",
	"terminal-precommit",
	"terminal-postcommit",
	"terminal-concurrent",
] as Case[])
	test("fresh realm signed-anchor: " + mode, async ({ context, cleanupOwner, recipientCleanup }, info) => {
		const identity = "signed-anchor-" + randomUUID();
		await cleanupOwner.register(identity, 3);
		recipientCleanup(identity);
		await info.attach("early-recipient-ownership", {
			body: JSON.stringify({ name: identity + "--recipient--drp-live-journal-v1" }),
			contentType: "application/json",
		});
		const setup = await context.newPage();
		await setup.goto(local.origin + "/work");
		await setup.waitForFunction(() => typeof Reflect.get(globalThis, "signedSetup") === "function");
		const installed = (await setup.evaluate((id) => Reflect.get(globalThis, "signedSetup")(id), identity)) as {
			realm: number;
			report: { bootstrap: Bootstrap };
			precondition: unknown;
		};
		await cleanupOwner.closeWork(setup);
		const recovery = await context.newPage();
		await recovery.goto(local.origin + "/work");
		await recovery.waitForFunction(() => typeof Reflect.get(globalThis, "signedExercise") === "function");
		const result = (await recovery.evaluate(({ b, mode }) => Reflect.get(globalThis, "signedExercise")(b, mode), {
			b: installed.report.bootstrap,
			mode,
		})) as Record<string, unknown>;
		await info.attach("fresh-native-result", {
			body: JSON.stringify({ installed, result }),
			contentType: "application/json",
		});
		assert.notEqual(result.realm, installed.realm);
		assert.equal(result.requirementFrozen, true);
		assert.equal(result.requirementFieldless, true);
		if (mode === "baseline") {
			assert.equal((result.observer as { ok: boolean }).ok, true);
			return;
		}
		assert.equal(
			result.classification,
			"REACHED",
			"WIRING_RED: genuine baseline source exists; future mechanism is missing"
		);
		if (mode === "in-place" || mode === "empty-import") {
			if (mode === "in-place") {
				const native = result.native as {
					modes: string[];
					writes: number;
					reads: { operation: string; table: string }[];
				};
				assert.equal(native.writes, 0);
				assert.ok(native.modes.every((value) => value === "readonly"));
				assert.ok(native.reads.every((read) => read.table !== "acceptedEntries"));
			}
			assert.equal((result.importerResult as { ok: boolean }).ok, true);
			assert.equal((result.observer as { ok: boolean }).ok, true);
			await cleanupOwner.closeWork(recovery);
			const reopen = await context.newPage();
			await reopen.goto(local.origin + "/work");
			await reopen.waitForFunction(() => typeof Reflect.get(globalThis, "signedExercise") === "function");
			const checked = (await reopen.evaluate(({ b, mode }) => Reflect.get(globalThis, "signedExercise")(b, mode), {
				b: installed.report.bootstrap,
				mode,
			})) as Record<string, unknown>;
			await info.attach("independent-recipient-reopen", {
				body: JSON.stringify(checked),
				contentType: "application/json",
			});
			assert.notEqual(checked.realm, result.realm);
			assert.equal((checked.observer as { ok: boolean }).ok, true);
			assert.equal((checked.importerResult as { ok: boolean }).ok, true);
		} else assert.ok(result.storageResults);
	});
