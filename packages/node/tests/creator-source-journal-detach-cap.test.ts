import { readFileSync } from "node:fs";

import { CanonicalEncodingError, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// RED (c-hot-2 on combined head 2197fd8a: "v3 room issue failed: issuance-rejected: v3 local issue transaction failed:
// canonical value exceeds byte limit"). A creator's own move runs its issuance maintenance admission, which primes the
// warm ordinary source (captureCreatorOrdinaryIssuanceProofSource, through captureCreatorOrdinarySourceWithoutForecast)
// and readiness refreshes it (prepareCreatorOrdinaryIssuanceProofSourceReadiness). Both detach the capture's live journal
// with detachClosedCaptureJournal, one encode under the close's 786,432-byte cap (CLOSED_RETIREMENT_BYTES). C1 made the
// journal observation CARRIER hold a drain control's plan by digest, because the plan's frames duplicate rows the journal
// still holds; the detach still encodes the whole observed journal: the full plan beside the rows it duplicates, and the
// native control carriers (the plan's bytes once more). At j19 widths the carrier fits, acquisition charges it, and the
// detach then throws the codec's untyped CanonicalEncodingError. The warm source declines to the exact cold route only on
// the typed Refusal (proof-budget-exceeded), so the error ends the creator's local issue, which the room and the
// application's rollover policy do not type: the player's move is refused (base bb4c667a, turnaround and active-source
// all hold these sites unchanged). No byte limit changes here.

const CAP = { maxBytes: 786_432, maxItems: 65_536, maxDepth: 128 };
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string | undefined {
	const found = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	return found?.getText(parsed).replace(/^export\s+/u, "");
}
function body(name: string): string {
	const text = declaration(name);
	if (text === undefined) throw new Error(`missing source owner ${name}`);
	return text;
}
// The owner's detach and carrier functions with the helpers they use, compiled from the owner's own declarations. A
// typed refusal is requireLaw's (here a TypeError naming its kind).
const OWNERS = ["detachClosedCaptureJournal", "creatorIssuanceMaintenanceObservationCarriers", "closedJournalObservationControl",
	"closedJournalDrainPlanCarriers", "closedJournalObservationRowsDigest", "closedRetirementBytes", "closedRetirementDigest",
	"closedObservationCarrierBytes"];
const compiled = new Function("encodeCanonical", "decodeCanonical", "hashDomain", "CLOSED_RETIREMENT_BYTES", "CanonicalEncodingError",
	"requireLaw", "maintenanceWidthAtom", `"use strict"; ${OWNERS.flatMap(name => declaration(name) ?? [])
		.map(text => ts.transpile(text, { target: ts.ScriptTarget.ES2022 })).join("\n")}
	return {detach: detachClosedCaptureJournal, carriers: creatorIssuanceMaintenanceObservationCarriers, carrierBytes: closedObservationCarrierBytes};`)(
	encodeCanonical, decodeCanonical, hashDomain, CAP, CanonicalEncodingError,
	(ok: unknown, reason = "internal-invariant") => { if (!ok) throw new TypeError(`typed:${reason}`); }, Symbol("maintenance-width")) as {
	detach: <T>(journal: T) => T;
	carriers: (input: Record<string, unknown>) => readonly unknown[];
	carrierBytes: (value: unknown) => Uint8Array | undefined;
};

// j19 widths (closed-journal-observation-carrier-plan.test.ts): 692 received rows of about 1.1 KB (about 765 KB), and the
// adoption drain's plan for epoch 0's 385 rows (about 520 KB).
const objectId = "j19-room";
const hex = (seed: number) => (seed.toString(16).padStart(8, "0")).repeat(8);
const scopes = [0, 1, 2].map(epoch => ({ objectId, epoch, anchorDigest: hex(0xa0 + epoch) }));
function receivedFrame(scope: (typeof scopes)[number], sequence: number): Uint8Array {
	return encodeCanonical(["accepted_entries", [scope.objectId, scope.epoch, scope.anchorDigest, sequence], {
		journal_sequence: sequence, vertex_digest: hex(scope.epoch * 1000 + sequence), source_kind: "received",
		received_preimage: new Uint8Array(764).fill(sequence & 0xff), received_signature: new Uint8Array(64).fill(7) }]);
}
const header = (scope: (typeof scopes)[number], next: number) => encodeCanonical(["scopes",
	[scope.objectId, scope.epoch, scope.anchorDigest], { object_id: scope.objectId, epoch: scope.epoch,
		anchor_digest: scope.anchorDigest, next_journal_sequence: next }]);
const perEpoch = [385, 160, 147];
const frames = scopes.map((scope, index) => Array.from({ length: perEpoch[index]! }, (_, sequence) => receivedFrame(scope, sequence)));
const canonicalRows = scopes.flatMap((scope, index) => [header(scope, perEpoch[index]!), ...frames[index]!]);
const WIDE = { maxBytes: 8_388_608 };
const rowsBytes = encodeCanonical(canonicalRows, WIDE).byteLength;
const image = { imageDigest: hex(0xbeef), scopeCount: 3, rowCount: 692, byteCharge: rowsBytes };
const baseControl = { kind: "v3-live-journal-retirement-control-2", objectId, incarnation: hex(0xc0), revision: 6, sequence: 3,
	active: null, completed: { decisionDigest: hex(0xd1), sourceProofDigest: hex(0xd2), throughEpoch: 0,
		protectedScopes: [scopes[1], scopes[2]] }, drain: null };
const plan = { baseControl, sourceImage: image, prefixes: [{ scope: scopes[0], highWatermark: frames[0]!.length,
	rows: frames[0]!.map((bytes, sequence) => ({ journalSequence: sequence, vertexDigest: hex(sequence), author: hex(0x5000 + (sequence % 4)),
		authorSequence: sequence, nativeFrameDigest: [...hashDomain("ts-drp/live-journal-native-frame/v1", bytes)]
			.map(byte => byte.toString(16).padStart(2, "0")).join(""), exactCanonicalNativeFrameBytes: bytes })) }],
	retiredEmptyHeaders: [], protectedHeaderScopes: [scopes[1], scopes[2]] };
const control = { ...baseControl, revision: 7, drain: { plan, cursor: 0, batches: 0, residualImageDigest: hex(0xe0) } };
const { plan: _plan, ...drainProgress } = control.drain;
// A mid-drain capture's journal read (LiveJournalRetirementImageObservation): the control, its native carriers (the control
// without its plan, then the plan), the image and the rows; the in-memory drainSource is the adapter's reconstruction.
const journal = {
	control,
	exactCanonicalControlCarriers: [encodeCanonical({ ...control, drain: drainProgress }, WIDE), encodeCanonical(plan, WIDE)],
	image,
	canonicalRows,
	drainSource: Object.freeze({ control: baseControl, image, canonicalRows }),
};
const rest = { snapshot: null, ahe: null, floor: null, floorImage: null, snapshotInventory: null };

function outcome(run: () => unknown): string {
	try {
		run();
		return "detached";
	} catch (error) {
		if (error instanceof CanonicalEncodingError) return `untyped:${error.message}`;
		if (error instanceof TypeError && error.message.startsWith("typed:")) return error.message;
		throw error;
	}
}

describe("a creator's warm source detaches every journal its acquisition charged", () => {
	it("the fixture is a mid-drain journal whose observation carrier fits the one encode cap", () => {
		expect(rowsBytes).toBeGreaterThan(760_000);
		expect(rowsBytes).toBeLessThan(CAP.maxBytes);
		const carrier = compiled.carriers({ journal, ...rest })[0];
		expect(compiled.carrierBytes(carrier), "acquisition charges this carrier under the cap").toBeDefined();
	});

	it("both warm-source captures detach the capture's journal through the one owner", () => {
		expect(body("captureCreatorOrdinaryIssuanceProofSource")).toMatch(/detachClosedCaptureJournal\(capture\.journal\)/u);
		expect(body("prepareCreatorOrdinaryIssuanceProofSourceReadiness")).toMatch(/detachClosedCaptureJournal\(capture\.journal\)/u);
	});

	it("RED: the detach of a journal whose carrier fits is never the codec's untyped byte-limit failure", () => {
		// Today: untyped:canonical value exceeds byte limit (rows plus the whole plan plus its native carrier, about 1.8 MB
		// under the 786,432-byte cap), which escapes the warm source's typed decline and refuses the creator's move.
		expect(outcome(() => compiled.detach(journal))).toMatch(/^(detached|typed:proof-budget-exceeded)$/u);
	});

	it("control: the same journal with no drain detaches", () => {
		const settled = { ...journal, control: baseControl, exactCanonicalControlCarriers: [encodeCanonical(baseControl, WIDE)] };
		delete (settled as { drainSource?: unknown }).drainSource;
		expect(outcome(() => compiled.detach(settled))).toBe("detached");
	});
});
