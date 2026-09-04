import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	authorizeLatchedApplicationWrite,
	openCanonicalLatchedAclSnapshot,
	stageLatchedAclOperations,
	type LatchedAclGroup,
	type LatchedAclMember,
	type LatchedAclOperation,
	type LatchedAclSnapshot,
} from "@ts-drp/protocol-v3/latched-acl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export const W0_VERTEX_SAMPLE_COUNT = 8_192;
export const W0_LEGACY_ACL_MAX_CANONICAL_BYTES = 8_192;

const KNOWN_PARAMETER_FIELDS = new Set([
	"maxDependencies",
	"maxEpochBytes",
	"maxEpochVertices",
	"maxPendingBytes",
	"maxPendingEntries",
	"maxSnapshotBytes",
	"snapshotChunkBytes",
]);

function author(index: number): string {
	return (index + 1).toString(16).padStart(64, "0");
}

function fullMember(index: number): LatchedAclMember {
	const identity = author(index);
	return Object.freeze({
		author: identity,
		finalityKey: identity,
		groups: Object.freeze(["admin", "finality", "referee", "writer"] as const),
	});
}

function digest(bytes: Uint8Array): string {
	return Array.from(hashDomain("ts-drp/latched-acl/v3", bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openSnapshot(snapshot: LatchedAclSnapshot): ReturnType<typeof openCanonicalLatchedAclSnapshot> {
	const bytes = encodeCanonical(snapshot);
	return openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes: bytes,
		expectedAclDigest: digest(bytes),
		expectedEpoch: snapshot.epoch,
		expectedObjectId: snapshot.objectId,
	});
}

function genesisSnapshot(permissionless = false): LatchedAclSnapshot {
	return Object.freeze({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: Object.freeze([fullMember(0)]),
		objectId: `creator:${"1".repeat(32)}`,
		permissionless,
		version: 2,
	});
}

/**
 * Measures one exact full-member legacy version-2 ACL snapshot.
 * @param memberCount - Boundary member count.
 * @returns Exact canonical byte length and legacy-ceiling disposition.
 */
export function encodedAclBoundary(memberCount: 31 | 64 | 65): Readonly<{
	readonly byteLength: number;
	readonly fitsLegacyCeiling: boolean;
}> {
	const snapshot: LatchedAclSnapshot = Object.freeze({
		...genesisSnapshot(),
		members: Object.freeze(Array.from({ length: memberCount }, (_, index) => fullMember(index))),
	});
	const byteLength = encodeCanonical(snapshot).byteLength;
	return Object.freeze({ byteLength, fitsLegacyCeiling: byteLength <= W0_LEGACY_ACL_MAX_CANONICAL_BYTES });
}

export function stageOpenBoundary(memberCount: 31 | 64 | 65): Readonly<{
	readonly openOk: boolean;
	readonly stageOk: boolean;
}> {
	const genesis = genesisSnapshot();
	const grants: LatchedAclOperation[] = [];
	for (let index = 1; index < memberCount; index += 1) {
		for (const group of ["admin", "finality", "referee", "writer"] as const) {
			grants.push(Object.freeze({ actor: genesis.members[0]!.author, group, kind: "grant", target: author(index) }));
		}
	}
	const granted = stageLatchedAclOperations({ operations: Object.freeze(grants), snapshot: genesis });
	if (!granted.ok) return Object.freeze({ openOk: false, stageOk: false });
	if (memberCount === 65) {
		return Object.freeze({ openOk: openSnapshot(granted.next).ok, stageOk: true });
	}
	const keyOperations = granted.next.members
		.slice(1)
		.map(
			(member): LatchedAclOperation =>
				Object.freeze({ actor: member.author, finalityKey: member.author, kind: "set-finality-key" })
		);
	const keyed = stageLatchedAclOperations({ operations: Object.freeze(keyOperations), snapshot: granted.next });
	if (!keyed.ok) return Object.freeze({ openOk: false, stageOk: false });
	return Object.freeze({ openOk: openSnapshot(keyed.next).ok, stageOk: true });
}

function lookupSnapshot(permissionless: boolean): LatchedAclSnapshot {
	const members: LatchedAclMember[] = [];
	for (let index = 0; index < 20; index += 1) {
		const groups: readonly LatchedAclGroup[] =
			index === 0 ? Object.freeze(["admin"]) : index % 2 === 0 ? Object.freeze(["writer"]) : Object.freeze(["referee"]);
		members.push(Object.freeze({ author: author(index), finalityKey: null, groups }));
	}
	const candidate: LatchedAclSnapshot = Object.freeze({
		epoch: 7,
		kind: "drp-v3-latched-acl",
		members: Object.freeze(members),
		objectId: `creator:${"2".repeat(32)}`,
		permissionless,
		version: 2,
	});
	const opened = openSnapshot(candidate);
	if (!opened.ok) throw new TypeError("D110C_0C1K_W0_LOOKUP_FIXTURE_REJECTED");
	return opened.snapshot;
}

export function measureMembershipLookups(): Readonly<{
	readonly decisionsMatch: boolean;
	readonly memberIterationsAfterOpen: number;
}> {
	const snapshots = [lookupSnapshot(false), lookupSnapshot(true)] as const;
	const tracked = new WeakSet<object>(snapshots.map((snapshot) => snapshot.members));
	const original = Array.prototype[Symbol.iterator];
	let memberIterationsAfterOpen = 0;
	let decisionsMatch = true;
	Object.defineProperty(Array.prototype, Symbol.iterator, {
		configurable: true,
		value: function (this: unknown[]): ArrayIterator<unknown> {
			if (tracked.has(this)) memberIterationsAfterOpen += 1;
			return Reflect.apply(original, this, []) as ArrayIterator<unknown>;
		},
		writable: true,
	});
	try {
		for (const snapshot of snapshots) {
			for (let vertex = 0; vertex < W0_VERTEX_SAMPLE_COUNT; vertex += 1) {
				const selectedAuthor =
					vertex % 23 < snapshot.members.length ? snapshot.members[vertex % 23]!.author : author(100);
				const member = snapshot.members.find(({ author: candidate }) => candidate === selectedAuthor);
				const expected = member !== undefined && (snapshot.permissionless || member.groups.includes("writer"));
				const actual = authorizeLatchedApplicationWrite({ author: selectedAuthor, snapshot });
				if (!actual.ok || actual.authorized !== expected) decisionsMatch = false;
			}
		}
	} finally {
		Object.defineProperty(Array.prototype, Symbol.iterator, {
			configurable: true,
			value: original,
			writable: true,
		});
	}
	return Object.freeze({ decisionsMatch, memberIterationsAfterOpen });
}

export function source(relative: string): string {
	return readFileSync(resolve(relative), "utf8");
}

export function silentCreatorCloseOversizeSites(): readonly string[] {
	const creatorClose = source("packages/node/src/creator-close.ts");
	const sites: string[] = [];
	if (/ref\.byteLength\s*>\s*SCANNABLE_BYTES\s*\)\s*continue/u.test(creatorClose)) sites.push("current-head-continue");
	if (/\.filter\s*\(\s*\(\{\s*ref\s*\}\)\s*=>\s*ref\.byteLength\s*<=\s*SCANNABLE_BYTES\s*\)/u.test(creatorClose)) {
		sites.push("proposed-head-filter");
	}
	return Object.freeze(sites);
}

export interface CapacitySourceAudit {
	readonly capacityBody: string;
	readonly capacityCalls: readonly string[];
	readonly newParameterNames: readonly string[];
	readonly parameterName: string | undefined;
	readonly parameterValueIsDefaultedByBuilders: boolean;
}

export function auditPerAuthorCapacitySource(): CapacitySourceAudit {
	const live = source("packages/node/src/v3-live.ts");
	const tree = ts.createSourceFile("v3-live.ts", live, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let capacityBody = "";
	const capacityCalls: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === "hasGraphCapacity") {
			capacityBody = node.getText(tree);
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "hasGraphCapacity") {
			capacityCalls.push(node.arguments.map((argument) => argument.getText(tree)).join(" | "));
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);

	const registry = JSON.parse(source("packages/protocol-v3/registry/registry-v1.json")) as {
		kinds: { parameters: { fields: readonly { name: string }[] } };
	};
	const newParameterNames = registry.kinds.parameters.fields
		.map(({ name }) => name)
		.filter((name) => !KNOWN_PARAMETER_FIELDS.has(name));
	const parameterName = newParameterNames.find((name) =>
		/(?:author|writer).*(?:share|quota)|(?:share|quota).*(?:author|writer)/iu.test(name)
	);
	const builders = [source("examples/grid/src/v3-zone.ts"), source("examples/v3-chat/src/index.ts")];
	return Object.freeze({
		capacityBody,
		capacityCalls: Object.freeze(capacityCalls),
		newParameterNames: Object.freeze(newParameterNames),
		parameterName,
		parameterValueIsDefaultedByBuilders:
			parameterName !== undefined &&
			builders.every((builder) => new RegExp(`${parameterName}\\s*:\\s*4\\b`, "u").test(builder)),
	});
}
