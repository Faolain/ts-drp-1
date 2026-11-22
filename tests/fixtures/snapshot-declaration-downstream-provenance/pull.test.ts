import assert from "node:assert/strict";
import { it } from "vitest";

it("reaches the real built pull owner decoder and receipt boundaries", async () => {
	const boundary = process.env.DOWNSTREAM_BOUNDARY ?? "pull-receipt";
	const variant = process.env.DOWNSTREAM_VARIANT ?? "range";
	const NativeBytes = Uint8Array;
	const stackLimit = Error.stackTraceLimit;
	Error.stackTraceLimit = 40;
	const sentinel: unknown =
		variant === "range"
			? new RangeError("controlled pull allocation")
			: variant === "type"
				? new TypeError("manifest carrier is unreadable: controlled operation")
				: Object.freeze({ marker: "unbranded processing sentinel" });
	let phase = "setup";
	let armed = false;
	let ordinal = 0;
	const events: Array<{ phase: string; ordinal: number; stack: string; injected: boolean }> = [];
	globalThis.Uint8Array = new Proxy(NativeBytes, {
		construct(target, args, newTarget): Uint8Array {
			if (args.length === 1 && typeof args[0] === "number") {
				const stack = new Error("pull manifest allocation").stack ?? "";
				if (phase !== "setup" && stack.includes("copyExactCarrier") && stack.includes("decodeSnapshotManifest")) {
					ordinal++;
					const selected = ordinal === (boundary === "pull-initial" ? 1 : 3);
					events.push({ phase, ordinal, stack, injected: armed && selected });
					if (armed && selected) {
						armed = false;
						throw sentinel;
					}
				}
			}
			return Reflect.construct(target, args, newTarget) as Uint8Array;
		},
	});
	try {
		const live = await import("../../../packages/node/dist/src/v3-live.js");
		const node = await import("../../../packages/node/dist/src/snapshot-transfer.js");
		const storage = await import("../../../packages/storage-node/dist/src/snapshot-transfer.js");
		const canonical = await import("../../../packages/canonical/dist/src/index.js");
		const { createGenuinePreparedV3Fixture } = await import("../phase-3a1b-p3/live-fixture.js");
		const { createRecoveryInput, fakeNetwork } = await import("../phase-4b-v3/live-snapshot.js");
		const { createSnapshotQuarantineFixture } = await import("../phase-4c-v3/snapshot-quarantine-contract.js");
		const { ScriptedSnapshotChunkPort, snapshotPeerAuthorization } = await import(
			"../phase-4c-v3/snapshot-pull-transport.js"
		);
		const { MessageQueueManager } = await import("@ts-drp/message-queue");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const directory = mkdtempSync(join(tmpdir(), "downstream-pull-red-"));
		const store = storage.createNodeSnapshotQuarantineStore({ primaryFilename: join(directory, "pull.db") });
		const fixture = createSnapshotQuarantineFixture({ chunks: [NativeBytes.of(1, 2, 3)] });
		const originalManifest = Array.from(fixture.declaration.exactCanonicalManifestBytes);
		const scope = await store.openScope(fixture.declaration);
		const transport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:honest", "honest"]]));
		const owner = node.createV3SnapshotTransferOwner({ transport });
		// Historical fixture types name the source private brand. Runtime preparation
		// and recovery both use the exact built owner; this bridges only that type identity.
		const prepared = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: canonical.encodeCanonical(0),
			prepareV3LiveGeneration: live.prepareV3LiveGeneration as unknown as NonNullable<
				Parameters<typeof createGenuinePreparedV3Fixture>[0]
			>["prepareV3LiveGeneration"],
		});
		const action = async (selectedPhase: string, inject: boolean, invalid = false): Promise<unknown> => {
			phase = "setup";
			const next = await prepared.prepareAgain();
			const bindings = await createRecoveryInput(
				prepared,
				next.capability,
				Object.freeze({ action: "acl", group: "writer", kind: "grant", target: "f".repeat(64) })
			);
			const recovered = await live.recoverV3LiveReplica(
				bindings.input as unknown as Parameters<typeof live.recoverV3LiveReplica>[0]
			);
			assert.ok(recovered.ok);
			phase = selectedPhase;
			ordinal = 0;
			armed = inject;
			try {
				return await owner.receive({
					authorization: snapshotPeerAuthorization(["peer:honest"]),
					capability: recovered.capability,
					descriptors: fixture.declaration.chunks,
					exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
					expectedManifestDigest: invalid ? "0".repeat(64) : fixture.declaration.scope.manifestDigest,
					messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork("peer:receiver", false),
					onAdmittedVertex: () => undefined,
					peers: ["peer:honest"],
					quarantine: scope,
				});
			} finally {
				armed = false;
				await bindings.issuanceStore.close();
				await bindings.journal.close();
			}
		};
		let report: Record<string, unknown>;
		try {
			await action("control", false);
			assert.ok(events.some((event) => event.phase === "control" && event.ordinal === 3));
			await assert.rejects(action("deterministic", false, true), { code: "manifest-invalid" });
			const openedBefore = transport.opened.length;
			const statusBefore = await scope.status();
			let failure: unknown;
			try {
				await action("fault", true);
			} catch (error) {
				failure = error;
			}
			assert.equal(events.filter((event) => event.injected).length, 1);
			const reached = events.find((event) => event.injected);
			assert.ok(reached);
			assert.ok(reached.stack.includes("packages/node/dist/src/snapshot-transfer.js"));
			if (boundary === "pull-receipt") {
				assert.ok(reached.stack.includes("verifyInput"));
				assert.ok(reached.stack.includes("verifySnapshotStreamWithReceipt"));
			}
			assert.equal(transport.opened.length, openedBefore, "manifest fault causes no transport calls");
			assert.deepEqual(await scope.status(), statusBefore, "fault preserves native quarantine state");
			const code = failure && typeof failure === "object" ? Reflect.get(failure, "code") : undefined;
			const chain: Array<{ code: unknown; message: unknown; sentinel: boolean }> = [];
			let current = failure;
			for (let count = 0; count < 12 && current && typeof current === "object"; count++) {
				chain.push({
					code: Reflect.get(current, "code"),
					message: Reflect.get(current, "message"),
					sentinel: current === sentinel,
				});
				current = Reflect.get(current, "cause");
			}
			assert.ok(chain.some((item) => item.sentinel));
			await action("retry", false);
			assert.deepEqual(Array.from(fixture.declaration.exactCanonicalManifestBytes), originalManifest);
			report = {
				boundary,
				variant,
				expected: boundary === "pull-initial" ? "manifest-invalid" : "quarantine-failed",
				observed: code,
				events,
				chain,
				controls: {
					valid: true,
					deterministic: true,
					retry: true,
					noTransportDuringFault: true,
					durableStateUnchanged: true,
					inputUnchanged: true,
				},
				directory,
			};
		} finally {
			await owner.close();
			await prepared.close();
			await store.close();
			rmSync(directory, { recursive: true, force: true });
		}
		console.log(
			"DOWNSTREAM_RESULT=" +
				JSON.stringify({ ...report, cleanup: { ownerClosed: true, storeClosed: true, preparedClosed: true } })
		);
	} finally {
		globalThis.Uint8Array = NativeBytes;
		Error.stackTraceLimit = stackLimit;
	}
}, 60000);
