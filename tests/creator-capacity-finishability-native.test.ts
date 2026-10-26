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

/**
 * The fixture knows `settlement` and `shipped` (creator-trusted-v1); `trusted` names the latter.
 * @param value - The CREATOR_CAPACITY_PROFILE value.
 * @returns The fixture profile.
 */
function capacityProfile(value: string | undefined): Profile {
	if (value === undefined || value === "settlement") return "settlement";
	if (value === "shipped" || value === "trusted") return "shipped";
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
 * @returns Accepted count, refusal text and the native image around the refusal.
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
				return { accepted: index, error: String(error), before, after: nativeImage(fixture.directory).tables };
			}
		}
		return { accepted: limit, error: undefined, before: undefined, after: undefined };
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

it.runIf(process.env.RUN_CREATOR_CAPACITY === "1")(
	"accepted native work finishes and admission recovers at the current proof capacity",
	async () => {
		const count = Number(process.env.CREATOR_CAPACITY_EDITS ?? 512);
		const batchSize = Number(process.env.CREATOR_CAPACITY_BATCH_SIZE ?? 1);
		const profile = capacityProfile(process.env.CREATOR_CAPACITY_PROFILE);
		const cycles = Number(process.env.CREATOR_CAPACITY_CYCLES ?? 1);
		const stateSlots = Number(process.env.CREATOR_CAPACITY_STATE_SLOTS ?? count * cycles);
		const fixture = await creatorDeliveryRoom({ profile });
		const creator = await fixture.open(0);
		const directory = required([...directories].at(-1));
		const events: unknown[] = [];
		Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
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
						const outcomes = await Promise.allSettled(operations.map((operation) => creator.room.issue(operation)));
						accepted += outcomes.filter((outcome) => outcome.status === "fulfilled").length;
						const failed = outcomes.find((outcome) => outcome.status === "rejected");
						if (failed?.status === "rejected") throw failed.reason;
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
					const preIssue = nativeImage(directory);
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
						emit("next-issue", {
							round,
							durationMs: Math.round(performance.now() - nextAt),
							native: nativeImage(directory),
						});
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
