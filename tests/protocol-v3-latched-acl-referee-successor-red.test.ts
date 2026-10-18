import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { activateV3LivePlane } from "../packages/node/src/v3-live.js";

type Group = "admin" | "finality" | "referee" | "writer";

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
	readonly version: 1 | 2;
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

type OpenResult =
	| Readonly<{ ok: false; reason: "malformed-input" | "snapshot-mismatch" }>
	| Readonly<{ ok: true; snapshot: Snapshot }>;

interface Surface {
	authorizeLatchedApplicationWrite(input: Readonly<{ author: string; snapshot: Snapshot }>): AuthorityResult;
	authorizeLatchedEnvelopeAuthor(input: Readonly<{ author: string; snapshot: Snapshot }>): AuthorityResult;
	deriveNextLatchedSignerSet(input: Readonly<{ snapshot: Snapshot }>):
		| Readonly<{ ok: false; reason: "malformed-input" }>
		| Readonly<{
				ok: true;
				signers: readonly Readonly<{ publicKey: string; signerId: string }>[];
		  }>;
	openCanonicalLatchedAclSnapshot(
		input: Readonly<{
			exactCanonicalLatchedAclBytes: Uint8Array;
			expectedAclDigest: string;
			expectedEpoch: number;
			expectedObjectId: string;
		}>
	): OpenResult;
	stageLatchedAclOperations(input: Readonly<{ operations: readonly Operation[]; snapshot: Snapshot }>): StageResult;
}

const surface = (await import("../packages/protocol-v3/src/latched-acl.js")) as unknown as Surface;

const ADMIN = "1".repeat(64);
const REFEREE = "2".repeat(64);
const WRITER = "3".repeat(64);
const CANDIDATE = "4".repeat(64);
const ADMIN_KEY = "a".repeat(64);
const OBJECT_ID = `creator:${"e".repeat(32)}`;

function member(author: string, groups: readonly Group[], finalityKey: string | null = null): Member {
	return Object.freeze({ author, finalityKey, groups: Object.freeze([...groups]) });
}

function snapshot(version: 1 | 2, members: readonly Member[]): Snapshot {
	return Object.freeze({
		epoch: 9,
		kind: "drp-v3-latched-acl",
		members: Object.freeze([...members]),
		objectId: OBJECT_ID,
		permissionless: false,
		version,
	});
}

function aclDigest(bytes: Uint8Array): string {
	return Array.from(hashDomain("ts-drp/latched-acl/v3", bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function open(selected: Snapshot): OpenResult {
	const exactCanonicalLatchedAclBytes = encodeCanonical(selected);
	return surface.openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes,
		expectedAclDigest: aclDigest(exactCanonicalLatchedAclBytes),
		expectedEpoch: selected.epoch,
		expectedObjectId: selected.objectId,
	});
}

function stage(selected: Snapshot, operations: readonly Operation[]): Snapshot {
	const result = surface.stageLatchedAclOperations({ operations, snapshot: selected });
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new TypeError(`latched ACL stage failed: ${result.reason}`);
	return result.next;
}

const V1 = snapshot(1, [member(ADMIN, ["admin", "finality", "writer"], ADMIN_KEY), member(WRITER, ["writer"])]);
const V2 = snapshot(2, [
	member(ADMIN, ["admin", "finality", "writer"], ADMIN_KEY),
	member(REFEREE, ["referee"]),
	member(WRITER, ["writer"]),
]);
const successorReady = open(V2).ok;

describe("E5-02 latched ACL referee-role successor RED", () => {
	it("keeps the version-1 carrier closed over its original three groups", () => {
		expect(open(V1)).toMatchObject({ ok: true, snapshot: V1 });
		expect(open(snapshot(1, [...V1.members, member(CANDIDATE, ["referee"])]))).toEqual({
			ok: false,
			reason: "snapshot-mismatch",
		});
		expect(open(snapshot(1, [member(ADMIN, ["admin", "finality", "referee", "writer"], ADMIN_KEY)]))).toEqual({
			ok: false,
			reason: "snapshot-mismatch",
		});
		expect(
			surface.stageLatchedAclOperations({
				operations: [Object.freeze({ actor: ADMIN, group: "referee", kind: "grant", target: CANDIDATE })],
				snapshot: V1,
			})
		).toEqual({ index: 0, ok: false, reason: "malformed-input" });
		expect(
			stage(V1, [Object.freeze({ actor: ADMIN, group: "writer", kind: "grant", target: CANDIDATE })]).version
		).toBe(1);
	});

	it("has one readiness failure for the unsupported version-2 authenticated carrier", () => {
		expect(successorReady, "GREEN must open the version-2 referee ACL carrier").toBe(true);
	});
});

describe.skipIf(!successorReady)("E5-02 version-2 referee semantics", () => {
	it("admits the canonical version-2 carrier and preserves its version across staging", () => {
		const opened = open(V2);
		expect(opened).toMatchObject({ ok: true, snapshot: V2 });
		if (!opened.ok) return;

		const granted = stage(opened.snapshot, [
			Object.freeze({ actor: ADMIN, group: "referee", kind: "grant", target: CANDIDATE }),
		]);
		expect(granted.version).toBe(2);
		expect(granted.epoch).toBe(V2.epoch + 1);
		expect(granted.members.find(({ author }) => author === CANDIDATE)?.groups).toEqual(["referee"]);

		const revoked = stage(granted, [
			Object.freeze({ actor: ADMIN, group: "referee", kind: "revoke", target: CANDIDATE }),
		]);
		expect(revoked.version).toBe(2);
		expect(revoked.members.find(({ author }) => author === CANDIDATE)).toBeUndefined();
	});

	it("treats a referee as an envelope member but never as an application writer or finality signer", () => {
		expect(surface.authorizeLatchedEnvelopeAuthor({ author: REFEREE, snapshot: V2 })).toEqual({
			authorized: true,
			ok: true,
		});
		expect(surface.authorizeLatchedApplicationWrite({ author: REFEREE, snapshot: V2 })).toEqual({
			authorized: false,
			ok: true,
		});
		expect(surface.deriveNextLatchedSignerSet({ snapshot: V2 })).toEqual({
			ok: true,
			signers: [{ publicKey: ADMIN_KEY, signerId: ADMIN }],
		});
	});

	it("keeps role administration with the latched admin and rejects staged escalation", () => {
		for (const actor of [REFEREE, WRITER]) {
			for (const kind of ["grant", "revoke"] as const) {
				expect(
					surface.stageLatchedAclOperations({
						operations: [Object.freeze({ actor, group: "referee", kind, target: CANDIDATE })],
						snapshot: V2,
					})
				).toEqual({ index: 0, ok: false, reason: "operation-not-authorized" });
			}
		}
		expect(
			surface.stageLatchedAclOperations({
				operations: [
					Object.freeze({ actor: ADMIN, group: "admin", kind: "grant", target: REFEREE }),
					Object.freeze({ actor: REFEREE, group: "writer", kind: "grant", target: REFEREE }),
				],
				snapshot: V2,
			})
		).toEqual({ index: 1, ok: false, reason: "operation-not-authorized" });
	});

	it("requires version-specific canonical group order and finality-key ownership", () => {
		expect(open(snapshot(2, [member(ADMIN, ["admin", "finality", "referee", "writer"], ADMIN_KEY)]))).toMatchObject({
			ok: true,
		});
		for (const groups of [
			["finality", "admin", "referee", "writer"],
			["admin", "referee", "finality", "writer"],
			["admin", "finality", "writer", "referee"],
		] as const) {
			expect(open(snapshot(2, [member(ADMIN, groups, ADMIN_KEY)]))).toEqual({
				ok: false,
				reason: "snapshot-mismatch",
			});
		}
		expect(
			open(
				snapshot(2, [member(ADMIN, ["admin", "finality", "writer"], ADMIN_KEY), member(REFEREE, ["referee"], REFEREE)])
			)
		).toEqual({
			ok: false,
			reason: "snapshot-mismatch",
		});
		expect(
			open(
				snapshot(2, [member(ADMIN, ["admin", "finality", "writer"], ADMIN_KEY), member(REFEREE, ["referee", "writer"])])
			)
		).toMatchObject({
			ok: true,
		});
	});

	it("routes referee grants through the genuine node ACL owner", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
			latchedAclVersion: 2,
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			const recovered = await recover(fixture, fixture.capability);
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:e5-02:referee-successor"),
				onAdmittedVertex: () => undefined,
			});
			if (!activation.ok) throw new TypeError("v2 referee fixture activation failed");
			expect(
				await activation.handle.issueLocal({
					operations: Object.freeze([
						Object.freeze({
							logicalTime: 2,
							operation: Object.freeze({
								action: "acl",
								group: "referee",
								kind: "grant",
								target: CANDIDATE,
							}),
						}),
					]),
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				})
			).toMatchObject({ ok: true });
			const preview = Reflect.get(activation.handle, "previewLatchedAcl");
			expect(typeof preview).toBe("function");
			const value = Reflect.apply(preview as () => unknown, activation.handle, []) as Readonly<{
				readonly next: Snapshot;
			}>;
			expect(value.next.version).toBe(2);
			expect(value.next.members.find(({ author }) => author === CANDIDATE)?.groups).toEqual(["referee"]);
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});
});
