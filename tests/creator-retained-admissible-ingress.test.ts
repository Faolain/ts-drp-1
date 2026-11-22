/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
// The hold-unavailable family, branch A: a Writer move whose received-append maintenance capture
// is refused transiently stays retained as pending ingress with every parent admitted.
//
// Observed under CPU load (8 concurrent runs on 8 vCPU): the creator's received-append maintenance
// capture refuses (a stale settlement preview, "admission was revoked", "aborted"); the error path
// retains the authenticated row (v3-live retainPendingIngress) and nothing drains it again, because
// the issuance maintenance job never resumes pending ingress when it ends (the readiness and the
// recovery-pool jobs do). The creator's next local issue walks pending ingress in its recovery
// census, which refuses a pending row whose parents are all admitted, so the issue fails
// permanently: "creator recovery dependency hold unavailable:replay".
//
// The fault seam here is the creator's durable lineage read (the fixture's failRecoveryReadFor),
// which the received-append maintenance capture reads: it refuses that capture exactly once
// ("received-maintenance-capture:F5B_RECOVERY_DURABLE_READ_UNAVAILABLE") and retains the row, as
// the load-induced refusals do. Model: packages/node/formal/member-received-close-pending-release.qnt
// (noAdmissibleRefusal; resume drains a retained admissible row).
import "fake-indexeddb/auto";
import { hashDomain } from "@ts-drp/canonical";
import { V3Envelope } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	hex,
	observed,
	openRoom,
	originalStorage,
	type Peer,
	record,
	required,
	sessions,
} from "./fixtures/grid-room-workload.js";
import { readV3RuntimeOwnerCensus } from "../packages/node/src/v3-live.js";

function ownCommits(peer: Peer) {
	return observed.commits.filter(
		(row) => row.issuedRecord.scope.objectId === peer.input.objectId && row.issuedRecord.scope.author === peer.author
	);
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
	observed.stores.clear();
	observed.planes.clear();
	observed.commits = [];
	observed.advances = [];
	observed.failSuffixFor = "";
	observed.faults = 0;
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	observed.issueAttempts = [];
	observed.commitHandles.clear();
	observed.issuePlans.clear();
	observed.timeline = [];
	observed.ambiguities = [];
	observed.publications = [];
	observed.planWrites = [];
	observed.prunes = [];
	observed.cleanup = [];
	observed.closeGraphs = [];
	observed.snapshots = [];
});
afterEach(async () => {
	await Promise.all([...sessions].map((room) => room.close().catch(() => undefined)));
	sessions.clear();
	vi.restoreAllMocks();
	// A one-shot seam installs an accessor; restore the fixture's plain data property.
	Object.defineProperty(observed, "failRecoveryReadFor", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: "",
	});
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens a creator and one Writer, admits a prefix from each, then delivers one Writer move to the
 * creator while `fault` refuses the creator's received-append maintenance capture.
 * @param fault - Installs the seam just before the delivery (given the creator and its plane).
 * @returns The fixture, the peers, the creator's plane and the delivered move's digest.
 */
async function retainedAdmissibleMove(
	fault: (creator: Peer, plane: Parameters<typeof readV3RuntimeOwnerCensus>[0]) => void
) {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "retained-creator-0");
	await fixture.issue(writer, "retained-writer-0");
	const prefix = hex(required(ownCommits(writer).at(-1)).envelope.digest);
	const deadline = Date.now() + 60_000;
	while (!fixture.received.has(prefix)) {
		expect(Date.now(), "RETAINED_PREFIX_ADMITTED").toBeLessThan(deadline);
		await sleep(50);
	}
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "retained-writer-1");
	const digest = hex(required(ownCommits(writer).at(-1)).envelope.digest);
	const move = required(
		fixture.envelopes.find(
			(message) => hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) === digest
		)
	);
	const plane = required(observed.planes.get(creator.databaseName));
	fault(creator, plane);
	fixture.deliver(move);
	return { fixture, creator, writer, plane, digest };
}

describe("hold-unavailable (A): a transiently refused Writer move retained with every parent admitted", () => {
	it("[RED] the creator's next local issue carries the retained row in its census and does not fail", async () => {
		const { fixture, creator, plane, digest } = await retainedAdmissibleMove((peer) => {
			observed.failRecoveryReadFor = peer.databaseName;
		});
		const deadline = Date.now() + 30_000;
		while (readV3RuntimeOwnerCensus(plane)?.pendingIngress !== 1) {
			expect(Date.now(), "RETAINED_ROW_HELD_AS_PENDING_INGRESS").toBeLessThan(deadline);
			await sleep(50);
		}
		// The refusal persists through every retry of its own; only then does it clear.
		await sleep(500);
		expect(fixture.received.has(digest), "RETAINED_ROW_NOT_ADMITTED_WHILE_REFUSED").toBe(false);
		observed.failRecoveryReadFor = "";

		// room.issue resolves on success and rejects with the refusal ("hold unavailable:replay").
		const issued = await creator.room
			.issue({ action: "message", clientOperationId: "retained-creator-1", text: "retained-creator-1" })
			.then(
				() => "ok",
				(error: unknown) => (error instanceof Error ? error.message : String(error))
			);
		expect(issued, "RETAINED_ROW_LOCAL_ISSUE_SUCCEEDS").toBe("ok");
		const own = required(ownCommits(creator).at(-1));
		expect(
			record(own.envelope.canonicalPreimageBytes).dependencies as string[],
			"RETAINED_ROW_NEVER_A_LOCAL_DEPENDENCY_BEFORE_ADMISSION"
		).not.toContain(digest);
		// After the issue, the retained row is admitted exactly once and leaves pending ingress.
		while (!fixture.received.has(digest) || readV3RuntimeOwnerCensus(plane)?.pendingIngress !== 0) {
			expect(Date.now(), "RETAINED_ROW_ADMITTED_AFTER_THE_ISSUE").toBeLessThan(deadline + 30_000);
			await sleep(50);
		}
		await Promise.all(fixture.peers.map(fixture.stop));
	}, 180_000);

	it("[RED] a refusal that clears is retried when the maintenance job ends: the row is admitted without another issue", async () => {
		let refused = 0;
		let retained = false;
		const { fixture, plane, digest } = await retainedAdmissibleMove((peer, creatorPlane) => {
			// Refuse the creator's lineage reads until the received-append capture has failed and
			// retained the row (one refusal), then let every read through: the refusal has cleared.
			Object.defineProperty(observed, "failRecoveryReadFor", {
				configurable: true,
				enumerable: true,
				get: () => {
					if (!retained && readV3RuntimeOwnerCensus(creatorPlane)?.pendingIngress === 1) retained = true;
					if (retained) return "";
					refused++;
					return peer.databaseName;
				},
				set: () => undefined,
			});
		});
		const started = performance.now();
		const deadline = Date.now() + 15_000;
		while (!fixture.received.has(digest)) {
			expect(Date.now(), "RETRIED_ROW_ADMITTED_WITHOUT_A_LOCAL_ISSUE").toBeLessThan(deadline);
			await sleep(25);
		}
		expect(retained, "RETRIED_ROW_WAS_RETAINED_BEFORE_ITS_ADMISSION").toBe(true);
		expect(refused, "RETRIED_ROW_SEAM_REFUSED").toBeGreaterThan(0);
		expect(readV3RuntimeOwnerCensus(plane)?.pendingIngress, "RETRIED_ROW_LEAVES_PENDING_INGRESS").toBe(0);
		console.log("RETAINED_ROW_RETRY_ADMISSION_MS", Math.round(performance.now() - started));
		await Promise.all(fixture.peers.map(fixture.stop));
	}, 180_000);
});
