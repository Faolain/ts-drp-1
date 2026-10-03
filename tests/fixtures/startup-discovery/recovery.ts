import { requireValue } from "./assert.js";
import { floorControl, replaceState, state } from "./floor.js";
import { event, trace } from "./observation.js";
import { durableHead, message, openRoom } from "./room.js";
import type { Bootstrap, RecoveryFault, Report } from "./types.js";
import { observeNativeReads } from "../cold-discovery/read-observer.js";
import { browserMutations, request } from "../pending-discovery/browser-mutations.js";
import { freshEffects, observe } from "../pending-discovery/observer.js";

Object.assign(globalThis, {
	startupRecover: async (b: Bootstrap, fault: RecoveryFault, oldHint = false): Promise<Report> => {
		const before = await state(b.identity);
		if (before === null) throw new Error("STARTUP_SETUP_FLOOR_MISSING");
		const selected = before.pending?.next ?? before.stable;
		if (fault === "floor-lost") await replaceState(b.identity, undefined);
		if (fault === "floor-invalid") await replaceState(b.identity, { malformed: true });
		if (fault === "floor-unavailable") floorControl.readFault = "unavailable";
		if (fault === "wrong-head") {
			// This is a genuine prior authenticated floor, not a synthetic altered tuple.
			const prior = Reflect.get(globalThis, "startupPrior");
			if (prior === undefined) throw new Error("STARTUP_GENUINE_PRIOR_REQUIRED");
			await replaceState(b.identity, prior);
		}
		if (fault === "floor-ahead")
			await replaceState(b.identity, { pending: null, stable: { ...selected, epoch: selected.epoch + 1 } });
		if (fault === "historic-floor-ahead")
			await replaceState(b.identity, {
				pending: null,
				stable: { ...selected, currentAnchorDigest: "e".repeat(64), epoch: 1 },
			});
		if (fault === "genesis-over-successor")
			await replaceState(b.identity, {
				pending: null,
				stable: { objectId: b.objectId, epoch: 0, currentAnchorDigest: b.invite.pinnedGenesisAnchorDigest },
			});
		if (["missing-metadata", "poisoned", "missing-chunk", "corrupt-chunk", "replace-after-lookup"].includes(fault)) {
			// The owner mutation runs before the actual room. It does not substitute a reader.
			if (fault === "replace-after-lookup") {
				const db = await request(indexedDB.open(b.identity + "--drp-snapshot-quarantine-v1"));
				let rows: Record<string, unknown>[];
				try {
					rows = (await request(db.transaction("scopes", "readonly").objectStore("scopes").getAll())) as Record<
						string,
						unknown
					>[];
				} finally {
					db.close();
				}
				const matches = rows.filter((row) => row.objectId === b.objectId && row.epoch === selected.epoch - 1);
				if (matches.length !== 1) throw new Error("STARTUP_REPLACEMENT_SCOPE_NOT_UNIQUE");
				const row = requireValue(matches[0], "STARTUP_FIXTURE_PRECONDITION");
				await browserMutations(b.identity).after(fault, {
					objectId: b.objectId,
					epoch: selected.epoch - 1,
					anchor: String(row.anchor),
					manifestDigest: String(row.manifestDigest),
				});
			} else
				await browserMutations(b.identity).before(
					fault as never,
					{ identity: b.identity, expectedPreviousRoomHead: { ...selected, epoch: selected.epoch - 1 } } as never
				);
		}
		trace.length = 0;
		const native = freshEffects();
		const report: Report = { detail: "fulfilled", trace, downstream: [], native };
		let room: Awaited<ReturnType<typeof openRoom>> | undefined;
		try {
			await observeNativeReads(
				() => {
					native.reads++;
					event("native-port-read");
				},
				() =>
					observe(native, async () => {
						room = await openRoom(b, "reopen", false, oldHint);
					})
			);
			report.downstream.push("opened");
			report.projection = requireValue(room, "STARTUP_FIXTURE_PRECONDITION").projection();
			report.authority = requireValue(room, "STARTUP_FIXTURE_PRECONDITION").authority();
			report.durableHead = await durableHead(b);
			report.downstream.push("state-authority-head");
			event("continued-issue-start");
			await requireValue(room, "STARTUP_FIXTURE_PRECONDITION").issue(message("continued"));
			report.afterIssue = requireValue(room, "STARTUP_FIXTURE_PRECONDITION").projection();
			report.downstream.push("continued-issue");
		} catch (error) {
			report.detail = error instanceof Error ? error.message : String(error);
		} finally {
			if (room !== undefined) {
				await room.close();
				event("session-closed");
			}
		}
		report.floor = await state(b.identity);
		return report;
	},
});
