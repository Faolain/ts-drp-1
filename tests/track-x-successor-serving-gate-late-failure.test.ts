import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";

// Track X, decision row 61 (RED first): a failed adoption never opens successor serving. A failure
// before or during the adoption's readiness is covered natively
// (tests/track-x-successor-material-wait.test.ts); the final `predecessorClose.stop()` of the
// adoption tail runs after the replacement authority and readiness are installed, and no native
// owner can be made to fail there, so this proof runs the exact source of the gate, the adoption
// tail and the adoption wrapper of packages/node/src/v3-room.ts (as astra's consult-3 probe did),
// with only the tail's collaborators stubbed. The file itself is never changed.

const settled = <T>(promise: Promise<T>): Promise<string> =>
	promise.then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);

interface Extracted {
	hold(closedEpoch: number, peerId: string, signal: AbortSignal): Promise<void>;
	adopt(): Promise<void>;
	adopted(closedEpoch: number): boolean;
	count(): number;
	terminal(): unknown;
}

/**
 * The exact gate, adoption tail and wrapper source, with the tail's collaborators stubbed.
 * @param stop - The predecessor close handle's stop.
 * @returns The extracted owners.
 */
function extracted(stop: () => Promise<void>): Extracted {
	const source = readFileSync("packages/node/src/v3-room.ts", "utf8");
	const gateStart = source.indexOf("\tlet startupServingReady = false;");
	const gateEnd = source.indexOf("\tconst serveSuccessor =", gateStart);
	const wrapperStart = source.indexOf("\tconst adoptCreatorSuccessor = (): Promise<void> => {");
	const wrapperEnd = source.indexOf("\t// Genuine room-native turnover", wrapperStart);
	const tailStart = source.lastIndexOf("\t\tactiveHandle = replacement;", wrapperStart);
	expect(gateStart).toBeGreaterThan(0);
	expect(gateEnd).toBeGreaterThan(gateStart);
	expect(tailStart).toBeGreaterThan(gateEnd);
	expect(wrapperEnd).toBeGreaterThan(wrapperStart);
	const body = `let creatorSuccessorAdoptionTask, successorProjectionAuthority = null, closed = false, terminalFailure;
${source.slice(gateStart, gateEnd)}
startupServingReady = true;
let activeHandle, replacement = {}, replacementOwned = true, creatorCloseHandle, rebound, creatorCloseUnavailableContinuity, startupReplay;
const authority = { epoch: 1 }, input = { receiveOnly: true }, settlementProfile = "none";
const installSuccessorProjectionBase = () => {}, commitSuccessorProjection = async () => {}, prepareCurrentCreatorOrdinaryReadiness = async () => {};
const predecessorClose = { stop };
const shutdown = async () => { closed = true; }, throwAfterJoinedCleanup = async (error) => { throw error; };
const publishAccepted = async () => {}, drainRebaseOutbox = async () => {};
const enqueueLifetimeTransition = (task) => Promise.resolve().then(task), assertSessionOpen = () => {};
let redirectPromise, redirectedSession, scheduledLulls;
const performCreatorSuccessorAdoption = async () => {
${source.slice(tailStart, wrapperStart)}
${source.slice(wrapperStart, wrapperEnd)}
return { hold: holdUntilSuccessorAdopted, adopt: adoptCreatorSuccessor, adopted: successorAdopted,
	count: () => successorServingHolds.size, terminal: () => terminalFailure };`;
	const compiled = transpileModule(body, {
		compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
	}).outputText;
	return new Function("stop", compiled)(stop) as Extracted;
}

it("a final predecessor-stop failure after the adoption's readiness leaves serving closed and the room failed", async () => {
	const gate = extracted(() => Promise.reject(new Error("TRACK_X_PREDECESSOR_STOP_FAILED")));
	const held = settled(gate.hold(0, "writer", new AbortController().signal));
	expect(await settled(gate.adopt())).toBe("failed: TRACK_X_PREDECESSOR_STOP_FAILED");
	expect(await held, "the held material response is not served").toBe("failed: creator successor serving is closed");
	expect(gate.terminal(), "the failure is the room's terminal failure").toBeInstanceOf(Error);
	expect(gate.adopted(0), "manifest and chunk serving stay refused").toBe(false);
	expect(gate.count()).toBe(0);
});

it("a successful adoption tail releases the held response", async () => {
	const gate = extracted(() => Promise.resolve());
	const held = settled(gate.hold(0, "writer", new AbortController().signal));
	expect(await settled(gate.adopt())).toBe("ok");
	expect(await held).toBe("ok");
	expect(gate.terminal()).toBeUndefined();
	expect(gate.adopted(0)).toBe(true);
	expect(gate.count()).toBe(0);
	// A repeated adoption is the same task's outcome or a new no-op one; serving stays open.
	expect(await settled(gate.adopt())).toBe("ok");
	expect(gate.adopted(0)).toBe(true);
});
