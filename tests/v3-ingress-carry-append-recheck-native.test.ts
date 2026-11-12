/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test helpers keep their inferred shapes. */
// A member's in-flight ingress job on the predecessor reaches the durable append after a same-epoch
// recovery revoked the plane, and the append lands after the successor rebuilt from the journal. The
// successor's index then lacks the row: the row reached its verdict on the dead plane, so the carry
// did not take it, and its child is held at the successor until delivery repair (a 5 s sweep, or a
// missing hint) brings the parent again: a visible stall in a game.
//
// The window is between the job's currency check (handleV3IngressWithSource) and its append. The
// test revokes the plane from inside it, synchronously from the plane's operation admission policy
// (reserve runs there), and the journal holds that row's durable write until the successor has read
// the journal: the stand-in for a job suspended across host turns in that window (the settlement
// source custody path awaits joinJournalReads there).
//
// The child must be admitted at the successor within 1 s, with no repair traffic.
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import {
	activateV3LivePlane,
	bindV3MissingDependencyRequest,
	carryV3PendingIngress,
	readV3RuntimeOwnerCensus,
	recoverV3LiveReplica,
	reofferV3CarriedPendingIngress,
	routeV3RetainedIngress,
	type V3CarriedPendingIngress,
	type V3PlaneHandle,
} from "../packages/node/src/v3-live.js";

type Fixture = Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>;

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SENDER = "peer:append-recheck:writer";
const IN_FLIGHT_VALUE = 4242;

async function eventually(check: () => boolean, ms: number) {
	for (const deadline = performance.now() + ms; performance.now() < deadline; ) {
		if (check()) return true;
		await sleep(10);
	}
	return check();
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("value is unavailable");
	return value;
}

it("a row whose append would land after the successor read the journal is carried: its child is admitted within 1 s, with no repair", async () => {
	const fixture = await createGenuinePreparedV3Fixture();
	fixtures.push(fixture);
	// The window hook: reserve runs after the job's currency check and before its append.
	let inWindow: (() => void) | undefined;
	const policy = Object.freeze({
		reserve(operation: Readonly<Record<string, unknown>>) {
			if (Reflect.get(operation, "value") === IN_FLIGHT_VALUE && inWindow !== undefined) {
				const hook = inWindow;
				inWindow = undefined;
				hook();
			}
			return Object.freeze({
				kind: "fresh" as const,
				commit: (): "committed" => "committed",
				release: (): void => undefined,
			});
		},
	});
	const recovered = await recover(fixture, fixture.capability, undefined, policy);
	const network = fakeNetwork("peer:append-recheck");
	const admitted = new Map<V3PlaneHandle, Set<string>>();
	const activate = (capability: Parameters<typeof activateV3LivePlane>[0]["capability"]): V3PlaneHandle => {
		const seen = new Set<string>();
		const activation = activateV3LivePlane({
			capability,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: network,
			onAdmittedVertex: vi.fn(({ vertex }: { vertex: { digest: Uint8Array } }) => {
				seen.add(Buffer.from(vertex.digest).toString("hex"));
				return Promise.resolve(Object.freeze({ kind: "continue" as const }));
			}) as never,
		});
		if (!activation.ok) throw new TypeError(`activation failed: ${activation.kind}`);
		admitted.set(activation.handle, seen);
		return activation.handle;
	};
	const predecessor = activate(recovered.capability);
	const topic = predecessor.topic;
	const gaps: { kind: string; peerId?: string }[] = [];
	bindV3MissingDependencyRequest(network, topic, (gap) => {
		if (gap !== undefined) gaps.push({ kind: gap.kind, ...(gap.peerId === undefined ? {} : { peerId: gap.peerId }) });
	});
	const row = async (authorSequence: number, dependency: string, value: number, logicalTime: number) => {
		const canonicalPreimageBytes = encodeCanonical({
			anchor: fixture.anchorDigest,
			author: fixture.author,
			authorSequence,
			dependencies: [dependency],
			epoch: 0,
			kind: "drp-vertex",
			logicalTime,
			objectId: fixture.objectId,
			operation: Object.freeze({ action: "add", value }),
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
		const signature = await fixture.signRegisteredVertexDigest(digest);
		return {
			digest: Buffer.from(digest).toString("hex"),
			message: Message.create({
				data: V3Envelope.encode({ canonicalPreimage: canonicalPreimageBytes, signature }).finish(),
				objectId: topic,
				sender: SENDER,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			}),
		};
	};
	const parent = await row(1, recovered.recoveryVertexDigest, IN_FLIGHT_VALUE, 2);
	const child = await row(2, parent.digest, IN_FLIGHT_VALUE + 1, 4);

	// The journal holds the parent's durable write until the successor has read the journal.
	const append = vi.mocked(recovered.journal.appendAccepted);
	const durableAppend = required(append.getMockImplementation());
	let releaseWrite!: () => void;
	const writeGate = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	let appendReached!: () => void;
	const reached = new Promise<"append">((resolve) => {
		appendReached = () => resolve("append");
	});
	let holding = true;
	append.mockImplementation(async (input) => {
		if (holding && Reflect.get(input, "vertexDigest") === parent.digest) {
			appendReached();
			await writeGate;
		}
		return durableAppend(input);
	});

	// The recovery revokes the predecessor inside the parent's window (the room opens the carry first).
	let carried: V3CarriedPendingIngress | undefined;
	inWindow = () => {
		carried = carryV3PendingIngress(predecessor);
		predecessor.deactivate();
	};
	expect(routeV3RetainedIngress(predecessor, parent.message)).toBe(true);
	const jobEnded = (async () => {
		await eventually(() => required(readV3RuntimeOwnerCensus(predecessor)).admittedInputJobs === 0, 30_000);
		return "ended" as const;
	})();
	await Promise.race([reached, jobEnded]);
	expect(inWindow, "the predecessor was revoked inside the parent's window").toBeUndefined();

	// The recovered successor reads the journal, binds the carry, and only then may a held write land.
	const prepared = await fixture.prepareAgain();
	const reopened = await recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
		issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
		issuanceStore: recovered.issuanceStore,
		liveJournalStore: recovered.journal,
	} as Parameters<typeof recoverV3LiveReplica>[0]);
	if (!reopened.ok) throw new TypeError(`successor recovery failed: ${reopened.kind}`);
	const successor = activate(reopened.capability);
	if (carried !== undefined) reofferV3CarriedPendingIngress(successor, carried);
	holding = false;
	releaseWrite();
	const missingBefore = gaps.filter((gap) => gap.kind === "missing").length;

	// The child reaches the successor.
	expect(routeV3RetainedIngress(successor, child.message)).toBe(true);
	const started = performance.now();
	const landed = await eventually(() => required(admitted.get(successor)).has(child.digest), 1_000);
	const ms = Math.round(performance.now() - started);
	console.log(
		"APPEND_RECHECK",
		JSON.stringify({ landed, ms, parentAtSuccessor: required(admitted.get(successor)).has(parent.digest) })
	);
	expect(landed, "the child is admitted at the successor within 1 s").toBe(true);
	expect(gaps.filter((gap) => gap.kind === "missing").length - missingBefore, "with no repair traffic").toBe(0);
	successor.deactivate();
}, 120_000);
