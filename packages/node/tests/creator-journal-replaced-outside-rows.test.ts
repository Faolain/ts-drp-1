import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { journalRetirementFrameDigest } from "@ts-drp/live-journal";
import { describe, expect, it } from "vitest";

// Track X, decision row 60 (R5, owner's option A): a journal scope whose rows are exactly its
// signed Cut's membership plus local-issued rows outside the Cut is collectible only when each
// outside row is a source this author replaced (the held lifetime's reader returns its facts),
// and every replacement digest is a member of a later scope's signed Cut. R5b (owner's B2): a
// received row outside the Cut is collectible once this peer's durable room-head floor, with
// nothing pending, is past the scope's epoch (it has durably installed the Cut's successor). This executes the
// private production membership classifier on DATA with controlled premises, as
// creator-journal-classification-compound.test.ts does: Cut, membership-carrier, ACL and
// signature openers are premises here; the reader's own checks (plan entry, derivation) are
// exercised by the room tests (tests/track-x-replaced-source-journal-*.test.ts).
const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found: ts.FunctionDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	if (found.length !== 1) throw Error(`PRIVATE_FUNCTION_NOT_UNIQUE:${name}:${found.length}`);
	return found[0]!.getText(parsed);
}
const classifierCode = [
	"closedJournalMembershipPrefix",
	"prepareClosedJournalMembershipPrefix",
	"closedJournalReplacedOutsideRows",
]
	.map(declaration)
	.join("\n");
const compareBytes = (a: Uint8Array, b: Uint8Array): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const equal = (a: unknown, b: unknown): boolean => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0;
const hexBytes = (value: string): Uint8Array =>
	Uint8Array.from(value.match(/../gu)!, (pair) => Number.parseInt(pair, 16));

const objectId = "room";
const scope = { objectId, epoch: 1, anchorDigest: "a1".repeat(32) };
const later = { objectId, epoch: 2, anchorDigest: "a2".repeat(32) };
const creator = "cc".repeat(32);
const writer = "ee".repeat(32);
const digests = {
	creator: "01".repeat(32),
	member: "02".repeat(32),
	outside: "03".repeat(32),
	replacement: "04".repeat(32),
};

const preimage = (author: string, authorSequence: number, dependencies: readonly string[], at = scope): Uint8Array =>
	encodeCanonical({ objectId, epoch: at.epoch, anchor: at.anchorDigest, author, authorSequence, dependencies });
const creatorPreimage = preimage(creator, 0, [scope.anchorDigest]);
const memberPreimage = preimage(writer, 4, [digests.creator]);
const outsidePreimage = preimage(writer, 5, [digests.member]);
const signature = new Uint8Array(64).fill(9);
const digestOf = new Map([
	[Buffer.from(creatorPreimage).toString("hex"), digests.creator],
	[Buffer.from(memberPreimage).toString("hex"), digests.member],
	[Buffer.from(outsidePreimage).toString("hex"), digests.outside],
]);

const carrier = (at: typeof scope, members: readonly string[], witnesses: readonly Record<string, unknown>[]) =>
	encodeCanonical({
		scope: at,
		exactCanonicalLatchedAclBytes: Uint8Array.of(1),
		orderedVertexDigests: members.map(hexBytes),
		localVertexWitnesses: witnesses,
	});
const memberWitness = {
	vertexDigest: digests.member,
	exactCanonicalPreimageBytes: memberPreimage,
	detachedSignature: signature,
};
const header = (at: typeof scope, next: number, bytes?: Uint8Array) =>
	encodeCanonical([
		"scopes",
		[objectId, at.epoch, at.anchorDigest],
		{ next_journal_sequence: next, ...(bytes === undefined ? {} : { closed_membership_bytes: bytes }) },
	]);
const entry = (ordinal: number, row: Record<string, unknown>) =>
	encodeCanonical(["accepted_entries", [objectId, scope.epoch, scope.anchorDigest, ordinal], row]);
const received = entry(0, {
	vertex_digest: digests.creator,
	source_kind: "received",
	received_preimage: creatorPreimage,
	received_signature: signature,
});
const member = entry(1, {
	vertex_digest: digests.member,
	source_kind: "local-issued",
	local_author: writer,
	local_author_sequence: 4,
});
const outsideLocal = entry(2, {
	vertex_digest: digests.outside,
	source_kind: "local-issued",
	local_author: writer,
	local_author_sequence: 5,
});
const outsideReceived = entry(2, {
	vertex_digest: digests.outside,
	source_kind: "received",
	received_preimage: outsidePreimage,
	received_signature: signature,
});
const authority = (at: typeof scope) => ({
	scope: at,
	exactCanonicalCutValueBytes: encodeCanonical({ parameters: { maxEpochVertices: 8 }, epoch: at.epoch }),
	closedAclDigest: "acl",
	profileId: "creator-trusted-settlement-v1",
	suiteId: "suite",
});

interface Case {
	outsideRow?: Uint8Array;
	laterMembers?: readonly string[];
	laterAuthority?: boolean;
	read?: (request: Record<string, unknown>) => Promise<unknown>;
	reader?: false;
	capture?: boolean;
	installedThroughEpoch?: number;
	members?: readonly string[];
	laterWitnesses?: readonly Record<string, unknown>[];
}

async function classify(input: Case = {}) {
	const calls: string[] = [];
	const image = {
		canonicalRows: [
			header(scope, 3, carrier(scope, input.members ?? [digests.creator, digests.member], [memberWitness])),
			received,
			member,
			input.outsideRow ?? outsideLocal,
			header(later, 1, carrier(later, input.laterMembers ?? [digests.replacement], input.laterWitnesses ?? [])),
		],
	};
	const read =
		input.read ??
		(async (request: Record<string, unknown>) => {
			calls.push(`read:${String(request.author).slice(0, 2)}:${String(request.authorSequence)}`);
			return {
				exactCanonicalPreimageBytes: outsidePreimage,
				detachedSignature: signature,
				replacementVertexDigests: [digests.replacement],
			};
		});
	const context = {
		decodeCanonical,
		encodeCanonical,
		compareBytes,
		record: decodeCanonical,
		closedRetirementEqual: equal,
		closedRetirementHex: hexBytes,
		journalRetirementFrameDigest,
		requireLaw: (ok: unknown, reason = "chain-invalid") => {
			if (!ok) throw Error(reason);
		},
		registry: {
			cryptoSuites: { active: [{ role: "identityAndVertex", suiteId: "suite" }] },
			kinds: { vertex: { domain: "vertex" } },
			domains: { vertex: "vertex" },
		},
		openCreatorCloseMembership: async ({ bytes }: { bytes: Uint8Array }) => {
			const opened = decodeCanonical(bytes) as Record<string, unknown>;
			calls.push(`membership:${String((opened.scope as { epoch: number }).epoch)}`);
			return opened;
		},
		openCanonicalLatchedAclSnapshot: () => ({ ok: true, snapshot: {} }),
		authorizeLatchedEnvelopeAuthor: () => ({ ok: true, authorized: true }),
		verifyReceivedVertex: (value: { receivedCanonicalPreimageBytes: Uint8Array }) => {
			const digest = digestOf.get(Buffer.from(value.receivedCanonicalPreimageBytes).toString("hex"));
			calls.push(`signature:${digest?.slice(0, 2) ?? "unknown"}`);
			return digest === undefined ? { accepted: false } : { accepted: true, digest: hexBytes(digest) };
		},
		data: {
			scope,
			image,
			authorities: [authority(scope), ...(input.laterAuthority === false ? [] : [authority(later)])],
			check: async () => {
				calls.push("check");
			},
			...(input.reader === false ? {} : { readReplacedLocalSource: read }),
			...(input.capture === true ? { captureApplicationRows: () => calls.push("capture") } : {}),
			...(input.installedThroughEpoch === undefined
				? {}
				: { installedThroughEpoch: () => input.installedThroughEpoch }),
		},
	};
	const js = ts.transpileModule(`${classifierCode} closedJournalMembershipPrefix(data);`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	const prefix = (await Function(
		...Object.keys(context),
		`"use strict";return eval(${JSON.stringify(js)});`
	)(...Object.values(context))) as { highWatermark: number; rows: readonly Record<string, unknown>[] } | undefined;
	return { prefix, calls };
}

describe("R5: a journal scope with this author's replaced moves outside its signed Cut", () => {
	it("is collectible, whole, when the outside row's replacement is in a later signed Cut", async () => {
		const { prefix, calls } = await classify();
		expect(prefix?.highWatermark).toBe(3);
		expect(prefix?.rows.map((row) => [row.journalSequence, row.vertexDigest, row.authorSequence])).toEqual([
			[0, digests.creator, 0],
			[1, digests.member, 4],
			[2, digests.outside, 5],
		]);
		// The source is read from the held owner, its replacement found in the later Cut, and the
		// outside row's original bytes verified against this scope's closed ACL like every member.
		expect(calls).toEqual([
			"membership:1",
			"check",
			"read:ee:5",
			"membership:2",
			"check",
			"signature:01",
			"signature:02",
			"signature:03",
			"check",
		]);
	});

	it("(a) stays retained while the replacement is not a member of a later signed Cut", async () => {
		expect((await classify({ laterMembers: ["05".repeat(32)] })).prefix).toBeUndefined();
		// A later scope's carrier without its held, authenticated Cut is no evidence either.
		expect((await classify({ laterAuthority: false })).prefix).toBeUndefined();
	});

	it("(b, d) stays retained when the held reader does not return a replaced source", async () => {
		// The reader returns nothing unless this author's own plan entry names a completed
		// replacement whose operations equal the source's derivation by the immutable policy.
		const { prefix, calls } = await classify({ read: async () => undefined });
		expect(prefix).toBeUndefined();
		expect(calls).not.toContain("signature:03");
		const refused = await classify({
			read: async () => {
				throw new TypeError("creator recovery close hold is unavailable");
			},
		});
		expect(refused.prefix).toBeUndefined();
	});

	// R5b (owner's B2) changed this case. Under option A a received row outside the Cut always
	// retained its scope; now it does until this peer's successor install is durable.
	it("(c, B2) keeps a received row outside the Cut until this peer has durably installed the successor", async () => {
		const reads: unknown[] = [];
		const read = async (request: Record<string, unknown>) => {
			reads.push(request);
			return undefined;
		};
		// (a) No durable floor past the scope (none supplied, the scope's own epoch, or pending,
		// which the caller supplies as none): retained.
		expect((await classify({ outsideRow: outsideReceived, read })).prefix).toBeUndefined();
		expect((await classify({ outsideRow: outsideReceived, read, installedThroughEpoch: 1 })).prefix).toBeUndefined();
		const { prefix, calls } = await classify({ outsideRow: outsideReceived, read, installedThroughEpoch: 2 });
		expect(prefix?.highWatermark).toBe(3);
		expect(prefix?.rows.map((row) => [row.journalSequence, row.vertexDigest, row.authorSequence])).toEqual([
			[0, digests.creator, 0],
			[1, digests.member, 4],
			[2, digests.outside, 5],
		]);
		// No replaced-source read: its own received bytes are authenticated like every member's.
		expect(reads).toEqual([]);
		expect(calls).toEqual(["membership:1", "check", "signature:01", "signature:02", "signature:03", "check"]);
		// An application-row capture keeps the original exact classifier.
		expect(
			(await classify({ outsideRow: outsideReceived, read, installedThroughEpoch: 2, capture: true })).prefix
		).toBeUndefined();
	});

	it("(b, B2) treats a received row that the Cut contains as a member, never as outside", async () => {
		const members = [digests.creator, digests.member, digests.outside];
		// A member: collectible with no durable install, and a member of the Cut may not depend on a
		// row outside it.
		const { prefix } = await classify({ outsideRow: outsideReceived, members });
		expect(prefix?.rows.map((row) => row.vertexDigest)).toEqual([digests.creator, digests.member, digests.outside]);
		// A Cut that holds the received row but not the local row it depends on: that local row is
		// a replaced source outside the Cut, and the received member depending on it is refused.
		await expect(
			classify({
				outsideRow: outsideReceived,
				members: [digests.creator, digests.outside],
				read: async () => ({
					exactCanonicalPreimageBytes: memberPreimage,
					detachedSignature: signature,
					replacementVertexDigests: [digests.replacement],
				}),
			})
		).rejects.toThrow("chain-invalid");
	});

	it("keeps the original classifier exact without a held reader or for an application-row capture", async () => {
		expect((await classify({ reader: false })).prefix).toBeUndefined();
		const { prefix, calls } = await classify({ capture: true });
		expect(prefix).toBeUndefined();
		expect(calls.some((call) => call.startsWith("read:"))).toBe(false);
	});
});

// R7 (owner's rule): an outside own settlement fence is collectible once a later own fence by the
// same Writer is a member of a signed Cut this Writer knows.
const fencePreimage = (author: string, authorSequence: number, at = scope): Uint8Array =>
	encodeCanonical({
		objectId,
		epoch: at.epoch,
		anchor: at.anchorDigest,
		author,
		authorSequence,
		dependencies: [at.anchorDigest],
		operation: { action: "$drp.author-fence.v1", fenceSequence: authorSequence, version: 1 },
	});
const otherWriter = "dd".repeat(32);
const fences = {
	outside: { digest: "06".repeat(32), bytes: fencePreimage(writer, 5) },
	later: { digest: "07".repeat(32), bytes: fencePreimage(writer, 7, later) },
	otherLater: { digest: "08".repeat(32), bytes: fencePreimage(otherWriter, 7, later) },
	received: { digest: "09".repeat(32), bytes: fencePreimage(otherWriter, 3) },
	lowerLater: { digest: "0a".repeat(32), bytes: fencePreimage(writer, 4, later) },
	laterMove: { digest: "0b".repeat(32), bytes: preimage(writer, 7, [later.anchorDigest], later) },
};
for (const fence of Object.values(fences)) digestOf.set(Buffer.from(fence.bytes).toString("hex"), fence.digest);
const outsideFence = entry(2, {
	vertex_digest: fences.outside.digest,
	source_kind: "local-issued",
	local_author: writer,
	local_author_sequence: 5,
});
const receivedFence = entry(2, {
	vertex_digest: fences.received.digest,
	source_kind: "received",
	received_preimage: fences.received.bytes,
	received_signature: signature,
});
const witness = (fence: { digest: string; bytes: Uint8Array }) => ({
	vertexDigest: fence.digest,
	exactCanonicalPreimageBytes: fence.bytes,
	detachedSignature: signature,
});
/** The held reader: this author's issued fences by sequence, marked as fences. */
const fenceReader =
	(
		reads: string[],
		issued: ReadonlyMap<number, Uint8Array> = new Map([
			[5, fences.outside.bytes],
			[7, fences.later.bytes],
		])
	) =>
	async (request: Record<string, unknown>) => {
		reads.push(`read:${String(request.authorSequence)}`);
		const bytes = issued.get(Number(request.authorSequence));
		return bytes === undefined
			? undefined
			: {
					exactCanonicalPreimageBytes: bytes,
					detachedSignature: signature,
					replacementVertexDigests: [],
					authorFence: true,
				};
	};
const laterFenceInCut = { laterMembers: [fences.later.digest], laterWitnesses: [witness(fences.later)] };

describe("R7: a journal scope with this author's own settlement fence outside its signed Cut", () => {
	it("is collectible, whole, once a later own fence is a member of a later signed Cut", async () => {
		const reads: string[] = [];
		const { prefix, calls } = await classify({
			outsideRow: outsideFence,
			read: fenceReader(reads),
			...laterFenceInCut,
		});
		expect(prefix?.highWatermark).toBe(3);
		expect(prefix?.rows.map((row) => [row.journalSequence, row.vertexDigest, row.authorSequence])).toEqual([
			[0, digests.creator, 0],
			[1, digests.member, 4],
			[2, fences.outside.digest, 5],
		]);
		// The outside fence and the later fence are both read from the held owner; the outside
		// fence's original bytes are verified against this scope's closed ACL like every member.
		expect(reads).toEqual(["read:5", "read:7"]);
		expect(calls).toContain("signature:06");
	});

	it("stays retained while no later own fence is a member of a signed Cut", async () => {
		const retained = async (input: Case) => (await classify({ outsideRow: outsideFence, ...input })).prefix;
		const reads: string[] = [];
		// No later fence at all.
		expect(await retained({ read: fenceReader(reads) })).toBeUndefined();
		// The later fence missed its own Cut too: it is not a member, even with a witness for it.
		expect(
			await retained({
				read: fenceReader(reads),
				laterMembers: [digests.replacement],
				laterWitnesses: [witness(fences.later)],
			})
		).toBeUndefined();
		// A later scope's carrier without its held, authenticated Cut is no evidence.
		expect(await retained({ read: fenceReader(reads), ...laterFenceInCut, laterAuthority: false })).toBeUndefined();
		// The held reader does not confirm the later fence as this author's issued fence.
		expect(
			await retained({ read: fenceReader(reads, new Map([[5, fences.outside.bytes]])), ...laterFenceInCut })
		).toBeUndefined();
		// A later own member at a lower sequence, or one that is a move rather than a fence.
		for (const other of [fences.lowerLater, fences.laterMove])
			expect(
				await retained({
					read: fenceReader(
						reads,
						new Map([
							[5, fences.outside.bytes],
							[4, fences.lowerLater.bytes],
							[7, other.bytes],
						])
					),
					laterMembers: [other.digest],
					laterWitnesses: [witness(other)],
				})
			).toBeUndefined();
		// The outside row's own facts are not exactly a fence at its sequence, or name a replacement.
		const notFence = async () => ({
			exactCanonicalPreimageBytes: outsidePreimage,
			detachedSignature: signature,
			replacementVertexDigests: [],
			authorFence: true,
		});
		expect(await retained({ read: notFence, ...laterFenceInCut })).toBeUndefined();
		const named = async (request: Record<string, unknown>) => ({
			...(await fenceReader([])(request)),
			replacementVertexDigests: [fences.later.digest],
		});
		expect(await retained({ read: named, ...laterFenceInCut })).toBeUndefined();
		// No held reader.
		expect(await retained({ reader: false, ...laterFenceInCut })).toBeUndefined();
	});

	it("never collects another author's fence by this rule", async () => {
		const reads: string[] = [];
		// The only later fence in a signed Cut is another author's.
		expect(
			(
				await classify({
					outsideRow: outsideFence,
					read: fenceReader(
						reads,
						new Map([
							[5, fences.outside.bytes],
							[7, fences.otherLater.bytes],
						])
					),
					laterMembers: [fences.otherLater.digest],
					laterWitnesses: [witness(fences.otherLater)],
				})
			).prefix
		).toBeUndefined();
		// Another author's fence outside the Cut is a received row: a later own fence in a signed Cut
		// does not collect it, and the reader is never consulted. Only R5b's rule (this peer's
		// successor install durable) does.
		const receivedReads: string[] = [];
		expect(
			(await classify({ outsideRow: receivedFence, read: fenceReader(receivedReads), ...laterFenceInCut })).prefix
		).toBeUndefined();
		const { prefix } = await classify({
			outsideRow: receivedFence,
			read: fenceReader(receivedReads),
			...laterFenceInCut,
			installedThroughEpoch: 2,
		});
		expect(prefix?.rows.map((row) => row.vertexDigest)).toEqual([
			digests.creator,
			digests.member,
			fences.received.digest,
		]);
		expect(receivedReads).toEqual([]);
	});
});
