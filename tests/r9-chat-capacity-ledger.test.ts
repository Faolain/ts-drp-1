/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing fixture capability inference is preserved. */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { expect, it } from "vitest";

import {
	createShippingChatCapacityAdmissionPolicy,
	createShippingChatGenesisStateBytes,
	reallocateShippingChatCapacity,
	restoreShippingChatCapacityState,
	shippingChatCapacityStateBytes,
} from "../examples/chat/src/v3-chat-capacity.js";
const alice = "a".repeat(64),
	bob = "b".repeat(64),
	carol = "c".repeat(64);
const acl = (epoch = 0, writers = [alice, bob]) =>
	encodeCanonical({
		epoch,
		kind: "drp-v3-latched-acl",
		members: [alice, bob, carol].map((author) => ({
			author,
			finalityKey: null,
			groups:
				author === alice
					? writers.includes(author)
						? ["admin", "writer"]
						: ["admin"]
					: writers.includes(author)
						? ["writer"]
						: [],
		})),
		objectId: "creator:capacity-native",
		permissionless: false,
		version: 1,
	});
const digest = (bytes: Uint8Array) => Buffer.from(hashDomain("ts-drp/latched-acl/v3", bytes)).toString("hex");
const message = (author: string, id = "limit", text = "x") => ({
	author,
	clientOperationId: id,
	displayTimeMs: 0,
	text,
});
const send = (id = "limit", text = "x") => ({ action: "message", clientOperationId: id, displayTimeMs: 0, text });
const commit = (reservation: ReturnType<ReturnType<typeof createShippingChatCapacityAdmissionPolicy>["reserve"]>) => {
	expect(reservation.kind).toBe("fresh");
	if (reservation.kind !== "fresh") throw new TypeError("fresh required");
	reservation.commit();
	reservation.release();
};
const genesis = () => createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: acl() });
function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("Chat ledger fixture value is missing");
	return value;
}
const policy = (stateBytes = genesis(), selectedAcl = acl()) =>
	createShippingChatCapacityAdmissionPolicy({
		aclDigest: digest(selectedAcl),
		epoch: (decodeCanonical(selectedAcl) as { epoch: number }).epoch,
		exactCanonicalLatchedAclBytes: selectedAcl,
		authenticatedApplicationStateBytes: stateBytes,
		exactCanonicalGenesisStateBytes: genesis(),
	});
function exactText(author: string): string {
	const state = restoreShippingChatCapacityState(genesis()),
		ceiling = required(state.capacity.allocations.find((row) => row[0] === author))[1];
	let low = 0,
		high = 32768;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encodeCanonical(message(author, "limit", "x".repeat(middle))).byteLength <= ceiling) low = middle;
		else high = middle - 1;
	}
	return "x".repeat(low);
}
it("disjoint complete-byte entitlements accept identical concurrent work under opposite peer orders", () => {
	const state = restoreShippingChatCapacityState(genesis());
	expect(state.capacity.allocations.length).toBe(3);
	const work = [
		{ author: alice, operation: send("limit", exactText(alice)) },
		{ author: bob, operation: send("limit", exactText(bob)) },
	];
	const outcomes = [];
	for (const order of [work, [...work].reverse()]) {
		const selected = policy();
		const accepted: string[] = [];
		for (const row of order) {
			commit(selected.reserve(row.operation, { author: row.author }));
			accepted.push(row.author);
		}
		for (const row of order) expect(selected.reserve(send("extra", "x"), { author: row.author }).kind).toBe("rejected");
		outcomes.push(accepted.sort());
	}
	expect(outcomes[0]).toEqual(outcomes[1]);
	const joined = { ...state, messages: work.map((row) => message(row.author, "limit", row.operation.text)) };
	expect(shippingChatCapacityStateBytes(joined).byteLength).toBeLessThanOrEqual(32768);
});
it("accepts the exact encoded author ceiling and refuses one extra text or metadata byte without consuming another identity", () => {
	const selected = policy(),
		text = exactText(alice),
		state = restoreShippingChatCapacityState(genesis()),
		ceiling = required(state.capacity.allocations[0])[1];
	expect(encodeCanonical(message(alice, "limit", text)).byteLength).toBe(ceiling);
	expect(encodeCanonical(message(alice, "limit", text + "x")).byteLength).toBe(ceiling + 1);
	expect(selected.reserve(send("limit", text + "x"), { author: alice }).kind).toBe("rejected");
	expect(selected.reserve(send("limits", text), { author: alice }).kind).toBe("rejected");
	commit(selected.reserve(send("limit", text), { author: alice }));
	commit(selected.reserve(send("limit", text), { author: alice }));
	expect(selected.reserve(send("limit", text + "x"), { author: alice }).kind).toBe("conflict");
	commit(selected.reserve(send("independent", "hello"), { author: bob }));
});
it("keeps pending exact reservations joined and refuses an atomic batch exceeding its author entitlement", () => {
	const selected = policy(),
		text = exactText(alice),
		first = selected.reserve(send("limit", text), { author: alice }),
		second = selected.reserve(send("limit", text), { author: alice });
	if (first.kind !== "fresh" || second.kind !== "fresh") throw new TypeError("fresh required");
	first.release();
	expect(selected.reserve(send("new", "x"), { author: alice }).kind).toBe("rejected");
	second.release();
	const batch = {
		action: "applicationBatch",
		batch: {
			version: 1,
			entries: [
				{ logicalTime: 0, operation: send("limit", text) },
				{ logicalTime: 1, operation: send("second", "x") },
			],
		},
	};
	expect(encodeCanonical(batch).byteLength).toBeLessThan(65536);
	expect(selected.reserve(batch, { author: alice }).kind).toBe("rejected");
	commit(selected.reserve(send("after-refusal", "hello"), { author: alice }));
});
it("rollover carries full messages and ceilings without refreshing credit; immutable retries remain possible", () => {
	const initial = restoreShippingChatCapacityState(genesis()),
		text = exactText(alice),
		closed = { ...initial, messages: [message(alice, "limit", text)] },
		bytes = shippingChatCapacityStateBytes(closed),
		selected = policy(bytes, acl(1));
	commit(selected.reserve(send("limit", text), { author: alice }));
	expect(selected.reserve(send("new", "x"), { author: alice }).kind).toBe("rejected");
	commit(selected.reserve(send("continued", "hello"), { author: bob }));
	expect(restoreShippingChatCapacityState(bytes).messages).toEqual(closed.messages);
});
it("does not release unseen source obligations on revocation or local terminal completion; published new incarnation alone retires the old namespace", () => {
	const initial = restoreShippingChatCapacityState(genesis()),
		state = { ...initial, messages: [message(alice, "old", "historical")] },
		selectedAcl = acl(2, [bob, carol]);
	const retained = reallocateShippingChatCapacity({
		state,
		exactCanonicalLatchedAclBytes: selectedAcl,
		authenticatedSettlementFrontiers: [[alice, 0, 999]],
	});
	expect(retained.allocations.find((row) => row[0] === alice)?.[1]).toBe(initial.capacity.allocations[0]?.[1]);
	expect(state.capacity.allocations.find((row) => row[0] === alice)?.[1]).toBe(initial.capacity.allocations[0]?.[1]);
	const released = reallocateShippingChatCapacity({
		state,
		exactCanonicalLatchedAclBytes: selectedAcl,
		authenticatedSettlementFrontiers: [[alice, 2, null]],
	});
	expect(released.allocations.find((row) => row[0] === alice)?.[1]).toBe(encodeCanonical(state.messages[0]).byteLength);
	expect(released.allocations.find((row) => row[0] === carol)?.[1]).toBeGreaterThan(0);
	expect(shippingChatCapacityStateBytes({ ...state, capacity: released }).byteLength).toBeLessThanOrEqual(32768);
});

it("carried source capacity rejects a target-only newer incarnation and forged basis while retaining complete bytes", () => {
	const initial = restoreShippingChatCapacityState(genesis());
	const state = { ...initial, messages: [message(alice, "source", "complete inherited bytes")] };
	const sourceAcl = acl(2);
	const targetAcl = encodeCanonical({
		...(decodeCanonical(sourceAcl) as object),
		objectId: "creator:foreign-capacity-target",
	});
	expect(() =>
		reallocateShippingChatCapacity({
			state,
			exactCanonicalLatchedAclBytes: targetAcl,
			authenticatedSettlementFrontiers: [[alice, 2, null]],
		})
	).toThrow("source basis");
	const target = policy(shippingChatCapacityStateBytes(state), targetAcl);
	const candidate = reallocateShippingChatCapacity({
		state,
		exactCanonicalLatchedAclBytes: sourceAcl,
		authenticatedSettlementFrontiers: [[alice, 2, null]],
	});
	for (const capacity of [candidate, { ...candidate, basisObjectId: "creator:foreign-capacity-target" }])
		expect(
			target.reserve(
				{ action: "capacityAllocation", epoch: 2, aclDigest: digest(targetAcl), capacity },
				{ author: alice }
			).kind
		).toBe("rejected");
	commit(target.reserve(send("continued", "new target message uses carried finite share"), { author: bob }));
	commit(target.reserve(send("source", "complete inherited bytes"), { author: alice }));
	expect(restoreShippingChatCapacityState(shippingChatCapacityStateBytes(state))).toEqual(state);
});
