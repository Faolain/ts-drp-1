import {
	type AdmissionCredential,
	type ClientRegistrationReceipt,
	RecordValidator,
	RegistryClient,
	type RegistryDiscoveryReceipt,
	type RegistryEndpoint,
	type RegistryRegistrationRequest,
	type RegistryRejection,
	type RendezvousDirectory,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

import { signedFixture } from "./fixtures.js";

const NOW = 1_750_000_000_000;
const EXPECTED_NAMESPACE = `drp-network:v1:${"a".repeat(43)}`;

describe("multi-backend rendezvous reconciliation", () => {
	it("unions backends and retains the highest valid signed sequence per Peer ID", async () => {
		const firstPeerV1 = await signedFixture(10);
		const firstPeerV2 = await signedFixture(10, {
			issuedAtMs: NOW + 1_000,
			expiresAtMs: NOW + 61_000,
			sequence: 2,
		});
		const secondPeer = await signedFixture(11);
		const directory: RendezvousDirectory = client([
			backend("primary", [firstPeerV1, secondPeer]),
			backend("secondary", [firstPeerV2]),
		]);

		const records = await directory.discover(EXPECTED_NAMESPACE, signal());
		expect(records).toHaveLength(2);
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ record: expect.objectContaining({ peerId: firstPeerV1.peerId, sequence: 2 }) }),
				expect.objectContaining({ record: expect.objectContaining({ peerId: secondPeer.peerId, sequence: 1 }) }),
			])
		);
	});

	it("rejects equal-sequence conflicts instead of choosing an endpoint winner", async () => {
		const left = await signedFixture(12);
		const right = await signedFixture(12, { expiresAtMs: NOW + 70_000 });
		const directory = client([backend("primary", [left]), backend("secondary", [right])]);

		expect(await directory.discover(EXPECTED_NAMESPACE, signal())).toEqual([]);
	});

	it("drops records that are expired at reconciliation time", async () => {
		const expired = await signedFixture(13, {
			issuedAtMs: NOW - 70_000,
			expiresAtMs: NOW - 10_000,
		});
		const directory = client([backend("primary", [expired]), backend("secondary", [])]);

		expect(await directory.discover(EXPECTED_NAMESPACE, signal())).toEqual([]);
	});

	it("rejects a valid-signed record outside the explicitly expected namespace", async () => {
		const attackerNamespace = `drp-network:v1:${"b".repeat(43)}`;
		const wrongNamespace = await signedFixture(14, { namespace: attackerNamespace });
		const directory = client([backend("attacker", [wrongNamespace]), backend("healthy", [])]);

		expect(await directory.discover(EXPECTED_NAMESPACE, signal())).toEqual([]);
		expect(directory.lastAttempts).toEqual([
			{
				code: "record-rejected",
				endpointId: "attacker",
				operation: "discover",
				status: "rejected",
			},
			{ endpointId: "healthy", operation: "discover", status: "empty" },
		]);
	});
});

function client(endpoints: readonly RegistryEndpoint[]): RegistryClient {
	return new RegistryClient({
		backoffMs: 0,
		clientId: "browser-a",
		endpoints,
		timeoutMs: 100,
		validatorFactory: () =>
			new RecordValidator({
				now: (): number => NOW,
				resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
			}),
	});
}

function backend(id: string, records: readonly SignedDrpRecordV1[]): RegistryEndpoint {
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

function signal(): AbortSignal {
	return new AbortController().signal;
}

type _RendezvousRegisterContract = (
	record: SignedDrpRecordV1,
	signal: AbortSignal,
	credential?: AdmissionCredential
) => Promise<ClientRegistrationReceipt>;

const _registerContract: _RendezvousRegisterContract | undefined = undefined;
void _registerContract;
