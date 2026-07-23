import {
	AdmissionPolicy,
	FixtureRegistryEndpoint,
	RecordValidator,
	RegistryClient,
	RegistryServer,
} from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

import { NAMESPACE, NOW, signedFixture } from "./fixtures.js";

const INVITE = "targeted-registry-fixture-invite";
const resolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

describe("RegistryClient targeted discovery", () => {
	it("returns only the target when selected and preserves the broad result otherwise", async () => {
		const target = await signedFixture(1_200);
		const other = await signedFixture(1_201);
		const endpoints = [endpoint("primary"), endpoint("secondary")] as const;
		const client = new RegistryClient({
			backoffMs: 0,
			clientId: "targeted-reader",
			endpoints,
			timeoutMs: 1_000,
			validatorFactory: (): RecordValidator => new RecordValidator({ now: (): number => NOW, resolver }),
		});
		for (const record of [target, other]) {
			await client.register(record, signal(), { kind: "invite", token: INVITE });
		}

		expect((await client.discover(NAMESPACE, signal())).map(peerId).sort()).toEqual(
			[target.peerId, other.peerId].sort()
		);
		expect((await client.discover(NAMESPACE, signal(), { targetPeerId: target.peerId })).map(peerId)).toEqual([
			target.peerId,
		]);
	});
});

function endpoint(id: string): FixtureRegistryEndpoint {
	return new FixtureRegistryEndpoint(
		new RegistryServer({
			endpointId: id,
			limits: { maxRequestsPerNamespaceWindow: 1_000, maxRequestsPerWindow: 1_000 },
			now: () => NOW,
			policy: new AdmissionPolicy({ inviteToken: INVITE }),
			validator: new RecordValidator({ now: () => NOW, resolver }),
		})
	);
}

function peerId({ record }: { readonly record: { readonly peerId: string } }): string {
	return record.peerId;
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
