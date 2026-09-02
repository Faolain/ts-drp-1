import { encodeCanonical } from "@ts-drp/canonical";
// eslint-disable-next-line import/no-unresolved -- Workspace subpath resolves after the required package build.
import { createRecoverableFinalitySigner } from "@ts-drp/keychain/finality";
import type { PresentHead } from "@ts-drp/storage";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CreatorLiveCloseHandle, CreatorLiveCloseStatus } from "../../../packages/node/src/creator-close.js";
import type { V3PlaneHandle } from "../../../packages/node/src/v3-live.js";
import { contract, hexBytes } from "../phase-3a0-v3/controlled-anchor-trust.js";
import { openD109dHotFixture } from "../phase-6b/runtime-reclamation-contract.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

type StoreCloser = Readonly<{ close(): Promise<void> }>;

export interface D110cARepeatCloseRedEvidence {
	readonly actorStatusAfterFailure: CreatorLiveCloseStatus;
	readonly actorStatusBeforeClose: CreatorLiveCloseStatus;
	readonly adoptionProbe: Readonly<Record<string, unknown>>;
	readonly afterHead: Awaited<ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>>;
	readonly beforeHead: Awaited<ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>>;
	readonly closeAttempts: 1;
	readonly closeError: Readonly<{ readonly code: unknown; readonly message: string; readonly name: string }>;
	readonly closeResult: undefined;
	readonly issued: Readonly<Record<string, unknown>>;
	readonly providerPresent: false;
	readonly published: Readonly<Record<string, unknown>>;
	readonly replacementActivationCalls: 0;
	readonly roomHeadAfter: Readonly<Record<string, unknown>> | undefined;
	readonly roomHeadBefore: Readonly<Record<string, unknown>> | undefined;
	readonly runtimeIdentity: Readonly<{
		readonly creatorCloseSourceUrl: string;
		readonly node: string;
		readonly storageNodeBuiltUrl: string;
	}>;
}

export interface D110cARepeatCloseRedFixture {
	readonly evidence: D110cARepeatCloseRedEvidence;
	close(): Promise<void>;
}

function copiedRoomHead(plane: V3PlaneHandle): Readonly<Record<string, unknown>> | undefined {
	const authority = plane.currentEphemeralAuthority();
	return authority === undefined
		? undefined
		: Object.freeze({
				aclDigest: authority.aclDigest,
				anchorDigest: authority.anchorDigest,
				epoch: authority.epoch,
				objectId: authority.objectId,
			});
}

function capturedError(
	error: unknown
): Readonly<{ readonly code: unknown; readonly message: string; readonly name: string }> {
	return Object.freeze({
		code: error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined,
		message: error instanceof Error ? error.message : String(error),
		name: error instanceof Error ? error.name : typeof error,
	});
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolvePromise) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolvePromise(), { once: true });
		request.addEventListener("error", () => resolvePromise(), { once: true });
		request.addEventListener("blocked", () => resolvePromise(), { once: true });
	});
}

function samePresentHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.kind === right.kind &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

/**
 * Executes the genuine adopted epoch-one close exactly once against unmodified production source.
 * @returns Retained causal evidence and a cooperative cleanup owner.
 */
export async function openD110cARepeatCloseRedFixture(): Promise<D110cARepeatCloseRedFixture> {
	const hot = await openD109dHotFixture();
	const primaryDatabaseName = `d110c-a-seal-${crypto.randomUUID()}`;
	const snapshotDatabaseName = `d110c-a-snapshot-${crypto.randomUUID()}`;
	const closers: StoreCloser[] = [];
	let closeHandle: CreatorLiveCloseHandle | undefined;
	let closed = false;
	const cleanup = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await closeHandle?.stop().catch(() => undefined);
		await Promise.all(closers.map((closer) => closer.close().catch(() => undefined)));
		await hot.close();
		await Promise.all([deleteDatabase(primaryDatabaseName), deleteDatabase(snapshotDatabaseName)]);
	};
	try {
		const plane = hot.successor as V3PlaneHandle;
		const issued = await hot.successor.issueLocal({
			operations: Object.freeze([
				Object.freeze({ logicalTime: 41, operation: Object.freeze({ action: "add", value: 11 }) }),
			]),
			signRegisteredVertexDigest: hot.base.signRegisteredVertexDigest,
		});
		if (issued.ok !== true) throw new TypeError(`D110C_A_POST_ADOPTION_ISSUE_FAILED:${String(issued.kind)}`);
		const published = await hot.successor.publishPending();
		if (published.ok !== true) throw new TypeError(`D110C_A_POST_ADOPTION_PUBLISH_FAILED:${String(published.kind)}`);

		const signer = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
		const [vote, evidenceStore, snapshotStore] = await Promise.all([
			hot.base.modules.openBrowserSealVoteStore({ databaseName: primaryDatabaseName }),
			hot.base.modules.openBrowserSealEvidenceStore({ databaseName: primaryDatabaseName }),
			hot.base.modules.createBrowserSnapshotQuarantineStore({ primaryDatabaseName: snapshotDatabaseName }),
		]);
		closers.push(vote, evidenceStore, snapshotStore);
		if (vote.observation.incarnation !== evidenceStore.observation.incarnation) {
			throw new TypeError("D110C_A_SEAL_INCARNATION_MISMATCH");
		}
		const bound = await hot.base.modules.bindCreatorLiveClose({
			evidenceStore: evidenceStore.store,
			exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
				minLocalCopies: 1,
				minMirrorReceipts: 0,
				minRollbackGenerations: 2,
				mode: "local-only",
			}),
			onObservation: () => undefined,
			plane,
			signer: signer.signer,
			snapshotStore,
			storageIncarnation: vote.observation.incarnation,
			voteStore: vote.store,
		});
		if (!bound.ok) throw new TypeError(`D110C_A_CLOSE_BIND_FAILED:${bound.reason}`);
		closeHandle = bound.handle;
		const roomHeadBefore = copiedRoomHead(plane);
		const beforeHead = await closeHandle.inspectDurableHead();
		const actorStatusBeforeClose = closeHandle.status();
		let closeError: ReturnType<typeof capturedError> | undefined;
		let closeAttempts = 0;
		try {
			closeAttempts += 1;
			await closeHandle.close();
		} catch (error) {
			closeError = capturedError(error);
		}
		if (closeAttempts !== 1) throw new TypeError("D110C_A_CLOSE_ATTEMPT_COUNT_INVALID");
		if (closeError === undefined) throw new TypeError("D110C_A_REPEAT_CLOSE_UNEXPECTEDLY_SUCCEEDED");
		const afterHead = await closeHandle.inspectDurableHead();
		if (!samePresentHead(beforeHead.head, afterHead.head)) {
			throw new TypeError("D110C_A_REPEAT_CLOSE_MUTATED_HEAD");
		}
		const adoptionProbe = await hot.base.modules.verifyCreatorSuccessorAdoption({
			catalog: hot.base.catalog,
			handle: closeHandle,
		});
		return Object.freeze({
			close: cleanup,
			evidence: Object.freeze({
				actorStatusAfterFailure: closeHandle.status(),
				actorStatusBeforeClose,
				adoptionProbe,
				afterHead,
				beforeHead,
				closeAttempts: 1 as const,
				closeError,
				closeResult: undefined,
				issued,
				providerPresent: false as const,
				published,
				replacementActivationCalls: 0 as const,
				roomHeadAfter: copiedRoomHead(plane),
				roomHeadBefore,
				runtimeIdentity: Object.freeze({
					creatorCloseSourceUrl: pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-close.ts")).href,
					node: process.version,
					storageNodeBuiltUrl: pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/index.js")).href,
				}),
			}),
		});
	} catch (error) {
		await cleanup();
		throw error;
	}
}
