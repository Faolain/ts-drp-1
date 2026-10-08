import type { BrowserContext } from "@playwright/test";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { V3ZoneRoomHeadAuthorityForOpen, V3ZoneRoomHeadOpenContext } from "../../../examples/grid/src/v3-zone.js";
import type {
	V3RoomHeadAuthority,
	V3RoomHeadAuthorityResult,
	V3RoomHeadScope,
	V3RoomHeadState,
} from "../../../examples/v3-room/src/index.js";
import { importWorkspacePackageExportFile } from "../shared/workspace-package-export-file.mjs";

const { decodeCanonical } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../../../packages/canonical"),
	})
).module as Readonly<{ decodeCanonical(bytes: Uint8Array): unknown }>;

/**
 * Honest external-account fixture, not a production authentication service.
 * Authority lives in the test process, survives page/IDB replacement, and is shared
 * only by the contexts explicitly installed together for one test.
 * @param contexts Browser contexts sharing one test-owned external account.
 */
export async function installGridRoomHeadAuthority(contexts: readonly BrowserContext[]): Promise<void> {
	const states = new Map<string, V3RoomHeadState>();
	const genesisByObject = new Map<string, string>();
	const capabilities = new Map<number, { scope: V3RoomHeadScope; create: boolean }>();
	let nextCapability = 0;
	const conflict = (): V3RoomHeadAuthorityResult => ({ ok: false, reason: "conflict" });
	const success = (state: V3RoomHeadState | null): V3RoomHeadAuthorityResult => ({
		ok: true,
		state: structuredClone(state),
	});
	const key = (scope: V3RoomHeadScope): string => JSON.stringify([scope.objectId, scope.pinnedGenesisAnchorDigest]);
	type Method = keyof Omit<V3RoomHeadAuthority, "initialization">;
	type Request = {
		[Name in Method]: { capability: number; method: Name; input: Parameters<V3RoomHeadAuthority[Name]>[0] };
	}[Method];
	await Promise.all(
		contexts.map(async (context) => {
			await context.exposeBinding("__gridTestOpenAuthority", (_source, open: V3ZoneRoomHeadOpenContext) => {
				const invite: unknown =
					typeof open.creatorInvite === "string"
						? decodeCanonical(new Uint8Array(Buffer.from(open.creatorInvite, "hex")))
						: open.creatorInvite;
				const pinnedGenesisAnchorDigest: unknown =
					invite !== null && typeof invite === "object" ? Reflect.get(invite, "pinnedGenesisAnchorDigest") : undefined;
				if (
					typeof pinnedGenesisAnchorDigest !== "string" ||
					!/^[0-9a-f]{64}$/u.test(pinnedGenesisAnchorDigest) ||
					!open.objectId ||
					!open.author ||
					(open.operation !== "create" && open.operation !== "join")
				)
					throw new Error("GRID_TEST_AUTHORITY_INVALID_OPEN");
				const scope = { objectId: open.objectId, pinnedGenesisAnchorDigest };
				const knownGenesis = genesisByObject.get(scope.objectId);
				if (knownGenesis !== undefined && knownGenesis !== pinnedGenesisAnchorDigest)
					throw new Error("GRID_TEST_AUTHORITY_SCOPE_CONFLICT");
				const capability = ++nextCapability;
				capabilities.set(capability, { scope, create: open.operation === "create" });
				return { capability, initialization: { kind: open.operation === "create" ? "create" : "reopen" } };
			});
			await context.exposeBinding("__gridTestAuthorityCall", (_source, request: Request): V3RoomHeadAuthorityResult => {
				const capability = capabilities.get(request.capability);
				if (capability === undefined) return { ok: false, reason: "unavailable" };
				const { scope } = request.input;
				if (
					!scope ||
					typeof scope.objectId !== "string" ||
					!scope.objectId ||
					!/^[0-9a-f]{64}$/u.test(scope.pinnedGenesisAnchorDigest)
				)
					return conflict();
				if (
					scope.objectId === capability.scope.objectId &&
					scope.pinnedGenesisAnchorDigest !== capability.scope.pinnedGenesisAnchorDigest
				)
					return conflict();
				const knownGenesis = genesisByObject.get(scope.objectId);
				if (knownGenesis !== undefined && knownGenesis !== scope.pinnedGenesisAnchorDigest) return conflict();
				const state = states.get(key(scope)) ?? null;
				switch (request.method) {
					case "read":
						return success(state);
					case "migrate":
						return conflict(); // No legacy bootstrap authority is granted by these tests.
					case "create": {
						const { stable } = request.input;
						if (
							!capability.create ||
							stable.objectId !== scope.objectId ||
							stable.epoch !== 0 ||
							stable.currentAnchorDigest !== scope.pinnedGenesisAnchorDigest
						)
							return conflict();
						const desired = { pending: null, stable };
						if (state !== null) return isDeepStrictEqual(state, desired) ? success(state) : conflict();
						genesisByObject.set(scope.objectId, scope.pinnedGenesisAnchorDigest);
						states.set(key(scope), structuredClone(desired));
						return success(desired);
					}
					case "begin": {
						const { expected, next } = request.input;
						if (
							state === null ||
							!isDeepStrictEqual(state, expected) ||
							state.pending !== null ||
							next.objectId !== scope.objectId ||
							next.epoch !== state.stable.epoch + 1 ||
							!/^[0-9a-f]{64}$/u.test(next.currentAnchorDigest) ||
							next.currentAnchorDigest === state.stable.currentAnchorDigest
						)
							return conflict();
						const desired = { stable: state.stable, pending: { previous: state.stable, next } };
						states.set(key(scope), structuredClone(desired));
						return success(desired);
					}
					case "commit": {
						if (state === null || !isDeepStrictEqual(state, request.input.expected) || state.pending === null)
							return conflict();
						const desired = { stable: state.pending.next, pending: null };
						states.set(key(scope), structuredClone(desired));
						return success(desired);
					}
					default:
						return conflict();
				}
			});
			await context.addInitScript(() => {
				const host = window as typeof window & {
					__gridTestOpenAuthority(
						open: V3ZoneRoomHeadOpenContext
					): Promise<{ capability: number; initialization: V3RoomHeadAuthority["initialization"] }>;
					__gridTestAuthorityCall(request: unknown): Promise<V3RoomHeadAuthorityResult>;
					__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__?: V3ZoneRoomHeadAuthorityForOpen;
				};
				host.__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__ = async (open): Promise<V3RoomHeadAuthority> => {
					const { capability, initialization } = await host.__gridTestOpenAuthority(open);
					return {
						initialization,
						begin: (input): Promise<V3RoomHeadAuthorityResult> =>
							host.__gridTestAuthorityCall({ capability, method: "begin", input }),
						commit: (input): Promise<V3RoomHeadAuthorityResult> =>
							host.__gridTestAuthorityCall({ capability, method: "commit", input }),
						create: (input): Promise<V3RoomHeadAuthorityResult> =>
							host.__gridTestAuthorityCall({ capability, method: "create", input }),
						migrate: (input): Promise<V3RoomHeadAuthorityResult> =>
							host.__gridTestAuthorityCall({ capability, method: "migrate", input }),
						read: (input): Promise<V3RoomHeadAuthorityResult> =>
							host.__gridTestAuthorityCall({ capability, method: "read", input }),
					};
				};
			});
		})
	);
}
