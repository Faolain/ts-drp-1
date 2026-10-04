/* eslint-disable jsdoc/require-jsdoc -- Finite controller-only oracles, never product input. */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion -- Controller-only shape helpers and positions follow explicit assertions. */
import type { GenerationRecord, GenerationRef, PresentHead } from "@ts-drp/storage";
import type { SnapshotChunkDescriptor, SnapshotQuarantineScopeKey } from "@ts-drp/storage/snapshot-transfer";
import assert from "node:assert/strict";

import type { Floor } from "./types.js";
export type Profile = "creator-trusted-v1" | "creator-trusted-settlement-v1";
export interface RoleConfig {
	epoch: 0 | 1 | 2;
	profile: Profile;
	stop?: "before-publication" | "already-published";
	setupFault?: "union-generic";
	stagePublishedEquivalent?: true;
}
export interface RoleBootstrap {
	identity: string;
	objectId: string;
	pinnedGenesisAnchorDigest: string;
	exactCanonicalPinnedGenesisTrustStateRecordBytes: string;
}
export interface RoleIdentity {
	roomHead: Floor["stable"];
	profileId: string;
	generation: GenerationRecord & { derivedHead: PresentHead };
	controls: { kind: string; ref: GenerationRef }[];
	snapshot: null | {
		scope: SnapshotQuarantineScopeKey;
		manifestByteLength: number;
		payloadDigest: string;
		stateDigest: string;
		closedAclDigest: string;
		successorAclDigest: string;
		totalBytes: number;
		chunks: readonly SnapshotChunkDescriptor[];
	};
}
export interface RoleOracle {
	floor: Floor;
	head: PresentHead;
	current: RoleIdentity;
	pending: null | { role: RoleIdentity; publication: string };
	supportGenerations: readonly GenerationRecord[];
	heldGenerations: readonly GenerationRecord[];
	currency: "point-observed-no-incarnation";
	nativeUnionBytes: number;
	allGenerations: readonly GenerationRecord[];
	preconditions: { early: boolean; deferred: boolean; predecessor: string }[];
}
export interface RoleReport {
	classification: string;
	result: null | {
		ok: boolean;
		kind?: string;
		debt?: {
			owner: string;
			role: string;
			objectId: string;
			generationId?: string;
			snapshotScope?: SnapshotQuarantineScopeKey;
		};
		cause?: { owner: string; reason: string };
	};
	summary: RoleOracle | null;
	events: { name: string; epoch?: number; index?: number; detail?: unknown }[];
	native?: {
		modes: string[];
		terminals: string[];
		writes: number;
		reads: unknown[];
		fixture: { writes: number; reads: unknown[] };
	};
	tokenEmpty?: boolean;
	tokenFrozen?: boolean;
	summaryFrozen?: boolean;
	foreign?: unknown[];
	floorReads?: number;
	getters?: number;
	sideEffects?: Record<string, number>;
	unchangedAhe?: boolean;
	unchangedSnapshot?: boolean;
	fixtureBoundaries?: { kind: string; before: string; after: string }[];
	cleanup?: { aheRelease: number; borrowedAhe: boolean; borrowedSnapshot: boolean; joined: number };
	mutation?: Record<string, unknown>;
	nativePrecondition?: { ok: boolean; unionBytes: number; rows: number; headEqual?: boolean };
	productCustody?: {
		calls: number;
		admitted: number;
		releaseCalls: number;
		released: number;
		unionBytes: number;
		rows: number;
	};
	legacy?: Record<string, unknown>;
}
export const positiveCases: readonly { name: string; config: RoleConfig }[] = (
	["creator-trusted-v1", "creator-trusted-settlement-v1"] as const
).flatMap((profile) => [
	...([0, 1, 2] as const).map((epoch) => ({ name: `stable-n${epoch}-${profile}`, config: { epoch, profile } })),
	...([0, 1] as const).flatMap((n) =>
		(["before-publication", "already-published"] as const).map((stop) => ({
			name: `pending-n${n}-${stop}-${profile}`,
			config: { epoch: (n + 1) as 1 | 2, profile, stop },
		}))
	),
]);
const pending: RoleConfig = { epoch: 2, profile: "creator-trusted-v1", stop: "before-publication" };
const settlement: RoleConfig = { ...pending, profile: "creator-trusted-settlement-v1" };
export const faultKinds = {
	"current-q-binding": "chain-invalid",
	"pending-q-l-trust": "chain-invalid",
	"complete-omission": "chain-invalid",
	"complete-replacement": "chain-invalid",
	"signed-qc-length": "chain-invalid",
	"current-missing-chunk": "snapshot-unavailable",
	"pending-missing-chunk": "snapshot-unavailable",
	"current-corrupt-chunk": "snapshot-invalid",
	"pending-corrupt-chunk": "snapshot-invalid",
	"current-acl": "snapshot-invalid",
	"pending-acl": "snapshot-invalid",
	"current-settlement": "chain-invalid",
	"pending-settlement": "chain-invalid",
	"equivalent-l": "role-ambiguous",
	"published-equivalent-l": "role-ambiguous",
	"contradictory-trust": "role-ambiguous",
	"contradictory-projection": "role-ambiguous",
	"unclassified-complete": "inherited-scope-unclassified",
	"missing-l": "role-missing",
	"stable-q": "role-missing",
	"non-head-current": "ahe-stale",
	"final-pending": "floor-stale",
	"final-retention": "snapshot-not-ready",
	"final-readiness": "snapshot-not-ready",
	"capture-extra-journal": "malformed-input",
	"capture-extra-head": "malformed-input",
	"capture-extra-role": "malformed-input",
	"capture-extra-acl": "malformed-input",
	"capture-extra-declaration": "malformed-input",
	"capture-extra-profile": "malformed-input",
	"capture-accessor": "malformed-input",
	"capture-symbol": "malformed-input",
	"capture-throw": "malformed-input",
	"capture-signal": "malformed-input",
	"initial-abort": "aborted",
	"abort-current": "aborted",
	"abort-pending": "aborted",
	"abort-cleanup": "aborted",
	"release-failed": "release-failed",
	"native-primary": "ahe-rejected",
} as const;
export type RoleFault =
	| "none"
	| "capture-mutation"
	| "capture-null-prototype"
	| "capture-pin-intrinsic"
	| "union-generic"
	| keyof typeof faultKinds
	| "legacy-genesis"
	| "legacy-current"
	| "legacy-pending"
	| "legacy-retry"
	| "legacy-active"
	| "legacy-survivor";
export const negativeCases: readonly { name: string; config: RoleConfig; fault: RoleFault }[] = Object.keys(
	faultKinds
).map((name) => ({
	name,
	config:
		name === "current-acl"
			? { epoch: 1, profile: "creator-trusted-v1" }
			: name.includes("settlement")
				? settlement
				: name === "published-equivalent-l"
					? { ...pending, stop: "already-published", stagePublishedEquivalent: true }
					: name === "stable-q" ||
						  name.includes("equivalent") ||
						  name.includes("contradictory") ||
						  name === "unclassified-complete" ||
						  name === "missing-l"
						? { ...pending, epoch: 1 }
						: pending,
	fault: name as RoleFault,
}));
export const extraCases: readonly { name: string; config: RoleConfig; fault: RoleFault }[] = [
	{ name: "capture-mutation", config: pending, fault: "capture-mutation" },
	{ name: "capture-null-prototype", config: pending, fault: "capture-null-prototype" },
	{ name: "capture-pin-intrinsic", config: pending, fault: "capture-pin-intrinsic" },
	{ name: "union-generic", config: { ...pending, setupFault: "union-generic" }, fault: "union-generic" },
	...(
		["legacy-genesis", "legacy-current", "legacy-pending", "legacy-retry", "legacy-active", "legacy-survivor"] as const
	).map((fault) => ({
		name: fault,
		config: {
			...pending,
			epoch: fault === "legacy-genesis" ? (0 as const) : (1 as const),
			stop: fault === "legacy-genesis" || fault === "legacy-current" ? undefined : pending.stop,
		},
		fault,
	})),
];
function normalizedControls(role: RoleIdentity) {
	return [...role.controls].sort((a, b) => a.kind.localeCompare(b.kind) || a.ref.digest.localeCompare(b.ref.digest));
}
function identity(actual: RoleIdentity, expected: RoleIdentity) {
	assert.deepEqual(actual.roomHead, expected.roomHead);
	assert.equal(actual.profileId, expected.profileId);
	assert.deepEqual(actual.generation, expected.generation);
	assert.deepEqual(normalizedControls(actual), normalizedControls(expected));
	assert.deepEqual(actual.snapshot, expected.snapshot);
	assert.deepEqual(Object.keys(actual).sort(), ["roomHead", "profileId", "generation", "controls", "snapshot"].sort());
}
export function assertRoleObservation(value: RoleReport, oracle: RoleOracle, fault: RoleFault): void {
	assert.equal(
		value.classification,
		"REACHED",
		"WIRING_RED: required private role API absent; downstream assertions did not execute"
	);
	if (fault.startsWith("legacy-")) {
		assert.ok(value.legacy);
		assert.equal(value.legacy.ok, true, "narrow preserved old/private-fact/adoption ordering control");
		return;
	}
	assert.ok(value.native);
	assert.equal(value.native.writes, 0);
	assert.ok(value.native.modes.every((m) => m === "readonly" || m === "BEGIN"));
	assert.equal(value.native.modes.length, value.native.terminals.length);
	assert.ok(value.sideEffects);
	assert.ok(
		Object.values(value.sideEffects).every((n) => n === 0),
		"no mutation/import/sign/issuance/registry operations"
	);
	assert.equal(
		value.unchangedSnapshot,
		true,
		"all native snapshot rows unchanged outside explicit fixture edit boundaries"
	);
	assert.ok(
		value.native.reads.every((read) => {
			const { table, sql } = read as { table?: string; sql?: string };
			return (
				!["acceptedEntries"].includes(table ?? "") && !/\b(?:accepted_entries|issuance_|journal_)\b/iu.test(sql ?? "")
			);
		}),
		"no journal/import/issuance native reads"
	);
	assert.ok(value.cleanup);
	assert.equal(value.cleanup.borrowedAhe, true);
	assert.equal(value.cleanup.borrowedSnapshot, true);
	const preIo = (fault.startsWith("capture-") && fault in faultKinds) || fault === "initial-abort";
	assert.ok(value.productCustody, "product custody is separate from controller native prerequisite");
	for (const key of ["calls", "admitted", "releaseCalls", "released"] as const)
		assert.equal(
			value.productCustody[key],
			preIo ? 0 : 1,
			"one actual admitted and genuinely joined product AHE reader: " + key
		);
	assert.equal(value.cleanup.aheRelease, preIo ? 0 : 1);
	if (!preIo) {
		assert.ok(value.productCustody.rows > 0 && value.productCustody.unionBytes > 0);
		assert.ok(value.native.modes.length > 0 && value.native.reads.length > 0, "nonempty actual product native custody");
	}
	const acquisitions = value.events.filter((e) => e.name === "snapshot-acquire"),
		releases = value.events.filter((e) => e.name === "snapshot-release");
	assert.equal(releases.length, acquisitions.length, "captured genuine release once per admitted reader");
	for (let i = 1; i < acquisitions.length; i++)
		assert.ok(
			value.events.indexOf(releases[i - 1]!) < value.events.indexOf(acquisitions[i]!),
			"current payload released before pending"
		);
	const expectedRoles = [oracle.current, ...(oracle.pending ? [oracle.pending.role] : [])],
		snapshots = expectedRoles.flatMap((r) => (r.snapshot ? [r.snapshot] : []));
	const selectedBefore = (phase: RoleReport["events"][number]) => {
		assert.deepEqual(
			acquisitions.map((e) => e.epoch),
			snapshots.map((s) => s.scope.epoch)
		);
		const at = value.events.indexOf(phase);
		const joinedReleases = value.events.filter((e) => e.name === "role-snapshot-release-joined");
		assert.equal(joinedReleases.length, snapshots.length);
		for (let i = 1; i < acquisitions.length; i++)
			assert.ok(
				value.events.indexOf(joinedReleases[i - 1]!) < value.events.indexOf(acquisitions[i]!),
				"genuine current drain settles before pending acquisition"
			);
		for (const s of snapshots) {
			const acquired = value.events.findIndex((e) => e.name === "snapshot-acquire" && e.epoch === s.scope.epoch);
			const lookup = value.events.findIndex((e) => e.name === "role-lookup-result" && e.epoch === s.scope.epoch);
			assert.ok(lookup >= 0 && lookup < acquired);
			assert.deepEqual(value.events[lookup]!.detail, {
				scope: s.scope,
				kind: "present",
				state: "verified",
				retention: "recovery",
			});
			const joined = value.events.findIndex(
				(e) => e.name === "role-snapshot-release-joined" && e.epoch === s.scope.epoch
			);
			assert.ok(
				acquired >= 0 && joined > acquired && joined < at,
				"selected genuine release settles before late phase"
			);
			for (const c of s.chunks) {
				const read = value.events.findIndex(
					(e) => e.name === "snapshot-read" && e.epoch === s.scope.epoch && e.index === c.index
				);
				const success = value.events.findIndex(
					(e) => e.name === "role-native-chunk-success" && e.epoch === s.scope.epoch && e.index === c.index
				);
				assert.ok(
					read > acquired && success > read && success < joined,
					"selected descriptor actually succeeds before joined release"
				);
			}
		}
	};
	if (fault in faultKinds) {
		assert.equal(value.result?.ok, false);
		assert.equal(value.result?.kind, faultKinds[fault as keyof typeof faultKinds]);
		assert.equal(value.summary, null, "no partial fact");
		assert.ok(value.result?.debt);
		if (fault.startsWith("capture-"))
			assert.ok(["", oracle.floor.stable.objectId].includes(value.result.debt.objectId));
		else assert.equal(value.result.debt.objectId, oracle.floor.stable.objectId);
		if (fault.startsWith("capture-") || fault === "initial-abort") {
			assert.equal(value.floorReads, 0);
			assert.equal(value.getters, 0);
			assert.deepEqual(value.native.modes, []);
			assert.deepEqual(value.events, []);
		} else if (
			[
				"equivalent-l",
				"published-equivalent-l",
				"contradictory-trust",
				"contradictory-projection",
				"unclassified-complete",
				"missing-l",
				"stable-q",
				"current-q-binding",
				"pending-q-l-trust",
				"complete-omission",
				"complete-replacement",
				"signed-qc-length",
			].includes(fault)
		) {
			assert.equal(acquisitions.length, 0);
			assert.equal(value.nativePrecondition?.ok, true);
		}
		if (fault.startsWith("pending-") && (fault.includes("chunk") || fault.includes("settlement"))) {
			assert.ok(
				value.events.some((e) => e.name === "snapshot-read" && e.epoch === oracle.current.snapshot?.scope.epoch)
			);
			assert.ok(
				value.events.some((e) => e.name === "snapshot-release" && e.epoch === oracle.current.snapshot?.scope.epoch)
			);
		}
		if (fault.includes("settlement")) {
			assert.deepEqual(value.mutation, {
				actualSignatures: true,
				earlyCryptoStructure: true,
				actualAclPolicy: false,
				refAndBaseTuplesRepaired: true,
				retainedPredecessor: true,
			});
			const role = fault.startsWith("current") ? oracle.current : oracle.pending!.role;
			assert.ok(value.events.some((e) => e.name === "snapshot-read" && e.epoch === role.snapshot?.scope.epoch));
		}
		if (fault === "non-head-current") {
			assert.deepEqual(value.result?.cause, { owner: "ahe", reason: "READ_STALE_ROLE_VIEW" });
			assert.equal(value.nativePrecondition?.headEqual, true);
			const started = value.events.find((e) => e.name === "role-non-head-edit-start"),
				joined = value.events.find((e) => e.name === "role-non-head-edit-joined"),
				currency = value.events.find((e) => e.name === "role-currency-call"),
				result = value.events.find((e) => e.name === "role-currency-result");
			assert.ok(started && joined && currency && result, "actual edit and full currency receipts");
			selectedBefore(currency);
			assert.ok(
				value.events.indexOf(started) < value.events.indexOf(joined) &&
					value.events.indexOf(joined) < value.events.indexOf(currency) &&
					value.events.indexOf(currency) < value.events.indexOf(result)
			);
			const edit = joined.detail as {
				generationId: string;
				beforeState: string;
				afterState: string;
				beforeHead: PresentHead;
				afterHead: PresentHead;
			};
			assert.equal(edit.generationId, oracle.current.generation.generationId);
			assert.equal(edit.beforeState, "Superseded");
			assert.equal(edit.afterState, "Discarded");
			assert.deepEqual(edit.beforeHead, oracle.head);
			assert.deepEqual(edit.afterHead, edit.beforeHead, "actual non-head edit leaves actual head unchanged");
			assert.deepEqual(result.detail, { ok: false, reason: "READ_STALE_ROLE_VIEW" });
			assert.equal(value.cleanup.joined, 1);
		}
		if (fault === "final-pending") {
			const edit = value.events.find((e) => e.name === "role-final-pending-edit"),
				currency = value.events.find((e) => e.name === "role-currency-result"),
				hosts = value.events.filter((e) => e.name === "role-host-result");
			assert.ok(edit && currency);
			selectedBefore(currency);
			assert.deepEqual(currency.detail, { ok: true, value: { kind: "current" } });
			assert.equal(value.floorReads, 2);
			assert.equal(hosts.length, 2);
			assert.deepEqual(hosts[0]!.detail, oracle.floor);
			assert.deepEqual(edit.detail, oracle.floor);
			assert.ok(oracle.floor.pending);
			assert.deepEqual(
				hosts[1]!.detail,
				{ ...oracle.floor, pending: null },
				"only actual host pending clears, stable unchanged"
			);
			assert.ok(
				value.events.indexOf(currency) < value.events.indexOf(edit) &&
					value.events.indexOf(edit) < value.events.indexOf(hosts[1]!)
			);
		}
		if (fault === "final-retention" || fault === "final-readiness") {
			const edit = value.events.find((e) => e.name === "role-" + fault + "-edit");
			assert.ok(edit, "actual selected final declaration/readiness fixture edit");
			selectedBefore(edit);
			assert.ok(
				value.fixtureBoundaries?.some(
					(b) => b.kind === (fault === "final-retention" ? "temporary" : "not-ready") && b.before !== b.after
				)
			);
			if (fault === "final-retention") {
				assert.deepEqual(edit.detail, oracle.current.snapshot!.scope);
				const result = value.events.find((e, i) => i > value.events.indexOf(edit) && e.name === "role-lookup-result");
				assert.ok(result);
				assert.deepEqual(result.detail, {
					scope: oracle.current.snapshot!.scope,
					kind: "present",
					state: "verified",
					retention: "temporary",
				});
			} else {
				const result = value.events.find((e, i) => i > value.events.indexOf(edit) && e.name === "role-status-result");
				assert.ok(result);
				assert.equal((result.detail as { migration: string }).migration, "classification-required");
			}
		}
		if (fault.includes("missing-chunk") || fault.includes("corrupt-chunk")) {
			const target = fault.startsWith("current") ? oracle.current : oracle.pending!.role;
			assert.ok(value.events.some((e) => e.name === "snapshot-read" && e.epoch === target.snapshot?.scope.epoch));
			assert.equal(acquisitions.length, fault.startsWith("current") ? 1 : 2);
			assert.ok(
				value.native.reads.some((r) => {
					const { table, sql } = r as { table?: string; sql?: string };
					return table === "chunks" || /FROM snapshot_chunks_v2/u.test(sql ?? "");
				})
			);
		}
		if (fault === "native-primary") {
			assert.deepEqual(value.result?.cause, { owner: "ahe", reason: "SUBSTRATE_FAILURE" });
			assert.ok(value.native.terminals.includes("ROLLBACK") || value.native.terminals.includes("abort"));
			assert.equal(value.mutation?.nativeTriggered, true);
			assert.equal(value.mutation?.laterAbort, true);
			assert.equal(value.mutation?.joinedReleaseRejected, true);
			assert.equal(value.mutation?.actualChunkCount, 2);
			assert.equal(acquisitions.length, 2);
			for (const s of snapshots)
				for (const c of s.chunks)
					assert.ok(
						value.events.some((e) => e.name === "snapshot-read" && e.epoch === s.scope.epoch && e.index === c.index)
					);
			assert.equal(value.cleanup.aheRelease, 1);
		}
		if (fault === "abort-current") assert.equal(acquisitions.length, 1);
		if (fault === "abort-pending") assert.equal(acquisitions.length, 2);
		if (fault === "release-failed" || fault === "abort-cleanup") assert.equal(value.cleanup.aheRelease, 1);
	} else if (!fault.startsWith("legacy-")) {
		assert.equal(value.result?.ok, true);
		assert.ok(value.summary);
		assert.deepEqual(value.summary.floor, oracle.floor);
		assert.deepEqual(value.summary.head, oracle.head);
		identity(value.summary.current, oracle.current);
		assert.equal(value.summary.pending === null, oracle.pending === null);
		if (oracle.pending) {
			assert.ok(value.summary.pending);
			identity(value.summary.pending.role, oracle.pending.role);
			assert.equal(value.summary.pending.publication, oracle.pending.publication);
		}
		assert.deepEqual(
			Object.keys(value.summary).sort(),
			["floor", "head", "current", "pending", "supportGenerations", "heldGenerations", "currency"].sort()
		);
		assert.equal(value.getters, 0);
		assert.deepEqual(
			[...value.summary.supportGenerations].sort((a, b) => a.generationId.localeCompare(b.generationId)),
			[...oracle.supportGenerations].sort((a, b) => a.generationId.localeCompare(b.generationId))
		);
		assert.deepEqual(
			[...value.summary.heldGenerations].sort((a, b) => a.generationId.localeCompare(b.generationId)),
			[...oracle.heldGenerations].sort((a, b) => a.generationId.localeCompare(b.generationId))
		);
		assert.equal(value.summary.currency, "point-observed-no-incarnation");
		assert.deepEqual(
			acquisitions.map((e) => e.epoch),
			snapshots.map((s) => s.scope.epoch)
		);
		for (const s of snapshots)
			for (const c of s.chunks)
				assert.ok(
					value.events.some((e) => e.name === "snapshot-read" && e.epoch === s.scope.epoch && e.index === c.index)
				);
		assert.equal(value.floorReads, 2);
		assert.equal(value.tokenEmpty, true);
		assert.equal(value.tokenFrozen, true);
		assert.equal(value.summaryFrozen, true);
		assert.deepEqual(value.foreign, [null, null, null, null, null]);
		assert.equal(value.cleanup.aheRelease, 1);
		const dispatch = value.events.filter((e) => e.name === "proof-accounting");
		assert.equal(dispatch.length, 1, "single existing accounting owner");
		assert.deepEqual(dispatch[0]?.detail, {
			refs: oracle.allGenerations
				.filter((g) => ["Complete", "Adopted", "Superseded"].includes(g.state))
				.flatMap((g) => g.closure)
				.filter((r, i, a) => a.findIndex((x) => x.digest === r.digest) === i)
				.sort((a, b) => a.digest.localeCompare(b.digest)),
			bytes: oracle.nativeUnionBytes,
		});
		if (snapshots.length)
			assert.ok(
				value.events.some((e) => e.name === "proof-charge" && (e.detail as { equal: boolean }).equal),
				"actual equal controls share native union seed bytes"
			);
		for (const e of value.events.filter((e) => e.name === "proof-charge"))
			assert.ok((e.detail as { chargedBytes: number }).chargedBytes <= 262144);
	} else {
		assert.ok(value.legacy);
		assert.equal(value.legacy.ok, true, "narrow original selection/custody law");
	}
	if (fault !== "non-head-current")
		assert.equal(value.unchangedAhe, true, "fixture mutation boundaries excluded from readonly product image");
}
