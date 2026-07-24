import {
	createNostrRelayDirectory,
	createNostrSignerFromSecretKey,
	createRecordProducer,
	InMemorySequenceStore,
	type NostrEvent,
	type NostrFilter,
	type NostrRelayConnection,
	type RecordValidator,
} from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

import { address, context, fixtureSigner, NAMESPACE, NOW, validator } from "./fixtures.js";

describe("scale-hardening record retirement", () => {
	it("uses the next sequence and produces a validator-accepted minimum-TTL record", async () => {
		const { peerId, signer } = await fixtureSigner(801);
		const producer = createRecordProducer({
			addressSource: () => [address(peerId, 4801)],
			capabilitySource: () => ["drp-gossipsub"],
			clock: () => NOW,
			namespace: NAMESPACE,
			peerId,
			sequenceStore: new InMemorySequenceStore(40),
			signer,
			ttlMs: 60_000,
		});
		const published = await producer.refresh();

		const retired = await producer.retire();
		const checked = await validator().validate(retired, context());

		expect(retired.sequence).toBeGreaterThan(published.sequence);
		expect(retired).toMatchObject({
			addresses: published.addresses,
			capabilities: published.capabilities,
			expiresAtMs: NOW + 5_000,
			issuedAtMs: NOW - 5_000,
			namespace: published.namespace,
			peerId: published.peerId,
		});
		expect(checked).toMatchObject({ accepted: true });
	});

	it("publishes retirement as a replacement Nostr event expiring about five seconds from now", async () => {
		const { peerId, signer } = await fixtureSigner(802);
		const producer = createRecordProducer({
			addressSource: () => [address(peerId, 4802)],
			capabilitySource: () => ["drp-gossipsub", "webrtc"],
			clock: () => NOW,
			namespace: NAMESPACE,
			peerId,
			sequenceStore: new InMemorySequenceStore(),
			signer,
			ttlMs: 60_000,
		});
		const relay = new CapturingRelay();
		const directory = createNostrRelayDirectory({
			connectionFactory: (_endpoint, signal): Promise<NostrRelayConnection> => {
				signal.throwIfAborted();
				return Promise.resolve(relay);
			},
			nostrSigner: createNostrSignerFromSecretKey(new Uint8Array(32).fill(9)),
			now: () => NOW,
			relays: [{ id: "retirement-relay", url: "wss://retirement-relay.example" }],
			validatorFactory: (): RecordValidator => validator(),
		});

		await directory.register(await producer.refresh(), signal());
		await directory.register(await producer.retire(), signal());

		expect(relay.events).toHaveLength(2);
		const [publishedEvent, retiredEvent] = relay.events;
		expect(publishedEvent).toBeDefined();
		expect(retiredEvent).toBeDefined();
		if (publishedEvent === undefined || retiredEvent === undefined) return;
		expect(requiredTag(retiredEvent, "d")).toBe(requiredTag(publishedEvent, "d"));
		expect(Number(requiredTag(retiredEvent, "expiration")) * 1_000).toBe(NOW + 5_000);
		expect(JSON.parse(retiredEvent.content)).toMatchObject({
			expiresAtMs: NOW + 5_000,
			issuedAtMs: NOW - 5_000,
			sequence: 2,
		});
	});
});

class CapturingRelay implements NostrRelayConnection {
	readonly events: NostrEvent[] = [];

	close(): void {}

	publish(event: NostrEvent, signal: AbortSignal): Promise<{ readonly accepted: true }> {
		signal.throwIfAborted();
		this.events.push(event);
		return Promise.resolve({ accepted: true });
	}

	async *query(_filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent> {
		signal.throwIfAborted();
		await Promise.resolve();
		for (const event of this.events.slice(0, 0)) yield event;
	}
}

function requiredTag(event: NostrEvent, name: string): string {
	const value = event.tags.find((tag) => tag[0] === name)?.[1];
	if (value === undefined) throw new Error(`missing ${name} tag`);
	return value;
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
