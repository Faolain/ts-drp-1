import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// Track X, decision row 51: the readiness ingress hold. These run the actual bodies of
// trackRegistrationJoinedWork, enqueueRegistrationTask, enqueueV3Ingress,
// holdV3IngressForReadiness and authenticateV3Ingress (v3-live.ts) and
// prepareCreatorOrdinaryReadiness (creator-close.ts) with controlled premises: the plane FIFO,
// the input pool and its counters are the real ones; capture and envelope decoding are stubs.
// Native admission is exercised by tests/track-x-readiness-hold-red.test.ts on the node host.

const liveSource = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const closeSource = readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8");
const liveTree = ts.createSourceFile("live.ts", liveSource, ts.ScriptTarget.Latest, true);
const closeTree = ts.createSourceFile("close.ts", closeSource, ts.ScriptTarget.Latest, true);

function declaration(tree: ts.SourceFile, name: string): string {
	const nodes = tree.statements.filter(
		(node): node is ts.FunctionDeclaration | ts.ClassDeclaration =>
			(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name
	);
	if (nodes.length !== 1) throw new Error(`missing actual declaration:${name}:${nodes.length}`);
	return nodes[0].getText(tree).replace(/^export\s+/, "");
}

function load(tree: ts.SourceFile, names: string[], bindings: Record<string, unknown>): Record<string, unknown> {
	const js = ts.transpileModule(
		`${names.map((name) => declaration(tree, name)).join("\n")}\nreturn {${names.join(",")}};`,
		{
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		}
	).outputText;
	return new Function("__bindings", `const {${Object.keys(bindings).join(",")}}=__bindings;${js}`)(bindings) as Record<
		string,
		unknown
	>;
}

function constant(name: string): number {
	const match = new RegExp(`^const ${name} = (\\d+);$`, "m").exec(liveSource);
	if (match === null) throw new Error(`missing actual constant:${name}`);
	return Number(match[1]);
}

const MAX_ADMITTED_INPUT_JOBS = constant("MAX_ADMITTED_INPUT_JOBS");

interface Registration {
	gate?: Promise<void>;
	joinedWork: Set<Promise<void>>;
	admittedInputJobs: number;
	admittedReadControlJobs: number;
	admittedPendingPublicationJobs: number;
	admittedEgressControlJobs: number;
	admittedInputBytes: number;
	payload: { parameters: { maxPendingEntries: number; maxPendingBytes: number } };
	blueprintClosing: boolean;
	readinessMaintenanceEntered?: boolean;
	terminalBarrier?: Promise<void>;
	readinessIngressHold?: Promise<void>;
	retainedReplayReadPhase?: Readonly<{ kind: string }>;
	retainedBootstrapHold: boolean;
}

interface Message {
	id: number;
	bytes: number;
}

type Hold = (registration: Registration) => Promise<(successful: boolean) => void>;
type Enqueue = (registration: Registration, message: Message, transport?: "gossip" | "retained") => Promise<void>;
type Task = <Result>(
	registration: Registration,
	capture: () => () => Promise<Result>,
	inputAdmission?: Readonly<{ refuse(): Result }>
) => Promise<Result>;

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

function plane(maxPendingBytes = 1_048_576): {
	registration: Registration;
	state: { current: boolean };
	logs: string[];
	decoded: number[];
	hold: Hold;
	enqueue: Enqueue;
	task: Task;
} {
	const registration: Registration = {
		joinedWork: new Set(),
		admittedInputJobs: 0,
		admittedReadControlJobs: 0,
		admittedPendingPublicationJobs: 0,
		admittedEgressControlJobs: 0,
		admittedInputBytes: 0,
		payload: { parameters: { maxPendingEntries: 1024, maxPendingBytes } },
		blueprintClosing: false,
		retainedBootstrapHold: false,
	};
	const state = { current: true };
	const logs: string[] = [];
	const decoded: number[] = [];
	const loaded = load(
		liveTree,
		[
			"InputCaptureCapacityError",
			"trackRegistrationJoinedWork",
			"enqueueRegistrationTask",
			"authenticateV3Ingress",
			"enqueueV3Ingress",
			"holdV3IngressForReadiness",
			"beginRetainedReplayTransition",
			"retireRetainedReplay",
			"releaseRetainedReplayPrefix",
		],
		{
			ReflectApply: Reflect.apply,
			SetPrototypeAdd: Set.prototype.add,
			SetPrototypeDelete: Set.prototype.delete,
			MAX_ADMITTED_INPUT_JOBS,
			MAX_ADMITTED_READ_CONTROL_JOBS: constant("MAX_ADMITTED_READ_CONTROL_JOBS"),
			MAX_ADMITTED_PENDING_PUBLICATION_JOBS: constant("MAX_ADMITTED_PENDING_PUBLICATION_JOBS"),
			MAX_ADMITTED_EGRESS_CONTROL_JOBS: constant("MAX_ADMITTED_EGRESS_CONTROL_JOBS"),
			currentRegistration: (value: Registration) => value === registration && state.current,
			ingressFailureLog: (category: string, stage?: string) => {
				logs.push(stage === undefined ? category : `${category}:${stage}`);
			},
			// The actual capture charges the exact wire bytes to the same custody.
			captureV3Ingress: (
				_: Registration,
				message: Message,
				transport: string,
				custody: { chargeBytes(bytes: number): void }
			) => {
				custody.chargeBytes(message.bytes);
				return { exactWireBytes: Uint8Array.of(message.id), transport };
			},
			// Past authenticateV3Ingress's gates, the first step decodes the envelope.
			V3Envelope: {
				decode: (bytes: Uint8Array) => {
					decoded.push(bytes[0]);
					throw new Error("stub envelope");
				},
			},
		}
	);
	return {
		registration,
		state,
		logs,
		decoded,
		hold: loaded.holdV3IngressForReadiness as Hold,
		enqueue: loaded.enqueueV3Ingress as Enqueue,
		task: loaded.enqueueRegistrationTask as Task,
	};
}

describe("readiness ingress hold: arrivals wait outside the FIFO", () => {
	it("captures and charges each arrival to the input pool, takes no FIFO reservation, and admits in arrival order after release", async () => {
		const f = plane();
		const release = await f.hold(f.registration);
		const gate = f.registration.gate;
		const arrivals = [1, 2, 3].map((id) => f.enqueue(f.registration, { id, bytes: 10 }));
		await settle();
		expect(f.registration.admittedInputJobs).toBe(3);
		expect(f.registration.admittedInputBytes).toBe(30);
		expect(f.registration.joinedWork.size).toBe(3);
		expect(f.registration.gate, "held arrivals reserve no FIFO slot").toBe(gate);
		expect(f.decoded).toEqual([]);
		// A FIFO task queued after the held arrivals (the job's own maintenance slot, a local
		// issue) runs while they wait: nothing in the FIFO waits on the hold.
		const order: string[] = [];
		await f.task(f.registration, () => async () => {
			order.push("fifo-task");
		});
		expect(order).toEqual(["fifo-task"]);
		expect(f.decoded).toEqual([]);
		release(true);
		await Promise.all(arrivals);
		expect(f.decoded).toEqual([1, 2, 3]);
		expect(f.logs).toEqual(["envelope-rejected", "envelope-rejected", "envelope-rejected"]);
		expect(f.registration.admittedInputJobs).toBe(0);
		expect(f.registration.admittedInputBytes).toBe(0);
		expect(f.registration.joinedWork.size).toBe(0);
		expect(f.registration.readinessIngressHold).toBeUndefined();
		expect(f.registration.retainedReplayReadPhase).toBeUndefined();
		// After release, an arrival goes straight to the FIFO.
		await f.enqueue(f.registration, { id: 4, bytes: 10 });
		expect(f.decoded).toEqual([1, 2, 3, 4]);
	});

	it("flushes every task queued before the hold first", async () => {
		const f = plane();
		const earlier = deferred();
		const order: string[] = [];
		const queued = f.task(f.registration, () => async () => {
			await earlier.promise;
			order.push("earlier-task");
		});
		let held = false;
		const holding = f.hold(f.registration).then((release) => {
			held = true;
			order.push("held");
			return release;
		});
		// The hold is set at once: an arrival during the flush already waits behind it.
		expect(f.registration.readinessIngressHold).toBeDefined();
		const arrival = f.enqueue(f.registration, { id: 7, bytes: 10 });
		await settle();
		expect(held).toBe(false);
		earlier.resolve();
		await queued;
		const release = await holding;
		expect(order).toEqual(["earlier-task", "held"]);
		expect(f.decoded).toEqual([]);
		release(true);
		await arrival;
		expect(f.decoded).toEqual([7]);
	});

	it("waits for both a terminal barrier and the hold", async () => {
		const f = plane();
		const terminal = deferred();
		f.registration.terminalBarrier = terminal.promise;
		const release = await f.hold(f.registration);
		const arrival = f.enqueue(f.registration, { id: 9, bytes: 10 });
		release(true);
		await settle();
		expect(f.decoded).toEqual([]);
		terminal.resolve();
		await arrival;
		expect(f.decoded).toEqual([9]);
	});
});

describe("readiness ingress hold: the closing gate", () => {
	it("with no hold, a closing gate (a seal or a close) still drops at enqueue; only an entered readiness boundary queues", async () => {
		for (const entered of [undefined, false]) {
			const f = plane();
			f.registration.blueprintClosing = true;
			f.registration.readinessMaintenanceEntered = entered;
			await f.enqueue(f.registration, { id: 1, bytes: 10 });
			expect(f.registration.admittedInputJobs).toBe(0);
			expect(f.decoded).toEqual([]);
		}
		// The entered boundary holds its FIFO slot; the arrival queues behind it.
		const boundary = plane();
		const slot = deferred();
		const boundarySlot = boundary.task(boundary.registration, () => async () => {
			await slot.promise;
			boundary.registration.blueprintClosing = false;
			boundary.registration.readinessMaintenanceEntered = false;
		});
		boundary.registration.blueprintClosing = true;
		boundary.registration.readinessMaintenanceEntered = true;
		const queued = boundary.enqueue(boundary.registration, { id: 2, bytes: 10 });
		slot.resolve();
		await Promise.all([boundarySlot, queued]);
		expect(boundary.decoded).toEqual([2]);
	});

	it("under a hold, an arrival during a closing gate queues and then meets the gate at authentication", async () => {
		// The gate stays set (a failed readiness boundary leaves it; a close sets it).
		const kept = plane();
		const releaseKept = await kept.hold(kept.registration);
		kept.registration.blueprintClosing = true;
		const arrival = kept.enqueue(kept.registration, { id: 3, bytes: 10 });
		await settle();
		expect(kept.registration.admittedInputJobs).toBe(1);
		releaseKept(false);
		await arrival;
		expect(kept.decoded, "dropped by authenticateV3Ingress's own gate, as today").toEqual([]);
		expect(kept.logs).toEqual([]);
		expect(kept.registration.admittedInputJobs).toBe(0);
		// The gate is cleared before release (a successful readiness boundary): admitted normally.
		const cleared = plane();
		const releaseCleared = await cleared.hold(cleared.registration);
		cleared.registration.blueprintClosing = true;
		const later = cleared.enqueue(cleared.registration, { id: 4, bytes: 10 });
		cleared.registration.blueprintClosing = false;
		releaseCleared(true);
		await later;
		expect(cleared.decoded).toEqual([4]);
	});

	it("drops held arrivals of a plane that was deactivated meanwhile", async () => {
		const f = plane();
		const release = await f.hold(f.registration);
		const arrival = f.enqueue(f.registration, { id: 5, bytes: 10 });
		await settle();
		f.state.current = false;
		release(true);
		await arrival;
		expect(f.decoded).toEqual([]);
		expect(f.registration.admittedInputJobs).toBe(0);
		expect(f.registration.joinedWork.size).toBe(0);
	});
});

describe("readiness ingress hold: the bounded input pool", () => {
	/**
	 * Fills the input pool with held arrivals, then sends one more.
	 * @param block - Holds the plane either by the readiness hold or by a busy FIFO task.
	 * @param maxPendingBytes - The plane's input byte bound.
	 * @param count - The number of arrivals to send.
	 * @returns The logs, decodes and counters at the moment the pool is full, and after.
	 */
	async function fill(block: "hold" | "busy-fifo", maxPendingBytes: number, count: number) {
		const f = plane(maxPendingBytes);
		const busy = deferred();
		let release = (_successful: boolean): void => busy.resolve();
		let busyTask: Promise<void> | undefined;
		if (block === "hold") release = await f.hold(f.registration);
		else busyTask = f.task(f.registration, () => () => busy.promise);
		const arrivals = Array.from({ length: count }, (_, index) => f.enqueue(f.registration, { id: index, bytes: 10 }));
		await settle();
		const full = {
			logs: [...f.logs],
			jobs: f.registration.admittedInputJobs,
			bytes: f.registration.admittedInputBytes,
		};
		release(true);
		await Promise.all(arrivals);
		await busyTask;
		return { full, decoded: f.decoded.length, after: f.registration.admittedInputJobs };
	}

	it("refuses the arrival past 32 jobs with the existing input-pool refusal, exactly as behind a busy FIFO", async () => {
		const held = await fill("hold", 1_048_576, MAX_ADMITTED_INPUT_JOBS + 3);
		const busy = await fill("busy-fifo", 1_048_576, MAX_ADMITTED_INPUT_JOBS + 3);
		expect(held.full).toEqual({
			logs: ["admission-rejected", "admission-rejected", "admission-rejected"],
			jobs: MAX_ADMITTED_INPUT_JOBS,
			bytes: MAX_ADMITTED_INPUT_JOBS * 10,
		});
		expect(held).toEqual(busy);
		expect(held.decoded).toBe(MAX_ADMITTED_INPUT_JOBS);
		expect(held.after).toBe(0);
	});

	it("refuses the arrival past maxPendingBytes with the existing capture refusal, exactly as behind a busy FIFO", async () => {
		const held = await fill("hold", 55, 7);
		const busy = await fill("busy-fifo", 55, 7);
		expect(held.full).toEqual({ logs: ["admission-rejected", "admission-rejected"], jobs: 5, bytes: 50 });
		expect(held).toEqual(busy);
		expect(held.decoded).toBe(5);
	});
});

describe("readiness ingress hold: release on every path", () => {
	it("refuses a hold on an unavailable plane or while one is set, without disturbing the first", async () => {
		const f = plane();
		const release = await f.hold(f.registration);
		const first = f.registration.readinessIngressHold;
		await expect(f.hold(f.registration)).rejects.toThrow("creator readiness ingress hold is unavailable");
		expect(f.registration.readinessIngressHold).toBe(first);
		release(true);
		release(true);
		expect(f.registration.readinessIngressHold).toBeUndefined();
		f.state.current = false;
		await expect(f.hold(f.registration)).rejects.toThrow("creator readiness ingress hold is unavailable");
		expect(f.registration.readinessIngressHold).toBeUndefined();
	});

	it("releases the hold, and every arrival behind it, when the flush throws", async () => {
		const f = plane();
		const gate = deferred();
		f.registration.gate = gate.promise.then(() => {
			throw new Error("flush failed");
		});
		const holding = f.hold(f.registration);
		const arrival = f.enqueue(f.registration, { id: 6, bytes: 10 });
		gate.resolve();
		await expect(holding).rejects.toThrow("flush failed");
		expect(f.registration.retainedReplayReadPhase).toEqual({ kind: "unavailable" });
		expect(f.registration.readinessIngressHold).toBeUndefined();
		await arrival;
		expect(f.decoded).toEqual([6]);
		expect(f.registration.admittedInputJobs).toBe(0);
	});

	it("prepareCreatorOrdinaryReadiness releases after the job settles: success, failure, terminal failure, synchronous throw", async () => {
		const outcomes = {
			success: (): Promise<void> => Promise.resolve(),
			failure: (): Promise<void> => Promise.reject(new TypeError("creator ordinary readiness admission was revoked")),
			terminal: (): Promise<void> => Promise.reject(new AggregateError([new Error("release")], "terminal")),
			throws: (): Promise<void> => {
				throw new TypeError("creator ordinary readiness owner is unavailable");
			},
		};
		for (const [name, job] of Object.entries(outcomes)) {
			const calls: string[] = [];
			const handle = {};
			const owner = {
				holdIngressForReadiness: async () => {
					calls.push("hold");
					return (successful: boolean): number => calls.push(`release:${successful}`);
				},
				prepareOrdinaryReadiness: async () => {
					calls.push("prepare");
					await Promise.resolve();
					await job();
					calls.push("prepared");
				},
			};
			const prepare = load(closeTree, ["prepareCreatorOrdinaryReadiness"], {
				runtimeReleaseOwners: new WeakMap([[handle, owner]]),
				bindings: new WeakMap([[handle, {}]]),
			}).prepareCreatorOrdinaryReadiness as (plane: object) => Promise<void>;
			const result = prepare(handle).then(
				() => "resolved",
				(error: Error) => error.message
			);
			if (name === "success") {
				await expect(result).resolves.toBe("resolved");
				expect(calls).toEqual(["hold", "prepare", "prepared", "release:true"]);
			} else {
				await expect(result).resolves.not.toBe("resolved");
				expect(calls, name).toEqual(["hold", "prepare", "release:false"]);
			}
		}
	});

	it("prepareCreatorOrdinaryReadiness never runs the job when the hold cannot be taken", async () => {
		const calls: string[] = [];
		const handle = {};
		const owner = {
			holdIngressForReadiness: () => Promise.reject(new TypeError("creator readiness ingress hold is unavailable")),
			prepareOrdinaryReadiness: async () => {
				calls.push("prepare");
			},
		};
		const prepare = load(closeTree, ["prepareCreatorOrdinaryReadiness"], {
			runtimeReleaseOwners: new WeakMap([[handle, owner]]),
			bindings: new WeakMap([[handle, {}]]),
		}).prepareCreatorOrdinaryReadiness as (plane: object) => Promise<void>;
		await expect(prepare(handle)).rejects.toThrow("creator readiness ingress hold is unavailable");
		expect(calls).toEqual([]);
	});
});

describe("readiness ingress hold: no FIFO task can await it", () => {
	/**
	 * The names of the top-level declarations whose text mentions an identifier.
	 * @param tree - The parsed source.
	 * @param identifier - The identifier.
	 * @returns The declaring statements' names, once each.
	 */
	function holders(tree: ts.SourceFile, identifier: string): string[] {
		const names = new Set<string>();
		for (const statement of tree.statements) {
			let found = false;
			const visit = (node: ts.Node): void => {
				if (found) return;
				if (ts.isIdentifier(node) && node.text === identifier) found = true;
				else ts.forEachChild(node, visit);
			};
			visit(statement);
			if (!found) continue;
			const named = statement as ts.Node & { name?: ts.Identifier };
			names.add(
				named.name?.text ??
					(ts.isVariableStatement(statement)
						? statement.declarationList.declarations.map((item) => item.name.getText(tree)).join(",")
						: "?")
			);
		}
		return [...names].sort();
	}

	it("only enqueueV3Ingress reads the hold, as its input-admission barrier, captured before the barrier", () => {
		expect(holders(liveTree, "readinessIngressHold")).toEqual([
			"V3PlaneRegistration",
			"enqueueV3Ingress",
			"holdV3IngressForReadiness",
		]);
		const enqueue = declaration(liveTree, "enqueueV3Ingress");
		expect(enqueue).toContain("const hold = registration.readinessIngressHold;");
		expect(enqueue).toContain("terminal === undefined ? hold : Promise.all([terminal, hold])");
		expect(enqueue).toContain("captureBeforeBarrier: true");
		expect(enqueue).toContain("...(barrier === undefined ? {} : { barrier })");
		// enqueueRegistrationTask waits on the barrier BEFORE it takes the FIFO reservation.
		expect(declaration(liveTree, "enqueueRegistrationTask")).toContain(
			"result = inputAdmission?.barrier === undefined ? enqueue() : inputAdmission.barrier.then(enqueue);"
		);
	});

	it("only the creator's readiness preparation takes the hold", () => {
		expect(holders(liveTree, "holdV3IngressForReadiness")).toEqual([
			"creatorCloseRegistration",
			"holdV3IngressForReadiness",
		]);
		expect(holders(liveTree, "holdIngressForReadiness")).toEqual(["creatorCloseRegistration"]);
		expect(holders(closeTree, "holdIngressForReadiness")).toEqual([
			"V3CreatorCloseRegistration",
			"bindCreatorLiveClose",
			"prepareCreatorOrdinaryReadiness",
			"runtimeReleaseOwners",
		]);
	});

	it("held arrivals are awaited only outside the FIFO: the gossip queue, a void retained route and joined deactivation", () => {
		expect(holders(liveTree, "enqueueV3Ingress")).toEqual([
			"activateV3LivePlane",
			"enqueueV3Ingress",
			"routeV3RetainedIngress",
		]);
		expect(declaration(liveTree, "routeV3RetainedIngress")).toContain(
			'void enqueueV3Ingress(registration, message, "retained");'
		);
		const activation = declaration(liveTree, "activateV3LivePlane");
		expect(activation.match(/enqueueV3Ingress\(/g)).toHaveLength(1);
		expect(activation).toContain("subscribeActivationQueue(boundQueueManager, queueId, (message) => {");
		expect(holders(liveTree, "joinedWork")).toEqual([
			"V3PlaneRegistration",
			"activateV3LivePlane",
			"deactivateV3LivePlaneJoined",
			"trackRegistrationJoinedWork",
		]);
	});
});
