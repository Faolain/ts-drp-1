import type { BrowserContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { V3ZoneRoomHeadAuthorityForOpen, V3ZoneRoomHeadOpenContext } from "../../../examples/grid/src/v3-zone.js";
import type {
	V3RoomHeadAuthority,
	V3RoomHeadAuthorityResult,
	V3RoomHeadScope,
} from "../../../examples/v3-room/src/index.js";
import type {
	NativeReadReservation,
	RoomHeadFenceCommitment,
	RoomHeadRetirementObservation,
} from "../../../packages/storage/src/index.js";
import type { NodeRoomHeadAuthority, NodeRoomHeadOptions } from "../../../packages/storage-node/src/room-head.js";
import { importWorkspacePackageExportFile } from "../shared/workspace-package-export-file.mjs";

const { decodeCanonical, encodeCanonical } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../../../packages/canonical"),
	})
).module as Readonly<{
	decodeCanonical(bytes: Uint8Array): unknown;
	encodeCanonical(value: unknown, limits?: { maxBytes: number; maxDepth: number; maxItems: number }): Uint8Array;
}>;

/**
 * Honest external-account fixture, not a production authentication service.
 * Authority lives in the test process, survives page/IDB replacement, and is shared
 * only by the contexts explicitly installed together for one test.
 * @param contexts Browser contexts sharing one test-owned external account.
 * @param factoryName App-owned acquisition hook; Grid remains the default.
 */
export async function installGridRoomHeadAuthority(
	contexts: readonly BrowserContext[],
	factoryName = "__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__",
	initializationForJoin: "create" | "reopen" = "reopen"
): Promise<void> {
	await installNativeRoomHeadAuthority(contexts, factoryName, initializationForJoin);
}

/**
 * Bridges genuine native floor proof ports for shipped browser app tests.
 * This test account is outside the origin, not an invented production service.
 * The same native owner supplies CAS, bounded images and joined reservations.
 * @param contexts Contexts explicitly sharing this one test-owned account.
 * @param factoryName Existing app acquisition hook.
 */
async function installNativeRoomHeadAuthority(
	contexts: readonly BrowserContext[],
	factoryName: string,
	initializationForJoin: "create" | "reopen"
): Promise<void> {
	if (contexts.length === 0) return;
	const { createNodeRoomHeadAuthority } = (
		await importWorkspacePackageExportFile({
			expectedPackageName: "@ts-drp/storage-node",
			exportKey: "./room-head",
			packageDirectory: resolve(import.meta.dirname, "../../../packages/storage-node"),
		})
	).module as Readonly<{ createNodeRoomHeadAuthority(options: NodeRoomHeadOptions): NodeRoomHeadAuthority }>;
	const { ROOM_HEAD_IMAGE_LIMITS } = (
		await importWorkspacePackageExportFile({
			expectedPackageName: "@ts-drp/storage",
			exportKey: ".",
			packageDirectory: resolve(import.meta.dirname, "../../../packages/storage"),
		})
	).module as Readonly<{ ROOM_HEAD_IMAGE_LIMITS: { maxBytes: number; maxDepth: number; maxItems: number } }>;
	const directory = await mkdtemp(join(tmpdir(), "native-room-head-account-"));
	const genesisByObject = new Map<string, string>();
	const capabilities = new Map<
		number,
		{ context: BrowserContext; scope: V3RoomHeadScope; native: NodeRoomHeadAuthority }
	>();
	const handles = new Map<
		number,
		{ context: BrowserContext; value: NativeReadReservation | RoomHeadRetirementObservation }
	>();
	const liveContexts = new Set(contexts);
	let nextId = 0;
	type Method = Exclude<keyof NodeRoomHeadAuthority, "initialization" | "close" | "inspectDisposableSessions">;
	type Call = {
		[Name in Method]: { capability: number; method: Name; input: Parameters<NodeRoomHeadAuthority[Name]>[0] };
	}[Method];
	type Point = Pick<RoomHeadRetirementObservation, "scope" | "state" | "control" | "imageDigest" | "metadataBytes">;
	type WirePoint = { snapshot: Point; exactCanonicalImageBytes: number[] };
	const wirePoint = (point: Point): WirePoint => {
		const snapshot: Point = {
			scope: point.scope,
			state: point.state,
			control: point.control,
			imageDigest: point.imageDigest,
			metadataBytes: point.metadataBytes,
		};
		const bytes = encodeCanonical(
			{ version: 1, scope: point.scope, state: point.state, control: point.control },
			ROOM_HEAD_IMAGE_LIMITS
		);
		if (bytes.byteLength !== point.metadataBytes) throw new Error("CANVAS_TEST_NATIVE_IMAGE_ACCOUNTING_MISMATCH");
		return { snapshot, exactCanonicalImageBytes: Array.from(bytes) };
	};
	await Promise.all(
		contexts.map(async (context) => {
			let accepting = true;
			const admitted = new Set<Promise<unknown>>();
			let cleanupTask: Promise<void> | undefined;
			const admittedCall = <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
				if (!accepting) return Promise.reject(new Error("CANVAS_TEST_ACCOUNT_CONTEXT_CLOSED"));
				const task = Promise.resolve().then(operation);
				admitted.add(task);
				void task.then(
					() => admitted.delete(task),
					() => admitted.delete(task)
				);
				return task;
			};
			const cleanup = (): Promise<void> => {
				accepting = false; // Revoke new binding admissions before joining old work.
				return (cleanupTask ??= (async (): Promise<void> => {
					await Promise.allSettled([...admitted]);
					const releases = await Promise.allSettled(
						[...handles]
							.filter(([, h]) => h.context === context)
							.map(async ([id, h]) => {
								try {
									await h.value.release();
								} finally {
									handles.delete(id);
								}
							})
					);
					const closes = await Promise.allSettled(
						[...capabilities]
							.filter(([, c]) => c.context === context)
							.map(async ([id, c]) => {
								try {
									await c.native.close();
								} finally {
									capabilities.delete(id);
								}
							})
					);
					liveContexts.delete(context);
					if (liveContexts.size === 0) await rm(directory, { recursive: true, force: true });
					const failures = [...releases, ...closes]
						.filter((r): r is PromiseRejectedResult => r.status === "rejected")
						.map((r) => r.reason);
					if (failures.length) throw new AggregateError(failures, "CANVAS_TEST_NATIVE_ACCOUNT_CLEANUP_FAILED");
				})());
			};
			// Playwright's close event does not join asynchronous listeners. Preserve
			// the original close semantics and explicitly join native cleanup afterward.
			const close = context.close.bind(context);
			context.close = async (options): Promise<void> => {
				let primary: unknown;
				let failed = false;
				try {
					await close(options);
				} catch (cause) {
					primary = cause;
					failed = true;
				}
				try {
					await cleanup();
				} catch (cause) {
					if (failed) throw new AggregateError([primary, cause], "CANVAS_TEST_CONTEXT_AND_NATIVE_CLOSE_FAILED");
					throw cause;
				}
				if (failed) throw primary;
			};
			context.on("close", () => {
				void cleanup().catch(() => undefined);
			});
			await context.exposeBinding("__gridTestOpenAuthority", (_source, open: V3ZoneRoomHeadOpenContext) =>
				admittedCall(() => {
					const invite: unknown =
						typeof open.creatorInvite === "string"
							? decodeCanonical(new Uint8Array(Buffer.from(open.creatorInvite, "hex")))
							: open.creatorInvite;
					const digest: unknown =
						invite !== null && typeof invite === "object"
							? Reflect.get(invite, "pinnedGenesisAnchorDigest")
							: undefined;
					if (
						typeof digest !== "string" ||
						!/^[0-9a-f]{64}$/u.test(digest) ||
						!open.objectId ||
						!open.author ||
						(open.operation !== "create" && open.operation !== "join")
					)
						throw new Error("GRID_TEST_AUTHORITY_INVALID_OPEN");
					const known = genesisByObject.get(open.objectId);
					if (known !== undefined && known !== digest) throw new Error("GRID_TEST_AUTHORITY_SCOPE_CONFLICT");
					const scope = { objectId: open.objectId, pinnedGenesisAnchorDigest: digest };
					// Explicit host choice for a newly owned independent account; never
					// infer creation permission from a missing file. Shared-account tests
					// retain their original join=reopen contract by default.
					const initialization = { kind: open.operation === "create" ? ("create" as const) : initializationForJoin };
					const filename = join(directory, `${createHash("sha256").update(open.objectId).digest("hex")}.sqlite`);
					// Reopen is native mode=rw, not existence-based permission to create.
					const native = createNodeRoomHeadAuthority({ filename, initialization });
					const capability = ++nextId;
					capabilities.set(capability, { context, scope, native });
					return { capability, initialization };
				})
			);
			await context.exposeBinding("__gridTestAuthorityCall", (_source, request: Call) =>
				admittedCall(async () => {
					const c = capabilities.get(request.capability);
					if (c === undefined || c.context !== context) throw new Error("CANVAS_TEST_NATIVE_CAPABILITY_UNAVAILABLE");
					if (!isDeepStrictEqual(c.scope, request.input.scope)) throw new Error("GRID_TEST_AUTHORITY_SCOPE_CONFLICT");
					switch (request.method) {
						case "read":
							return c.native.read(request.input);
						case "migrate":
							return { ok: false, reason: "conflict" }; // No inherited bootstrap permission.
						case "create": {
							if (
								request.input.stable.epoch !== 0 ||
								request.input.stable.currentAnchorDigest !== c.scope.pinnedGenesisAnchorDigest
							)
								return { ok: false, reason: "conflict" };
							const result = await c.native.create(request.input);
							if (result.ok) genesisByObject.set(c.scope.objectId, c.scope.pinnedGenesisAnchorDigest);
							return result;
						}
						case "begin":
							return c.native.begin(request.input);
						case "commit":
							return c.native.commit(request.input);
						case "readRetirementImage":
							return wirePoint(await c.native.readRetirementImage(request.input));
						case "acquireNativeReadReservation": {
							const value = await c.native.acquireNativeReadReservation(request.input),
								handle = ++nextId;
							handles.set(handle, { context, value });
							return { handle };
						}
						case "acquireRetirementControl": {
							const value = await c.native.acquireRetirementControl(request.input),
								handle = ++nextId;
							handles.set(handle, { context, value });
							return { handle, ...wirePoint(value) };
						}
					}
				})
			);
			await context.exposeBinding(
				"__gridTestNativeHandleCall",
				(
					_source,
					request: {
						handle: number;
						method: "check" | "release" | "prepareFence" | "abortPrepared" | "commitPrepared" | "fenceDecision";
						input?: RoomHeadFenceCommitment;
					}
				) =>
					admittedCall(async () => {
						const h = handles.get(request.handle);
						if (h === undefined || h.context !== context) throw new Error("CANVAS_TEST_NATIVE_HANDLE_UNAVAILABLE");
						if (request.method === "release") {
							try {
								await h.value.release();
							} finally {
								handles.delete(request.handle);
							}
							return;
						}
						if (request.method === "check") {
							if (!("check" in h.value)) throw new Error("CANVAS_TEST_NATIVE_HANDLE_KIND");
							return h.value.check();
						}
						if (!("prepareFence" in h.value) || request.input === undefined)
							throw new Error("CANVAS_TEST_NATIVE_HANDLE_KIND");
						switch (request.method) {
							case "prepareFence":
								return h.value.prepareFence(request.input);
							case "abortPrepared":
								return h.value.abortPrepared(request.input);
							case "commitPrepared":
								return h.value.commitPrepared(request.input);
							case "fenceDecision": {
								const fence = h.value.fenceDecision;
								if (fence === undefined) throw new Error("CANVAS_TEST_NATIVE_HANDLE_KIND");
								return fence.call(h.value, request.input);
							}
						}
					})
			);
			await context.addInitScript(
				({ factoryName, maximumBytes }) => {
					const host = window as typeof window & {
						__gridTestOpenAuthority(
							open: V3ZoneRoomHeadOpenContext
						): Promise<{ capability: number; initialization: V3RoomHeadAuthority["initialization"] }>;
						__gridTestAuthorityCall(request: unknown): Promise<unknown>;
						__gridTestNativeHandleCall(request: unknown): Promise<unknown>;
					};
					const capturePoint = (wire: WirePoint): Point => {
						if (
							!Array.isArray(wire.exactCanonicalImageBytes) ||
							wire.exactCanonicalImageBytes.length > maximumBytes ||
							wire.exactCanonicalImageBytes.length !== wire.snapshot.metadataBytes ||
							wire.exactCanonicalImageBytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
						)
							throw new Error("CANVAS_TEST_NATIVE_IMAGE_BRIDGE_INVALID");
						// All fields and bytes originate in the same native bounded capture;
						// the product recaptures/checks its canonical image and original digest.
						return wire.snapshot;
					};
					const acquire: V3ZoneRoomHeadAuthorityForOpen = async (open) => {
						const { capability, initialization } = await host.__gridTestOpenAuthority(open);
						const call = (method: string, input: unknown): Promise<unknown> =>
							host.__gridTestAuthorityCall({ capability, method, input });
						const authority = {
							initialization,
							begin: (input: Parameters<V3RoomHeadAuthority["begin"]>[0]): Promise<V3RoomHeadAuthorityResult> =>
								call("begin", input) as Promise<V3RoomHeadAuthorityResult>,
							commit: (input: Parameters<V3RoomHeadAuthority["commit"]>[0]): Promise<V3RoomHeadAuthorityResult> =>
								call("commit", input) as Promise<V3RoomHeadAuthorityResult>,
							create: (input: Parameters<V3RoomHeadAuthority["create"]>[0]): Promise<V3RoomHeadAuthorityResult> =>
								call("create", input) as Promise<V3RoomHeadAuthorityResult>,
							migrate: (input: Parameters<V3RoomHeadAuthority["migrate"]>[0]): Promise<V3RoomHeadAuthorityResult> =>
								call("migrate", input) as Promise<V3RoomHeadAuthorityResult>,
							read: (input: Parameters<V3RoomHeadAuthority["read"]>[0]): Promise<V3RoomHeadAuthorityResult> =>
								call("read", input) as Promise<V3RoomHeadAuthorityResult>,
							readRetirementImage: async (input: { scope: V3RoomHeadScope }): Promise<Point> =>
								capturePoint((await call("readRetirementImage", input)) as WirePoint),
							acquireNativeReadReservation: async (input: {
								scope: V3RoomHeadScope;
							}): Promise<NativeReadReservation> => {
								const { handle } = (await call("acquireNativeReadReservation", input)) as { handle: number };
								let joined: Promise<void> | undefined;
								return {
									check: async (): Promise<void> => {
										await host.__gridTestNativeHandleCall({ handle, method: "check" });
									},
									release: () =>
										(joined ??= host.__gridTestNativeHandleCall({ handle, method: "release" }).then(() => undefined)),
								};
							},
							acquireRetirementControl: async (input: {
								scope: V3RoomHeadScope;
							}): Promise<RoomHeadRetirementObservation> => {
								const wire = (await call("acquireRetirementControl", input)) as WirePoint & { handle: number };
								let joined: Promise<void> | undefined;
								return {
									...capturePoint(wire),
									prepareFence: (value) =>
										host.__gridTestNativeHandleCall({
											handle: wire.handle,
											method: "prepareFence",
											input: value,
										}) as Promise<RoomHeadRetirementObservation["control"]>,
									abortPrepared: (value) =>
										host.__gridTestNativeHandleCall({
											handle: wire.handle,
											method: "abortPrepared",
											input: value,
										}) as Promise<RoomHeadRetirementObservation["control"]>,
									commitPrepared: (value) =>
										host.__gridTestNativeHandleCall({
											handle: wire.handle,
											method: "commitPrepared",
											input: value,
										}) as Promise<RoomHeadRetirementObservation["control"]>,
									fenceDecision: (value) =>
										host.__gridTestNativeHandleCall({
											handle: wire.handle,
											method: "fenceDecision",
											input: value,
										}) as Promise<RoomHeadRetirementObservation["control"]>,
									release: () =>
										(joined ??= host
											.__gridTestNativeHandleCall({ handle: wire.handle, method: "release" })
											.then(() => undefined)),
								};
							},
						};
						return authority;
					};
					Reflect.set(host, factoryName, acquire);
				},
				{ factoryName, maximumBytes: ROOM_HEAD_IMAGE_LIMITS.maxBytes }
			);
		})
	);
}
