import { describe, expect, it } from "vitest";

import {
	createEphemeralChannel,
	decodeEphemeralFrame,
	type EphemeralChannelOptions,
	type EphemeralPublishInput,
	type EphemeralTransportPort,
	type EphemeralTransportSendInput,
} from "../src/index.js";

const OPTIONS: EphemeralChannelOptions = Object.freeze({
	maxMessageBytes: 65_536,
	maxSequencedKeys: 32,
	maxSequencedSenders: 32,
});

interface TargetedChannel {
	authorizedPeers(): readonly string[];
	close(): void;
	publish(input: EphemeralPublishInput): Promise<boolean>;
	publishTo(recipients: readonly string[], input: EphemeralPublishInput): Promise<boolean>;
	resetReliable(): Promise<void>;
}

interface TargetedModule {
	readonly EPHEMERAL_TARGET_RECIPIENTS_MAX: number;
}

interface CapturedSend {
	readonly bytes: Uint8Array;
	readonly class: EphemeralTransportSendInput["class"];
	readonly recipients: EphemeralTransportSendInput["recipients"];
}

interface ControlledPort extends EphemeralTransportPort {
	readonly sent: CapturedSend[];
	setAuthorizedPeers(peers: readonly string[]): void;
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((selected) => {
		resolve = selected;
	});
	return { promise, resolve };
}

function port(
	initialPeers: readonly string[],
	sendOwner?: (input: EphemeralTransportSendInput, ordinal: number) => Promise<boolean>
): ControlledPort {
	let peers = [...initialPeers];
	const sent: CapturedSend[] = [];
	return {
		authorizedPeers: (): readonly string[] => [...peers],
		isAuthorized: (sender): boolean => peers.includes(sender),
		maxEnvelopeBytes: (): number => 65_536,
		onMessage: (): (() => void) => (): void => undefined,
		send: (input): Promise<boolean> => {
			sent.push({ bytes: input.bytes.slice(), class: input.class, recipients: input.recipients });
			return sendOwner === undefined ? Promise.resolve(true) : sendOwner(input, sent.length - 1);
		},
		sent,
		setAuthorizedPeers(next): void {
			peers = [...next];
		},
	};
}

function channel(selectedPort: EphemeralTransportPort): TargetedChannel {
	return createEphemeralChannel(selectedPort, OPTIONS) as unknown as TargetedChannel;
}

function publication(value: number, key: string | null = null): EphemeralPublishInput {
	return {
		class: key === null ? "unreliable-unordered" : "unreliable-sequenced",
		key,
		payload: Uint8Array.of(value),
	};
}

function reliablePublication(value: number): EphemeralPublishInput {
	return { class: "reliable-unordered", key: null, payload: Uint8Array.of(value) };
}

const readinessPort = port(["peer-a"]);
const readinessChannel = channel(readinessPort);
const targetedReady = typeof readinessChannel.publishTo === "function";
readinessChannel.close();

it("E4-02 RED exposes the missing targeted ephemeral publication owner", () => {
	expect(targetedReady).toBe(true);
});

describe.skipIf(!targetedReady)("E4-02 targeted AOI publication", () => {
	it("publishes one bounded public target contract", async () => {
		const module = (await import("../src/index.js")) as unknown as TargetedModule;
		expect(module.EPHEMERAL_TARGET_RECIPIENTS_MAX).toBe(8);
	});

	it("copies, sorts, and sends only the named authorized recipients", async () => {
		const selectedPort = port(["peer-c", "peer-a", "peer-b"]);
		const selectedChannel = channel(selectedPort);
		const recipients = ["peer-c", "peer-a"];
		const accepted = selectedChannel.publishTo(recipients, publication(7));
		recipients[0] = "peer-b";

		await expect(accepted).resolves.toBe(true);
		expect(selectedPort.sent).toHaveLength(1);
		expect(selectedPort.sent[0]?.recipients).toEqual(["peer-a", "peer-c"]);
		expect(decodeEphemeralFrame(selectedPort.sent[0]?.bytes ?? new Uint8Array()).payload).toEqual(Uint8Array.of(7));
		selectedChannel.close();
	});

	it("keeps broadcast publication as the explicit all-authorized control", async () => {
		const selectedPort = port(["peer-a", "peer-b"]);
		const selectedChannel = channel(selectedPort);

		await expect(selectedChannel.publish(publication(8))).resolves.toBe(true);
		expect(selectedPort.sent[0]?.recipients).toBe("all");
		selectedChannel.close();
	});

	it("rejects malformed, duplicate, over-cap, and no-longer-authorized target sets", async () => {
		const authorized = Array.from({ length: 9 }, (_, index) => `peer-${String(index)}`);
		const selectedPort = port(authorized);
		const selectedChannel = channel(selectedPort);

		expect(() => selectedChannel.publishTo([], publication(1))).toThrow();
		expect(() => selectedChannel.publishTo(["peer-0", "peer-0"], publication(1))).toThrow();
		expect(() => selectedChannel.publishTo([""], publication(1))).toThrow();
		expect(() => selectedChannel.publishTo(authorized, publication(1))).toThrow();
		selectedPort.setAuthorizedPeers(["peer-0"]);
		await expect(selectedChannel.publishTo(["peer-1"], publication(1))).resolves.toBe(false);
		await expect(selectedChannel.publishTo(["peer-0", "peer-1"], publication(1))).resolves.toBe(false);
		expect(selectedPort.sent).toHaveLength(0);
		selectedChannel.close();
	});

	it("rechecks every queued target against current authority before transport send", async () => {
		const blocked = deferred<boolean>();
		const selectedPort = port(["peer-a", "peer-b"], (_input, ordinal) =>
			ordinal === 0 ? blocked.promise : Promise.resolve(true)
		);
		const selectedChannel = channel(selectedPort);
		const active = selectedChannel.publishTo(["peer-a"], publication(1));
		const revoked = selectedChannel.publishTo(["peer-b"], publication(2));
		selectedPort.setAuthorizedPeers(["peer-a"]);
		blocked.resolve(true);

		await expect(active).resolves.toBe(true);
		await expect(revoked).resolves.toBe(false);
		expect(selectedPort.sent).toHaveLength(1);
		expect(selectedPort.sent[0]?.recipients).toEqual(["peer-a"]);
		selectedChannel.close();
	});

	it("never coalesces one observer's sequenced AOI batch into another target set", async () => {
		const blocked = deferred<boolean>();
		const selectedPort = port(["peer-a", "peer-b"], (_input, ordinal) =>
			ordinal === 0 ? blocked.promise : Promise.resolve(true)
		);
		const selectedChannel = channel(selectedPort);
		const active = selectedChannel.publishTo(["peer-a"], publication(0));
		const padding = Array.from({ length: 254 }, (_, index) =>
			selectedChannel.publishTo(["peer-a"], publication((index + 1) & 0xff))
		);
		const firstAoi = selectedChannel.publishTo(["peer-a"], publication(1, "avatar"));
		const replacementAoi = selectedChannel.publishTo(["peer-a"], publication(2, "avatar"));

		await expect(firstAoi).resolves.toBe(false);
		await expect(selectedChannel.publishTo(["peer-b"], publication(3, "avatar"))).resolves.toBe(false);
		blocked.resolve(true);
		await expect(active).resolves.toBe(true);
		await expect(replacementAoi).resolves.toBe(true);
		await expect(Promise.all(padding)).resolves.toHaveLength(254);
		const sequenced = selectedPort.sent.filter(({ bytes }) => decodeEphemeralFrame(bytes).key === "avatar");
		expect(sequenced).toHaveLength(1);
		expect(sequenced[0]?.recipients).toEqual(["peer-a"]);
		expect(decodeEphemeralFrame(sequenced[0]?.bytes ?? new Uint8Array()).payload).toEqual(Uint8Array.of(2));
		selectedChannel.close();
	});

	it("resolves queued targeted work false when the channel closes", async () => {
		const blocked = deferred<boolean>();
		const selectedPort = port(["peer-a"], (_input, ordinal) =>
			ordinal === 0 ? blocked.promise : Promise.resolve(true)
		);
		const selectedChannel = channel(selectedPort);
		const active = selectedChannel.publishTo(["peer-a"], publication(1));
		const queued = selectedChannel.publishTo(["peer-a"], publication(2));
		selectedChannel.close();

		await expect(active).resolves.toBe(false);
		await expect(queued).resolves.toBe(false);
		blocked.resolve(true);
	});

	it("cancels active and queued targeted reliable work on the existing reliable reset", async () => {
		const blocked = deferred<boolean>();
		const selectedPort = port(["peer-a"], (_input, ordinal) =>
			ordinal === 0 ? blocked.promise : Promise.resolve(true)
		);
		const selectedChannel = channel(selectedPort);
		const active = selectedChannel.publishTo(["peer-a"], reliablePublication(1));
		const queued = selectedChannel.publishTo(["peer-a"], reliablePublication(2));

		await selectedChannel.resetReliable();
		await expect(active).resolves.toBe(false);
		await expect(queued).resolves.toBe(false);
		blocked.resolve(true);
		selectedChannel.close();
	});
});
