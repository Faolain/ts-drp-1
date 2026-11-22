import { describe, expect, it } from "vitest";

import { revalidateStoppedCleanupIdentities } from "./fixtures/phase-2e6-process-death-runner.js";
import type { ProcessCampaignAuthority, ProcessIdentity } from "./fixtures/process-forest.js";

const PROFILE = "/tmp/phase 2h/profile";
const CHROMIUM = "/opt/playwright/chromium/chrome";

type CampaignSignal = "SIGKILL" | "SIGSTOP";
type SignalEvent = readonly [target: number, signal: CampaignSignal | "SIGCONT"];

interface PinnedCampaignSignalDependencies {
	readonly authority: ProcessCampaignAuthority;
	captureForest(): readonly ProcessIdentity[];
	signal(target: number, signal: CampaignSignal | "SIGCONT"): void;
}

type ExecutePinnedCampaignSignalSequence = (
	dependencies: PinnedCampaignSignalDependencies
) => Promise<readonly ProcessIdentity[]>;

function identity(
	pid: number,
	ppid: number,
	pgid: number,
	command: string,
	state = "S",
	birthToken = `birth-${pid}`
): ProcessIdentity {
	return Object.freeze({ birthToken, command, pgid, pid, ppid, state });
}

function forest(state = "S"): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(90, 1, 80, "node playwright-controller.js", state),
		identity(100, 90, 100, "node phase-2e6-crash-child.js", state),
		identity(200, 100, 200, `${CHROMIUM} --user-data-dir=${PROFILE}`, state),
		identity(201, 200, 200, `${CHROMIUM} --type=zygote --user-data-dir=${PROFILE}`, state),
		identity(202, 201, 200, `${CHROMIUM} --type=renderer --user-data-dir=${PROFILE}`, state),
	]);
}

function authority(initial: readonly ProcessIdentity[]): ProcessCampaignAuthority {
	const childRoot = initial.find(({ pid }) => pid === 100);
	const browserRoot = initial.find(({ pid }) => pid === 200);
	if (childRoot === undefined || browserRoot === undefined) throw new TypeError("control roots are absent");
	return Object.freeze({
		browserRoot,
		childRoot,
		contentProcessClass: "chromium-renderer",
		controllerPgid: 80,
		executablePath: CHROMIUM,
		platform: "linux",
		profilePath: PROFILE,
		scope: "phase2h",
	});
}

async function signalSequenceOwner(): Promise<ExecutePinnedCampaignSignalSequence> {
	const runner = await import("./fixtures/phase-2e6-process-death-runner.js");
	const candidate = Reflect.get(runner, "executePinnedCampaignSignalSequence");
	expect(
		candidate,
		"missing injected executePinnedCampaignSignalSequence owner for the live runEdge stop/kill boundary"
	).toBeTypeOf("function");
	return candidate as ExecutePinnedCampaignSignalSequence;
}

async function executeWithCaptures(captures: readonly (readonly ProcessIdentity[])[]): Promise<
	Readonly<{
		events: readonly SignalEvent[];
		result: PromiseSettledResult<readonly ProcessIdentity[]>;
		timeline: readonly string[];
	}>
> {
	const execute = await signalSequenceOwner();
	const events: SignalEvent[] = [];
	const timeline: string[] = [];
	let captureIndex = 0;
	const result = await Promise.allSettled([
		execute({
			authority: authority(captures[0] as readonly ProcessIdentity[]),
			captureForest: () => {
				const capture = captures[captureIndex];
				timeline.push(`capture:${String(captureIndex)}`);
				captureIndex += 1;
				if (capture === undefined) throw new TypeError("signal owner captured more than once per negative-PGID effect");
				return capture;
			},
			signal: (target, signal) => {
				events.push(Object.freeze([target, signal]));
				timeline.push(`${signal}:${String(target)}`);
			},
		}),
	]);
	expect.soft(captureIndex).toBe(captures.length);
	return Object.freeze({
		events: Object.freeze(events),
		result: result[0] as PromiseSettledResult<readonly ProcessIdentity[]>,
		timeline: Object.freeze(timeline),
	});
}

describe("Phase 2h-d live signal authority corrective RED", () => {
	it("positive control: exact cleanup revalidation resumes a reused PID and grants no stale group", () => {
		const expected = identity(200, 100, 200, `${CHROMIUM} --user-data-dir=${PROFILE}`, "T");
		const reused = identity(200, 100, 300, `${CHROMIUM} --user-data-dir=${PROFILE}`, "S", "foreign-birth");
		const continued: number[] = [];

		const observed = revalidateStoppedCleanupIdentities([expected], [reused], (pid) => continued.push(pid));

		expect(continued).toEqual([200]);
		expect(observed.groups).toEqual([]);
		expect(observed.errors).toHaveLength(1);
	});

	it("RED: freshly validates before every negative-PGID stop and kill", async () => {
		const running = forest("S");
		const stopped = forest("T");

		const observed = await executeWithCaptures([running, stopped, stopped, stopped]);

		expect(observed.result.status).toBe("fulfilled");
		expect(observed.timeline).toEqual([
			"capture:0",
			"SIGSTOP:-100",
			"capture:1",
			"SIGSTOP:-200",
			"capture:2",
			"SIGKILL:-200",
			"capture:3",
			"SIGKILL:-100",
		]);
	});

	it("RED: a post-stop identity contradiction resumes only exact owned PIDs and sends no group kill", async () => {
		const running = forest("S");
		const afterChildStop = forest("T");
		const contradiction = forest("T").map((candidate) =>
			candidate.pid === 100 ? Object.freeze({ ...candidate, birthToken: "foreign-child-birth", pgid: 300 }) : candidate
		);

		const observed = await executeWithCaptures([running, afterChildStop, contradiction]);

		expect(observed.result.status).toBe("rejected");
		expect(observed.events).toEqual([
			[-100, "SIGSTOP"],
			[-200, "SIGSTOP"],
			[200, "SIGCONT"],
			[201, "SIGCONT"],
			[202, "SIGCONT"],
		]);
		expect(observed.events).not.toContainEqual([100, "SIGCONT"]);
		expect(observed.events.some(([target, signal]) => target < 0 && signal === "SIGKILL")).toBe(false);

		const commandContradiction = forest("T").map((candidate) =>
			candidate.pid === 200
				? Object.freeze({
						...candidate,
						command: "/opt/foreign/chrome --user-data-dir=/tmp/foreign-profile",
					})
				: candidate
		);
		const commandObserved = await executeWithCaptures([running, afterChildStop, commandContradiction]);

		expect(commandObserved.result.status).toBe("rejected");
		expect(commandObserved.events).toEqual([
			[-100, "SIGSTOP"],
			[-200, "SIGSTOP"],
			[100, "SIGCONT"],
			[200, "SIGCONT"],
			[201, "SIGCONT"],
			[202, "SIGCONT"],
		]);
		expect(commandObserved.events.some(([target, signal]) => target < 0 && signal === "SIGKILL")).toBe(false);
	});
});
