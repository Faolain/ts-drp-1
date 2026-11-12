import * as canonical from "@ts-drp/canonical";
import { expect, it } from "vitest";

import * as codec from "../../live-journal/src/retirement.js";
import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";

// fix/maintenance-image-capacity, sdiag d4/d5 (bx_6ytwadfw, 5-Writer received-refusal case): an admission in epoch E
// reserves the successor fence's horizon (fenceHorizon: the next successor's header and its first fence). After a
// refusal-triggered rollover epoch E+1 holds only its adoption fence, then closes: its header gains that close's
// membership row before the E+2 adoption fence acquires the journal. The horizon left that membership out, so the
// fence's journal carrier went over the encode cap by about one membership row (786,942 and 786,510 / 786,432) and
// the room stopped. The horizon must dominate the same live-journal function chained through closing epoch E+1.

const author = "1".repeat(64);
const parametersDigest = (canonical.decodeCanonical(anchorMaterial(0).bytes) as { parametersDigest: string }).parametersDigest;
type Material = ReturnType<typeof anchorMaterial>;
type Scope = Material["scope"];

const header = (material: Material, next: number, membership: number) => ({
	...material.scope, nextJournalSequence: next, exactCanonicalAnchorPreimageBytes: material.bytes,
	detachedAnchorSignature: material.install.detachedAnchorSignature, parametersDigest,
	exactCanonicalParametersCarrierBytes: material.install.exactCanonicalParametersCarrierBytes,
	...(membership === 0 ? {} : { closedMembershipBytes: new Uint8Array(membership) }),
});
const digestOf = (scope: Scope, ordinal: number) =>
	Buffer.from(canonical.hashDomain("ts-drp/journal-horizon-fixture/v1", canonical.encodeCanonical({ scope, ordinal }))).toString("hex");
const local = (scope: Scope, journalSequence: number, authorSequence: number) => ({
	scope, sourceKind: "local-issued" as const, author, authorSequence, vertexDigest: digestOf(scope, authorSequence) });
const localRow = (scope: Scope, journalSequence: number, authorSequence: number) => ({
	...scope, journalSequence, sourceKind: "local-issued", vertexDigest: digestOf(scope, authorSequence),
	localAuthor: author, localAuthorSequence: authorSequence });
const frame = (table: string, scope: Scope, value: unknown, ordinal?: number) => codec.journalRetirementCanonicalRow(table,
	[scope.objectId, scope.epoch, scope.anchorDigest, ...(ordinal === undefined ? [] : [ordinal])], value);
const install = (material: Material) => ({ objectId: material.scope.objectId,
	exactCanonicalAnchorPreimageBytes: material.bytes,
	exactCanonicalParametersCarrierBytes: material.install.exactCanonicalParametersCarrierBytes });
const phaseBytes = (phase: codec.JournalFutureNativeWidths) => [phase.canonicalRowsBytes, phase.nativeImageBytes];

it("the fence horizon reserved in epoch E covers the E+2 adoption fence after epoch E+1 closes with its fence alone", () => {
	const epoch = 2, rows = 40, membershipE = 9_000, membershipNext = 1_917;
	const current = anchorMaterial(epoch), next = anchorMaterial(epoch + 1), after = anchorMaterial(epoch + 2);
	const e = current.scope, n = next.scope;
	const journal = [frame("scopes", e, header(current, rows, 0)),
		...Array.from({ length: rows }, (_, ordinal) => frame("acceptedEntries", e, localRow(e, ordinal, ordinal), ordinal))];
	// Epoch E's ordinary admission: its move, E's close membership, E+1's header and fence, and the fence horizon.
	const reserved = codec.journalFutureAppendPostimageWidths(journal, local(e, rows, rows), install(next),
		{ author, authorSequence: rows + 1 }, [], { closedMembershipByteLength: membershipE, fenceHorizon: true });
	expect(reserved.fenceHorizon).toBeDefined();
	// The actual journal after E closed and E+1 was adopted, without E+1's fence row: the same function, chained,
	// appends that fence, closes E+1 with its membership and adopts E+2 with its own fence.
	const adopted = [frame("scopes", e, header(current, rows + 1, membershipE)), ...journal.slice(1),
		frame("acceptedEntries", e, localRow(e, rows, rows), rows), frame("scopes", n, header(next, 0, 0))];
	const chained = codec.journalFutureAppendPostimageWidths(adopted, local(n, 0, rows + 1), install(after),
		{ author, authorSequence: rows + 2 }, [], { closedMembershipByteLength: membershipNext });
	const horizon = reserved.fenceHorizon!;
	// afterSuccessor: what the E+2 adoption fence's cold acquisition observes; afterSuccessorLocal adds its row.
	for (const [bound, actual] of [[horizon.afterSuccessor, chained.afterSuccessor], [horizon.afterSuccessorLocal, chained.afterSuccessorLocal!]] as const) {
		const [boundRows, boundImage] = phaseBytes(bound), [actualRows, actualImage] = phaseBytes(actual);
		expect(boundRows, "the horizon's canonical rows dominate the chained journal").toBeGreaterThanOrEqual(actualRows!);
		expect(boundImage, "the horizon's native image dominates the chained journal").toBeGreaterThanOrEqual(actualImage!);
		expect(bound.rowCount).toBeGreaterThanOrEqual(actual.rowCount);
		expect(bound.scopeCount).toBeGreaterThanOrEqual(actual.scopeCount);
	}
});

