import { afterEach, describe, expect, it } from "vitest";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
// Peer 1 is a genuine owned local session (Q3: abandonment is local-owned only).
const fixture = (options: { local?: boolean; members?: ("genesis")[]; localMembers?: number[] } = {}) => chatSharesRoomFixture({
	members: options.members ?? ["genesis"], format: "window",
	...(options.local === false ? {} : { localMembers: options.localMembers ?? [1] }),
	genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function nativeImage(f: Fixture, index: number) {
	const author = required(f.identities[index]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(index, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const completed = control.control.completed; await control.release();
		return {
			plan: await store.readSettlementPlan(scope),
			lineage: await store.readLineage(scope),
			outbox: (await store.readOutboxPage({ scope, limit: 128 })).map(row => ({ sequence: row.commit.authorSequence,
				digest: Buffer.from(row.commit.envelope.digest).toString("hex"), publishState: row.publishState,
				action: (decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action?: unknown } }).operation.action })),
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence),
			retiredThroughEpoch: completed?.throughEpoch,
			prunedThrough: (await maintenance.inspectPruningState(scope)).prunedThroughAuthorSequence,
		};
	});
}

/** Revoked Writer with one accepted, never-published source of unknown commitment. */
async function revokedWithUnresolvedWork(f: Fixture, options: { publishSource?: boolean } = {}) {
	const creator = await f.open(0), member = await f.open(1);
	const published: Uint8Array[] = [];
	const gossip = { allowed: options.publishSource === true };
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => {
		const packet = args[0] as { data?: Uint8Array } | undefined;
		if (packet?.data instanceof Uint8Array) published.push(new Uint8Array(packet.data));
		// A failed gossip leaves the accepted source durably pending (never acknowledged).
		return gossip.allowed ? publish.apply(member.networkNode, args) : Promise.resolve(false);
	});
	await member.room.issue(message("before-removal")).catch(() => undefined);
	const original = required((await f.issuedAfter(1, null)).at(-1));
	const author = required(f.identities[1]).author;
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	const unresolved = await member.room.unresolvedAcceptedWork();
	expect(unresolved).toMatchObject([{ sourceSequence: original.commit.authorSequence, commitment: "unknown",
		disposition: "manual-review", operations: [message("before-removal")] }]);
	return { creator, member, original, author, unresolved: required(unresolved[0]), published, gossip };
}

describe("explicit local-author source abandonment", () => {
	it("terminates unknown accepted work by signed expiry without publishing, a FENCE or a Writer grant", async () => {
		const f = await fixture();
		const { creator, member, original, author, unresolved, published, gossip } = await revokedWithUnresolvedWork(f);
		const before = await nativeImage(f, 1);
		expect(before.outbox.find(row => row.sequence === original.commit.authorSequence)?.publishState).toBe("pending");
		const publishedBefore = published.length;
		const result = await member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence,
			sourceDigest: unresolved.sourceDigest, sourceContextDigest: unresolved.sourceContextDigest });
		expect(result).toMatchObject({ author, sourceSequence: unresolved.sourceSequence, sourceDigest: unresolved.sourceDigest,
			disposition: "expire", commitment: "unknown" });
		expect(result.expiryDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		const after = await nativeImage(f, 1);
		const entry = required(after.plan?.entries.find(value => value.sourceSequence === unresolved.sourceSequence));
		expect(entry).toMatchObject({ disposition: "expire", replacementSequence: null });
		expect(Buffer.from(required(entry.sourceResolutionDigest)).toString("hex")).toBe(result.expiryDigest);
		expect(after.plan?.fenceSequence).toBe(before.plan?.fenceSequence ?? null);
		expect(after.plan?.fenceSequence ?? null).toBeNull();
		// No new vertex, no FENCE: the lineage and outbox rows are unchanged; the source stays pending.
		expect(after.lineage).toEqual(before.lineage);
		expect(after.outbox).toEqual(before.outbox);
		// The receipt never reaches the wire, and the source never publishes afterwards.
		expect(published.length).toBe(publishedBefore);
		gossip.allowed = true;
		await member.room.requestRetainedRepair();
		await member.republish();
		const sourceHex = Buffer.from(original.commit.envelope.canonicalPreimageBytes).toString("hex");
		expect(published.slice(publishedBefore).some(bytes => Buffer.from(bytes).toString("hex").includes(sourceHex))).toBe(false);
		await expect(member.room.issue(message("still-not-a-writer"))).rejects.toThrow();
		// Idempotent retry returns the same receipt without signing a second one.
		expect(await member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence,
			sourceDigest: unresolved.sourceDigest, sourceContextDigest: unresolved.sourceContextDigest })).toEqual(result);
		// Reopen authenticates the retained receipt and keeps the work terminal.
		await f.stop(member);
		const reopened = await f.open(1, { reopen: true, promote: true });
		expect(await reopened.room.unresolvedAcceptedWork()).toEqual([]);
		// The ORIGINAL retirement owner retires the abandoned pending source: it is
		// no longer a protected hole, yet its outbox row never becomes published.
		let retired: readonly number[] | undefined;
		for (let seal = 0; seal < 4; seal++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await f.install(reopened);
		}
		const drained = await nativeImage(f, 1);
		retired = drained.holes;
		expect(drained.retiredThroughEpoch).toBeGreaterThanOrEqual(3);
		expect(retired).not.toContain(original.commit.authorSequence);
		expect(drained.outbox.find(row => row.sequence === original.commit.authorSequence)?.publishState).toBe("pending");
		expect(published.slice(publishedBefore).some(bytes => Buffer.from(bytes).toString("hex").includes(sourceHex))).toBe(false);
		// Abandonment adds no FENCE and no Writer grant. Once nothing below the removed
		// author's own earlier signed FENCE is unresolved, that retained no-op leaves
		// protection too (removed-author FENCE release). Its plan entry stays as
		// custody while the row is physically present, so physical prefix pruning
		// still does not run for a removed author.
		const fence = drained.outbox.find(row => row.action === "$drp.author-fence.v1");
		expect(retired).toEqual([]);
		expect(drained.plan?.entries.find(entry => entry.sourceSequence === required(fence).sequence))
			.toMatchObject({ disposition: "expire", replacementSequence: null });
		expect(drained.prunedThrough).toBeNull();
		expect(await reopened.room.unresolvedAcceptedWork()).toEqual([]);
		expect(decodeCanonical(original.commit.envelope.canonicalPreimageBytes)).toMatchObject({ author });
	}, 240_000);

	type Mutable = Record<string, unknown> & { entries: Record<string, unknown>[]; sourceContexts: { digest: Uint8Array; exactCanonicalContextBytes: Uint8Array }[] };
	const issuanceDatabase = (f: Fixture): string => {
		const root = join(f.directory, "local-sessions");
		const found: string[] = [];
		const walk = (directory: string): void => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path); else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) found.push(path);
		} };
		walk(root);
		expect(found).toHaveLength(1);
		return found[0]!;
	};
	/** Exact refusal text through wrapped causes (the reopen owner wraps its primary). */
	const causes = (error: unknown): string => {
		const seen: string[] = [];
		const visit = (value: unknown): void => {
			if (!(value instanceof Error) || seen.length > 16) return;
			seen.push(value.message);
			visit(value.cause);
			if (value instanceof AggregateError) for (const nested of value.errors) visit(nested);
		};
		visit(error);
		return seen.join(" <- ");
	};
	const expiryKind = (context: { exactCanonicalContextBytes: Uint8Array }) =>
		Reflect.get(decodeCanonical(context.exactCanonicalContextBytes) as object, "kind");

	it("refuses forged, retargeted and foreign signed expiry at reopen with byte-identical rows, head and floor", async () => {
		const prepare = async () => {
			const f = await fixture();
			const state = await revokedWithUnresolvedWork(f);
			const result = await state.member.room.abandonUnresolvedAcceptedWork({ sourceSequence: state.unresolved.sourceSequence,
				sourceDigest: state.unresolved.sourceDigest, sourceContextDigest: state.unresolved.sourceContextDigest });
			await f.stop(state.member);
			return { f, ...state, result, path: issuanceDatabase(f) };
		};
		const { f, result, path } = await prepare(), foreign = await prepare();
		const original = new DatabaseSync(path), other = new DatabaseSync(foreign.path, { readOnly: true });
		original.function("issuance_retirement_connection", { varargs: true }, () => 1);
		const floor = new DatabaseSync(join(f.directory, "peer-1-external-floor.sqlite"), { readOnly: true });
		try {
			const raw = original.prepare("SELECT entries_json FROM settlement_plans WHERE object_id=?").get(f.objectId)!;
			const wrapper = JSON.parse(String(raw.entries_json)) as { kind: string; bytes: string };
			const foreignPlan = decodeCanonical(Buffer.from(JSON.parse(String(other.prepare("SELECT entries_json FROM settlement_plans WHERE object_id=?")
				.get(foreign.f.objectId)!.entries_json)).bytes, "base64")) as Mutable;
			const foreignExpiry = required(foreignPlan.sourceContexts.find(context => expiryKind(context) === "creator-settlement-source-expiry-1"));
			const head = (await f.readHead(1)).head, issued = await f.issuedAfter(1, null);
			const floorBefore = floor.prepare("SELECT * FROM room_head").all();
			const nativeRows = () => ["lineages", "issued_records", "issuance_outbox", "settlement_plans"].map(table =>
				original.prepare(`SELECT * FROM ${table}`).all());
			for (const mutation of ["signature", "receipt-field", "retarget-to-source-context", "foreign-receipt", "missing-resolution"]) {
				const plan = decodeCanonical(Buffer.from(wrapper.bytes, "base64")) as Mutable;
				const context = required(plan.sourceContexts.find(value => expiryKind(value) === "creator-settlement-source-expiry-1"));
				const entry = required(plan.entries.find(value => Buffer.from(value.sourceResolutionDigest as Uint8Array ?? []).toString("hex") === result.expiryDigest));
				const carrier = decodeCanonical(context.exactCanonicalContextBytes) as Record<string, Uint8Array | string | number>;
				if (mutation === "signature") (carrier.detachedSignature as Uint8Array)[0]! ^= 1;
				if (mutation === "receipt-field") {
					const receipt = decodeCanonical(carrier.exactCanonicalReceiptBytes as Uint8Array) as Record<string, unknown>;
					receipt.signingEpoch = Number(receipt.signingEpoch) + 1; carrier.exactCanonicalReceiptBytes = encodeCanonical(receipt);
				}
				if (mutation === "retarget-to-source-context") {
					entry.sourceResolutionDigest = new Uint8Array(entry.sourceContextDigest as Uint8Array);
					plan.sourceContexts = plan.sourceContexts.filter(value => value !== context);
				} else if (mutation === "missing-resolution") {
					plan.sourceContexts = plan.sourceContexts.filter(value => value !== context);
				} else {
					context.exactCanonicalContextBytes = mutation === "foreign-receipt" ? foreignExpiry.exactCanonicalContextBytes : encodeCanonical(carrier);
					context.digest = hashDomain("ts-drp/settlement-source-context/v1", context.exactCanonicalContextBytes);
					entry.sourceResolutionDigest = context.digest;
					plan.sourceContexts.sort((a, b) => Buffer.compare(a.digest, b.digest));
				}
				original.prepare("UPDATE settlement_plans SET entries_json=? WHERE object_id=?").run(JSON.stringify({ ...wrapper,
					bytes: Buffer.from(encodeCanonical(plan)).toString("base64") }), f.objectId);
				const expected = nativeRows();
				const opened = await f.open(1, { reopen: true, promote: true }).then(value => ({ value }), error => ({ error }));
				if ("value" in opened) {
					// A session that opens without consuming the plan still never treats it as terminal or publishable.
					await expect(opened.value.room.unresolvedAcceptedWork(), mutation).rejects.toThrow("creator source expiry proof is invalid");
					await expect(opened.value.room.issue(message("forged-expiry-cannot-write")), mutation).rejects.toThrow();
					let sent = false;
					Reflect.set(opened.value.networkNode, "publishMessage", async () => { sent = true; return true; });
					await expect(opened.value.republish(), mutation).rejects.toThrow();
					expect(sent, mutation).toBe(false);
					await f.stop(opened.value);
				} else expect(causes(opened.error), mutation).toContain(mutation === "missing-resolution"
					// A dangling resolution is refused structurally by the plan codec before any signature check.
					? "creator issuance ACL authority is invalid" : "creator source expiry proof is invalid");
				expect((await f.readHead(1)).head, mutation).toEqual(head);
				expect(await f.issuedAfter(1, null), mutation).toEqual(issued);
				expect(nativeRows(), mutation).toEqual(expected);
				expect(floor.prepare("SELECT * FROM room_head").all(), mutation).toEqual(floorBefore);
			}
			// The genuine plan reopens and stays terminal.
			original.prepare("UPDATE settlement_plans SET entries_json=? WHERE object_id=?").run(String(raw.entries_json), f.objectId);
			const reopened = await f.open(1, { reopen: true, promote: true });
			expect(await reopened.room.unresolvedAcceptedWork()).toEqual([]);
			expect(await reopened.room.abandonUnresolvedAcceptedWork({ sourceSequence: result.sourceSequence, sourceDigest: result.sourceDigest,
				sourceContextDigest: result.sourceContextDigest })).toEqual(result);
		} finally { original.close(); other.close(); floor.close(); }
	}, 240_000);

	it("refuses wrong selectors, a foreign author, cancellation and a closed session without any native change", async () => {
		const f = await fixture({ members: ["genesis", "genesis"], localMembers: [1, 2] });
		const { member, unresolved } = await revokedWithUnresolvedWork(f);
		const other = await f.open(2);
		const floor = new DatabaseSync(join(f.directory, "peer-1-external-floor.sqlite"), { readOnly: true });
		try {
			const image = async () => ({ native: await nativeImage(f, 1), other: await nativeImage(f, 2), head: (await f.readHead(1)).head,
				floor: floor.prepare("SELECT * FROM room_head").all() });
			const before = await image();
			const selector = { sourceSequence: unresolved.sourceSequence, sourceDigest: unresolved.sourceDigest, sourceContextDigest: unresolved.sourceContextDigest };
			const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
			const cancelled = new AbortController(); cancelled.abort();
			const differs = "creator source abandonment selector differs from the retained source";
			const refusals: [string, () => Promise<unknown>, string][] = [
				["wrong-digest", () => member.room.abandonUnresolvedAcceptedWork({ ...selector, sourceDigest: flip(selector.sourceDigest) }), differs],
				["wrong-context", () => member.room.abandonUnresolvedAcceptedWork({ ...selector, sourceContextDigest: flip(selector.sourceContextDigest) }), differs],
				["wrong-sequence", () => member.room.abandonUnresolvedAcceptedWork({ ...selector, sourceSequence: selector.sourceSequence + 7 }), differs],
				["extra-field", () => member.room.abandonUnresolvedAcceptedWork({ ...selector, sourceAuthor: "00" } as typeof selector),
					"creator source abandonment input is invalid"],
				["cancelled", () => member.room.abandonUnresolvedAcceptedWork({ ...selector, signal: cancelled.signal }),
					"creator source abandonment owner is unavailable"],
				// Another author's own owned session cannot abandon this author's source.
				["foreign-author", () => other.room.abandonUnresolvedAcceptedWork(selector), differs],
			];
			for (const [label, refusal, reason] of refusals) await expect(refusal(), label).rejects.toThrow(reason);
			expect(await image()).toEqual(before);
			expect(await member.room.unresolvedAcceptedWork()).toEqual([unresolved]);
			await f.stop(member);
			await expect(member.room.abandonUnresolvedAcceptedWork(selector)).rejects.toThrow("v3 local room session is closed");
			expect(await image()).toEqual(before);
		} finally { floor.close(); }
	}, 240_000);

	it("refuses replay after publication without any native change", async () => {
		const f = await fixture();
		const { member, original, unresolved } = await revokedWithUnresolvedWork(f, { publishSource: true });
		const before = await nativeImage(f, 1), head = (await f.readHead(1)).head;
		expect(before.outbox.find(row => row.sequence === original.commit.authorSequence)?.publishState).toBe("published");
		await expect(member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence, sourceDigest: unresolved.sourceDigest,
			sourceContextDigest: unresolved.sourceContextDigest })).rejects.toThrow("creator source abandonment requires unresolved never-published work");
		expect(await nativeImage(f, 1)).toEqual(before);
		expect((await f.readHead(1)).head).toEqual(head);
	}, 240_000);

	it("restricts abandonment to owned local sessions (app-supplied signers refuse)", async () => {
		const f = await fixture({ local: false });
		const { member, unresolved } = await revokedWithUnresolvedWork(f);
		const before = await nativeImage(f, 1);
		await expect(member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence, sourceDigest: unresolved.sourceDigest,
			sourceContextDigest: unresolved.sourceContextDigest })).rejects.toThrow("v3 room source abandonment requires an owned local session");
		expect(await nativeImage(f, 1)).toEqual(before);
	}, 240_000);

	it("keeps abandoned work terminal through Writer re-admission: never rebased, completed or published", async () => {
		const f = await fixture();
		const { creator, member, original, author, unresolved, published, gossip } = await revokedWithUnresolvedWork(f);
		const result = await member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence,
			sourceDigest: unresolved.sourceDigest, sourceContextDigest: unresolved.sourceContextDigest });
		gossip.allowed = true;
		const publishedBefore = published.length;
		await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		await member.room.issue(message("after-readmission"));
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		await member.room.requestRetainedRepair();
		await member.republish();
		const after = await nativeImage(f, 1);
		const entry = required(after.plan?.entries.find(value => value.sourceSequence === unresolved.sourceSequence));
		expect(entry).toMatchObject({ disposition: "expire", replacementSequence: null });
		expect(Buffer.from(required(entry.sourceResolutionDigest)).toString("hex")).toBe(result.expiryDigest);
		expect(after.outbox.find(row => row.sequence === original.commit.authorSequence)?.publishState).toBe("pending");
		// No replacement re-issues the abandoned operation, and its bytes never reach the wire.
		const reissued = (await f.issuedAfter(1, original.commit.authorSequence)).filter(row =>
			JSON.stringify(Reflect.get(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as object, "operation")).includes("before-removal"));
		expect(reissued).toEqual([]);
		const sourceHex = Buffer.from(original.commit.envelope.canonicalPreimageBytes).toString("hex");
		expect(published.slice(publishedBefore).some(bytes => Buffer.from(bytes).toString("hex").includes(sourceHex))).toBe(false);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect((creator.room.projection() as unknown as { messages: { clientOperationId: string }[] }).messages
			.map(row => row.clientOperationId)).not.toContain("before-removal");
	}, 240_000);
});
