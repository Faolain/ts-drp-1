import { createEphemeralChannel, decodeEphemeralFrame } from "@ts-drp/ephemeral";
import { describe, expect, it } from "vitest";

type DeliveryClass = "reliable-unordered" | "unreliable-sequenced" | "unreliable-unordered";

interface FutureSendInput {
	readonly bytes: Uint8Array;
	readonly class: DeliveryClass;
	readonly recipients: "all" | readonly string[];
}

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise!: (value: Value) => void;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("E3-00 independent delivery lanes RED", () => {
	it("lets unreliable work reach the class-aware transport while reliable work is pending", async () => {
		const reliableGate = deferred<boolean>();
		const capCalls: DeliveryClass[] = [];
		const calls: Array<
			Readonly<{
				bytes: Uint8Array;
				class: DeliveryClass;
				classAware: boolean;
				recipients: "all" | readonly string[];
			}>
		> = [];
		const send = (rawInput: Uint8Array | FutureSendInput): Promise<boolean> => {
			const classAware = !(rawInput instanceof Uint8Array);
			const bytes = classAware ? rawInput.bytes : rawInput;
			const frame = decodeEphemeralFrame(bytes);
			calls.push(
				Object.freeze({
					bytes: bytes.slice(),
					class: frame.class,
					classAware,
					recipients: classAware ? rawInput.recipients : "all",
				})
			);
			return frame.class === "reliable-unordered" ? reliableGate.promise : Promise.resolve(true);
		};
		const common = {
			authorizedPeers: (): readonly string[] => [],
			close: (): void => undefined,
			isAuthorized: (): boolean => true,
			localPeerId: "peer:e3-00",
			onMessage: (): (() => void) => (): void => undefined,
		};
		let channel;
		try {
			channel = createEphemeralChannel(
				{
					...common,
					maxEnvelopeBytes: (deliveryClass: DeliveryClass): number => {
						capCalls.push(deliveryClass);
						return 65_536;
					},
					send,
				} as never,
				{ maxMessageBytes: 65_536, maxSequencedKeys: 4, maxSequencedSenders: 4 }
			);
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			channel = createEphemeralChannel({ ...common, maxEnvelopeBytes: 65_536, send } as never, {
				maxMessageBytes: 65_536,
				maxSequencedKeys: 4,
				maxSequencedSenders: 4,
			});
		}

		try {
			const reliable = channel.publish({
				class: "reliable-unordered",
				key: null,
				payload: Uint8Array.of(1),
			});
			await Promise.resolve();
			expect(calls.map(({ class: deliveryClass }) => deliveryClass)).toEqual(["reliable-unordered"]);

			const payload = Uint8Array.of(7);
			const unreliable = channel.publish({ class: "unreliable-sequenced", key: "movement", payload });
			payload[0] = 99;
			await Promise.resolve();

			expect(calls.map(({ class: deliveryClass }) => deliveryClass)).toEqual([
				"reliable-unordered",
				"unreliable-sequenced",
			]);
			expect(calls[1]).toMatchObject({ classAware: true, recipients: "all" });
			expect(decodeEphemeralFrame(calls[1]?.bytes ?? new Uint8Array()).payload).toEqual(Uint8Array.of(7));
			expect(capCalls).toEqual(expect.arrayContaining(["reliable-unordered", "unreliable-sequenced"]));

			reliableGate.resolve(true);
			expect(await Promise.all([reliable, unreliable])).toEqual([true, true]);
			expect(channel.stats()).toMatchObject({ dropped: 0, published: 2 });
		} finally {
			reliableGate.resolve(false);
			channel.close();
		}
	});
});
