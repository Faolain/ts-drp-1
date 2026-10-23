import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { journalRetirementFrameDigest } from "@ts-drp/live-journal";
import { describe, expect, it } from "vitest";

// Journal retirement consumes one held completion reader: an own outside source must have
// signed terminal coverage and locally completed immutable policy settlement. The reader's
// original bytes still pass the scope's closed ACL, signature, dependency and native-row checks.
// Received outside rows become collectible after durable successor installation. These tests
// execute the private classifier with authentication premises; the completion owner is exercised
// separately by creator-census-older-source-replacement.test.ts and the native room schedules.
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
	"closedJournalSettledOutsideRows",
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
	/** In place of the one later scope's header: later scopes' headers and rows. */
	laterRows?: readonly Uint8Array[];
	/** The later scopes with a held, authenticated Cut (default: the one later scope). */
	laterAuthorities?: readonly (typeof scope)[];
	maxScopes?: number;
}

async function classify(input: Case = {}) {
	const calls: string[] = [];
	const image = {
		canonicalRows: [
			header(scope, 3, carrier(scope, input.members ?? [digests.creator, digests.member], [memberWitness])),
			received,
			member,
			input.outsideRow ?? outsideLocal,
			...(input.laterRows ?? [
				header(later, 1, carrier(later, input.laterMembers ?? [digests.replacement], input.laterWitnesses ?? [])),
			]),
		],
	};
	const read =
		input.read ??
		(async (request: Record<string, unknown>) => {
			calls.push(`read:${String(request.author).slice(0, 2)}:${String(request.authorSequence)}`);
			return {
				exactCanonicalPreimageBytes: outsidePreimage,
				detachedSignature: signature,
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
		LIVE_JOURNAL_RETIREMENT_LIMITS: { maxScopes: input.maxScopes ?? 7 },
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
			authorities: [
				authority(scope),
				...(input.laterAuthority === false ? [] : (input.laterAuthorities ?? [later]).map(authority)),
			],
			check: async () => {
				calls.push("check");
			},
			...(input.reader === false ? {} : { readSettledLocalSource: read }),
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

describe("journal Done: own outside rows with terminal coverage and local settlement", () => {
	it("collects the exact whole prefix without any later Cut, replacement chain or fence witness", async () => {
		const { prefix, calls } = await classify({ laterRows: [], laterAuthority: false });
		expect(prefix?.highWatermark).toBe(3);
		expect(prefix?.rows.map(row => [row.journalSequence, row.vertexDigest, row.authorSequence])).toEqual([
			[0, digests.creator, 0], [1, digests.member, 4], [2, digests.outside, 5],
		]);
		expect(calls).toEqual(["membership:1", "check", "read:ee:5", "check",
			"signature:01", "signature:02", "signature:03", "check"]);
	});

	it("retains when the owner cannot prove both terminal coverage and exact local settlement", async () => {
		for (const input of [{ reader: false as const }, { read: async () => undefined },
			{ read: async () => { throw new TypeError("close hold unavailable"); } }])
			expect((await classify(input)).prefix).toBeUndefined();
	});

	it("re-verifies the returned original bytes against the exact native digest and closed ACL", async () => {
		await expect(classify({ read: async () => ({ exactCanonicalPreimageBytes: memberPreimage,
			detachedSignature: signature }) })).rejects.toThrow("chain-invalid");
		await expect(classify({ read: async () => ({ exactCanonicalPreimageBytes: Uint8Array.of(1),
			detachedSignature: signature }) })).rejects.toThrow();
	});

	it("keeps application capture exact rather than including locally settled outside rows", async () => {
		const { prefix, calls } = await classify({ capture: true });
		expect(prefix).toBeUndefined();
		expect(calls.some(call => call.startsWith("read:"))).toBe(false);
	});

	it("retains a received outside row until its successor installation is durable", async () => {
		const reads: unknown[] = [];
		const read = async (request: Record<string, unknown>) => { reads.push(request); return undefined; };
		for (const installedThroughEpoch of [undefined, 0, 1])
			expect((await classify({ outsideRow: outsideReceived, read, installedThroughEpoch })).prefix).toBeUndefined();
		const { prefix, calls } = await classify({ outsideRow: outsideReceived, read, installedThroughEpoch: 2 });
		expect(prefix?.highWatermark).toBe(3);
		expect(reads).toEqual([]);
		expect(calls).toEqual(["membership:1", "check", "signature:01", "signature:02", "signature:03", "check"]);
	});

	it("does not confuse signed membership with received-outside classification", async () => {
		const members = [digests.creator, digests.member, digests.outside];
		expect((await classify({ outsideRow: outsideReceived, members })).prefix?.rows.map(row => row.vertexDigest))
			.toEqual(members);
		await expect(classify({ outsideRow: outsideReceived, members: [digests.creator, digests.outside],
			read: async () => ({ exactCanonicalPreimageBytes: memberPreimage, detachedSignature: signature }) }))
			.rejects.toThrow("chain-invalid");
	});
});
