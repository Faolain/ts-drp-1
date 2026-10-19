import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { maintainCreatorRecipientRecoveryPool } from "../src/creator-adoption.js";

const root = new URL("../src/", import.meta.url);
const adoption = readFileSync(new URL("creator-adoption.ts", root), "utf8");
const live = readFileSync(new URL("v3-live.ts", root), "utf8");
const room = readFileSync(new URL("v3-room.ts", root), "utf8");

// Any touch of an unrelated port is a boundary leak, not an unsupported result.
const untouchable = (): never =>
	new Proxy(
		{},
		{
			get(_target, key) {
				throw new Error(`unexpected port access: ${String(key)}`);
			},
		}
	) as never;

describe("recipient early recovery-pool maintenance", () => {
	it("refuses a plane without recipient registration before touching any port", async () => {
		await expect(
			maintainCreatorRecipientRecoveryPool({
				plane: {} as never,
				catalog: untouchable(),
				expectedRoomHead: { objectId: "object", epoch: 3, currentAnchorDigest: "00".repeat(32) },
				snapshotStore: untouchable(),
				recoveryContext: untouchable(),
			})
		).resolves.toEqual({ kind: "deferred", reason: "unsupported" });
	});

	it("shares one turnover predicate and pass loop between install and the lull", () => {
		expect(adoption.match(/receivedRecoveryTurnoverDue\(/gu)?.length).toBe(3);
		expect(adoption.match(/runReceivedRecoveryTurnoverPasses\(/gu)?.length).toBe(3);
		const install = adoption.slice(adoption.indexOf("const prepareReceivedRecoveryTurnover"));
		expect(install.slice(0, install.indexOf("return true;"))).toContain("source.sealReceivedRecoveryDependencies(");
	});

	it("runs the lull under the received gate and halts after any failure past entry", () => {
		const body = live.slice(live.indexOf("async function runCreatorReceivedRecoveryMaintenance("));
		const lull = body.slice(0, body.indexOf("\n}\n"));
		expect(lull).toContain("registration.blueprintClosing = true;");
		expect(lull).toContain("registration.receivedTransition = true;");
		expect(lull).toContain("registration.operationAdmissionHalted = true;");
		expect(lull).toContain("if (deferrable) return \"deferred\";");
		expect(lull.indexOf("registration.receivedTransition = false;")).toBeGreaterThan(lull.indexOf('!== "complete"'));
	});

	it("queues ingress behind a deferrable lull and clears the queue gate on every exit", () => {
		const body = live.slice(live.indexOf("async function runCreatorReceivedRecoveryMaintenance("));
		const lull = body.slice(0, body.indexOf("\n}\n"));
		expect(lull).toContain("registration.readinessMaintenanceEntered = deferrable;");
		const halt = lull.slice(lull.indexOf("registration.operationAdmissionHalted = true;"));
		expect(halt.slice(0, halt.indexOf("throw "))).toContain("registration.readinessMaintenanceEntered = false;");
		const reopen = lull.slice(lull.indexOf("registration.blueprintClosing = false;"));
		expect(reopen).toContain("registration.readinessMaintenanceEntered = false;");
		expect(live).toMatch(/registration\.blueprintClosing && registration\.readinessMaintenanceEntered !== true\) return Promise\.resolve\(\);/u);
	});

	it("routes recipient sessions through the lifecycle FIFO with the issue barrier", () => {
		const body = room.slice(room.indexOf("const maintainRecipientRecoveryPool = async"));
		const recipient = body.slice(0, body.indexOf("\n\t};\n"));
		expect(recipient).toContain("poolMaintenanceBarrier");
		expect(recipient).toContain("await drainPendingIssues();");
		expect(recipient).toContain("creatorRecipientRecoveryRequired = true;");
		expect(recipient).toContain("requestRetainedHistory()");
		expect(room).toMatch(/if \(input\.receiveOnly \|\| creatorCloseHandle === undefined\) return maintainRecipientRecoveryPool\(\);/u);
	});

	it("keeps install-path cuts bound to the same owners", () => {
		// Hot handoff resumes publication only over the same original store and scope.
		const handoff = live.slice(live.indexOf("registration.hotPredecessor = new WeakRefConstructor(existing);"));
		const carry = handoff.slice(0, handoff.indexOf("registration.publicationCursor = existing.publicationCursor;"));
		expect(carry).toContain("creatorOriginalIssuanceStore(existing) ===");
		expect(carry).toContain("existing.issuanceScope.objectId === selectedScope.objectId");
		expect(carry).toContain("existing.issuanceScope.author === selectedScope.author");
		// Receive currency re-reads the native head only after the full initial inspection.
		const receive = adoption.slice(adoption.indexOf("export async function receiveCreatorSuccessorAdoption("));
		expect(receive.match(/await inspectHead\(/gu)?.length).toBe(1);
		expect(receive.match(/await nativeHeadUnchanged\(/gu)?.length).toBe(3);
	});
});
