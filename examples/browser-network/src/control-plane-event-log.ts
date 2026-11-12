/** How many control-plane events a session's diagnostics keep: the newest, oldest dropped first. */
export const CONTROL_PLANE_EVENT_LOG_CAP = 256;

/** A bounded log of a session's control-plane events that counts the events it dropped. */
export interface ControlPlaneEventLog<Event> {
	push(event: Event): void;
	/** The retained events, oldest first (a copy). */
	events(): Event[];
	/** Events dropped to stay within the cap since the session started. */
	readonly dropped: number;
}

/**
 * Creates a ring buffer of the newest `cap` events. A game session runs for hours, so the log must
 * not grow with it; the dropped count keeps the diagnostics truthful about what is missing.
 * @param cap - The most events kept.
 * @returns The log.
 */
export function createControlPlaneEventLog<Event>(
	cap: number = CONTROL_PLANE_EVENT_LOG_CAP
): ControlPlaneEventLog<Event> {
	if (!Number.isInteger(cap) || cap < 1) throw new RangeError("control-plane event log cap must be a positive integer");
	const ring: Event[] = [];
	let start = 0;
	let dropped = 0;
	return {
		push(event: Event): void {
			if (ring.length < cap) {
				ring.push(event);
				return;
			}
			ring[start] = event;
			start = (start + 1) % cap;
			dropped++;
		},
		events: (): Event[] => [...ring.slice(start), ...ring.slice(0, start)],
		get dropped(): number {
			return dropped;
		},
	};
}
