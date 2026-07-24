import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	createNostrRelayDirectory,
	DEFAULT_REGISTRY_LIMITS,
	type NostrEvent,
	type NostrFilter,
	type NostrRelayConnectionFactory,
	type NostrSigner,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

import { NAMESPACE, NOW, signedFixture, validator } from "./fixtures.js";

const ADDRESSABLE_EVENT_KIND = 30_078;
const TRANSPORT_PUBLIC_KEY = "11".repeat(32);
const TRANSPORT_SIGNATURE = "22".repeat(64);
const encoder = new TextEncoder();

describe("NostrRelayDirectory targeted discovery", () => {
	it("queries the target's deterministic replacement key with the bounded addressable-event filter", async () => {
		const target = await signedFixture(1_001);
		const relay = new FixtureRelay([eventFor(target)]);
		const directory = createNostrRelayDirectory(options(relay));

		await directory.discover(NAMESPACE, signal(), { targetPeerId: target.peerId });

		expect(relay.filters).toEqual([
			{
				"#d": [replacementKey(NAMESPACE, target.peerId)],
				"kinds": [ADDRESSABLE_EVENT_KIND],
				"limit": DEFAULT_REGISTRY_LIMITS.maxResponseRecords + 1,
			},
		]);
	});

	it("post-filters a target plus 63 unrelated valid records returned by a relay that ignores its filter", async () => {
		const target = await signedFixture(1_010);
		const unrelated = await Promise.all(Array.from({ length: 63 }, (_, index) => signedFixture(1_011 + index)));
		const relay = new FixtureRelay([target, ...unrelated].map((record) => eventFor(record)));
		const directory = createNostrRelayDirectory(options(relay));

		const discovered = await directory.discover(NAMESPACE, signal(), { targetPeerId: target.peerId });

		expect(discovered).toHaveLength(1);
		expect(discovered[0]?.record.peerId).toBe(target.peerId);
	});

	it("excludes a validly signed different peer returned for the target's d-tag", async () => {
		const target = await signedFixture(1_080);
		const squatter = await signedFixture(1_081);
		const relay = new FixtureRelay([eventFor(squatter, replacementKey(NAMESPACE, target.peerId))]);
		const directory = createNostrRelayDirectory(options(relay));

		await expect(directory.discover(NAMESPACE, signal(), { targetPeerId: target.peerId })).resolves.toEqual([]);
	});

	it("keeps record and byte caps on the targeted filter path", async () => {
		const targetV1 = await signedFixture(1_090);
		const targetV2 = await signedFixture(1_090, {
			expiresAtMs: NOW + 61_000,
			issuedAtMs: NOW + 1_000,
			sequence: 2,
		});
		const targetV3 = await signedFixture(1_090, {
			expiresAtMs: NOW + 62_000,
			issuedAtMs: NOW + 2_000,
			sequence: 3,
		});
		const recordCappedRelay = new FixtureRelay([targetV1, targetV2, targetV3].map((record) => eventFor(record)));
		const recordCapped = createNostrRelayDirectory(options(recordCappedRelay, { maxResponseRecords: 2 }));

		await expect(recordCapped.discover(NAMESPACE, signal(), { targetPeerId: targetV1.peerId })).resolves.toMatchObject([
			{ record: { peerId: targetV1.peerId, sequence: 2 } },
		]);
		expect(recordCappedRelay.filters[0]).toEqual({
			"#d": [replacementKey(NAMESPACE, targetV1.peerId)],
			"kinds": [ADDRESSABLE_EVENT_KIND],
			"limit": 3,
		});

		const firstEvent = eventFor(targetV1);
		const byteCappedRelay = new FixtureRelay([firstEvent, eventFor(targetV2)]);
		const byteCapped = createNostrRelayDirectory(
			options(byteCappedRelay, {
				maxResponseBytes: Math.max(1_024, encoder.encode(JSON.stringify(firstEvent)).byteLength),
			})
		);

		await expect(byteCapped.discover(NAMESPACE, signal(), { targetPeerId: targetV1.peerId })).resolves.toMatchObject([
			{ record: { peerId: targetV1.peerId, sequence: 1 } },
		]);
		expect(byteCappedRelay.filters[0]).toMatchObject({
			"#d": [replacementKey(NAMESPACE, targetV1.peerId)],
			"limit": DEFAULT_REGISTRY_LIMITS.maxResponseRecords + 1,
		});
	});

	it("preserves broad discovery while narrowing only an explicitly targeted request", async () => {
		const target = await signedFixture(1_100);
		const other = await signedFixture(1_101);
		const broadRelay = new FixtureRelay([eventFor(target), eventFor(other)]);
		const targetedRelay = new FixtureRelay([eventFor(target), eventFor(other)]);
		const broad = createNostrRelayDirectory(options(broadRelay));
		const targeted = createNostrRelayDirectory(options(targetedRelay));

		expect((await broad.discover(NAMESPACE, signal())).map(peerId).sort()).toEqual(
			[target.peerId, other.peerId].sort()
		);
		expect((await targeted.discover(NAMESPACE, signal(), { targetPeerId: target.peerId })).map(peerId)).toEqual([
			target.peerId,
		]);
		expect(broadRelay.filters[0]).toEqual({
			"#n": [NAMESPACE],
			"kinds": [ADDRESSABLE_EVENT_KIND],
			"limit": DEFAULT_REGISTRY_LIMITS.maxResponseRecords + 1,
		});
	});
});

class FixtureRelay {
	readonly filters: NostrFilter[] = [];

	constructor(readonly events: readonly NostrEvent[]) {}

	readonly connectionFactory: NostrRelayConnectionFactory = (): Promise<{
		close(): void;
		publish(): Promise<{ readonly accepted: boolean }>;
		query(filter: NostrFilter, operationSignal: AbortSignal): AsyncIterable<NostrEvent>;
	}> =>
		Promise.resolve({
			close: (): void => undefined,
			publish: (): Promise<{ readonly accepted: boolean }> => Promise.resolve({ accepted: true }),
			query: (filter, operationSignal): AsyncIterable<NostrEvent> => {
				this.filters.push(filter);
				return eventsIgnoringFilter(this.events, operationSignal);
			},
		});
}

function options(
	relay: FixtureRelay,
	limits: {
		readonly maxResponseBytes?: number;
		readonly maxResponseRecords?: number;
	} = {}
): Parameters<typeof createNostrRelayDirectory>[0] {
	return {
		connectionFactory: relay.connectionFactory,
		limits,
		nostrSigner: signer,
		now: (): number => NOW,
		relays: [{ id: "fixture-relay", url: "wss://fixture-relay.example" }],
		validatorFactory: () => validator(),
	};
}

const signer: NostrSigner = {
	getPublicKey: (): string => TRANSPORT_PUBLIC_KEY,
	signEventId: (): string => TRANSPORT_SIGNATURE,
};

async function* eventsIgnoringFilter(
	events: readonly NostrEvent[],
	operationSignal: AbortSignal
): AsyncIterable<NostrEvent> {
	await Promise.resolve();
	for (const event of events) {
		operationSignal.throwIfAborted();
		yield event;
	}
}

function eventFor(record: SignedDrpRecordV1, d = `fixture:${record.peerId}`): NostrEvent {
	return {
		content: JSON.stringify(record),
		created_at: Math.floor(NOW / 1_000),
		id: "33".repeat(32),
		kind: ADDRESSABLE_EVENT_KIND,
		pubkey: TRANSPORT_PUBLIC_KEY,
		sig: TRANSPORT_SIGNATURE,
		tags: [
			["d", d],
			["n", record.namespace],
		],
	};
}

function replacementKey(namespace: string, peerId: string): string {
	return bytesToHex(sha256(encoder.encode(JSON.stringify(["ts-drp-rendezvous", namespace, peerId]))));
}

function peerId({ record }: { readonly record: SignedDrpRecordV1 }): string {
	return record.peerId;
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
