import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type Group = "admin" | "finality" | "writer";

interface Member {
	readonly author: string;
	readonly finalityKey: string | null;
	readonly groups: readonly Group[];
}

interface Snapshot {
	readonly epoch: number;
	readonly kind: "drp-v3-latched-acl";
	readonly members: readonly Member[];
	readonly objectId: string;
	readonly permissionless: boolean;
	readonly version: 1;
}

type Operation =
	| Readonly<{ actor: string; group: Group; kind: "grant" | "revoke"; target: string }>
	| Readonly<{ actor: string; finalityKey: string; kind: "set-finality-key" }>;

type AuthorityResult = Readonly<{ ok: false; reason: "malformed-input" }> | Readonly<{ authorized: boolean; ok: true }>;

type StageResult =
	| Readonly<{
			index: number;
			ok: false;
			reason: "last-admin" | "malformed-input" | "operation-invalid" | "operation-not-authorized";
	  }>
	| Readonly<{ next: Snapshot; ok: true }>;

type SignerResult =
	| Readonly<{ ok: false; reason: "malformed-input" }>
	| Readonly<{ ok: true; signers: readonly Readonly<{ publicKey: string; signerId: string }>[] }>;

interface Surface {
	authorizeLatchedApplicationWrite(input: Readonly<{ author: string; snapshot: Snapshot }>): AuthorityResult;
	authorizeLatchedEnvelopeAuthor(input: Readonly<{ author: string; snapshot: Snapshot }>): AuthorityResult;
	deriveNextLatchedSignerSet(input: Readonly<{ snapshot: Snapshot }>): SignerResult;
	stageLatchedAclOperations(input: Readonly<{ operations: readonly Operation[]; snapshot: Snapshot }>): StageResult;
}

const SOURCE = resolve("packages/protocol-v3/src/latched-acl.ts");
const ABSENT: Surface = Object.freeze({
	authorizeLatchedApplicationWrite: () => ({ ok: false, reason: "malformed-input" }),
	authorizeLatchedEnvelopeAuthor: () => ({ ok: false, reason: "malformed-input" }),
	deriveNextLatchedSignerSet: () => ({ ok: false, reason: "malformed-input" }),
	stageLatchedAclOperations: () => ({ index: 0, ok: false, reason: "malformed-input" }),
});

const surface: Surface = existsSync(SOURCE)
	? ((await import(`${pathToFileURL(SOURCE).href}?d933d=${Date.now()}`)) as unknown as Surface)
	: ABSENT;

const ALICE = "1".repeat(64);
const BOB = "2".repeat(64);
const CAROL = "3".repeat(64);
const DAVE = "4".repeat(64);
const ALICE_KEY = "a".repeat(64);
const CAROL_KEY = "c".repeat(64);
const ROTATED_KEY = "d".repeat(64);

function member(author: string, groups: readonly Group[], finalityKey: string | null = null): Member {
	return Object.freeze({ author, finalityKey, groups: Object.freeze([...groups]) });
}

function snapshot(
	members: readonly Member[] = [
		member(ALICE, ["admin", "finality", "writer"], ALICE_KEY),
		member(BOB, ["writer"]),
		member(CAROL, ["finality"], CAROL_KEY),
	]
): Snapshot {
	return Object.freeze({
		epoch: 7,
		kind: "drp-v3-latched-acl",
		members: Object.freeze([...members]),
		objectId: `creator:${"e".repeat(32)}`,
		permissionless: false,
		version: 1,
	});
}

function grant(actor: string, target: string, group: Group): Operation {
	return Object.freeze({ actor, group, kind: "grant", target });
}

function revoke(actor: string, target: string, group: Group): Operation {
	return Object.freeze({ actor, group, kind: "revoke", target });
}

function stage(selected: Snapshot, operations: readonly Operation[]): Snapshot {
	const result = surface.stageLatchedAclOperations({ operations, snapshot: selected });
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new TypeError(`latched ACL stage failed: ${result.reason}`);
	return result.next;
}

function selectedMember(selected: Snapshot, author: string): Member | undefined {
	return selected.members.find((candidate) => candidate.author === author);
}

describe("Phase 3d pure latched ACL semantics RED", () => {
	it("ships one explicit protocol-v3 subpath without widening the package root", () => {
		const manifest = JSON.parse(readFileSync("packages/protocol-v3/package.json", "utf8")) as {
			exports?: Record<string, unknown>;
		};
		expect(manifest.exports?.["./latched-acl"]).toEqual({
			import: "./dist/src/latched-acl.js",
			types: "./dist/src/latched-acl.d.ts",
		});
		expect(Object.keys(manifest.exports ?? {})).not.toContain("./latched-acl/testing");
	});

	it("keeps current authority latched while independent Writer grant and Finality revoke both stage", () => {
		const current = snapshot();
		expect(surface.authorizeLatchedEnvelopeAuthor({ author: DAVE, snapshot: current })).toEqual({
			authorized: false,
			ok: true,
		});
		expect(surface.authorizeLatchedApplicationWrite({ author: DAVE, snapshot: current })).toEqual({
			authorized: false,
			ok: true,
		});

		const forward = stage(current, [grant(ALICE, DAVE, "writer"), revoke(ALICE, CAROL, "finality")]);
		const reverse = stage(current, [revoke(ALICE, CAROL, "finality"), grant(ALICE, DAVE, "writer")]);
		expect(reverse).toEqual(forward);
		expect(forward.epoch).toBe(8);
		expect(selectedMember(forward, DAVE)?.groups).toEqual(["writer"]);
		expect(selectedMember(forward, CAROL)).toBeUndefined();
		expect(surface.authorizeLatchedEnvelopeAuthor({ author: DAVE, snapshot: current })).toEqual({
			authorized: false,
			ok: true,
		});
		expect(surface.authorizeLatchedApplicationWrite({ author: DAVE, snapshot: forward })).toEqual({
			authorized: true,
			ok: true,
		});
		expect(surface.deriveNextLatchedSignerSet({ snapshot: forward })).toEqual({
			ok: true,
			signers: [{ publicKey: ALICE_KEY, signerId: ALICE }],
		});
	});

	it("uses revoke-wins only for the same target and group", () => {
		const current = snapshot();
		const forward = stage(current, [grant(ALICE, BOB, "finality"), revoke(ALICE, BOB, "finality")]);
		const reverse = stage(current, [revoke(ALICE, BOB, "finality"), grant(ALICE, BOB, "finality")]);
		expect(reverse).toEqual(forward);
		expect(selectedMember(forward, BOB)?.groups).toEqual(["writer"]);
		expect(selectedMember(forward, CAROL)?.groups).toEqual(["finality"]);
	});

	it("permits an admin handoff across epochs but not staged-authority escalation or last-admin removal", () => {
		const current = snapshot();
		const handedOff = stage(current, [grant(ALICE, BOB, "admin")]);
		expect(selectedMember(handedOff, ALICE)?.groups).toContain("admin");
		expect(selectedMember(handedOff, BOB)?.groups).toEqual(["admin", "writer"]);
		const removed = stage(handedOff, [revoke(BOB, ALICE, "admin")]);
		expect(selectedMember(removed, ALICE)?.groups).toEqual(["finality", "writer"]);
		expect(selectedMember(removed, BOB)?.groups).toContain("admin");

		expect(
			surface.stageLatchedAclOperations({
				operations: [grant(ALICE, BOB, "admin"), grant(BOB, DAVE, "writer")],
				snapshot: current,
			})
		).toEqual({ index: 1, ok: false, reason: "operation-not-authorized" });
		expect(
			surface.stageLatchedAclOperations({ operations: [revoke(ALICE, ALICE, "admin")], snapshot: current })
		).toEqual({ index: 0, ok: false, reason: "last-admin" });
	});

	it("rotates a finality key only for a latched Finality member and derives a sorted signer set", () => {
		const current = snapshot();
		const rotated = stage(current, [
			Object.freeze({ actor: CAROL, finalityKey: ROTATED_KEY, kind: "set-finality-key" }),
		]);
		expect(surface.deriveNextLatchedSignerSet({ snapshot: rotated })).toEqual({
			ok: true,
			signers: [
				{ publicKey: ALICE_KEY, signerId: ALICE },
				{ publicKey: ROTATED_KEY, signerId: CAROL },
			],
		});
		expect(
			surface.stageLatchedAclOperations({
				operations: [Object.freeze({ actor: BOB, finalityKey: ROTATED_KEY, kind: "set-finality-key" })],
				snapshot: current,
			})
		).toEqual({ index: 0, ok: false, reason: "operation-not-authorized" });
	});

	it("fails closed for malformed, mixed, unsorted, duplicate, and caller-mutated evidence", () => {
		const current = snapshot();
		const malformedSnapshots: unknown[] = [
			{ ...current, extra: true },
			{ ...current, epoch: -1 },
			{ ...current, members: [...current.members].reverse() },
			{ ...current, members: [...current.members, current.members[0]] },
			{ ...current, members: [{ ...current.members[0], groups: ["writer", "admin"] }] },
		];
		for (const malformed of malformedSnapshots) {
			expect(surface.authorizeLatchedEnvelopeAuthor({ author: ALICE, snapshot: malformed as Snapshot })).toEqual({
				ok: false,
				reason: "malformed-input",
			});
		}
		const mutableOperations: Operation[] = [grant(ALICE, DAVE, "writer")];
		const result = surface.stageLatchedAclOperations({ operations: mutableOperations, snapshot: current });
		mutableOperations[0] = revoke(ALICE, DAVE, "writer");
		expect(result).toMatchObject({ ok: true });
		if (result.ok) expect(selectedMember(result.next, DAVE)?.groups).toEqual(["writer"]);
	});
});
