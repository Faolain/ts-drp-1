/* eslint-disable @typescript-eslint/explicit-function-return-type -- Disposable native crash worker. */
import { readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, StatementSync } from "node:sqlite";
import { expect, it } from "vitest";

import {
	bytes,
	hex,
	json,
	type KillEdge,
	loadedModules,
	nativeFilename,
	readNativeState,
	record,
	required,
	sha256,
} from "./native.js";
import { createShippingChatWindowGenesisStateBytes } from "../../../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "../chat-membership-shares/room.js";

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
const originalId = "accepted-before-process-death";

it("rejoin process-death worker", async () => {
	const directory = required(process.env.REJOIN_KILL_DIRECTORY),
		mode = required(process.env.REJOIN_KILL_MODE),
		edge = required(process.env.REJOIN_KILL_EDGE) as KillEdge,
		nonce = required(process.env.REJOIN_KILL_NONCE);
	if (!["receipt-commit", "floor-commit"].includes(edge) || !["mutate", "recover"].includes(mode))
		throw new Error("REJOIN_KILL_MODE_INVALID");
	const originalPrepare = DatabaseSync.prototype.prepare,
		originalRun = StatementSync.prototype.run,
		originalExec = DatabaseSync.prototype.exec;
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string; filename: string }>();
	const committedReceipts = new WeakMap<DatabaseSync, { wrapperHex: string; sql: string }>();
	let armed = false;
	let expected:
		| {
				objectId: string;
				targetA: { epoch: number; anchorDigest: string };
				targetB: { epoch: number; anchorDigest: string };
				cutAHex: string;
				before: ReturnType<typeof readNativeState>;
				original: ReturnType<typeof readNativeState>["issued"][number];
		  }
		| undefined;
	const haltAtCommittedBoundary = (boundary: string, committedWrapperHex?: string): never => {
		armed = false;
		const prepared = required(expected),
			native = readNativeState(directory, prepared.objectId);
		const receipt = required(native.receipts.find((row) => row.cutHex === prepared.cutAHex));
		expect(receipt.kind).toBe("creator-received-checkpoint-certificate-1");
		expect(receipt.oldHeadHex).toBe(prepared.before.headRecordHex);
		expect(receipt.retention).toBe("recovery");
		expect(receipt.state).toBe("verified");
		if (committedWrapperHex !== undefined) expect(receipt.wrapperHex).toBe(committedWrapperHex);
		expect(native.issued.find((row) => row.sequence === prepared.original.sequence)).toEqual(prepared.original);
		const sourceEntry = required(
			native.plans
				.flatMap((plan) => plan.entries as readonly unknown[])
				.map(record)
				.find((entry) => entry.sourceSequence === prepared.original.sequence)
		);
		expect(hex(bytes(sourceEntry.sourceDigest))).toBe(prepared.original.digest);
		const contextDigest = hex(bytes(sourceEntry.sourceContextDigest));
		expect(
			native.plans.flatMap((plan) => plan.sourceContexts).some((context) => context.digest === contextDigest)
		).toBe(true);
		if (edge === "receipt-commit") {
			expect(boundary).toBe("real snapshot COMMIT returned");
			expect(native.headRecordHex).toBe(prepared.before.headRecordHex);
			expect(native.generations.some((row) => row.generationId === receipt.candidateGenerationId)).toBe(false);
			expect(native.floor.state.stable.epoch).toBe(0);
		} else {
			expect(boundary).toBe("public floor.commit returned");
			expect(native.head).toMatchObject({
				kind: "present",
				generationId: receipt.candidateGenerationId,
				closureDigest: receipt.candidateClosureDigest,
			});
			expect(native.floor.state.stable).toMatchObject({
				epoch: prepared.targetA.epoch,
				currentAnchorDigest: prepared.targetA.anchorDigest,
			});
		}
		expect(native.floor.state.pending).toBeNull();
		const report = json({
			schema: "rejoin-real-process-death-1",
			nonce,
			edge,
			pid: process.pid,
			boundary,
			modules: loadedModules(),
			expected: prepared,
			native,
		});
		writeFileSync(join(directory, "ready-to-kill.json"), report);
		// FD3 belongs to the parent. Synchronous IPC occurs only after the exact
		// durable tuple above is observed. No exception or cleanup may unwind it.
		writeSync(
			3,
			JSON.stringify({
				kind: "ready-to-kill",
				nonce,
				edge,
				pid: process.pid,
				reportSha256: sha256(report),
				targetA: prepared.targetA,
				targetB: prepared.targetB,
			}) + "\n"
		);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		throw new Error("REJOIN_KILL_PARENT_DID_NOT_TERMINATE");
	};
	if (mode === "mutate" && edge === "receipt-commit") {
		DatabaseSync.prototype.prepare = function (sql: string) {
			const statement = originalPrepare.call(this, sql);
			const filename = String(
				originalPrepare
					.call(this, "PRAGMA database_list")
					.all()
					.find((row) => row.name === "main")?.file ?? ""
			);
			statements.set(statement, { database: this, sql, filename });
			return statement;
		};
		StatementSync.prototype.run = function (...args: (SQLInputValue | Record<string, SQLInputValue>)[]) {
			const result = Reflect.apply(originalRun, this, args) as ReturnType<StatementSync["run"]>,
				source = statements.get(this);
			if (
				armed &&
				source !== undefined &&
				source.sql.startsWith("UPDATE snapshot_scopes_v2 SET retention='recovery',received_certificate_bytes=") &&
				realpathSync(source.filename) === realpathSync(nativeFilename(directory, "snapshots")) &&
				args[0] instanceof Uint8Array &&
				Number(result.changes) === 1
			)
				committedReceipts.set(source.database, { wrapperHex: hex(args[0]), sql: source.sql });
			return result;
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = originalExec.call(this, sql);
			if (sql.trim().toUpperCase() === "ROLLBACK") committedReceipts.delete(this);
			if (sql.trim().toUpperCase() === "COMMIT") {
				const receipt = committedReceipts.get(this);
				committedReceipts.delete(this);
				if (armed && receipt !== undefined)
					haltAtCommittedBoundary("real snapshot COMMIT returned", receipt.wrapperHex);
			}
			return result;
		};
	}
	try {
		const fixture = await chatSharesRoomFixture({
			members: ["genesis"],
			format: "window",
			directory,
			genesisStateBytes: createShippingChatWindowGenesisStateBytes,
			...(mode === "mutate" && edge === "floor-commit"
				? {
						afterFloorWrite(peer: number, phase: "begin" | "commit") {
							if (armed && peer === 1 && phase === "commit") haltAtCommittedBoundary("public floor.commit returned");
						},
					}
				: {}),
		});
		if (mode === "mutate") {
			const creator = await fixture.open(0),
				member = await fixture.open(1);
			await member.room.issue(message(originalId));
			const before = readNativeState(directory, fixture.objectId),
				original = required(before.issued.find((row) => record(row.operation).clientOperationId === originalId));
			for (let epoch = 0; epoch < 2; epoch++) {
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
			}
			const targetA = required(creator.room.authority()),
				transferA = await fixture.successorDelivery(1);
			for (let epoch = 0; epoch < 2; epoch++) {
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
			}
			const targetB = required(creator.room.authority());
			expect(targetA.epoch).toBe(2);
			expect(targetB.epoch).toBe(4);
			expect(targetA.anchorDigest).not.toBe(targetB.anchorDigest);
			expected = {
				objectId: fixture.objectId,
				targetA,
				targetB,
				before,
				original,
				cutAHex: hex(transferA.offer.exactCanonicalCutValueBytes),
			};
			writeFileSync(join(directory, "prepared.json"), json(expected));
			Reflect.set(member.networkNode, "createSnapshotChunkProtocolHost", () => transferA.port);
			armed = true;
			await member.room.installCreatorSuccessor({ offer: transferA.offer, peers: transferA.peers });
			throw new Error(`REJOIN_KILL_EDGE_NOT_REACHED:${edge}`);
		}
		// Recovery installs no SQL or floor interceptors. It is a fresh process
		// opening the ordinary public room over the killed process's exact files.
		const death = JSON.parse(readFileSync(join(directory, "ready-to-kill.json"), "utf8")) as {
			nonce: string;
			pid: number;
			expected: NonNullable<typeof expected>;
			native: ReturnType<typeof readNativeState>;
		};
		expect(death.nonce).toBe(nonce);
		expect(death.pid).not.toBe(process.pid);
		const creator = await fixture.open(0, { reopen: true });
		expect(creator.room.authority()).toMatchObject(death.expected.targetB);
		let member = await fixture.open(1, { reopen: true, promote: true });
		expect(member.room.authority()).toMatchObject(death.expected.targetA);
		expect(member.room.authority()?.anchorDigest).not.toBe(death.expected.targetB.anchorDigest);
		const recoveredA = readNativeState(directory, fixture.objectId),
			receipt = required(death.native.receipts.find((row) => row.cutHex === death.expected.cutAHex));
		expect(recoveredA.head).toMatchObject({
			kind: "present",
			generationId: receipt.candidateGenerationId,
			closureDigest: receipt.candidateClosureDigest,
		});
		expect(recoveredA.issued.find((row) => row.sequence === death.expected.original.sequence)).toEqual(
			death.expected.original
		);
		for (const context of death.native.plans.flatMap((plan) => plan.sourceContexts))
			expect(recoveredA.plans.flatMap((plan) => plan.sourceContexts)).toContainEqual(context);
		const unresolvedA = await member.room.unresolvedAcceptedWork();
		expect(unresolvedA).toMatchObject([
			{
				sourceSequence: death.expected.original.sequence,
				sourceEpoch: 0,
				commitment: "unknown",
				operations: [message(originalId)],
			},
		]);
		expect(member.room.projection().messages.map((row) => row.clientOperationId)).not.toContain(originalId);
		await member.room.issue(message("fresh-after-kill-at-A"));
		const issuedAtA = readNativeState(directory, fixture.objectId);
		expect(
			issuedAtA.issued.find((row) => record(row.operation).clientOperationId === "fresh-after-kill-at-A")?.sourceEpoch
		).toBe(2);
		// B is adopted only through this explicit, later public operation.
		await fixture.install(member);
		expect(member.room.authority()).toMatchObject(death.expected.targetB);
		const unresolvedB = await member.room.unresolvedAcceptedWork();
		expect(unresolvedB.find((row) => row.sourceSequence === death.expected.original.sequence)).toMatchObject({
			sourceEpoch: 0,
			commitment: "unknown",
			operations: [message(originalId)],
		});
		await fixture.stop(member);
		member = await fixture.open(1, { reopen: true, promote: true });
		expect(member.room.authority()).toMatchObject(death.expected.targetB);
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unresolvedB);
		await member.room.issue(message("fresh-after-second-reopen-at-B"));
		const recoveredB = readNativeState(directory, fixture.objectId);
		expect(recoveredB.issued.find((row) => row.sequence === death.expected.original.sequence)).toEqual(
			death.expected.original
		);
		for (const context of death.native.plans.flatMap((plan) => plan.sourceContexts))
			expect(recoveredB.plans.flatMap((plan) => plan.sourceContexts)).toContainEqual(context);
		expect(
			recoveredB.issued.find((row) => record(row.operation).clientOperationId === "fresh-after-second-reopen-at-B")
				?.sourceEpoch
		).toBe(4);
		writeFileSync(
			join(directory, "recovered.json"),
			json({
				edge,
				pid: process.pid,
				killedPid: death.pid,
				targetA: death.expected.targetA,
				targetB: death.expected.targetB,
				recoveredA,
				recoveredB,
				unresolvedA,
				unresolvedB,
				continued: true,
				productionInterceptorsInstalled: false,
				modules: loadedModules(),
			})
		);
	} finally {
		DatabaseSync.prototype.prepare = originalPrepare;
		StatementSync.prototype.run = originalRun;
		DatabaseSync.prototype.exec = originalExec;
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 180_000);
