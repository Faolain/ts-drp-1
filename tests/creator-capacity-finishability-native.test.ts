/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe helpers retain fixture types. */
import { createHash } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { creatorDeliveryRoom, eventually, type Profile } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, directories, required } from "./fixtures/track-m/room-retention-fixture.js";
import { linkSuccessorProtocol } from "./fixtures/track-x/successor-link.js";
import * as closedRollbackData from "../packages/node/src/internal/creator-closed-rollback-data.js";

function nativeImage(directory: string) {
	const files = readdirSync(directory, { recursive: true }).map(String).sort();
	const databases = files.filter((file) => file.endsWith(".sqlite"));
	const result: Record<string, unknown> = {};
	for (const file of databases) {
		const database = new DatabaseSync(join(directory, file), { readOnly: true });
		try {
			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all();
			for (const { name } of tables) {
				const rows = database.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all();
				const canonical = rows
					.map((row) =>
						JSON.stringify(row, (_, value) =>
							value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value
						)
					)
					.sort();
				const payloadBytes = rows.reduce(
					(sum, row) =>
						sum +
						Object.values(row).reduce<number>(
							(total, value) =>
								total +
								(value instanceof Uint8Array
									? value.byteLength
									: typeof value === "string"
										? Buffer.byteLength(value)
										: 0),
							0
						),
					0
				);
				result[`${file}/${name}`] = {
					rows: rows.length,
					payloadBytes,
					canonicalDumpBytes: canonical.reduce((sum, row) => sum + Buffer.byteLength(row), 0),
					digest: createHash("sha256").update(canonical.join("\n")).digest("hex"),
				};
			}
		} finally {
			database.close();
		}
	}
	return {
		tables: result,
		physicalBytes: files.reduce((sum, file) => {
			const stat = statSync(join(directory, file));
			return sum + (stat.isFile() ? stat.size : 0);
		}, 0),
	};
}

/**
 * Whether every peer's live journal holds the same vertex digests at the newest epoch.
 * @param directory - The fixture directory.
 * @returns True when at least two journals reached the newest epoch with equal vertex sets.
 */
function newestJournalsConverged(directory: string): boolean {
	const journals = readdirSync(directory, { recursive: true })
		.map(String)
		.filter((file) => file.endsWith("drp-live-journal-v1.sqlite"))
		.map((file) => {
			const database = new DatabaseSync(join(directory, file), { readOnly: true });
			try {
				const rows = database
					.prepare(
						"SELECT epoch, vertex_digest FROM accepted_entries WHERE epoch = (SELECT MAX(epoch) FROM accepted_entries)"
					)
					.all();
				return {
					epoch: Number(rows[0]?.epoch ?? -1),
					digests: rows
						.map((row) => String(row.vertex_digest))
						.sort()
						.join(","),
				};
			} finally {
				database.close();
			}
		});
	const newest = Math.max(...journals.map((journal) => journal.epoch));
	const current = journals.filter((journal) => journal.epoch === newest);
	return current.length >= 2 && current.every((journal) => journal.digests === current[0]?.digests);
}

function errorDetails(error: unknown): unknown[] {
	const details: unknown[] = [],
		seen = new Set<unknown>();
	for (let current = error; current !== null && typeof current === "object" && !seen.has(current); ) {
		seen.add(current);
		details.push(
			Object.fromEntries(
				["name", "message", "code", "retryClass", "kind"].flatMap((key) => {
					const value = Reflect.get(current, key);
					return typeof value === "string" ? [[key, value]] : [];
				})
			)
		);
		current = Reflect.get(current, "cause");
	}
	return details;
}

/**
 * Pre-write budget refusals of the same admission sizing: the proof book or the
 * maintenance native image bound. Either must leave the native image unchanged.
 * @param error - The rejected issue.
 * @returns Whether the refusal is a capacity refusal.
 */
function capacityRefusal(error: unknown): boolean {
	return /proof reserve is exhausted|MAINTENANCE_NATIVE_IMAGE_EXHAUSTED/u.test(String(error));
}

/** The capacity gate's profile labels: the signed profile, not which product ships it. */
type CapacityProfileLabel = "settlement" | "trusted-v1";

/**
 * Reads CREATOR_CAPACITY_PROFILE. `settlement` (default) is creator-trusted-settlement-v1 and
 * `trusted-v1` is creator-trusted-v1. The old values `shipped` and `trusted` remain aliases of
 * `trusted-v1`, which no shipped app signs by default any more (each app's own profile is in
 * examples/<app>/src/profile.ts), so "shipped" no longer names it.
 * @param value - The CREATOR_CAPACITY_PROFILE value.
 * @returns The gate label and the delivery-room fixture profile it selects.
 */
function capacityProfile(value: string | undefined): Readonly<{ label: CapacityProfileLabel; fixture: Profile }> {
	if (value === undefined || value === "settlement") return { label: "settlement", fixture: "settlement" };
	if (value === "trusted-v1" || value === "shipped" || value === "trusted")
		return { label: "trusted-v1", fixture: "shipped" };
	throw new TypeError(`unknown CREATOR_CAPACITY_PROFILE: ${value}`);
}

afterEach(async () => {
	vi.restoreAllMocks();
	expect(await closeFixtures()).toEqual([]);
});

/**
 * Offers distinct settlement records until the first refusal.
 * @param exactOnly - Decline the incremental source-program reservation, so the
 * original exact composer decides every admission.
 * @param limit - Maximum number of records offered.
 * @returns Accepted count, refusal text, the native image around the refusal, and the open room.
 */
async function settlementAdmissionBoundary(exactOnly: boolean, limit: number) {
	const fixture = await creatorDeliveryRoom({ profile: "settlement" });
	const creator = await fixture.open(0);
	const incremental = vi.spyOn(closedRollbackData, "reserveCreatorOrdinaryFinishingCapacity");
	if (exactOnly) incremental.mockResolvedValue(undefined);
	try {
		for (let index = 0; index < limit; index++) {
			const before = nativeImage(fixture.directory).tables;
			try {
				await creator.room.issue({
					action: "placeBlock",
					id: `boundary-${index}`,
					kind: "stone",
					x: index % 10,
					y: index,
				});
			} catch (error) {
				return {
					accepted: index,
					error: String(error),
					before,
					after: nativeImage(fixture.directory).tables,
					fixture,
					creator,
				};
			}
		}
		return { accepted: limit, error: undefined, before: undefined, after: undefined, fixture, creator };
	} finally {
		incremental.mockRestore();
	}
}

it("incremental settlement admission never accepts a record the exact maintenance sizing refuses", async () => {
	const limit = 96;
	const exact = await settlementAdmissionBoundary(true, limit);
	const incremental = await settlementAdmissionBoundary(false, limit);
	console.info(
		`CREATOR_CAPACITY_BOUNDARY ${JSON.stringify({
			limit,
			exact: { accepted: exact.accepted, error: exact.error },
			incremental: { accepted: incremental.accepted, error: incremental.error },
		})}`
	);
	expect(exact.accepted, "the exact composer finds a finite settlement boundary").toBeLessThan(limit);
	expect(exact.after, "an exact refusal performs no native writes").toEqual(exact.before);
	expect(incremental.after, "an incremental-path refusal performs no native writes").toEqual(incremental.before);
	expect(
		incremental.accepted,
		"the incremental reservation is never looser than the exact composer"
	).toBeLessThanOrEqual(exact.accepted);
}, 600_000);

it.each([
	["exact", true],
	["incremental", false],
] as const)(
	"%s settlement admission reserves the adoption fence and its successor, so the full epoch seals and adopts",
	async (_label, exactOnly) => {
		const boundary = await settlementAdmissionBoundary(exactOnly, 96);
		expect(boundary.accepted, "admission finds a finite settlement boundary").toBeLessThan(96);
		expect(capacityRefusal(boundary.error), String(boundary.error)).toBe(true);
		expect(boundary.after, "the boundary refusal performs no native writes").toEqual(boundary.before);
		const { fixture, creator } = boundary;
		const seal = await creator.room.sealEpoch();
		expect(seal.ok).toBe(true);
		linkSuccessorProtocol(creator, await fixture.open(1), { joinHandlersOnClose: true });
		await creator.room.exportCreatorSuccessor();
		// Adoption issues the mandatory fence on the successor live plane; that
		// fence's own admission reserves ITS successor fence. Accepted work must
		// leave room for both, or the close authority is lost here.
		await creator.room.adoptCreatorSuccessor();
		expect(creator.room.status().closeAuthority).toBe("available");
	},
	600_000
);

it("a full ordinary proof book declines the optional readiness source instead of failing adoption", async () => {
	const fixture = await creatorDeliveryRoom({ profile: "shipped" });
	const creator = await fixture.open(0);
	for (let index = 0; index < 8; index++)
		await creator.room.issue({ action: "placeBlock", id: `readiness-${index}`, kind: "stone", x: index, y: 0 });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	linkSuccessorProtocol(creator, await fixture.open(1), { joinHandlersOnClose: true });
	await creator.room.exportCreatorSuccessor();
	// After a full epoch the first successor readiness retains every closed
	// journal row's PRE/signature beside the whole cold census: measured at 512
	// offered, 1,233,566 B were charged before 483 closed rows needing 242,398 B
	// against the 1,310,720 B ordinary book. Reproduce that exhausted book here.
	const original = closedRollbackData.captureCreatorOrdinaryIssuanceProofSource;
	let exhausted = 0;
	const refusals: string[] = [];
	const capture = vi
		.spyOn(closedRollbackData, "captureCreatorOrdinaryIssuanceProofSource")
		.mockImplementation(async (proof, readiness, fence) => {
			if (readiness === undefined) return original(proof, readiness, fence);
			const { accounting } = proof;
			expect(accounting.chargeUnknownEncodedLength(accounting.maxBytes - accounting.chargedBytes - 1)).toBe(true);
			exhausted++;
			try {
				return await original(proof, readiness, fence);
			} catch (error) {
				// A typed refusal is not an Error; wherever it surfaces it names its kind.
				refusals.push(String(error));
				throw error;
			}
		});
	try {
		await creator.room.adoptCreatorSuccessor();
	} finally {
		capture.mockRestore();
	}
	expect(exhausted, "adoption prepared successor readiness on an exhausted book").toBeGreaterThan(0);
	expect(refusals).toEqual(["creator closed rollback refusal: proof-budget-exceeded"]);
	expect(creator.room.status().closeAuthority).toBe("available");
	// The exact cold route still admits fresh work in the successor epoch.
	await creator.room.issue({ action: "placeBlock", id: "readiness-after", kind: "stone", x: 0, y: 1 });
}, 600_000);

it.runIf(process.env.RUN_CREATOR_CAPACITY === "1")(
	"accepted native work finishes and admission recovers at the current proof capacity",
	async () => {
		const count = Number(process.env.CREATOR_CAPACITY_EDITS ?? 512);
		const batchSize = Number(process.env.CREATOR_CAPACITY_BATCH_SIZE ?? 1);
		const { label: profile, fixture: fixtureProfile } = capacityProfile(process.env.CREATOR_CAPACITY_PROFILE);
		const cycles = Number(process.env.CREATOR_CAPACITY_CYCLES ?? 1);
		const stateSlots = Number(process.env.CREATOR_CAPACITY_STATE_SLOTS ?? count * cycles);
		const fixture = await creatorDeliveryRoom({ profile: fixtureProfile });
		const creator = await fixture.open(0);
		const directory = required([...directories].at(-1));
		const events: unknown[] = [];
		// Cold issuance books in order; each names the next epoch's forecast.
		const issuanceBooks: { chargedBytes: number; maxBytes: number; nextEpochForecastBytes?: number }[] = [];
		Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
			if ((event as { kind?: string }).kind === "creator-issuance-maintenance-book")
				issuanceBooks.push(event as (typeof issuanceBooks)[number]);
			if ((event as { kind?: string }).kind === "closed-retirement-selection")
				console.info(`CREATOR_RETIREMENT ${JSON.stringify(event)}`);
			if (
				(event as { kind?: string }).kind === "closed-data-acquisition-refused" &&
				(event as { refusal?: string }).refusal === "internal-invariant"
			)
				console.info(`CREATOR_REFUSAL ${JSON.stringify(event)}`);
			events.push(event);
			if (events.length > 16) events.shift();
		});
		const started = performance.now();
		const emit = (phase: string, detail: Record<string, unknown>) =>
			console.info(
				`CREATOR_CAPACITY ${JSON.stringify({ phase, profile, profileId: profile === "settlement" ? "creator-trusted-settlement-v1" : "creator-trusted-v1", offeredUnit: batchSize === 1 ? "native-record" : "application-edit", requested: count, batchSize, cycles, stateSlots, elapsedMs: Math.round(performance.now() - started), ...detail })}`
			);
		const profiler = process.env.CREATOR_CAPACITY_CPU_PROFILE === undefined ? undefined : new Session();
		if (profiler !== undefined) {
			profiler.connect();
			await profiler.post("Profiler.enable");
			await profiler.post("Profiler.start");
		}
		let accepted = 0;
		let receiver: Awaited<ReturnType<typeof fixture.open>> | undefined;
		if (process.env.CREATOR_CAPACITY_RECEIVER_START === "initial") {
			receiver = await fixture.open(1);
			linkSuccessorProtocol(creator, receiver, { joinHandlersOnClose: true });
			await fixture.network.idle();
		}
		let refusal: unknown;
		let before = nativeImage(directory);
		try {
			for (let cycle = 0; cycle < cycles; cycle++) {
				refusal = undefined;
				// The largest next-epoch forecast an accepted admission of this cycle made.
				let acceptedForecast: number | undefined;
				const admittedBeforeCycle = accepted;
				const nativeVerticesBeforeCycle = creator.accepted.size;
				for (let index = 0; index < count; index += batchSize) {
					before = nativeImage(directory);
					const operations = Array.from({ length: Math.min(batchSize, count - index) }, (_, offset) => ({
						action: "placeBlock",
						id: `retained-${(cycle * count + index + offset) % stateSlots}`,
						kind: "stone",
						x: (index + offset) % 10,
						y: cycle * count + index + offset,
					}));
					try {
						issuanceBooks.length = 0;
						const outcomes = await Promise.allSettled(operations.map((operation) => creator.room.issue(operation)));
						accepted += outcomes.filter((outcome) => outcome.status === "fulfilled").length;
						const failed = outcomes.find((outcome) => outcome.status === "rejected");
						if (failed?.status === "rejected") throw failed.reason;
						for (const book of issuanceBooks)
							if (book.nextEpochForecastBytes !== undefined)
								acceptedForecast = Math.max(acceptedForecast ?? 0, book.nextEpochForecastBytes);
					} catch (error) {
						refusal = error;
						emit("refusal", {
							accepted,
							error: String(error),
							errorDetails: errorDetails(error),
							status: creator.room.status(),
							before,
							after: nativeImage(directory),
							events,
						});
						break;
					}
					if (accepted % 32 === 0) emit("population", { accepted, acceptedRows: creator.accepted.size, events });
				}
				if (refusal !== undefined) {
					expect(refusal).toBeInstanceOf(TypeError);
					expect(capacityRefusal(refusal), String(refusal)).toBe(true);
					if (batchSize === 1)
						expect(nativeImage(directory).tables, "refusal performs no native writes").toEqual(before.tables);
				}
				const acceptedProjection = required(fixture.application.migration).canonicalStateBytes(
					creator.room.projection()
				);
				emit("seeded", {
					cycle,
					admittedThisCycle: accepted - admittedBeforeCycle,
					nativeVerticesThisCycle: creator.accepted.size - nativeVerticesBeforeCycle,
					accepted,
					acceptedRows: creator.accepted.size,
					native: nativeImage(directory),
					events,
				});
				const sealedAt = performance.now();
				const seal = await creator.room.sealEpoch();
				emit("seal", { durationMs: Math.round(performance.now() - sealedAt), seal });
				expect(seal.ok).toBe(true);
				if (receiver === undefined) {
					receiver = await fixture.open(1);
					linkSuccessorProtocol(creator, receiver, { joinHandlersOnClose: true });
				}
				const offer = await creator.room.exportCreatorSuccessor();
				const adoptedAt = performance.now();
				try {
					await creator.room.adoptCreatorSuccessor();
					emit("adopt", { durationMs: Math.round(performance.now() - adoptedAt), status: creator.room.status() });
				} catch (error) {
					emit("adopt-failed", {
						error: String(error),
						status: creator.room.status(),
						native: nativeImage(directory),
						events,
					});
					throw error;
				}
				expect(required(fixture.application.migration).canonicalStateBytes(creator.room.projection())).toEqual(
					acceptedProjection
				);
				const installedAt = performance.now();
				await receiver.room.installCreatorSuccessor({ offer, peers: [creator.peerId] });
				expect(required(fixture.application.migration).canonicalStateBytes(receiver.room.projection())).toEqual(
					acceptedProjection
				);
				emit("receiver-installed", {
					cycle,
					accepted,
					durationMs: Math.round(performance.now() - installedAt),
					status: receiver.room.status(),
				});
				const maintainedAt = performance.now();
				const maintenance = await creator.room.maintainRecoveryPool();
				emit("maintenance", {
					cycle,
					durationMs: Math.round(performance.now() - maintainedAt),
					maintenance,
					native: nativeImage(directory),
				});
				let nextIssued = false;
				for (let round = 0; round < 4; round++) {
					const nextAt = performance.now();
					// The receiver's own successor work (its author fence) reaches the
					// creator asynchronously and is admitted on a later creator turn. Let
					// both journals hold the same newest-epoch vertices first, so the
					// no-write comparison below observes only this issue. (A received
					// vertex the creator refuses never converges; the wait then expires.)
					await fixture.network.idle();
					await eventually(() => newestJournalsConverged(directory), 30_000);
					const preIssue = nativeImage(directory);
					issuanceBooks.length = 0;
					try {
						await creator.room.issue({
							action: "placeBlock",
							id: `after-capacity-${round}`,
							kind: "stone",
							x: 0,
							y: 1000,
						});
						nextIssued = true;
					} catch (error) {
						emit("next-issue-failed", { round, error: String(error), status: creator.room.status(), events });
						if (!capacityRefusal(error)) throw error;
						expect(
							nativeImage(directory).tables,
							"a capacity refusal before a fresh retry performs no native writes"
						).toEqual(preIssue.tables);
					}
					if (nextIssued) {
						const firstColdBook = issuanceBooks[0]?.chargedBytes;
						emit("next-issue", {
							round,
							durationMs: Math.round(performance.now() - nextAt),
							acceptedForecast,
							firstColdBook,
							native: nativeImage(directory),
						});
						// The previous epoch's accepted forecast bounds the next epoch's
						// first cold admission book it reserved for.
						if (round === 0 && acceptedForecast !== undefined && firstColdBook !== undefined)
							expect(firstColdBook, "next-epoch first cold book within the accepted forecast").toBeLessThanOrEqual(
								acceptedForecast
							);
						break;
					}
					// Only the settlement profile has a required, already-admitted fence
					// for another nonempty Cut. The ordinary profile must retain useful
					// admission headroom; inventing an empty Cut would change the protocol.
					expect(profile, "ordinary profile has no admitted successor fence and useful admission is stranded").toBe(
						"settlement"
					);
					const drainSeal = await creator.room.sealEpoch();
					emit("drain-seal", { round, seal: drainSeal });
					expect(drainSeal.ok).toBe(true);
					const drainOffer = await creator.room.exportCreatorSuccessor();
					await creator.room.adoptCreatorSuccessor();
					await receiver.room.installCreatorSuccessor({ offer: drainOffer, peers: [creator.peerId] });
					expect(required(fixture.application.migration).canonicalStateBytes(creator.room.projection())).toEqual(
						acceptedProjection
					);
					expect(required(fixture.application.migration).canonicalStateBytes(receiver.room.projection())).toEqual(
						acceptedProjection
					);
					emit("drain-maintenance", {
						round,
						maintenance: await creator.room.maintainRecoveryPool(),
						native: nativeImage(directory),
					});
				}
				expect(nextIssued, "normal signed lifecycle and maintenance must recover useful admission").toBe(true);
				expect(
					await eventually(
						() =>
							Buffer.from(
								required(fixture.application.migration).canonicalStateBytes(receiver.room.projection())
							).equals(
								Buffer.from(required(fixture.application.migration).canonicalStateBytes(creator.room.projection()))
							),
						30_000
					)
				).toBe(true);
				emit("receiver-applied", { cycle, accepted, nextIssue: true });
				if (process.env.CREATOR_CAPACITY_REQUIRE_ALL === "1")
					expect(accepted - admittedBeforeCycle, "every offered edit receives a successful admission receipt").toBe(
						count
					);
			}
		} catch (error) {
			emit("failed", { error: String(error), events, native: nativeImage(directory) });
			throw error;
		} finally {
			Reflect.deleteProperty(globalThis, "__warmProofEvent");
			if (profiler !== undefined) {
				const { profile: sampled } = await profiler.post("Profiler.stop");
				writeFileSync(required(process.env.CREATOR_CAPACITY_CPU_PROFILE), JSON.stringify(sampled));
				profiler.disconnect();
			}
		}
	},
	Number(process.env.CREATOR_CAPACITY_TIMEOUT_MS ?? 600_000)
);
