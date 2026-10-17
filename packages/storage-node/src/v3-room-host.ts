/* eslint-disable @typescript-eslint/explicit-function-return-type -- Inference preserves the original storage owners' public capability types. */
/* eslint-disable @typescript-eslint/require-await -- Synchronous SQLite acquisition failures must reject the asynchronous SDK factories. */
import { ROOM_HEAD_IMAGE_LIMITS, type RoomHeadAuthority, type RoomHeadInitialization } from "@ts-drp/storage";
import { hashDomain } from "@ts-drp/canonical";
import { createRecoverableFinalitySigner, retireRecoverableFinalitySigner, signOwnedLocalRequest } from "@ts-drp/keychain/finality";
import { inspectOwnedGenesisSigningRequest, withAuthoredCreatorSelectionSigningRequest, withAuthoredIdentityChallengeSigningRequest, type OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { consumeOwnedCreatorSelectionSigningRequest } from "@ts-drp/node/v3-live";
import { consumeOwnedLocalRoomBindingRequest, consumeOwnedLocalSessionTerminalRequest, resolveOwnedLocalSessionTerminalAdmission } from "@ts-drp/node/v3-room";
import { consumeOwnedCreatorPossessionSigningRequest, consumeOwnedCreatorTransportSigningRequest } from "@ts-drp/node/creator-adoption";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { LocalSessionCatalog, type LocalSessionSelector, type SessionStoreFamily } from "./internal/local-session-catalog.js";
import { LocalSessionLifetime } from "./internal/local-session-lifetime.js";

import { createSqliteAheDurableStore } from "./index.js";
import { createNodeDurableIssuanceStore } from "./issuance.js";
import { createNodeDurableLiveJournalStore } from "./live-journal.js";
import { acquireNodeDisposableSessionAccount, acquireNodeDisposableSessionSigning, createNodeRoomHeadAuthority, openNodeDisposableSessionRoomHead, resolveNodeDisposableSessionAccount, withNodeRoomGenesisCreation,
	type NodeDisposableSessionAccountLease, type NodeRoomHeadAuthority } from "./room-head.js";
import { openNodeSealEvidenceStore } from "./seal-evidence.js";
import { openNodeSealVoteStore } from "./seal-vote.js";
import { createNodeSnapshotQuarantineStore } from "./snapshot-transfer.js";

export type NodeV3RoomStoreFamily = "ahe" | "issuance" | "journal" | "snapshots" | "signing";
export interface NodeV3RoomStorageHostOptions {
	readonly directory: string;
	/** Host acquisition policy, not wire authority or an independent freshness oracle. */
	initialization(input: Readonly<{ name: string; family: NodeV3RoomStoreFamily }>): "create" | "reopen";
	/** Explicit finite local custody profile. No shipped default or wire authority. */
	readonly localSessionSlots?: number;
	readonly localSessionStoreScopes?: number;
	/** Aggregate live session/store/protection aliases and admitted SDK jobs across this native directory. */
	readonly localSessionHandles?: number;
	/** Genuine independent account freshness, retained outside this owned directory. */
	readonly localSessionAccount?: NodeRoomHeadAuthority;
}

/**
 * Composes existing SQLite owners into the public SDK room-host boundary.
 * The host explicitly selects creation for newly authorized local scopes and
 * noncreating reopen for retained scopes. It must not infer permission to create
 * from a missing file. Signing aliases share one physical custody domain.
 * External room-head/freshness and role authorization remain separate owners.
 * @param options - Existing storage directory and explicit acquisition policy.
 * @returns Mechanical factories structurally implementing V3RoomStorageHost.
 */
export function createNodeV3RoomStorageHost(options: NodeV3RoomStorageHostOptions) {
	const directory = options.directory;
	const selectInitialization = options.initialization;
	if (
		typeof directory !== "string" ||
		!directory ||
		directory.includes("\0") ||
		typeof selectInitialization !== "function"
	)
		throw new TypeError("invalid native room host");
	const root = resolve(directory);
	const configured = [options.localSessionSlots, options.localSessionStoreScopes, options.localSessionHandles].filter((value) => value !== undefined).length;
	if (configured !== 0 && configured !== 3)
		throw new TypeError("LOCAL_SESSION_CAPACITY_PROFILE_REQUIRED");
	if (options.localSessionAccount !== undefined && configured !== 3) throw new TypeError("LOCAL_SESSION_CAPACITY_PROFILE_REQUIRED");
	let catalog: LocalSessionCatalog | undefined;
	const localCatalog = (): LocalSessionCatalog => {
		if (options.localSessionSlots === undefined || options.localSessionStoreScopes === undefined || options.localSessionHandles === undefined)
			throw new Error("LOCAL_SESSIONS_NOT_CONFIGURED");
		return catalog ??= new LocalSessionCatalog(root, options.localSessionSlots, options.localSessionStoreScopes, options.localSessionHandles, options.localSessionAccount);
	};
	const filename = (name: string, family: NodeV3RoomStoreFamily | "room-head"): string => {
		if (typeof name !== "string" || !name || name.includes("\0") || Buffer.byteLength(name) > ROOM_HEAD_IMAGE_LIMITS.maxBytes) throw new TypeError("invalid local storage identity");
		// A filesystem address only: this digest authenticates neither a room nor a peer.
		const key = createHash("sha256")
			.update(JSON.stringify([family, name]))
			.digest("hex");
		return join(root, `${key}.sqlite`);
	};
	const storeOptions = (name: string, family: NodeV3RoomStoreFamily) => {
		const selectedFilename = filename(name, family);
		const initialization = selectInitialization(Object.freeze({ name, family }));
		if (initialization !== "create" && initialization !== "reopen")
			throw new TypeError("invalid native acquisition policy");
		return { filename: selectedFilename, initialization };
	};
	const ordinaryHost = Object.freeze({
		openAhe: async (name: string) => createSqliteAheDurableStore(storeOptions(name, "ahe")),
		openIssuance: async (name: string) => {
			const { filename: primaryFilename, initialization } = storeOptions(name, "issuance");
			return createNodeDurableIssuanceStore({ primaryFilename, initialization });
		},
		openJournal: async (name: string) => {
			const { filename: primaryFilename, initialization } = storeOptions(name, "journal");
			return createNodeDurableLiveJournalStore({ primaryFilename, initialization });
		},
		openSnapshots: async (name: string) => {
			const { filename: primaryFilename, initialization } = storeOptions(name, "snapshots");
			return createNodeSnapshotQuarantineStore({ primaryFilename, initialization });
		},
		openSealVote: async (name: string) => openNodeSealVoteStore(storeOptions(name, "signing")),
		openSealEvidence: async (name: string) => openNodeSealEvidenceStore(storeOptions(name, "signing")),
		openRoomHead: async (name: string, initialization: RoomHeadInitialization) =>
			createNodeRoomHeadAuthority({ filename: filename(name, "room-head"), initialization }),
	});
	const resumeTerminalCleanup = async (selector: LocalSessionSelector): Promise<void> => {
		const selected = localCatalog(), captured = selected.capture(selector);
		if (options.localSessionAccount === undefined) { selected.cleanup(captured); return; }
		const handle = selected.reserveHandle();
		let token: NodeDisposableSessionAccountLease | undefined, failed = false, primary: unknown;
		try {
			token = acquireNodeDisposableSessionAccount(options.localSessionAccount, { kind: "resume-terminal", directory: root,
				profile: { slots: options.localSessionSlots!, storeScopes: options.localSessionStoreScopes!, handles: options.localSessionHandles! }, selector: captured });
			const account = resolveNodeDisposableSessionAccount(token);
			account.beginCleanup(); // Real cross-process exclusion BEFORE any key/file deletion.
			selected.commitDisposableFence(captured, token); // Same independent intent resumes a fence-commit prefix.
			const receipt = selected.cleanup(captured, token);
			account.complete(receipt); // Actual joined native readback; no caller digest/reset grant.
		} catch (cause) { failed = true; primary = cause; }
		try { if (token !== undefined) resolveNodeDisposableSessionAccount(token).release(); handle.release(); }
		catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "terminal native cleanup and joined release failed", { cause: primary }); throw cleanup; }
		if (failed) throw primary;
	};
	return Object.freeze({
		...ordinaryHost,
		inspectLocalSessions: async () => localCatalog().inspect(),
		resumeTerminalCleanup,
		acquireLocalSession: async (input: Readonly<{ kind: "create" }> | Readonly<{ kind: "reopen"; selector: LocalSessionSelector }>) => {
			const selected = localCatalog();
			if (input === null || typeof input !== "object" || !["create", "reopen"].includes(input.kind))
				throw new TypeError("INVALID_LOCAL_SESSION_ACQUISITION");
			const captured = input.kind === "reopen" ? selected.capture(input.selector) : undefined;
			const leaseHandle = selected.reserveHandle(captured, true); // Before identity allocation or native lease open.
			let ownedKeyHandle: ReturnType<LocalSessionCatalog["reserveHandle"]>;
			try { ownedKeyHandle = selected.reserveHandle(captured, true); }
			catch (primary) {
				try { leaseHandle.release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "owned key capacity and lease release failed", { cause: primary }); }
				throw primary;
			}
			let selector: LocalSessionSelector, custody: ReturnType<LocalSessionCatalog["acquire"]>;
			let accountLease: NodeDisposableSessionAccountLease | undefined;
			try {
				if (options.localSessionAccount !== undefined) {
					const profile = { slots: options.localSessionSlots!, storeScopes: options.localSessionStoreScopes!, handles: options.localSessionHandles! };
					accountLease = acquireNodeDisposableSessionAccount(options.localSessionAccount, captured === undefined
						? { kind: "create", directory: root, profile } : { kind: "reopen", directory: root, profile, selector: captured });
					selector = selected.allocateDisposable(accountLease);
				} else selector = captured ?? selected.allocate();
				custody = selected.acquire(selector);
			}
			catch (primary) {
				try { if (accountLease !== undefined) resolveNodeDisposableSessionAccount(accountLease).release(); ownedKeyHandle.release(); leaseHandle.release(); }
				catch (cleanup) { throw new AggregateError([primary, cleanup], "local session acquisition and handle release failed", { cause: primary }); }
				throw primary;
			}
			if (accountLease !== undefined) {
				try { await selected.recoverAbandonedDisposablePreparation(selector, accountLease); }
				catch (primary) {
					try { custody.release(); resolveNodeDisposableSessionAccount(accountLease).release(); ownedKeyHandle.release(); leaseHandle.release(); }
					catch (cleanup) { throw new AggregateError([primary, cleanup], "unfenced preparation recovery and acquisition release failed", { cause: primary }); }
					throw primary;
				}
			}
			const lifetime = new LocalSessionLifetime(() => { custody.check(); leaseHandle.check(); selected.assertActive(selector); }, () => selected.reserveHandle(selector), accountLease);
			// The seed is generated and retained only by native catalog custody.
			// Applications receive the actual public key and genuine signer, never
			// a caller-controlled/reconstructible seed or a proxy capability.
			let acquiredSigning: Awaited<ReturnType<typeof createRecoverableFinalitySigner>> | undefined;
			const keyHandle = (): void => { try { ownedKeyHandle.release(); } catch (cause) { lifetime.fail(cause); throw cause; } };
			let seed: Uint8Array | undefined;
			try {
				if (accountLease === undefined) {
					seed = selected.ownedSeed(selector);
					acquiredSigning = await createRecoverableFinalitySigner({ seed }, lifetime);
				} else acquiredSigning = await acquireNodeDisposableSessionSigning(accountLease, lifetime);
				selected.installOwnedPublicKey(selector, acquiredSigning.publicKey);
				lifetime.bindOwnedAuthor(Buffer.from(acquiredSigning.publicKey).toString("hex"));
			} catch (primary) {
				lifetime.revoke();
				try {
					if (acquiredSigning !== undefined) await retireRecoverableFinalitySigner({ signer: acquiredSigning.signer });
					keyHandle(); custody.release(); if (accountLease !== undefined) resolveNodeDisposableSessionAccount(accountLease).release(); leaseHandle.release();
				}
				catch (cleanup) { throw new AggregateError([primary, cleanup], "owned key acquisition and native release failed", { cause: primary }); }
				throw primary;
			} finally { seed?.fill(0); }
			const signingIdentity = acquiredSigning;
			if (signingIdentity === undefined) throw new Error("LOCAL_SESSION_OWNED_KEY_UNAVAILABLE");
			const keyOwner = Object.freeze({ close: async (): Promise<void> => {
				await retireRecoverableFinalitySigner({ signer: signingIdentity.signer }); lifetime.closedOwner(keyOwner);
			} });
			lifetime.registerOwner(keyOwner, keyHandle);
			let roomHeadAuthority: NodeRoomHeadAuthority | undefined;
			if (accountLease !== undefined) {
				const release = lifetime.reserveNativeHandle();
				try {
					roomHeadAuthority = openNodeDisposableSessionRoomHead(accountLease, lifetime);
					lifetime.registerOwner(roomHeadAuthority, release);
				} catch (primary) {
					try { release(); lifetime.revoke(); await lifetime.closeOwners(); custody.release(); resolveNodeDisposableSessionAccount(accountLease).release(); leaseHandle.release(); }
					catch (cleanup) { throw new AggregateError([primary, cleanup], "disposable floor acquisition and original custody close failed", { cause: primary }); }
					throw primary;
				}
			}
			const assertBound = (): void => { if (accountLease !== undefined) resolveNodeDisposableSessionAccount(accountLease).assertBound(); };
			const signing = Object.freeze({
				author: Buffer.from(signingIdentity.publicKey).toString("hex"),
				get publicKeyBytes(): Uint8Array { lifetime.assertCurrent(); return Uint8Array.from(signingIdentity.publicKey); },
				get finalitySigner() { lifetime.assertCurrent(); assertBound(); return signingIdentity.signer; },
				signRequest: async (request: OwnedSigningRequest): Promise<Uint8Array> => {
					lifetime.assertCurrent();
					assertBound();
					const challenge = consumeOwnedCreatorPossessionSigningRequest(request) ?? consumeOwnedCreatorTransportSigningRequest(request);
					if (challenge !== undefined) {
						lifetime.assertOwnedPublicKey(challenge.publicKey);
						const finish = lifetime.enterOwnedSigning(); // Before retained native checks / crypto.
						let failed = false, primary: unknown;
						try {
							const signature = await challenge.checkWhile(() => withAuthoredIdentityChallengeSigningRequest({ kind: challenge.kind,
								exactCanonicalChallengeBytes: challenge.bytes, signerPublicKey: challenge.publicKey },
								captured => {
									const domain = challenge.kind === "possession" ? "ts-drp/creator-issuance-possession/v1" : "ts-drp/creator-successor-transport/v1";
									return lifetime.withOwnedIdentityChallengeSigning(challenge.kind, hashDomain(domain, challenge.bytes),
										() => signOwnedLocalRequest({ signer: signingIdentity.signer, request: captured }));
								}));
							lifetime.assertCurrent(); return signature;
						} catch (cause) { failed = true; primary = cause; throw cause; }
						finally { try { finish(); } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "owned identity challenge and joined local release failed", { cause: primary }); throw cleanup; } }
					}
					const admitted = consumeOwnedCreatorSelectionSigningRequest(request);
					if (admitted === undefined) return signOwnedLocalRequest({ signer: signingIdentity.signer, request });
					lifetime.assertOwnedPublicKey(admitted.publicKey);
					const finish = lifetime.enterOwnedSigning(); // Before retained native checks/crypto.
					let failed = false, primary: unknown;
					try {
						const signature = await admitted.checkWhile(() => lifetime.withOwnedSelectionSigning(admitted.digest,
							() => withAuthoredCreatorSelectionSigningRequest({ exactCanonicalSelectionBytes: admitted.bytes, signerPublicKey: admitted.publicKey },
								captured => signOwnedLocalRequest({ signer: signingIdentity.signer, request: captured }))));
						lifetime.assertCurrent(); return signature;
					} catch (cause) { failed = true; primary = cause; throw cause; }
					finally { try { finish(); } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "owned selection and joined local release failed", { cause: primary }); throw cleanup; } }
				},
				signGenesisRequest: async (request: OwnedSigningRequest, accountHead: RoomHeadAuthority): Promise<Uint8Array> => {
					lifetime.assertCurrent();
					if (accountLease !== undefined && accountHead !== roomHeadAuthority) throw new Error("DISPOSABLE_SESSION_EXACT_ACCOUNT_GENESIS_REQUIRED");
					const captured = inspectOwnedGenesisSigningRequest(request);
					if (captured?.genesis === undefined) throw new TypeError("UNTRUSTED_OWNED_GENESIS_REQUEST");
					lifetime.assertOwnedPublicKey(captured.publicKey);
					selected.assertOwnedGenesis(selector, captured.genesis.bindingDigest); // Before account-provider effects.
					const release = lifetime.enterOwnedSigning(); // Finite admission before retained provider/signing work.
					let failed = false, primary: unknown;
					try {
						const signature = await withNodeRoomGenesisCreation(accountHead, { scope: { objectId: captured.genesis.objectId, pinnedGenesisAnchorDigest: Buffer.from(captured.digest).toString("hex") }, bindingDigest: captured.genesis.bindingDigest }, async () => {
							lifetime.assertCurrent();
							selected.bindOwnedGenesis(selector, captured.genesis!.bindingDigest);
							return lifetime.withOwnedGenesisSigning(captured.digest, () => signOwnedLocalRequest({ signer: signingIdentity.signer, request }));
						});
						lifetime.assertCurrent(); return signature;
					} catch (cause) { failed = true; primary = cause; throw cause; }
					finally { try { release(); } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "owned genesis and local joined release failed", { cause: primary }); throw cleanup; } }
				},
			});
			let closed: Promise<void> | undefined;
			const close = (): Promise<void> => {
				lifetime.revoke();
				return closed ??= (async () => {
					await lifetime.join();
					await lifetime.closeOwners(); custody.release(); if (accountLease !== undefined) resolveNodeDisposableSessionAccount(accountLease).release(); leaseHandle.release();
				})();
			};
			const acquire = <Owner extends { close(): Promise<void> }>(family: SessionStoreFamily, name: string,
				open: (declaration: ReturnType<LocalSessionCatalog["declare"]>) => Owner | Promise<Owner>, requireExisting = false): Promise<Owner> =>
				lifetime.run(async () => {
					assertBound();
					const release = lifetime.reserveNativeHandle(); // Before declaration/native file effects.
					let registered = false;
					try {
						const declaration = selected.declare(selector, family, name, requireExisting);
						const suffix = family === "issuance" ? ".drp-issuance-v1.sqlite" : family === "journal" ? ".drp-live-journal-v1.sqlite" : family === "snapshots" ? ".drp-snapshot-quarantine-v1.sqlite" : "";
						lifetime.declareNativeFile(`${declaration.filename}${suffix}`, family);
						const owner = await open(declaration);
						lifetime.registerOwner(owner, release, `${declaration.filename}${suffix}`); registered = true; // Preserve branded identity.
						selected.installed(selector, family, declaration.digest);
						return owner;
					} catch (primary) {
						if (!registered) try { release(); }
						catch (cleanup) { throw new AggregateError([primary, cleanup], "local store admission and handle release failed", { cause: primary }); }
						throw primary; // Registered owners remain joined by the session close.
					}
				});
			const storageHost = Object.freeze({
				openAhe: (name: string) => acquire("ahe", name, ({ filename, initialization }) => createSqliteAheDurableStore({ filename, initialization }, lifetime)),
				openIssuance: (name: string) => acquire("issuance", name, ({ filename, initialization }) => createNodeDurableIssuanceStore({ primaryFilename: filename, initialization }, lifetime)),
				openJournal: (name: string) => acquire("journal", name, ({ filename, initialization }) => createNodeDurableLiveJournalStore({ primaryFilename: filename, initialization }, lifetime)),
				openSnapshots: (name: string) => acquire("snapshots", name, ({ filename, initialization }) => createNodeSnapshotQuarantineStore({ primaryFilename: filename, initialization }, lifetime)),
				openSealVote: (name: string) => acquire("signing", name, ({ filename, initialization }) => openNodeSealVoteStore({ filename, initialization }, lifetime)),
				openSealEvidence: (name: string) => acquire("signing", name, ({ filename, initialization }) => openNodeSealEvidenceStore({ filename, initialization }, lifetime)),
				openRoomHead: (name: string, initialization: RoomHeadInitialization) => accountLease !== undefined ? lifetime.run(async () => {
					assertBound();
					const release = lifetime.reserveNativeHandle();
					try { const owner = openNodeDisposableSessionRoomHead(accountLease, lifetime); lifetime.registerOwner(owner, release); return owner; }
					catch (primary) { try { release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "disposable floor alias and release failed", { cause: primary }); } throw primary; }
				}) : acquire("room-head", name, (declaration) => {
					if (initialization.kind === "reopen" && declaration.initialization !== "reopen") throw new Error("LOCAL_SESSION_ROOM_HEAD_MISSING");
					return createNodeRoomHeadAuthority({ filename: declaration.filename,
						initialization: declaration.initialization === "reopen" ? { kind: "reopen" } : initialization }, lifetime);
				}, initialization.kind === "reopen"),
			});
			let bindingLease!: Parameters<typeof consumeOwnedLocalRoomBindingRequest>[1];
			const lease = Object.freeze({ selector, storageHost, close, signing, roomHeadAuthority,
				requiresAuthenticatedDisposition: accountLease !== undefined,
				bindAuthenticatedRoom: (request: unknown): void => {
					lifetime.assertCurrent();
					const admitted = consumeOwnedLocalRoomBindingRequest(request, bindingLease);
					if (admitted === undefined) {
						if (accountLease !== undefined || !(request instanceof Uint8Array)) throw new Error("DISPOSABLE_SESSION_AUTHENTICATED_ROOM_REQUEST_REQUIRED");
						selected.bindOwnedRoom(selector, request); return;
					}
					lifetime.assertOwnedPublicKey(admitted.publicKey);
					if (accountLease !== undefined) resolveNodeDisposableSessionAccount(accountLease).bindRoot(admitted.scope, admitted.bindingDigest);
					selected.bindOwnedRoom(selector, admitted.bindingDigest);
					lifetime.assertCurrent();
				},
				assertCurrent: (): void => lifetime.assertCurrent(),
				admit: async <T>(operation: () => T | Promise<T>): Promise<T> => {
					if (typeof operation !== "function") throw new TypeError("INVALID_LOCAL_SESSION_ADMISSION");
					const release = lifetime.reserveNativeHandle(); // Bound retained SDK jobs before entry.
					let failed = false, primary: unknown, result: T | undefined;
					try { result = await lifetime.run(operation); }
					catch (cause) { failed = true; primary = cause; }
					try { release(); }
					catch (cleanup) {
						if (failed) throw new AggregateError([primary, cleanup], "local SDK admission and release failed", { cause: primary });
						throw cleanup;
					}
					if (failed) throw primary;
					lifetime.assertCurrent(); // The run-result await is itself a delivery boundary.
					return result as T;
				},
				retire: async (request: Readonly<{ join(): Promise<void>; disposition?: unknown }>): Promise<void> => {
					if (request === null || typeof request !== "object" || typeof request.join !== "function") throw new TypeError("INVALID_LOCAL_SESSION_JOIN");
					if (accountLease !== undefined) {
						lifetime.assertCurrent();
						const admission = consumeOwnedLocalSessionTerminalRequest(request.disposition, bindingLease), source = resolveOwnedLocalSessionTerminalAdmission(admission);
						if (request.disposition !== undefined && (admission === undefined || source === undefined)) throw new Error("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
						const preparationHandle = selected.reserveHandle(selector);
						const release = (): void => { try { preparationHandle.release(); } catch (cause) { lifetime.fail(cause); throw cause; } };
						let failed = false, primary: unknown, fenced = false;
						try {
							const prepared = source === undefined ? selected.prepareDisposableEmptyTerminal(selector, lifetime, preparationHandle) : await selected.prepareDisposableTerminal(selector, admission, lifetime, preparationHandle);
							await source?.releaseFloorForFence();
							lifetime.assertCurrent();
							resolveNodeDisposableSessionAccount(accountLease).fence(admission, prepared);
							fenced = true; lifetime.revoke(); // Independent durable fence precedes revocation/admission closure.
							selected.commitDisposableFence(selector, accountLease);
						} catch (cause) { failed = true; primary = cause; }
						if (!fenced) {
							try { resolveNodeDisposableSessionAccount(accountLease).check(); await selected.abortDisposablePreparation(selector, accountLease, preparationHandle); }
							catch { /* Unknown independent state retains exact prepared intent; never erase an acknowledged fence. */ }
						}
						try { await source?.release(); } catch (cleanup) { primary = failed ? new AggregateError([primary, cleanup], "terminal admission and source release failed", { cause: primary }) : cleanup; failed = true; }
						if (fenced) {
							try { await request.join(); } catch (cause) { primary = failed ? new AggregateError([primary, cause], "terminal admission and original room join failed", { cause: primary }) : cause; failed = true; }
							try { await close(); } catch (cleanup) { primary = failed ? new AggregateError([primary, cleanup], "terminal room join and original native close failed", { cause: primary }) : cleanup; failed = true; }
						}
						try { release(); } catch (cleanup) { primary = failed ? new AggregateError([primary, cleanup], "terminal work and local admission release failed", { cause: primary }) : cleanup; failed = true; }
						if (failed) throw primary;
						await resumeTerminalCleanup(selector);
						return;
					}
					selected.fence(selector); // Durable revocation precedes every external/native drain.
					lifetime.revoke();
					let primary: unknown, failed = false;
					try { await request.join(); } catch (cause) { primary = cause; failed = true; }
					try { await close(); } catch (cleanup) {
						if (failed) throw new AggregateError([primary, cleanup], "terminal session join and native close failed", { cause: primary });
						throw cleanup;
					}
					if (failed) throw primary; // Keep exact recoverable intent/bytes and original error.
					selected.cleanup(selector);
				},
			});
			bindingLease = lease;
			return lease;
		},
	});
}

export type NodeV3RoomStorageHost = ReturnType<typeof createNodeV3RoomStorageHost>;
