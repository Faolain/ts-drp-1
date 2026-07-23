import {
	type ClientRegistrationReceipt,
	CompositeRendezvousConfigurationError,
	createCompositeRendezvousDirectory,
	type RegistryBackendSelection,
	RegistryExhaustedError,
	type RendezvousDirectory,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

import { NAMESPACE, signedFixture } from "./fixtures.js";

const signal = (): AbortSignal => new AbortController().signal;

function directory(options: {
	readonly discover?: RendezvousDirectory["discover"];
	readonly register?: RendezvousDirectory["register"];
}): RendezvousDirectory {
	return {
		discover: options.discover ?? ((): Promise<readonly ValidatedDrpRecord[]> => Promise.resolve([])),
		register:
			options.register ??
			((record): Promise<ClientRegistrationReceipt> =>
				Promise.resolve({
					acceptedEndpointIds: [],
					attempts: [],
					sequence: record.sequence,
				})),
	};
}

describe("createCompositeRendezvousDirectory", () => {
	it("registers with every child and succeeds when either accepts", async () => {
		const record = await signedFixture(801);
		const first = directory({
			register: () =>
				Promise.resolve({
					acceptedEndpointIds: [],
					attempts: [{ code: "endpoint-unavailable", endpointId: "http-1", operation: "register", status: "rejected" }],
					sequence: record.sequence,
				}),
		});
		const second = directory({
			register: () =>
				Promise.resolve({
					acceptedEndpointIds: ["nostr-1"],
					attempts: [{ endpointId: "nostr-1", operation: "register", status: "accepted" }],
					sequence: record.sequence,
				}),
		});

		await expect(createCompositeRendezvousDirectory([first, second]).register(record, signal())).resolves.toEqual({
			acceptedEndpointIds: ["nostr-1"],
			attempts: [
				{ code: "endpoint-unavailable", endpointId: "http-1", operation: "register", status: "rejected" },
				{ endpointId: "nostr-1", operation: "register", status: "accepted" },
			],
			sequence: record.sequence,
		});
	});

	it("throws register exhaustion only after every child fails", async () => {
		const record = await signedFixture(802);
		const firstAttempt = {
			code: "endpoint-unavailable" as const,
			endpointId: "http-1",
			operation: "register" as const,
			status: "rejected" as const,
		};
		const secondAttempt = {
			code: "endpoint-unavailable" as const,
			endpointId: "nostr-1",
			operation: "register" as const,
			status: "rejected" as const,
		};
		const composite = createCompositeRendezvousDirectory([
			directory({ register: () => Promise.reject(new RegistryExhaustedError("register", [firstAttempt])) }),
			directory({ register: () => Promise.reject(new RegistryExhaustedError("register", [secondAttempt])) }),
		]);

		const terminal = composite.register(record, signal());

		await expect(terminal).rejects.toBeInstanceOf(RegistryExhaustedError);
		await expect(terminal).rejects.toMatchObject({
			attempts: [firstAttempt, secondAttempt],
			operation: "register",
		});
	});

	it("unions records returned by every child", async () => {
		const firstRecord = {
			admissionMode: "open" as const,
			record: await signedFixture(803),
			sourceEndpointId: "http-1",
		};
		const secondRecord = {
			admissionMode: "open" as const,
			record: await signedFixture(804),
			sourceEndpointId: "nostr-1",
		};
		const composite = createCompositeRendezvousDirectory([
			directory({ discover: () => Promise.resolve([firstRecord]) }),
			directory({ discover: () => Promise.resolve([secondRecord]) }),
		]);

		await expect(composite.discover(NAMESPACE, signal())).resolves.toEqual([firstRecord, secondRecord]);
	});

	it("returns healthy child records when another child throws", async () => {
		const healthyRecord = {
			admissionMode: "open" as const,
			record: await signedFixture(805),
			sourceEndpointId: "nostr-1",
		};
		const composite = createCompositeRendezvousDirectory([
			directory({
				discover: () => {
					throw new Error("offline");
				},
			}),
			directory({ discover: () => Promise.resolve([healthyRecord]) }),
		]);

		await expect(composite.discover(NAMESPACE, signal())).resolves.toEqual([healthyRecord]);
	});

	it("throws discover exhaustion with ordered attempts when every child throws", async () => {
		const firstAttempt = {
			code: "endpoint-unavailable" as const,
			endpointId: "http-1",
			operation: "discover" as const,
			status: "rejected" as const,
		};
		const secondAttempt = {
			code: "endpoint-unavailable" as const,
			endpointId: "nostr-1",
			operation: "discover" as const,
			status: "rejected" as const,
		};
		const composite = createCompositeRendezvousDirectory([
			directory({ discover: () => Promise.reject(new RegistryExhaustedError("discover", [firstAttempt])) }),
			directory({ discover: () => Promise.reject(new RegistryExhaustedError("discover", [secondAttempt])) }),
		]);

		const terminal = composite.discover(NAMESPACE, signal());

		await expect(terminal).rejects.toBeInstanceOf(RegistryExhaustedError);
		await expect(terminal).rejects.toMatchObject({
			attempts: [firstAttempt, secondAttempt],
			operation: "discover",
		});
	});

	it("passes backend selection through to every child", async () => {
		const firstDiscover = vi.fn<RendezvousDirectory["discover"]>(() => Promise.resolve([]));
		const secondDiscover = vi.fn<RendezvousDirectory["discover"]>(() => Promise.resolve([]));
		const selection: RegistryBackendSelection = {
			excludeBackendIds: ["offline"],
			preferredRegistryIds: ["nostr-1"],
		};
		const composite = createCompositeRendezvousDirectory([
			directory({ discover: firstDiscover }),
			directory({ discover: secondDiscover }),
		]);

		await composite.discover(NAMESPACE, signal(), selection);

		expect(firstDiscover).toHaveBeenCalledWith(NAMESPACE, expect.any(AbortSignal), selection);
		expect(secondDiscover).toHaveBeenCalledWith(NAMESPACE, expect.any(AbortSignal), selection);
	});

	it("filters targeted results even when every child ignores the selection", async () => {
		const targetRecord = {
			admissionMode: "open" as const,
			record: await signedFixture(806),
			sourceEndpointId: "target",
		};
		const unrelatedRecord = {
			admissionMode: "open" as const,
			record: await signedFixture(807),
			sourceEndpointId: "unrelated",
		};
		const leakingChild = directory({
			discover: () => Promise.resolve([unrelatedRecord, targetRecord]),
		});
		const composite = createCompositeRendezvousDirectory([leakingChild, leakingChild]);

		await expect(
			composite.discover(NAMESPACE, signal(), { targetPeerId: targetRecord.record.peerId })
		).resolves.toEqual([targetRecord, targetRecord]);
	});

	it("rejects an empty child directory list with a typed configuration error", () => {
		expect(() => createCompositeRendezvousDirectory([])).toThrow(CompositeRendezvousConfigurationError);
		expect(() => createCompositeRendezvousDirectory([])).toThrow(/at least one/iu);
	});
});
