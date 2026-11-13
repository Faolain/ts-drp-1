/**
 * The realtime harness's rollover observation (a page global, __TS_DRP_ROLLOVER_OBSERVATION__)
 * for a room hosted in a dedicated worker: the worker installs a stand-in that forwards stage
 * brackets and delivery stats as room worker diagnostics, and the page re-issues them on its own
 * observation and clock. Harness only: without a page observation nothing is installed or sent.
 *
 * It imports nothing, so a worker file can install it before the room's modules load (they
 * capture the observation when evaluated).
 */
const OBSERVATION = "__TS_DRP_ROLLOVER_OBSERVATION__";

interface Observation {
	stage<Value>(name: string, run: () => Promise<Value>): Promise<Value>;
	bindDelivery(role: string, room: unknown, stats: () => Record<string, unknown>): void;
}

type Diagnostic = (name: string, value: unknown) => void;

/**
 * Worker side: installs the rollover observation global (before the room's modules load: they
 * capture it when evaluated), forwarding stage brackets and delivery stats to the page.
 * @param diagnostic - The room worker context's diagnostic sink.
 */
export function installV3RoomWorkerObservation(diagnostic: Diagnostic): void {
	let nextStage = 1;
	let room: { authority(): { epoch: number } | null } | undefined;
	const epoch = (): number | null => {
		try {
			return room?.authority()?.epoch ?? null;
		} catch {
			return null;
		}
	};
	const observation: Observation = {
		stage<Value>(name: string, run: () => Promise<Value>): Promise<Value> {
			const id = nextStage++;
			diagnostic("stage.start", { id, name });
			const end = (ok: boolean, value?: unknown): void => {
				const successor =
					value !== null && typeof value === "object" && typeof Reflect.get(value, "successorEpoch") === "number"
						? (Reflect.get(value, "successorEpoch") as number)
						: -1;
				diagnostic("stage.end", { id, ok, successorEpoch: successor, epoch: epoch() });
			};
			let pending: Promise<Value>;
			try {
				pending = run();
			} catch (error) {
				end(false);
				throw error;
			}
			return pending.then(
				(value) => {
					end(true, value);
					return value;
				},
				(error: unknown) => {
					end(false);
					throw error;
				}
			);
		},
		bindDelivery(role: string, selected: unknown, stats: () => Record<string, unknown>): void {
			room = selected as typeof room;
			// Event-free stats are sampled at the harness's 250 ms cadence (harness only).
			const push = (): void => {
				let copy: Record<string, unknown> | null = null;
				try {
					copy = { ...stats() };
				} catch {
					copy = null;
				}
				diagnostic("delivery", { role, epoch: epoch(), stats: copy });
			};
			push();
			setInterval(push, 250);
		},
	};
	Reflect.set(globalThis, OBSERVATION, Object.freeze(observation));
}

/**
 * Page side: whether the page carries the harness's rollover observation.
 * @returns The page observation, if any.
 */
function pageObservation(): Observation | undefined {
	return Reflect.get(globalThis, OBSERVATION) as Observation | undefined;
}

/**
 * Page side: re-issues the worker's observation on the page's own observation (and clock).
 * @returns A diagnostic sink for openRoomWorker's onDiagnostic, or undefined without a page observation.
 */
export function forwardV3RoomWorkerObservation(): Diagnostic | undefined {
	const observation = pageObservation();
	if (observation === undefined) return undefined;
	const stages = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
	const delivery = { epoch: null as number | null, stats: {} as Record<string, unknown>, bound: false };
	return (name, raw) => {
		const value = raw as Record<string, unknown>;
		if (name === "stage.start") {
			const id = value.id as number;
			observation
				.stage(String(value.name), () => new Promise((resolve, reject) => stages.set(id, { resolve, reject })))
				.catch(() => undefined);
		} else if (name === "stage.end") {
			delivery.epoch = (value.epoch as number | null) ?? delivery.epoch;
			const pending = stages.get(value.id as number);
			stages.delete(value.id as number);
			if (value.ok === true) pending?.resolve({ successorEpoch: value.successorEpoch });
			else pending?.reject(new Error("stage failed in the room worker"));
		} else if (name === "delivery") {
			delivery.epoch = value.epoch as number | null;
			delivery.stats = (value.stats as Record<string, unknown> | null) ?? {};
			if (!delivery.bound) {
				delivery.bound = true;
				observation.bindDelivery(
					String(value.role),
					{ authority: () => (delivery.epoch === null ? null : { epoch: delivery.epoch }) },
					() => delivery.stats
				);
			}
		}
	};
}
