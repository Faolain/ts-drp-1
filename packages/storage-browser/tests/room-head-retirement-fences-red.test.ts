import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserRoomHeadAuthority } from "../src/room-head.js";

// Slice 14c (specs/bounded-storage-lifecycle/slices/14c-host-floor-retirement-fence.md).
// Mechanism evidence over fake-indexeddb only; the native three-engine and
// SIGKILL evidence belongs to slice 14f.

const scope = Object.freeze({ objectId: "floor-fence-room", pinnedGenesisAnchorDigest: "0".repeat(64) });
const head = (epoch: number): { objectId: string; epoch: number; currentAnchorDigest: string } => ({
	objectId: scope.objectId,
	epoch,
	currentAnchorDigest: (epoch % 10).toString().repeat(64),
});
const digest = (letter: string): string => letter.repeat(64);

function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = (): void => resolve(r.result);
		r.onerror = (): void => reject(r.error);
	});
}
function terminal(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = (): void => resolve();
		tx.onabort = (): void => reject(tx.error);
	});
}
async function rawOpen(name: string): Promise<IDBDatabase> {
	return request(indexedDB.open(name));
}
async function rawFences(name: string): Promise<unknown> {
	const db = await rawOpen(name);
	try {
		const tx = db.transaction("retirementFences", "readonly"),
			done = terminal(tx);
		const value = await request(tx.objectStore("retirementFences").get(scope.objectId));
		await done;
		return value;
	} finally {
		db.close();
	}
}
async function rawPutFences(name: string, value: unknown): Promise<void> {
	const db = await rawOpen(name);
	try {
		const tx = db.transaction("retirementFences", "readwrite", { durability: "strict" }),
			done = terminal(tx);
		tx.objectStore("retirementFences").put(value, scope.objectId);
		await done;
	} finally {
		db.close();
	}
}

type Authority = Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>> & {
	fenceRetirement(input: unknown): Promise<unknown>;
	readRetirementFences(input: unknown): Promise<unknown>;
};

async function openFenced(name: string, kind: "create" | "reopen" = "create", epoch = 6): Promise<Authority> {
	const authority = (await createBrowserRoomHeadAuthority({
		databaseName: name,
		initialization: { kind },
		retirementFences: true,
	} as never)) as Authority;
	if (kind === "create") {
		await authority.create({ scope, stable: head(0) });
		let state = (await authority.read({ scope })) as { ok: true; state: unknown };
		for (let next = 1; next <= epoch; next++) {
			const begun = await authority.begin({ scope, expected: state.state as never, next: head(next) });
			if (!begun.ok) throw new Error("fixture begin failed");
			const committed = await authority.commit({ scope, expected: begun.state as never });
			if (!committed.ok) throw new Error("fixture commit failed");
			state = committed as never;
		}
	}
	return authority;
}

const entry = (owner: string, through: number, base: string, target: string): unknown => ({
	owner,
	through,
	base,
	target,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "accepted";
}

afterEach(() => vi.restoreAllMocks());

describe("14c per-owner retirement fences in the host floor", () => {
	it("leaves the version-1 floor unchanged when the host does not opt in", async () => {
		const name = `fence-v1-${crypto.randomUUID()}`;
		const authority = await createBrowserRoomHeadAuthority({ databaseName: name, initialization: { kind: "create" } });
		try {
			expect("fenceRetirement" in authority).toBe(false);
			expect("readRetirementFences" in authority).toBe(false);
			await authority.create({ scope, stable: head(0) });
		} finally {
			await authority.close();
		}
		const db = await rawOpen(name);
		try {
			expect(db.version).toBe(1);
			expect([...db.objectStoreNames]).toEqual(["floor"]);
		} finally {
			db.close();
		}
	});

	it("creates exactly the floor and retirementFences stores at version 2", async () => {
		const name = `fence-v2-${crypto.randomUUID()}`;
		const authority = await openFenced(name);
		try {
			expect(await authority.readRetirementFences({ scope })).toBeNull();
		} finally {
			await authority.close();
		}
		const db = await rawOpen(name);
		try {
			expect(db.version).toBe(2);
			expect([...db.objectStoreNames].sort()).toEqual(["floor", "retirementFences"]);
			const store = db.transaction("retirementFences", "readonly").objectStore("retirementFences");
			expect(store.keyPath).toBeNull();
			expect(store.autoIncrement).toBe(false);
			expect([...store.indexNames]).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("upgrades an existing version-1 floor on reopen and keeps its image", async () => {
		const name = `fence-upgrade-${crypto.randomUUID()}`;
		const legacy = await createBrowserRoomHeadAuthority({ databaseName: name, initialization: { kind: "create" } });
		await legacy.create({ scope, stable: head(0) });
		const before = await legacy.read({ scope });
		await legacy.close();
		const authority = await openFenced(name, "reopen");
		try {
			expect(await authority.read({ scope })).toEqual(before);
			expect(await authority.readRetirementFences({ scope })).toBeNull();
		} finally {
			await authority.close();
		}
	});

	it("fences version-1 code out of a version-2 floor and closes open version-1 connections", async () => {
		const name = `fence-stale-${crypto.randomUUID()}`;
		const legacy = await createBrowserRoomHeadAuthority({ databaseName: name, initialization: { kind: "create" } });
		await legacy.create({ scope, stable: head(0) });
		const authority = await openFenced(name, "reopen");
		try {
			// The open version-1 connection received versionchange and closed.
			expect(await refusal(legacy.read({ scope }))).toBe("ROOM_HEAD_CLOSED");
			// Version-1 code cannot open the upgraded database at all.
			const stale = await refusal(
				createBrowserRoomHeadAuthority({ databaseName: name, initialization: { kind: "reopen" } })
			);
			expect(stale).not.toBe("accepted");
		} finally {
			await authority.close();
		}
	});

	it("records a first fence, then applied and unapplied transitions, monotone and idempotent", async () => {
		const name = `fence-transitions-${crypto.randomUUID()}`;
		const authority = await openFenced(name);
		try {
			const first = (await authority.fenceRetirement({
				scope,
				owners: [entry("journal", 2, digest("a"), digest("b")), entry("ahe", 1, digest("c"), digest("d"))],
			})) as { revision: number; owners: unknown[] };
			expect(first.revision).toBe(1);
			expect(first.owners).toEqual([
				["ahe", { through: 1, base: digest("c"), target: digest("d") }],
				["journal", { through: 2, base: digest("a"), target: digest("b") }],
			]);
			expect(await authority.readRetirementFences({ scope })).toEqual(first);

			// Idempotent replay: identical entries, no write.
			const replay = (await authority.fenceRetirement({
				scope,
				owners: [entry("journal", 2, digest("a"), digest("b"))],
			})) as { revision: number };
			expect(replay.revision).toBe(1);

			// Applied: the new base is the old target.
			const applied = (await authority.fenceRetirement({
				scope,
				owners: [entry("journal", 3, digest("b"), digest("e"))],
			})) as { revision: number; owners: unknown[] };
			expect(applied.revision).toBe(2);
			expect(applied.owners).toContainEqual(["journal", { through: 3, base: digest("b"), target: digest("e") }]);
			expect(applied.owners).toContainEqual(["ahe", { through: 1, base: digest("c"), target: digest("d") }]);

			// Unapplied: the target never reached the room database, so the base is unchanged.
			const replaced = (await authority.fenceRetirement({
				scope,
				owners: [entry("journal", 3, digest("b"), digest("f"))],
			})) as { revision: number; owners: unknown[] };
			expect(replaced.revision).toBe(3);
			expect(replaced.owners).toContainEqual(["journal", { through: 3, base: digest("b"), target: digest("f") }]);
		} finally {
			await authority.close();
		}
	});

	it("refuses conflicts, lowered fences, the window and scope mismatches with zero writes", async () => {
		const name = `fence-refusals-${crypto.randomUUID()}`;
		const authority = await openFenced(name, "create", 6);
		try {
			await authority.fenceRetirement({ scope, owners: [entry("signing", 3, digest("a"), digest("b"))] });
			const before = await rawFences(name);
			const conflict = await refusal(
				authority.fenceRetirement({ scope, owners: [entry("signing", 4, digest("c"), digest("e"))] })
			);
			expect(conflict).toBe("ROOM_HEAD_FENCE_CONFLICT");
			const lowered = await refusal(
				authority.fenceRetirement({ scope, owners: [entry("signing", 2, digest("b"), digest("e"))] })
			);
			expect(lowered).toBe("ROOM_HEAD_FENCE_CONFLICT");
			// The stable epoch is 6: a completed retirement stays below it.
			const window = await refusal(
				authority.fenceRetirement({ scope, owners: [entry("snapshot", 6, digest("a"), digest("b"))] })
			);
			expect(window).toBe("ROOM_HEAD_FENCE_WINDOW");
			const otherScope = await refusal(
				authority.fenceRetirement({
					scope: { ...scope, objectId: "another-room" },
					owners: [entry("journal", 1, digest("a"), digest("b"))],
				})
			);
			expect(otherScope).toBe("ROOM_HEAD_CONTROL_CONFLICT");
			// One refused owner refuses the whole request.
			const mixed = await refusal(
				authority.fenceRetirement({
					scope,
					owners: [entry("journal", 1, digest("a"), digest("b")), entry("signing", 4, digest("c"), digest("e"))],
				})
			);
			expect(mixed).toBe("ROOM_HEAD_FENCE_CONFLICT");
			expect(await rawFences(name)).toEqual(before);
		} finally {
			await authority.close();
		}
	});

	it("refuses malformed requests before any native transaction", async () => {
		const name = `fence-input-${crypto.randomUUID()}`;
		const authority = await openFenced(name);
		try {
			for (const owners of [
				[],
				[entry("journal", 1, digest("a"), digest("b")), entry("journal", 1, digest("a"), digest("b"))],
				[entry("unknown-owner", 1, digest("a"), digest("b"))],
				[entry("journal", -1, digest("a"), digest("b"))],
				[entry("journal", 1.5, digest("a"), digest("b"))],
				[entry("journal", 1, "not-a-digest", digest("b"))],
				[{ owner: "journal", through: 1, base: digest("a") }],
			]) {
				expect(await refusal(authority.fenceRetirement({ scope, owners }))).toMatch(/^ROOM_HEAD_INVALID_/u);
			}
			expect(await rawFences(name)).toBeUndefined();
		} finally {
			await authority.close();
		}
	});

	it("refuses a missing floor image and a corrupt fence record without writing", async () => {
		const name = `fence-corrupt-${crypto.randomUUID()}`;
		const empty = (await createBrowserRoomHeadAuthority({
			databaseName: name,
			initialization: { kind: "create" },
			retirementFences: true,
		} as never)) as Authority;
		try {
			expect(
				await refusal(empty.fenceRetirement({ scope, owners: [entry("journal", 0, digest("a"), digest("b"))] }))
			).toBe("ROOM_HEAD_CONTROL_CONFLICT");
		} finally {
			await empty.close();
		}
		const authority = await openFenced(`${name}-2`);
		try {
			await authority.fenceRetirement({ scope, owners: [entry("journal", 1, digest("a"), digest("b"))] });
			const corrupt = Uint8Array.of(1, 2, 3);
			await rawPutFences(`${name}-2`, corrupt);
			expect(
				await refusal(authority.fenceRetirement({ scope, owners: [entry("journal", 2, digest("b"), digest("c"))] }))
			).toBe("ROOM_HEAD_FENCE_CORRUPT");
			expect(await refusal(authority.readRetirementFences({ scope }))).toBe("ROOM_HEAD_FENCE_CORRUPT");
			expect(await rawFences(`${name}-2`)).toEqual(corrupt);
		} finally {
			await authority.close();
		}
	});

	it("writes fences only in one strict read-write transaction over floor and retirementFences", async () => {
		const name = `fence-strict-${crypto.randomUUID()}`;
		const authority = await openFenced(name);
		const calls: unknown[][] = [];
		const original = IDBDatabase.prototype.transaction;
		vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
			this: IDBDatabase,
			...args: Parameters<IDBDatabase["transaction"]>
		) {
			calls.push(args);
			return original.apply(this, args);
		});
		try {
			await authority.fenceRetirement({ scope, owners: [entry("issuance", 2, digest("a"), digest("b"))] });
		} finally {
			vi.restoreAllMocks();
			await authority.close();
		}
		const writes = calls.filter((call) => call[1] === "readwrite");
		expect(writes).toHaveLength(1);
		expect([...(writes[0]![0] as string[])].sort()).toEqual(["floor", "retirementFences"]);
		expect(writes[0]![2]).toEqual({ durability: "strict" });
	});
});
