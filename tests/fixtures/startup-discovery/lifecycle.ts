import { requireValue } from "./assert.js";
import { authority, floorControl, replaceState, state } from "./floor.js";
import { control, event, trace } from "./observation.js";
import { bootstrap, durableHead, message, openRoom, roomInput } from "./room.js";
import type { Fault, Report } from "./types.js";
import { createV3RoomSession } from "../../../examples/v3-room/src/index.js";

Object.assign(globalThis, {
	startupProvider: async (
		identity: string,
		mode: "missing" | "null" | "primitive" | "incomplete"
	): Promise<{ detail: string; trace: Record<string, unknown>[] }> => {
		const b = await bootstrap(identity),
			input = await roomInput(b, "create", false);
		trace.length = 0;
		const provider =
			mode === "missing"
				? undefined
				: mode === "null"
					? null
					: mode === "primitive"
						? 1
						: {
								initialization: { kind: "create" },
								read: async (): Promise<{ ok: boolean; state: null }> => Promise.resolve({ ok: true, state: null }),
							};
		let room: Awaited<ReturnType<typeof openRoom>> | undefined,
			detail = "fulfilled";
		try {
			room = await createV3RoomSession({ ...input, roomHeadAuthority: provider } as never);
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error);
		} finally {
			await room?.close();
		}
		return { detail, trace: [...trace] };
	},
	startupSettlementRecovery: async (identity: string): Promise<Report> => {
		const b = await bootstrap(identity, "creator-trusted-settlement-v1"),
			room = await openRoom(b, "create");
		const report: Report = { detail: "fulfilled", trace, downstream: [] };
		try {
			await room.issue(message("zero"));
			await room.sealEpoch();
			event("hot-settlement-recovery-start");
			control.issueAfterSignFault = true;
			try {
				await room.adoptCreatorSuccessor();
				report.downstream.push("reused-settlement-recovery");
			} catch (error) {
				report.detail = error instanceof Error ? error.message : String(error);
			}
			if (report.detail === "fulfilled") {
				report.projection = room.projection();
				report.authority = room.authority();
				report.durableHead = await room.inspectDurableHead();
				await room.issue(message("continued"));
				report.afterIssue = room.projection();
				report.downstream.push("continued-issue");
				await room.sealEpoch();
				control.issueAfterSignFault = true;
				event("second-settlement-recovery-start");
				await room.adoptCreatorSuccessor();
				report.authority = room.authority();
				report.downstream.push("repeated-settlement-recovery");
			}
		} finally {
			await room.close();
			report.floor = await state(identity);
		}
		return report;
	},
	startupLifecycle: async (
		identity: string,
		fault:
			| Fault
			| "noop-read"
			| "lost-after-hot"
			| "regressed-after-hot"
			| "invalid-after-hot"
			| "unavailable-after-hot"
	): Promise<Report> => {
		const b = await bootstrap(identity),
			room = await openRoom(b, "create");
		const genesis = requireValue(await state(identity), "STARTUP_FIXTURE_PRECONDITION");
		const report: Report = { detail: "fulfilled", trace, downstream: [] };
		try {
			await room.issue(message("zero"));
			await room.sealEpoch();
			if (fault === "publication") control.publicationFault = true;
			else if (
				["begin-unavailable", "commit-unavailable", "commit-lost-response", "reread-unavailable"].includes(fault)
			)
				floorControl.fault = fault as Fault;
			let failed: string | null = null;
			event("first-adoption-attempt-start");
			try {
				await room.adoptCreatorSuccessor();
			} catch (error) {
				failed = error instanceof Error ? error.message : String(error);
			}
			event("first-attempt-settled", { failed });
			report.downstream.push("first-attempt");
			if (["lost-after-hot", "regressed-after-hot", "invalid-after-hot", "unavailable-after-hot"].includes(fault)) {
				if (fault === "lost-after-hot") await replaceState(identity, undefined);
				if (fault === "regressed-after-hot") await replaceState(identity, genesis);
				if (fault === "invalid-after-hot") await replaceState(identity, { malformed: true });
				if (fault === "unavailable-after-hot") floorControl.readFault = "unavailable";
			} else floorControl.readFault = "none";
			event("retry-start");
			try {
				await room.adoptCreatorSuccessor();
			} catch (error) {
				report.detail = error instanceof Error ? error.message : String(error);
			}
			// Preserve the primary refusal even if the failed room's public owner is terminal.
			// This samples actual durable AHE state; it does not reconcile or repair either store.
			report.durableHead = await durableHead(b);
			report.downstream.push("explicit-retry");
			if (report.detail === "fulfilled") {
				report.projection = room.projection();
				report.authority = room.authority();
				await room.issue(message("continued"));
				report.afterIssue = room.projection();
				report.downstream.push("continued-issue");
				if (fault === "noop-read") {
					await room.sealEpoch();
					await room.adoptCreatorSuccessor();
					event("second-hot-adoption");
					await room.adoptCreatorSuccessor();
					report.authority = room.authority();
					report.downstream.push("second-adoption-noop");
				}
			}
		} finally {
			await room.close();
			report.floor = await state(identity);
		}
		return report;
	},
	startupComposition: async (
		identity: string,
		profile: "creator-trusted-v1" | "creator-trusted-settlement-v1",
		composition: "factory" | "rebase" | "signer"
	): Promise<{
		detail: string;
		calls: { policy: number; sign: number; transport: number };
		reads: { sign: number; transport: number };
		trace: Record<string, unknown>[];
	}> => {
		const b = await bootstrap(identity, profile),
			input = await roomInput(b, "reopen", composition === "signer");
		await authority(identity, "create").create({
			scope: { objectId: b.objectId, pinnedGenesisAnchorDigest: b.invite.pinnedGenesisAnchorDigest },
			stable: { objectId: b.objectId, epoch: 0, currentAnchorDigest: b.invite.pinnedGenesisAnchorDigest },
		});
		// Structurally valid successor expectation is enough to classify composition, not authentication.
		await replaceState(identity, {
			pending: null,
			stable: { objectId: b.objectId, epoch: 1, currentAnchorDigest: "f".repeat(64) },
		});
		const calls = { policy: 0, sign: 0, transport: 0 },
			reads = { sign: 0, transport: 0 };
		const selected = {
			...input,
			...(composition === "factory"
				? {
						createOperationAdmissionPolicy: (): object => {
							calls.policy++;
							return {};
						},
					}
				: {}),
			...(composition === "rebase" ? { rebaseSourceInvite: b.invite } : {}),
			get signRegisteredVertexDigest() {
				reads.sign++;
				return async (): Promise<Uint8Array<ArrayBuffer>> => {
					calls.sign++;
					return Promise.resolve(new Uint8Array(64));
				};
			},
			get openTransport() {
				reads.transport++;
				if (profile === "creator-trusted-settlement-v1" && composition === "signer")
					throw new Error("COMPOSITION_DEFERRED_TRANSPORT_READ");
				return (): never => {
					calls.transport++;
					throw new Error("COMPOSITION_TRANSPORT_REACHED");
				};
			},
		};
		trace.length = 0;
		let detail = "fulfilled";
		try {
			await createV3RoomSession(selected as never);
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error);
		}
		return { detail, calls, reads, trace: [...trace] };
	},
});
