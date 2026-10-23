import "fake-indexeddb/auto";
import { encodeCanonical } from "@ts-drp/canonical";
import { type DurableLiveJournalStore, LIVE_JOURNAL_RETIREMENT_LIMITS } from "@ts-drp/live-journal";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/src/live-journal.js";
import { createBrowserDurableLiveJournalStore } from "../packages/storage-browser/src/live-journal.js";
import { anchorMaterial } from "./fixtures/journal-anchor-read/material.js";

const request = <T>(value: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});

it.each(["sqlite", "indexeddb"] as const)(
	"%s point membership reads are bounded, detached, noncreating and preserve native currency",
	async (backend) => {
		const directory = await mkdtemp(join(tmpdir(), "journal-membership-read-"));
		const name = join(directory, "journal");
		let store: DurableLiveJournalStore | undefined;
		try {
			store =
				backend === "sqlite"
					? createNodeDurableLiveJournalStore({ primaryFilename: name })
					: await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
			const read = store.readClosedMembership!,
				image = store.readRetirementImage!,
				record = store.recordClosedMembership!;
			const material = anchorMaterial(0),
				scope = material.scope;
			const bytes = encodeCanonical({ kind: "opaque-test-evidence", payload: new Uint8Array(262144).fill(19) });
			expect(await read({ scope, maxBytes: bytes.byteLength })).toEqual({ ok: true, kind: "missing" });
			expect(await store.readiness({ scope })).toMatchObject({ ok: true, ready: false });
			expect(await store.installGenesis(material.install)).toMatchObject({ ok: true });
			expect(await read({ scope, maxBytes: bytes.byteLength })).toEqual({ ok: true, kind: "missing" });
			const before = await image({ objectId: scope.objectId });
			if (!before.ok) throw new Error(before.kind);
			expect(
				await record({
					scope,
					exactCanonicalMembershipBytes: bytes,
					expectedNativeImage: { imageDigest: before.value.image.imageDigest, controlBytes: null },
				})
			).toMatchObject({ ok: true });
			const written = await image({ objectId: scope.objectId });
			expect(await read({ scope, maxBytes: bytes.byteLength - 1 })).toEqual({
				ok: false,
				kind: "read-budget-exceeded",
			});
			let getters = 0;
			expect(
				await read({
					scope,
					get maxBytes() {
						getters++;
						return bytes.byteLength;
					},
				})
			).toEqual({ ok: false, kind: "malformed-input" });
			expect(getters).toBe(0);
			expect(await read({ scope, maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1 })).toEqual({
				ok: false,
				kind: "malformed-input",
			});
			const result = await read({ scope, maxBytes: bytes.byteLength });
			expect(result).toEqual({ ok: true, kind: "present", scope, exactCanonicalMembershipBytes: bytes });
			if (!result.ok || result.kind !== "present") throw new Error("membership missing");
			result.exactCanonicalMembershipBytes.fill(0);
			expect(await read({ scope, maxBytes: bytes.byteLength })).toEqual({
				ok: true,
				kind: "present",
				scope,
				exactCanonicalMembershipBytes: bytes,
			});
			expect(await image({ objectId: scope.objectId })).toEqual(written);
			await store.close();
			expect(await read({ scope, maxBytes: bytes.byteLength })).toEqual({ ok: false, kind: "store-closed" });
		} finally {
			await store?.close();
			if (backend === "indexeddb") await request(indexedDB.deleteDatabase(`${name}--drp-live-journal-v1`));
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it("SQLite membership export uses one bounded scope query without scanning accepted entries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "journal-membership-query-"));
	const store = createNodeDurableLiveJournalStore({ primaryFilename: join(directory, "journal") });
	try {
		const material = anchorMaterial(0);
		expect(await store.installGenesis(material.install)).toMatchObject({ ok: true });
		const sql: string[] = [],
			original = DatabaseSync.prototype.prepare;
		const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
			this: DatabaseSync,
			value: string
		) {
			sql.push(value);
			return original.call(this, value);
		});
		try {
			expect(await store.readClosedMembership!({ scope: material.scope, maxBytes: 1 })).toEqual({
				ok: true,
				kind: "missing",
			});
		} finally {
			spy.mockRestore();
		}
		expect(sql.filter((value) => /FROM scopes/u.test(value))).toHaveLength(1);
		expect(sql.some((value) => /accepted_entries|ORDER BY|SELECT \*/u.test(value))).toBe(false);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
