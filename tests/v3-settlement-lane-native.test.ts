/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test helpers keep their inferred shapes. */
import { readFileSync } from "node:fs";

import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import {
	activateV3LivePlane,
	readV3RuntimeOwnerCensus,
	routeV3RetainedIngress,
	type V3PlaneHandle,
} from "../packages/node/src/v3-live.js";

// fix/adoption-fence-reserved-input. A creator's adoption issues its mandatory author fence (the room's
// settlement drain, v3-room issueSettlement). That issue entered the plane through the caller input
// pool, which received rows share and which holds at most 32 jobs. In a five-Writer room the Writers'
// rows filled it at the roll (bx_6ytwadfw: "v3 room settlement issue failed: admission-rejected: v3
// input task capacity exhausted; retry after admitted work joins"), the fence was refused and the room
// stopped. The settlement drain's own issues (fence, replacement, frontier resolution) now have their
// own lane; received rows and caller moves keep their 32-job bound and never consume it.
//
// Genuine prepared live plane (the same fixture as v3-ingress-carry-ends-native): one local issue holds
// the FIFO at its signer, received rows queue behind it until the input pool refuses, and then the
// room's settlement issue is still admitted and completes once the FIFO moves.

type Fixture = Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>;

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_ADMITTED_INPUT_JOBS = 32;

async function eventually(check: () => boolean, ms = 30_000): Promise<boolean> {
	for (const deadline = performance.now() + ms; performance.now() < deadline; ) {
		if (check()) return true;
		await sleep(20);
	}
	return check();
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("value is unavailable");
	return value;
}

async function plane() {
	const fixture = await createGenuinePreparedV3Fixture();
	fixtures.push(fixture);
	const recovered = await recover(fixture, fixture.capability);
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
		networkNode: fakeNetwork("peer:settlement-lane"),
		onAdmittedVertex: vi.fn(() => Promise.resolve(Object.freeze({ kind: "continue" as const }))) as never,
	});
	if (!activation.ok) throw new TypeError(`activation failed: ${activation.kind}`);
	const handle = activation.handle;
	// A received row whose parent the plane lacks: authenticated, then held as pending ingress.
	const row = async (authorSequence: number) => {
		const canonicalPreimageBytes = encodeCanonical({
			anchor: fixture.anchorDigest,
			author: fixture.author,
			authorSequence,
			dependencies: ["ab".repeat(32)],
			epoch: 0,
			kind: "drp-vertex",
			logicalTime: 2,
			objectId: fixture.objectId,
			operation: Object.freeze({ action: "add", value: authorSequence }),
			protocolMajor: 3,
		});
		const signature = await fixture.signRegisteredVertexDigest(hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes));
		return Message.create({
			data: V3Envelope.encode({ canonicalPreimage: canonicalPreimageBytes, signature }).finish(),
			objectId: handle.topic,
			sender: "peer:settlement-lane:writer",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		});
	};
	// One local issue enters the FIFO and waits at its signer: everything after it queues.
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const signing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = handle.issueLocal({
		operations: [Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 77 }) })],
		signRegisteredVertexDigest: async (digest: Uint8Array) => {
			entered();
			await gate;
			return fixture.signRegisteredVertexDigest(digest);
		},
	});
	await signing;
	const census = () => required(readV3RuntimeOwnerCensus(handle));
	return { fixture, handle, row, held, release, census };
}

it("received rows fill the plane's input jobs at a roll; the room's own settlement issue is still admitted and completes", async () => {
	const p = await plane();
	// Received rows queue behind the held FIFO until the input pool refuses them (the route takes every
	// row; the pool refuses past its bound).
	for (let sequence = 2; sequence < 2 + 2 * MAX_ADMITTED_INPUT_JOBS; sequence++)
		routeV3RetainedIngress(p.handle, await p.row(sequence));
	expect(p.census().admittedInputJobs, "precondition: received rows hold every input job").toBe(MAX_ADMITTED_INPUT_JOBS);
	// A caller move is refused there: received rows keep their 32-job bound, unchanged.
	const move = await p.handle.issueLocal({
		operations: [Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 78 }) })],
		signRegisteredVertexDigest: (digest: Uint8Array) => p.fixture.signRegisteredVertexDigest(digest),
	});
	expect(move).toMatchObject({ ok: false, kind: "admission-rejected" });
	// The room's settlement issue (its adoption fence) takes its own lane: admitted, not refused.
	const settlementIssue = p.handle.issueSettlementLocal;
	expect(settlementIssue, "the plane offers the settlement lane").toBeTypeOf("function");
	const fence = required(settlementIssue)({
		operations: [Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 79 }) })],
		signRegisteredVertexDigest: (digest: Uint8Array) => p.fixture.signRegisteredVertexDigest(digest),
	});
	const early = await Promise.race([fence.then((result) => ({ settled: result })), sleep(200).then(() => "queued" as const)]);
	expect(early, "admitted behind the held FIFO, not refused for input capacity").toBe("queued");
	expect(p.census().admittedInputJobs, "it consumed no input job").toBe(MAX_ADMITTED_INPUT_JOBS);
	p.release();
	expect(await p.held).toMatchObject({ ok: true });
	expect(await fence, "the settlement issue completes once the FIFO moves").toMatchObject({ ok: true });
	expect(await eventually(() => p.census().admittedInputJobs === 0), "the received rows' jobs ended").toBe(true);
	p.handle.deactivate();
}, 120_000);

it("the room's settlement drain issues its fence through the settlement lane", () => {
	const room = readFileSync(new URL("../packages/node/src/v3-room.ts", import.meta.url), "utf8");
	expect(room).toContain("await (activeHandle.issueSettlementLocal ?? activeHandle.issueLocal)(localInput);");
	const live = readFileSync(new URL("../packages/node/src/v3-live.ts", import.meta.url), "utf8");
	// Replacements and frontier resolutions are the drain's own work too.
	expect(live.match(/pool: "settlement",/gu)?.length).toBe(2);
	expect(live).toContain(': enqueueLocalIssue(registration, input, "settlement"),');
});
