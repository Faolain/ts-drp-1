import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { writeSync } from "node:fs";

import { assertSignedIdentity, openProducerFixture, type ProducerFixture, type ScopeObservation } from "./fixture.js";
import { nativeProducerModules } from "./native-modules.js";
import { fixture as snapshotFixture } from "../snapshot-recovery-owner/contract.js";

const [primaryFilename, aheFilename, mode, token] = process.argv.slice(2);
assert.ok(primaryFilename && aheFilename && token);
assert.ok(mode === "producer" || mode === "late-retention-control");

function send(message: Readonly<Record<string, unknown>>): void {
	assert.ok(process.send, "native producer child requires owned IPC");
	process.send({ ...message, token, pid: process.pid, mode });
}

/**
 * The same synchronous hold is used by the native control and the true producer post-commit decorator.
 * @param fixture - Genuine native producer and original cumulative checkpoints.
 * @param scope - Retained scope whose handle and accounting are observed.
 * @param kind - True producer boundary or deliberately late control identity.
 */
async function checkpointAndHold(
	fixture: ProducerFixture,
	scope: ScopeObservation,
	kind: "checkpoint" | "late-checkpoint"
): Promise<never> {
	const owner = await fixture.owner.recoveryStatus();
	const boundary = await fixture.checkpoint();
	const message = {
		kind,
		token,
		pid: process.pid,
		mode,
		transport: "synchronous-stdout-pipe",
		declaration: scope.declaration,
		owner,
		beforeClose: fixture.beforeClose,
		persistenceEntries: fixture.persistenceEntries,
		boundary,
		handle: {
			id: scope.id,
			completed: scope.completed,
			released: scope.released,
			retentionCalls: scope.retentionCalls,
			retained: scope.retained,
		},
	};
	// Payload chunks never cross IPC. Only declaration, accounting and operation/AHE-reference metadata do.
	const serialized = JSON.stringify(message, (_key, value: unknown) =>
		value instanceof Uint8Array ? { producerExactBytes: Array.from(value) } : value
	);
	const line = Buffer.from(`PRODUCER_NATIVE_CHECKPOINT ${serialized}\n`);
	assert.ok(line.byteLength < 48_000, "native checkpoint must fit the bounded synchronous transport");
	let written = 0;
	while (written < line.byteLength) written += writeSync(1, line, written, line.byteLength - written);
	// No await, timer or event-loop turn may let persistSnapshot's caller continue beyond this point.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	throw new Error("NATIVE_PRODUCER_SYNCHRONOUS_HOLD_RETURNED");
}

async function run(): Promise<void> {
	send({ kind: "born" });
	let fixture: ProducerFixture | undefined;
	try {
		fixture = await openProducerFixture({
			adapter: "SQLite/Node",
			primaryFilename,
			modules: nativeProducerModules(aheFilename),
		});
		const unrelated = snapshotFixture("producer-native-unrelated-temporary");
		const temporary = await fixture.owner.openScope(unrelated.declaration);
		await temporary.release();
		const selected = fixture;
		let earlySent = false;
		if (mode === "producer") {
			fixture.afterRetention = (scope): Promise<void> => checkpointAndHold(selected, scope, "checkpoint");
			fixture.onOperation = (operation): void => {
				if (!earlySent && operation.lane !== "snapshot") {
					earlySent = true;
					send({
						kind: "early-effect",
						operation,
						beforeClose: selected.beforeClose,
						persistenceEntries: selected.persistenceEntries,
						operations: selected.operations,
					});
				}
			};
		}
		const result = await fixture.prepared.handle.close();
		fixture.record({
			lane: "close",
			name: "success",
			detail: { epoch: result.epoch, successorEpoch: result.successorEpoch },
		});
		const scope = fixture.scopes[0];
		assert.ok(scope && scope.completed);
		await assertSignedIdentity(fixture, result, scope);
		if (mode === "producer") {
			send({
				kind: "early-close-success",
				declaration: scope.declaration,
				beforeClose: fixture.beforeClose,
				persistenceEntries: fixture.persistenceEntries,
				operations: fixture.operations,
			});
		} else {
			// A deliberately late real owner retention is an oracle/hold control, never a compliant producer proof.
			// It carries the genuine close's already-observed evidence, votes and publications into the held checkpoint.
			const reopened = await fixture.owner.openScope(scope.declaration);
			await reopened.retainForRecovery();
			await checkpointAndHold(fixture, scope, "late-checkpoint");
		}
	} catch (error) {
		send({ kind: "child-error", detail: String(error), stack: error instanceof Error ? error.stack : undefined });
		process.exitCode = 1;
	} finally {
		await fixture?.close();
		process.disconnect?.();
	}
}

void run();
