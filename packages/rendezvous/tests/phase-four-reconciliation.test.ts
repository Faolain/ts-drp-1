import {
	RecordValidator,
	RegistryClient,
	type RegistryDiscoveryReceipt,
	type RegistryEndpoint,
	type RegistryRegistrationRequest,
	type RegistryRejection,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAMESPACE, NOW, signedFixture } from "./fixtures.js";

interface PhaseFourReconciliationModule {
	reconcileValidatedRecords(recordSets: readonly (readonly ValidatedDrpRecord[])[]): readonly ValidatedDrpRecord[];
}

afterEach(() => vi.useRealTimers());

describe("Phase 4a reconciliation owner", () => {
	it("unions record sets and retains the highest sequence for each Peer ID", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const reconcile = await loadReconcile();
		if (reconcile === undefined) return;
		const peerV1 = await signedFixture(101);
		const peerV2 = await signedFixture(101, {
			expiresAtMs: NOW + 70_000,
			issuedAtMs: NOW + 10_000,
			sequence: 2,
		});
		const otherPeer = await signedFixture(102);

		expect(
			reconcile([
				[validated(peerV1, "registry-a"), validated(otherPeer, "registry-a")],
				[validated(peerV2, "anchor-a")],
			])
		).toEqual([validated(peerV2, "anchor-a"), validated(otherPeer, "registry-a")].sort(byPeerId));
	});

	it("drops both equal-sequence conflicting records instead of selecting a source winner", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const reconcile = await loadReconcile();
		if (reconcile === undefined) return;
		const left = await signedFixture(103);
		const right = await signedFixture(103, { expiresAtMs: NOW + 70_000 });

		expect(reconcile([[validated(left, "registry-a")], [validated(right, "anchor-a")]])).toEqual([]);
	});

	it("drops records at or beyond expiry during pure reconciliation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const reconcile = await loadReconcile();
		if (reconcile === undefined) return;
		const expired = await signedFixture(104, {
			expiresAtMs: NOW,
			issuedAtMs: NOW - 60_000,
		});
		const fresh = await signedFixture(105);

		expect(reconcile([[validated(expired, "registry-a"), validated(fresh, "registry-a")]])).toEqual([
			validated(fresh, "registry-a"),
		]);
	});

	it("keeps RegistryClient discover reconciliation behavior unchanged", async () => {
		const peerV1 = await signedFixture(106);
		const peerV2 = await signedFixture(106, {
			expiresAtMs: NOW + 70_000,
			issuedAtMs: NOW + 10_000,
			sequence: 2,
		});
		const otherPeer = await signedFixture(107);
		const client = new RegistryClient({
			backoffMs: 0,
			clientId: "phase-four-reader",
			endpoints: [endpoint("registry-a", [peerV1, otherPeer]), endpoint("registry-b", [peerV2])],
			timeoutMs: 100,
			validatorFactory: (): RecordValidator =>
				new RecordValidator({
					now: (): number => NOW,
					resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
				}),
		});

		expect(await client.discover(NAMESPACE, new AbortController().signal)).toEqual(
			[validated(peerV2, "registry-b"), validated(otherPeer, "registry-a")].sort(byPeerId)
		);
		expect(client.lastAttempts).toEqual([
			{ endpointId: "registry-a", operation: "discover", status: "accepted" },
			{ endpointId: "registry-b", operation: "discover", status: "accepted" },
		]);
	});
});

async function loadReconcile(): Promise<PhaseFourReconciliationModule["reconcileValidatedRecords"] | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourReconciliationModule>;
	expect(loaded.reconcileValidatedRecords, "Phase 4a must export the shared reconciliation owner").toBeTypeOf(
		"function"
	);
	return loaded.reconcileValidatedRecords;
}

function endpoint(id: string, records: readonly SignedDrpRecordV1[]): RegistryEndpoint {
	return {
		id,
		discover: (): Promise<RegistryDiscoveryReceipt> =>
			Promise.resolve({
				endpointId: id,
				records: records.map((record) => ({ admissionMode: "invite", record })),
			}),
		register: (_request: RegistryRegistrationRequest): Promise<RegistryRejection> =>
			Promise.resolve({ accepted: false, code: "endpoint-unavailable" }),
	};
}

function validated(record: ValidatedDrpRecord["record"], sourceEndpointId: string): ValidatedDrpRecord {
	return { admissionMode: "invite", record, sourceEndpointId };
}

function byPeerId(left: ValidatedDrpRecord, right: ValidatedDrpRecord): number {
	return left.record.peerId.localeCompare(right.record.peerId);
}
