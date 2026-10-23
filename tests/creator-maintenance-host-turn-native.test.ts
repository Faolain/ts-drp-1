/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native scheduling probes preserve production signatures. */
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";

import { creatorDeliveryRoom } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import * as retirement from "../packages/node/src/internal/closed-epoch-cleanup.js";
import * as cooperativeWork from "../packages/node/src/internal/cooperative-work.js";

type NativeControl = Readonly<{
	kind: string;
	revision: number;
	active: Readonly<{ preparation: Readonly<Record<string, unknown>> }> | null;
	completed: Readonly<Record<string, unknown>> | null;
}>;

function retirementControls(directory: string) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".sqlite"))
		.flatMap((name) => {
			const path = join(directory, name),
				database = new DatabaseSync(path, { readOnly: true });
			try {
				if (
					database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retirement_controls'").get() ===
					undefined
				)
					return [];
				return database
					.prepare("SELECT object_id, record FROM retirement_controls")
					.all()
					.map((row) => ({
						path,
						objectId: row.object_id as string,
						record: new Uint8Array(row.record as Uint8Array),
						control: decodeCanonical(row.record as Uint8Array) as NativeControl,
					}));
			} finally {
				database.close();
			}
		});
}

function holdReleasedParticipant() {
	let armed = false,
		entered!: () => void,
		resume!: () => void;
	const arrival = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const nativeTransactions = new Set<DatabaseSync>();
	const statements = new WeakMap<StatementSync, { sql: string; database: DatabaseSync }>();
	const aheWrites: NativeControl[] = [];
	const pendingAheWrites = new Map<DatabaseSync, NativeControl[]>();
	let mutations = 0,
		acquisitions = 0,
		withinParticipantRelease = false;
	const exec = DatabaseSync.prototype.exec,
		prepare = DatabaseSync.prototype.prepare,
		run = StatementSync.prototype.run;
	vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		const result = exec.call(this, sql);
		if (/^\s*BEGIN\b/iu.test(sql)) nativeTransactions.add(this);
		if (/^\s*COMMIT\b/iu.test(sql)) aheWrites.push(...(pendingAheWrites.get(this) ?? []));
		if (/^\s*(COMMIT|ROLLBACK)\b/iu.test(sql)) {
			nativeTransactions.delete(this);
			pendingAheWrites.delete(this);
		}
		return result;
	});
	vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql);
		statements.set(statement, { sql, database: this });
		return statement;
	});
	vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (this: StatementSync, ...args: unknown[]) {
		const result = Reflect.apply(run, this, args),
			source = statements.get(this),
			sql = source?.sql;
		if (sql !== undefined && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql) && Number(result.changes) !== 0)
			mutations++;
		if (sql?.includes("retirement_controls")) {
			for (const bytes of args.filter((value) => value instanceof Uint8Array)) {
				const control = decodeCanonical(bytes) as NativeControl;
				if (control.kind === "ahe-retirement-control-3" && source !== undefined) {
					if (!nativeTransactions.has(source.database)) aheWrites.push(control);
					else {
						let writes = pendingAheWrites.get(source.database);
						if (writes === undefined) pendingAheWrites.set(source.database, (writes = []));
						writes.push(control);
					}
				}
			}
		}
		return result;
	});
	const apply = retirement.applyClosedEpochRetirementIntent;
	vi.spyOn(retirement, "applyClosedEpochRetirementIntent").mockImplementation((input) =>
		apply({
			...input,
			afterParticipantRelease: async () => {
				withinParticipantRelease = true;
				try {
					await input.afterParticipantRelease?.();
				} finally {
					withinParticipantRelease = false;
				}
			},
			participants: input.participants.map((participant) => ({
				...participant,
				acquire: async (coordinator) => {
					acquisitions++;
					return participant.acquire(coordinator);
				},
			})),
		})
	);
	const createCheckpoint = cooperativeWork.createWorkCheckpoint;
	vi.spyOn(cooperativeWork, "createWorkCheckpoint").mockImplementation(() => {
		const checkpoint = createCheckpoint();
		return () => {
			const original = checkpoint();
			if (!armed || !withinParticipantRelease) return original;
			armed = false;
			return (async () => {
				await original;
				entered();
				await gate;
			})();
		};
	});
	return {
		arrival,
		resume,
		aheWrites,
		arm: () => {
			armed = true;
		},
		counts: () => ({ mutations, acquisitions, nativeTransactions: nativeTransactions.size }),
	};
}

it.each(["close", "foreign-native-control"] as const)(
	"joins genuine native participant custody before a maintenance host turn and handles %s",
	async (mode) => {
		const gate = holdReleasedParticipant();
		let maintenance: Promise<unknown> | undefined, closing: Promise<unknown> | undefined;
		try {
			const fixture = await creatorDeliveryRoom({ profile: "settlement", writers: 0 });
			let creator = await fixture.open(0);
			for (let epoch = 0; epoch < 4; epoch++) {
				for (let index = 0; index < 16; index++)
					await creator.room.issue({ action: "placeBlock", id: `slot-${index}`, kind: "stone", x: index, y: epoch });
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
			}
			const projection = creator.room.projection();
			gate.arm();
			maintenance = creator.room.maintainRecoveryPool();
			void maintenance.catch(() => undefined);
			await Promise.race([
				gate.arrival,
				maintenance.then((result) => {
					throw Error(`released-participant checkpoint was not reached: ${JSON.stringify(result)}`);
				}),
			]);
			expect(gate.counts().nativeTransactions).toBe(0);
			const controls = retirementControls(fixture.directory);
			const coordinator = required(controls.find((row) => row.control.kind === "ahe-retirement-control-3"));
			const active = required(coordinator.control.active);
			const exactIntent = encodeCanonical(active);
			const held = gate.counts(),
				beforeWrites = gate.aheWrites.length;
			if (mode === "close") {
				closing = creator.room.close();
				void closing.catch(() => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				gate.resume();
				await expect(maintenance).rejects.toThrow("aborted");
				await closing;
				expect(gate.counts().acquisitions).toBe(held.acquisitions);
				expect(gate.counts().mutations).toBe(held.mutations);
				const interrupted = required(
					retirementControls(fixture.directory).find((row) => row.control.kind === "ahe-retirement-control-3")
				);
				expect(encodeCanonical(interrupted.control.active)).toEqual(exactIntent);
				await creator.floor.close();
				creator = await fixture.open(0, { reopen: true });
				expect(creator.room.projection()).toEqual(projection);
				await creator.room.maintainRecoveryPool();
				const writes = gate.aheWrites.slice(beforeWrites);
				const resumed = writes.findIndex(
					(control) =>
						control.active === null &&
						control.completed?.decisionDigest === active.preparation.decisionDigest &&
						control.completed?.sourceProofDigest === active.preparation.sourceProofDigest
				);
				expect(
					resumed,
					"the original committed intent completes before a fresh source can replace it"
				).toBeGreaterThanOrEqual(0);
				for (const control of writes.slice(0, resumed))
					if (control.active !== null) expect(encodeCanonical(control.active)).toEqual(exactIntent);
			} else {
				const changed = required(
					controls.find((row) => row.control.kind.startsWith("v3-live-journal-retirement-control-"))
				);
				const foreign = new DatabaseSync(changed.path);
				try {
					foreign
						.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?")
						.run(encodeCanonical({ ...changed.control, revision: changed.control.revision + 1 }), changed.objectId);
				} finally {
					foreign.close();
				}
				const afterForeignMutation = gate.counts().mutations;
				gate.resume();
				await expect(maintenance).rejects.toThrow("native metadata source or phase changed");
				expect(gate.counts().acquisitions).toBe(held.acquisitions + 1);
				expect(gate.counts().mutations).toBe(afterForeignMutation);
				const refused = required(
					retirementControls(fixture.directory).find((row) => row.control.kind === "ahe-retirement-control-3")
				);
				expect(encodeCanonical(refused.control.active)).toEqual(exactIntent);
			}
		} finally {
			gate.resume();
			await Promise.allSettled([maintenance, closing]);
			await closeFixtures();
			vi.restoreAllMocks();
		}
	},
	120_000
);
