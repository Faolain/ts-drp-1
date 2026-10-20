import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { resolveCreatorCloseEvidenceStore } from "@ts-drp/seal/internal/creator-close-intent";
import { decodeGenerationRecordV1, encodeGenerationRecordV1 } from "@ts-drp/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	lullFixture,
	type LullFixture,
	type OpenedRoom,
	required,
	rollover,
	transition,
} from "./fixtures/track-m/room-retention-fixture.js";
import {
	advancedControl,
	type Dump,
	flipped,
	foreignWrite,
	ownedDifference,
	readRow,
	type Row,
	rowsOf,
	trapRetention,
} from "./fixtures/track-m/room-retention-probe.js";

// Track M, slice 14b RED 1-4 (retention trust), on the browser room database host
// (fake-indexeddb: mechanism evidence; the native engines are slice 14f). The room opts
// into retention; each lull's first pass decides from its own complete cold acquisition
// (stage 1) and applies the decision as one room transaction (step B) per continuation.
//
// A probe changes durable bytes through its OWN connection between the decision and
// step B, as a foreign writer or a corrupting host would. Step B must refuse with zero
// writes; the boundary then retains, and the next pass runs the existing path from a
// fresh acquisition (the probe restores the bytes first, so that pass and the next lull
// prove the room continues). Nothing is repaired.

type Event = Readonly<Record<string, unknown>>;
type Selection = Readonly<{
	objectId: string;
	throughEpoch: number;
	snapshot: Readonly<{ retire: readonly Readonly<{ scope: Readonly<Record<string, unknown>> }>[] }>;
	journal: Readonly<{
		prefixes: readonly Readonly<{
			scope: Readonly<{ objectId: string; epoch: number; anchorDigest: string }>;
			highWatermark: number;
			rows: readonly Readonly<{ journalSequence: number }>[];
		}>[];
		headers: readonly Readonly<{ scope: Readonly<{ objectId: string; epoch: number; anchorDigest: string }> }>[];
	}>;
	signing: Readonly<{ evidence: readonly Readonly<{ key: readonly unknown[] }>[] }>;
	ahe: Readonly<{
		units: readonly Readonly<{ reclamation: { lineageFloor: { deleteGenerationIds: readonly string[] } } }>[];
	}>;
	survivors: Readonly<{
		journalHeaders: readonly Readonly<{ scope: Readonly<{ objectId: string; epoch: number; anchorDigest: string }> }>[];
	}>;
}>;

const events: Event[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
	events.length = 0;
	restore = installEnvironment((event) => {
		if (String(event.kind ?? "").startsWith("room-retention")) events.push(event);
	});
});
afterEach(async () => {
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

const STEADY = 5;
const headerKey = (scope: Readonly<{ objectId: string; epoch: number; anchorDigest: string }>) => [
	scope.objectId,
	scope.epoch,
	scope.anchorDigest,
];

/** A retention room in steady turnover: STEADY rollovers with both lulls. */
async function steady(
	seed: string
): Promise<Readonly<{ fixture: LullFixture; creator: OpenedRoom; recipient: OpenedRoom }>> {
	const fixture = await lullFixture({ retention: true, creatorLull: true, seed });
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
	// Steady turnover: both lulls already applied retention decisions.
	expect(
		events.filter((event) => event.kind === "room-retention-pass" && event.outcome === "applied").length
	).toBeGreaterThan(2);
	return { fixture, creator, recipient };
}

/** One change a probe makes between the decision and step B, and its exact undo. */
interface Change {
	readonly puts: readonly Row[];
	readonly deletes?: readonly Readonly<{ store: string; key: unknown }>[];
	readonly undoPuts: readonly Row[];
	readonly undoDeletes?: readonly Readonly<{ store: string; key: unknown }>[];
}

interface Refusal {
	readonly pass: Event;
	readonly poisoned: Dump;
	readonly afterAbort: Dump;
	readonly lull: unknown;
	readonly fired: boolean;
}

/**
 * Runs the next lull of `who` with `choose` applied by a foreign connection just before the
 * retention session's first plan (after the decision, before step B), and undone after
 * the session aborts.
 */
async function probeLull(
	room: Readonly<{ fixture: LullFixture; creator: OpenedRoom; recipient: OpenedRoom }>,
	who: "creator" | "recipient",
	choose: (selection: Selection, database: string) => Promise<Change>,
	epoch = STEADY
): Promise<Refusal> {
	const { fixture, creator, recipient } = room;
	await transition(fixture, creator, recipient, epoch);
	let poisoned: Dump | undefined, afterAbort: Dump | undefined, change: Change | undefined;
	const trap = trapRetention(fixture, {
		beforeFirstPlan: async ({ database, selection }) => {
			if (change !== undefined) return;
			change = await choose(selection as unknown as Selection, database);
			await foreignWrite(database, change.puts, change.deletes).committed;
			poisoned = await dumpDatabase(database);
		},
		afterAbort: async ({ database }) => {
			if (change === undefined || afterAbort !== undefined) return;
			afterAbort = await dumpDatabase(database);
			await foreignWrite(database, change.undoPuts, change.undoDeletes).committed;
		},
	});
	const before = events.length;
	let lull: unknown;
	try {
		lull = await (who === "creator" ? creator : recipient).room.maintainRecoveryPool();
	} finally {
		trap.release();
	}
	const pass = events.slice(before).find((event) => event.kind === "room-retention-pass");
	return {
		pass: required(pass),
		poisoned: required(poisoned),
		afterAbort: required(afterAbort),
		lull,
		fired: change !== undefined,
	};
}

/** The refusal retained the boundary with zero writes, and the room continues. */
async function expectRetained(
	room: Readonly<{ fixture: LullFixture; creator: OpenedRoom; recipient: OpenedRoom }>,
	result: Refusal,
	reason: RegExp,
	next = STEADY + 1
): Promise<void> {
	expect(result.fired).toBe(true);
	expect(result.pass).toMatchObject({ outcome: "retained" });
	expect(String(result.pass.reason)).toMatch(reason);
	// Zero writes: the database after the aborted step B is exactly the poisoned one.
	expect(ownedDifference(result.poisoned, result.afterAbort)).toEqual([]);
	// The next pass ran the existing path from a fresh acquisition: the lull completed.
	expect(result.lull).toMatchObject({ kind: "maintained" });
	// And the next boundary decides again on the retention path.
	const before = events.length;
	await rollover(room.fixture, room.creator, room.recipient, next);
	const outcomes = events
		.slice(before)
		.filter((event) => event.kind === "room-retention-pass")
		.map((event) => event.outcome);
	expect(outcomes.length).toBeGreaterThanOrEqual(2);
	expect(new Set(outcomes)).toEqual(new Set(["applied"]));
}

async function storeWith(database: string, prefix: string, key: unknown): Promise<string> {
	const dump = await dumpDatabase(database);
	for (const [store, rows] of Object.entries(dump))
		if (store.startsWith(prefix) && rows.some(([candidate]) => JSON.stringify(candidate) === JSON.stringify(key)))
			return store;
	throw new TypeError(`TRACK_M_STORE_NOT_FOUND ${prefix} ${JSON.stringify(key)}`);
}

async function change(
	database: string,
	store: string,
	key: unknown,
	mutate: (value: unknown) => unknown
): Promise<Change> {
	const value = required(await readRow(database, store, key));
	return { puts: [{ store, key, value: mutate(value) }], undoPuts: [{ store, key, value }] };
}

/** Flips one named field (bytes or hex) of a row value. */
const field =
	(name: string) =>
	(value: unknown): unknown => ({
		...(value as Record<string, unknown>),
		[name]: flipped({ [name]: (value as Record<string, unknown>)[name] }) as unknown as Record<string, unknown>,
	});
const fieldOf = (name: string) => (value: unknown) => {
	const out = field(name)(value) as Record<string, Record<string, unknown>>;
	return { ...out, [name]: required(out[name])[name] };
};

describe("14b RED 1: poisoned bytes refuse RETENTION_STALE with zero writes", () => {
	it("a deleted signing evidence row whose bytes no longer hash to its verified fact", async () => {
		const room = await steady("track-m-trust-evidence");
		const result = await probeLull(room, "creator", (selection, database) => {
			const entry = required(selection.signing.evidence[0]);
			return change(database, "sealEvidence", [...entry.key], flipped);
		});
		await expectRetained(room, result, /^RETENTION_STALE:signing:row-changed$/);
	}, 600_000);

	it("a deleted journal row of a collectible prefix", async () => {
		const room = await steady("track-m-trust-journal-row");
		const result = await probeLull(room, "creator", (selection, database) => {
			const prefix = required(selection.journal.prefixes[0]);
			const row = required(prefix.rows[0]);
			return change(
				database,
				"journal:acceptedEntries",
				[...headerKey(prefix.scope), row.journalSequence],
				fieldOf("vertexDigest")
			);
		});
		await expectRetained(room, result, /^RETENTION_STALE:journal:/);
	}, 600_000);

	it("a chunk of a retiring snapshot scope", async () => {
		const room = await steady("track-m-trust-chunk");
		const result = await probeLull(room, "creator", async (selection, database) => {
			const scope = required(selection.snapshot.retire[0]).scope;
			const chunk = (await rowsOf(database, "snapshot:chunks")).find(([key]) =>
				JSON.stringify(key).includes(JSON.stringify(scope.anchor))
			);
			return change(database, "snapshot:chunks", required(chunk)[0], flipped);
		});
		await expectRetained(room, result, /^RETENTION_STALE:snapshot:survivors$/);
	}, 600_000);

	it("a protected journal header the decision relies on (survivor)", async () => {
		const room = await steady("track-m-trust-survivor-header");
		const result = await probeLull(room, "creator", (selection, database) => {
			const survivor = required(selection.survivors.journalHeaders[0]);
			return change(database, "journal:scopes", headerKey(survivor.scope), fieldOf("detachedAnchorSignature"));
		});
		await expectRetained(room, result, /^RETENTION_STALE:journal:survivor$/);
	}, 600_000);

	it("a protected journal header the decision relies on, on a recipient", async () => {
		const room = await steady("track-m-trust-recipient-header");
		const result = await probeLull(room, "recipient", (selection, database) => {
			const survivor = required(selection.survivors.journalHeaders[0]);
			return change(database, "journal:scopes", headerKey(survivor.scope), fieldOf("detachedAnchorSignature"));
		});
		await expectRetained(room, result, /^RETENTION_STALE:journal:survivor$/);
	}, 600_000);

	it("a surviving AHE generation (the head's rollback chain)", async () => {
		const room = await steady("track-m-trust-ahe-survivor");
		const result = await probeLull(room, "recipient", async (selection, database) => {
			const retiring = new Set(
				selection.ahe.units.flatMap((unit) => unit.reclamation.lineageFloor.deleteGenerationIds)
			);
			const generations = await rowsOf(database, "ahe:generations");
			const [key] = required(generations.find(([candidate]) => !retiring.has(String((candidate as unknown[])[1]))));
			// The surviving generation's stored record bytes differ from the verified ones.
			return change(database, "ahe:generations", key, (value) => {
				const row = value as Record<string, unknown>;
				return { ...row, record: flipped(row.record) };
			});
		});
		await expectRetained(room, result, /^RETENTION_(STALE|CORRUPT):ahe:/);
	}, 600_000);

	it.each([
		["ahe", "ahe:", (objectId: string) => `ahe-retirement:${objectId}`],
		["journal", "journal:retirementControls", (objectId: string) => objectId],
		["snapshot", "snapshot:retirementControls", (objectId: string) => objectId],
		["signing", "storageMeta", (objectId: string) => `signing-retirement:${objectId}`],
		["issuance", "issuance:retirementControls", (objectId: string) => objectId],
	] as const)(
		"the %s owner control differs from the one the decision verified",
		async (owner, prefix, keyOf) => {
			const room = await steady(`track-m-trust-control-${owner}`);
			const result = await probeLull(room, "creator", async (selection, database) => {
				const key = keyOf(selection.objectId);
				return change(database, await storeWith(database, prefix, key), key, advancedControl);
			});
			await expectRetained(room, result, new RegExp(`^RETENTION_STALE:${owner}:control$`));
		},
		600_000
	);

	it("a carrier the decision relies on (a prefix header's closed-membership carrier)", async () => {
		const room = await steady("track-m-trust-carrier");
		const result = await probeLull(room, "creator", (selection, database) => {
			const prefix = required(selection.journal.prefixes[0]);
			return change(database, "journal:scopes", headerKey(prefix.scope), fieldOf("closedMembershipBytes"));
		});
		await expectRetained(room, result, /^RETENTION_STALE:journal:prefix-header-changed$/);
	}, 600_000);
});

describe("14b RED 2: a foreign writer between the decision and step B", () => {
	it("appends to a retired range: step B sees the row and refuses", async () => {
		const room = await steady("track-m-trust-foreign-append");
		const result = await probeLull(room, "creator", async (selection, database) => {
			const prefix = required(selection.journal.prefixes[0]);
			const last = required(prefix.rows.at(-1));
			const key = [...headerKey(prefix.scope), last.journalSequence];
			const value = required(await readRow(database, "journal:acceptedEntries", key)) as Record<string, unknown>;
			// A distinct row (its own vertex digest and local reference) past the prefix.
			const appended = {
				...(fieldOf("vertexDigest")(value) as Record<string, unknown>),
				journalSequence: prefix.highWatermark + 1,
				...(typeof value.localAuthorSequence === "number"
					? { localAuthorSequence: value.localAuthorSequence + 1_000_000 }
					: {}),
			};
			const appendedKey = [...headerKey(prefix.scope), prefix.highWatermark + 1];
			return {
				puts: [{ store: "journal:acceptedEntries", key: appendedKey, value: appended }],
				undoPuts: [],
				undoDeletes: [{ store: "journal:acceptedEntries", key: appendedKey }],
			};
		});
		await expectRetained(room, result, /^RETENTION_STALE:journal:/);
	}, 600_000);

	it("adopts (a new generation appears): step B sees the census change and refuses", async () => {
		const room = await steady("track-m-trust-foreign-adopt");
		const result = await probeLull(room, "recipient", async (_selection, database) => {
			const generations = await rowsOf(database, "ahe:generations");
			const [key, value] = required(generations.at(-1));
			const row = value as Record<string, unknown>;
			const decoded = decodeGenerationRecordV1(row.record as Uint8Array);
			if (!decoded.ok) throw new TypeError("TRACK_M_GENERATION");
			const generationId = `${decoded.value.generationId.slice(0, -1)}${decoded.value.generationId.endsWith("0") ? "1" : "0"}`;
			const record = encodeGenerationRecordV1({
				...decoded.value,
				generationId: generationId as typeof decoded.value.generationId,
			});
			const added = [(key as unknown[])[0], generationId];
			return {
				puts: [{ store: "ahe:generations", key: added, value: { ...row, generationId, record } }],
				undoPuts: [],
				undoDeletes: [{ store: "ahe:generations", key: added }],
			};
		});
		await expectRetained(room, result, /^RETENTION_(STALE|CORRUPT|CAPACITY):ahe:/);
	}, 600_000);

	it("rolls back an owner control to the one before the previous decision: step B refuses", async () => {
		const room = await steady("track-m-trust-foreign-rollback");
		const { fixture, creator } = room;
		const database = fixture.host.database("creator");
		// The journal control as it was BEFORE the previous lull's decision.
		const key = fixture.objectId;
		const older = required(await readRow(database, "journal:retirementControls", key));
		// One more boundary advances it.
		await rollover(fixture, creator, room.recipient, STEADY);
		const result = await probeLull(
			room,
			"creator",
			async () => {
				const current = required(await readRow(database, "journal:retirementControls", key));
				return {
					puts: [{ store: "journal:retirementControls", key, value: older }],
					undoPuts: [{ store: "journal:retirementControls", key, value: current }],
				};
			},
			STEADY + 1
		);
		await expectRetained(room, result, /^RETENTION_STALE:journal:control$/, STEADY + 2);
	}, 600_000);

	it("writes while step B holds the room: it is serialised after the committed decision", async () => {
		const room = await steady("track-m-trust-foreign-serial");
		const { fixture, creator, recipient } = room;
		await transition(fixture, creator, recipient, STEADY);
		const order: string[] = [];
		let writer: Promise<void> | undefined;
		// Read before the lull: a read while step B holds the room would itself wait for it.
		const value = required(
			await readRow(fixture.host.database("creator"), "issuance:retirementControls", fixture.objectId)
		) as Record<string, unknown>;
		const scratch = `${fixture.objectId}:track-m-foreign`;
		const trap = trapRetention(fixture, {
			afterPlan: async ({ database }) => {
				if (writer !== undefined) return;
				// A net no-op write (put then delete of an unused key) to a store step B holds:
				// it must wait for the commit.
				const write = foreignWrite(
					database,
					[{ store: "issuance:retirementControls", key: scratch, value: { ...value, objectId: scratch } }],
					[{ store: "issuance:retirementControls", key: scratch }]
				);
				await write.started;
				writer = write.committed.then(() => {
					order.push("foreign");
				});
			},
			afterCommit: ({ kind }) => {
				order.push(kind);
			},
		});
		const before = events.length;
		try {
			expect(await creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			trap.release();
		}
		await required(writer);
		expect(events.slice(before).find((event) => event.kind === "room-retention-pass")).toMatchObject({
			outcome: "applied",
		});
		// The foreign write committed only after the first continuation's step B committed whole.
		expect(order.indexOf("foreign")).toBeGreaterThan(order.indexOf("checkpoint"));
		expect(order.indexOf("checkpoint")).toBeGreaterThanOrEqual(0);
	}, 600_000);
});

describe("14b RED 3: after step B, every owner's ordinary writer for the retired range refuses", () => {
	/** Ordinary writes of the rows the boundary's lull retired, by each genuine owner. */
	async function staleWrites(fixture: LullFixture, before: Dump, after: Dump): Promise<Record<string, unknown>> {
		const gone = (store: string) =>
			(before[store] ?? []).filter(
				([key]) => !(after[store] ?? []).some(([other]) => JSON.stringify(other) === JSON.stringify(key))
			);
		const out: Record<string, unknown> = {};
		const evidence = gone("sealEvidence")[0];
		if (evidence !== undefined) {
			const store = await fixture.host.storageHost.openSealEvidence("creator");
			try {
				const adapter = required(resolveCreatorCloseEvidenceStore(store.store));
				const record = evidence[1] as Parameters<typeof adapter.put>[0];
				out.signing = await adapter.put(record, null);
			} finally {
				await store.close();
			}
		}
		const journal = await fixture.host.storageHost.openJournal("creator");
		try {
			const row = gone("journal:acceptedEntries")[0];
			if (row !== undefined) {
				const value = row[1] as Record<string, unknown>;
				out.journalAppend = await journal.appendAccepted({
					scope: {
						objectId: String(value.objectId),
						epoch: Number(value.epoch),
						anchorDigest: String(value.anchorDigest),
					},
					sourceKind: "local-issued",
					vertexDigest: String(value.vertexDigest),
					author: String(value.localAuthor),
					authorSequence: Number(value.localAuthorSequence),
				} as Parameters<typeof journal.appendAccepted>[0]);
			}
			const header = gone("journal:scopes")[0];
			if (header !== undefined) {
				const value = header[1] as Record<string, Uint8Array | string>;
				out.journalAnchor = await journal.installEpochAnchor({
					objectId: String(value.objectId),
					exactCanonicalAnchorPreimageBytes: value.exactCanonicalAnchorPreimageBytes as Uint8Array,
					detachedAnchorSignature: value.detachedAnchorSignature as Uint8Array,
					exactCanonicalParametersCarrierBytes: value.exactCanonicalParametersCarrierBytes as Uint8Array,
				});
			}
		} finally {
			await journal.close();
		}
		const scope = gone("snapshot:scopes")[0];
		if (scope !== undefined) {
			const declaration = fixture.declarations.get(Number((scope[1] as Record<string, unknown>).epoch));
			const snapshots = await fixture.host.storageHost.openSnapshots("creator");
			try {
				if (declaration !== undefined)
					out.snapshot = await snapshots
						.openScope(declaration as Parameters<typeof snapshots.openScope>[0])
						.then(async (opened) => {
							await opened.release();
							return { ok: true };
						})
						.catch((error: unknown) => ({ ok: false, code: (error as { code?: unknown }).code ?? String(error) }));
			} finally {
				await snapshots.close();
			}
		}
		const generation = gone("ahe:generations")[0];
		if (generation !== undefined) {
			const decoded = decodeGenerationRecordV1((generation[1] as Record<string, unknown>).record as Uint8Array);
			if (!decoded.ok) throw new TypeError("TRACK_M_GENERATION");
			const ahe = await fixture.host.storageHost.openAhe("creator--ahe");
			try {
				out.ahe = await ahe.beginGeneration({
					objectId: decoded.value.objectId,
					generationId: decoded.value.generationId,
					baseExpectedHead: decoded.value.baseExpectedHead,
					closure: decoded.value.closure,
				});
			} finally {
				await ahe.close();
			}
		}
		return out;
	}

	/** The creator's stale writes after the boundary STEADY lull, on either path. */
	async function staleAfterLull(retention: boolean): Promise<Record<string, unknown>> {
		const fixture = await lullFixture({ retention, creatorLull: true, seed: `track-m-trust-stale-${retention}` });
		const creator = await fixture.open("creator", fixture.creator);
		const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
		for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
		await transition(fixture, creator, recipient, STEADY);
		const database = fixture.host.database("creator");
		const before = await dumpDatabase(database);
		const passes = events.length;
		expect(await creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		if (retention)
			expect(events.slice(passes).find((event) => event.kind === "room-retention-pass")).toMatchObject({
				outcome: "applied",
			});
		const after = await dumpDatabase(database);
		const writes = await staleWrites(fixture, before, after);
		// No ordinary writer changed any owned row.
		expect(ownedDifference(after, await dumpDatabase(database))).toEqual([]);
		await fixture.stop(recipient);
		await fixture.stop(creator);
		return writes;
	}

	it("refuses with the same existing codes as after the existing path's retirement", async () => {
		const existing = await staleAfterLull(false);
		const retention = await staleAfterLull(true);
		const outcome = (value: unknown) => {
			const record = value as Record<string, unknown> | undefined;
			return record === undefined ? undefined : { ok: record.ok, reason: record.reason ?? record.kind ?? record.code };
		};
		const summary = (writes: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(writes).map(([owner, value]) => [owner, outcome(value)]));
		// Both paths retire the same rows at this boundary (no journal header is collectible
		// yet; a header retired at a later boundary is compared the same way when present).
		for (const owner of ["signing", "journalAppend", "snapshot", "ahe"]) expect(owner in retention, owner).toBe(true);
		for (const value of Object.values(retention)) expect(outcome(value)?.ok).toBe(false);
		expect(summary(retention)).toEqual(summary(existing));
	}, 900_000);
});

describe("14b RED 4: reopen starts from the open verification", () => {
	it("no fact the first decision after a reopen acts on predates the open", async () => {
		const fixture = await lullFixture({ retention: true, creatorLull: true, seed: "track-m-trust-reopen" });
		let creator = await fixture.open("creator", fixture.creator);
		let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
		for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
		await fixture.stop(recipient);
		await fixture.stop(creator);
		const opened = performance.now();
		creator = await fixture.open("creator", fixture.creator, { reopen: true });
		recipient = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
		const before = events.length;
		await rollover(fixture, creator, recipient, STEADY);
		// Every pass after the reopen (including a cold boundary's empty decision during the
		// transition) applied, and both lulls retired something.
		const passes = events.slice(before).filter((event) => event.kind === "room-retention-pass");
		const writes = (event: Readonly<Record<string, unknown>>) =>
			(event.decisions as readonly Readonly<{ writes: number }>[]).reduce((sum, decision) => sum + decision.writes, 0);
		expect(passes.map((event) => event.outcome).every((outcome) => outcome === "applied")).toBe(true);
		expect(passes.filter((event) => writes(event) > 0)).toHaveLength(2);
		for (const pass of passes) expect(Number(pass.acquisitionStarted)).toBeGreaterThan(opened);
	}, 600_000);

	it("a poisoned retained row found by the open verification fails closed", async () => {
		const fixture = await lullFixture({ retention: true, creatorLull: true, seed: "track-m-trust-reopen-poison" });
		let creator = await fixture.open("creator", fixture.creator);
		let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
		for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
		await transition(fixture, creator, recipient, STEADY);
		await fixture.stop(recipient);
		await fixture.stop(creator);
		// A retained row the next decision relies on: the newest closed journal header kept.
		const database = fixture.host.database("creator");
		const headers = await rowsOf(database, "journal:scopes");
		const [key, value] = required(headers.filter(([candidate]) => Number((candidate as unknown[])[1]) > 0).at(0));
		await foreignWrite(database, [{ store: "journal:scopes", key, value: fieldOf("detachedAnchorSignature")(value) }])
			.committed;
		const poisoned = await dumpDatabase(database);
		const before = events.length;
		let outcome: unknown;
		try {
			creator = await fixture.open("creator", fixture.creator, { reopen: true });
			outcome = await creator.room.maintainRecoveryPool().catch((error: unknown) => ({ failed: String(error) }));
		} catch (error) {
			outcome = { openFailed: String(error) };
		}
		// Fails closed: no retention decision applied and nothing retired.
		expect(
			events.slice(before).filter((event) => event.kind === "room-retention-pass" && event.outcome === "applied")
		).toEqual([]);
		expect(outcome).not.toMatchObject({ kind: "maintained" });
		const removed = ownedDifference(poisoned, await dumpDatabase(database)).filter((line) =>
			line.startsWith("removed")
		);
		expect(removed).toEqual([]);
	}, 600_000);

	it("a tampered mark that claims more retirement than the floor fails closed", async () => {
		const fixture = await lullFixture({ retention: true, creatorLull: true, seed: "track-m-trust-mark" });
		let creator = await fixture.open("creator", fixture.creator);
		const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
		for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
		await transition(fixture, creator, recipient, STEADY);
		await fixture.stop(recipient);
		await fixture.stop(creator);
		// The journal control claims retirement through the CURRENT epoch (beyond the floor's).
		const database = fixture.host.database("creator");
		const key = fixture.objectId;
		// The native row carries the control's canonical bytes: { objectId, record, planRecord? }.
		const row = required(await readRow(database, "journal:retirementControls", key)) as Record<string, unknown>;
		const control = decodeCanonical(row.record as Uint8Array) as Record<string, unknown>;
		const completed = required(control.completed as Record<string, unknown> | null);
		const record = encodeCanonical({ ...control, completed: { ...completed, throughEpoch: STEADY + 1 } });
		await foreignWrite(database, [{ store: "journal:retirementControls", key, value: { ...row, record } }]).committed;
		const tampered = await dumpDatabase(database);
		const before = events.length;
		let outcome: unknown;
		try {
			creator = await fixture.open("creator", fixture.creator, { reopen: true });
			outcome = await creator.room.maintainRecoveryPool().catch((error: unknown) => ({ failed: String(error) }));
		} catch (error) {
			outcome = { openFailed: String(error) };
		}
		expect(
			events.slice(before).filter((event) => event.kind === "room-retention-pass" && event.outcome === "applied")
		).toEqual([]);
		expect(outcome).not.toMatchObject({ kind: "maintained" });
		const removed = ownedDifference(tampered, await dumpDatabase(database)).filter((line) =>
			line.startsWith("removed")
		);
		expect(removed).toEqual([]);
	}, 600_000);
});

describe("14b adversarial: a fact crossing a non-genuine handoff", () => {
	it("a forged snapshot turnover authority refuses with zero writes", async () => {
		const room = await steady("track-m-trust-forged-authority");
		const { fixture, creator, recipient } = room;
		await transition(fixture, creator, recipient, STEADY);
		let refused: unknown,
			before: Dump | undefined,
			after: Dump | undefined,
			forged = false;
		const trap = trapRetention(fixture, {
			beforeFirstPlan: async ({ database, selection, owners, session }) => {
				const chosen = selection as unknown as Selection;
				if (forged || chosen.snapshot.retire.length === 0) return;
				forged = true;
				// A second session handed the same selection with an authority no genuine
				// turnover registered: the snapshot section must refuse it.
				const other = (await fixture.host.storageHost.openRoomRetirement("creator")) as unknown as Record<
					string,
					(...args: unknown[]) => Promise<unknown>
				>;
				before = await dumpDatabase(database);
				try {
					const planned = (await required(other.planRetention)(owners, selection)) as { decisionDigest: string };
					const { roomRetentionSourceDigest } = await import("@ts-drp/storage/room-head");
					await required(other.applyRetention)(
						owners,
						selection,
						{
							throughEpoch: chosen.throughEpoch,
							decisionDigest: planned.decisionDigest,
							sourceProofDigest: roomRetentionSourceDigest(selection as never),
						},
						{ snapshotAuthority: { capability: Object.freeze({}), custody: Object.freeze({}) } }
					);
					await required(other.commit)();
				} catch (error) {
					refused = error;
					await required(other.abort)(error).catch(() => undefined);
				}
				after = await dumpDatabase(database);
				void session;
			},
		});
		try {
			expect(await creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			trap.release();
		}
		expect(forged).toBe(true);
		expect(refused).toMatchObject({ code: "RETENTION_STALE" });
		expect(ownedDifference(required(before), required(after))).toEqual([]);
	}, 600_000);
});
