import { AdoptionCommitExhaustedError, ApplyInvariantError, createVertex, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type ApplyResult,
	DrpType,
	type IDRP,
	Message,
	MessageType,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	SyncAccept,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

class CounterDRP implements IDRP {
	semanticsType: SemanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

type HandlerSurface = "UPDATE" | "SYNC_ACCEPT";
type RejectedBoundaryError = AdoptionCommitExhaustedError | ApplyInvariantError;

function makeNode(seed: string): DRPNode {
	return new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
}

function makeRejectedBoundaryError(
	kind: "adoption" | "invariant",
	partialResult: ApplyResult
): { error: RejectedBoundaryError; partialResultReads(): number } {
	const error =
		kind === "adoption"
			? new AdoptionCommitExhaustedError("rejected-boundary-vertex", 3)
			: new ApplyInvariantError([new Error("controlled invariant cause")], "controlled rejected boundary");
	let reads = 0;
	Object.defineProperty(error, "partialResult", {
		configurable: true,
		get: () => {
			reads++;
			return partialResult;
		},
	});
	return { error, partialResultReads: () => reads };
}

async function captureError(action: () => Promise<void>): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("expected handler to reject");
}

describe("Phase 0q-b3 rejected-boundary node consumers", () => {
	vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

	const sender = makeNode("phase-0q-b3-sender");
	const receiver = makeNode("phase-0q-b3-receiver");
	let fixtureSequence = 0;

	beforeAll(async () => {
		await sender.start();
		await receiver.start();
		vi.spyOn(sender.networkNode, "broadcastMessage").mockResolvedValue();
		vi.spyOn(receiver.networkNode, "broadcastMessage").mockResolvedValue();
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled([sender.stop(), receiver.stop()]);
	});

	async function makeFixture(surface: HandlerSurface): Promise<{
		message: Message;
		object: Awaited<ReturnType<typeof receiver.createObject<CounterDRP>>>;
	}> {
		const objectId = `phase-0q-b3-${surface.toLowerCase()}-${fixtureSequence++}`;
		const object = await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const vertex = createVertex(
			sender.networkNode.peerId,
			Operation.create({ drpType: DrpType.DRP, opType: "increment" }),
			[HashGraph.rootHash],
			fixtureSequence
		);
		vertex.signature = await sender.keychain.signWithSecp256k1(vertex.hash);
		const requested = [vertex];

		const message =
			surface === "UPDATE"
				? Message.create({
						sender: sender.networkNode.peerId,
						type: MessageType.MESSAGE_TYPE_UPDATE,
						objectId,
						data: Update.encode(Update.create({ vertices: requested })).finish(),
					})
				: Message.create({
						sender: sender.networkNode.peerId,
						type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
						objectId,
						data: SyncAccept.encode(SyncAccept.create({ requested })).finish(),
					});

		return { message, object };
	}

	it.each([
		["UPDATE", "adoption"],
		["UPDATE", "invariant"],
		["SYNC_ACCEPT", "adoption"],
		["SYNC_ACCEPT", "invariant"],
	] as const)(
		"%s consumes the exact %s rejected boundary without losing primary failure attribution",
		async (surface, errorKind) => {
			const { message, object } = await makeFixture(surface);
			const partialResult: ApplyResult = {
				applied: false,
				missing: [`missing-at-${surface}-${errorKind}`],
				invalid: [`invalid-at-${surface}-${errorKind}`],
				quarantined: [`quarantined-at-${surface}-${errorKind}`],
			};
			const rejectedBoundary = makeRejectedBoundaryError(errorKind, partialResult);
			const primaryError = rejectedBoundary.error;
			const merge = vi.spyOn(object, "merge").mockRejectedValue(primaryError);
			const recover = vi.spyOn(receiver, "syncObject").mockResolvedValue();
			const persist = vi.spyOn(receiver, "put");

			try {
				const exposedError = await captureError(() => handleMessage(receiver, message));

				expect(merge).toHaveBeenCalledTimes(1);
				expect({
					exactPartialResultConsumed: rejectedBoundary.partialResultReads() > 0,
					recoveryUsedRejectedBoundary:
						recover.mock.calls.length === 1 &&
						recover.mock.calls[0]?.[0] === message.objectId &&
						recover.mock.calls[0]?.[1] === message.sender,
					persistenceUsedExactObject:
						persist.mock.calls.length === 1 &&
						persist.mock.calls[0]?.[0] === object.id &&
						persist.mock.calls[0]?.[1] === object,
					primaryPreserved:
						exposedError === primaryError || Reflect.get(exposedError as object, "cause") === primaryError,
				}).toEqual({
					exactPartialResultConsumed: true,
					recoveryUsedRejectedBoundary: true,
					persistenceUsedExactObject: true,
					primaryPreserved: true,
				});
			} finally {
				merge.mockRestore();
				recover.mockRestore();
				persist.mockRestore();
			}
		}
	);

	it.each(["UPDATE", "SYNC_ACCEPT"] as const)(
		"%s persists the rejected boundary and preserves the primary error when recovery also rejects",
		async (surface) => {
			const { message, object } = await makeFixture(surface);
			const partialResult: ApplyResult = {
				applied: false,
				missing: [`missing-before-recovery-rejection-at-${surface}`],
				invalid: [],
				quarantined: [`quarantined-before-recovery-rejection-at-${surface}`],
			};
			const rejectedBoundary = makeRejectedBoundaryError("adoption", partialResult);
			const primaryError = rejectedBoundary.error;
			const recoveryError = new Error(`controlled recovery rejection at ${surface}`);
			const merge = vi.spyOn(object, "merge").mockRejectedValue(primaryError);
			const recover = vi.spyOn(receiver, "syncObject").mockRejectedValue(recoveryError);
			const persist = vi.spyOn(receiver, "put");

			try {
				const exposedError = await captureError(() => handleMessage(receiver, message));

				expect(merge).toHaveBeenCalledTimes(1);
				expect({
					exactPartialResultConsumed: rejectedBoundary.partialResultReads() > 0,
					recoveryAttemptedOnce:
						recover.mock.calls.length === 1 &&
						recover.mock.calls[0]?.[0] === message.objectId &&
						recover.mock.calls[0]?.[1] === message.sender,
					persistenceStillUsedExactObject:
						persist.mock.calls.length === 1 &&
						persist.mock.calls[0]?.[0] === object.id &&
						persist.mock.calls[0]?.[1] === object,
					primaryPreserved:
						exposedError === primaryError || Reflect.get(exposedError as object, "cause") === primaryError,
					secondaryDidNotReplacePrimary: exposedError !== recoveryError,
				}).toEqual({
					exactPartialResultConsumed: true,
					recoveryAttemptedOnce: true,
					persistenceStillUsedExactObject: true,
					primaryPreserved: true,
					secondaryDidNotReplacePrimary: true,
				});
			} finally {
				merge.mockRestore();
				recover.mockRestore();
				persist.mockRestore();
			}
		}
	);

	it.each(["UPDATE", "SYNC_ACCEPT"] as const)(
		"%s retains successful missing-result recovery and persistence",
		async (surface) => {
			const { message, object } = await makeFixture(surface);
			const missing = [`successful-missing-at-${surface}`];
			const merge = vi.spyOn(object, "merge").mockResolvedValue([false, missing, []]);
			const recover = vi.spyOn(receiver, "syncObject").mockResolvedValue();
			const persist = vi.spyOn(receiver, "put");

			try {
				await expect(handleMessage(receiver, message)).resolves.toBeUndefined();

				expect(merge).toHaveBeenCalledTimes(1);
				expect(recover).toHaveBeenCalledTimes(1);
				expect(recover).toHaveBeenCalledWith(message.objectId, message.sender);
				expect(persist).toHaveBeenCalledTimes(1);
				expect(persist).toHaveBeenCalledWith(object.id, object);
			} finally {
				merge.mockRestore();
				recover.mockRestore();
				persist.mockRestore();
			}
		}
	);
});
