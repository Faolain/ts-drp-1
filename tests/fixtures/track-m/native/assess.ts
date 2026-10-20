// Track M, slice 14f: exact state comparisons for the process-death cases, on the
// digest dumps the browser worker reports (pure functions, Node side).

export interface DigestStore {
	readonly keyPath: unknown;
	readonly rows: readonly (readonly [string, string])[];
}
export interface DigestDump {
	readonly database: string;
	readonly version: number;
	readonly stores: Readonly<Record<string, DigestStore>>;
}
export interface Write {
	readonly seq: number;
	readonly op: string;
	readonly database: string;
	readonly store: string;
	readonly key: string;
	readonly digest?: string;
	readonly session: boolean;
	readonly continuation: number;
	readonly tx: number;
	readonly committed: boolean;
}
type State = Map<string, Map<string, string>>;

export function stateOf(dump: DigestDump): State {
	return new Map(Object.entries(dump.stores).map(([name, store]) => [name, new Map(store.rows)]));
}

export function applyWrites(state: State, writes: readonly Write[]): State {
	const next: State = new Map([...state].map(([name, rows]) => [name, new Map(rows)]));
	for (const write of [...writes].sort((left, right) => left.seq - right.seq)) {
		const rows = next.get(write.store);
		if (rows === undefined) throw new Error(`TRACK_M_14F_WRITE_TO_UNKNOWN_STORE ${write.store}`);
		if (write.key.startsWith('{"$range"')) throw new Error(`TRACK_M_14F_RANGE_DELETE ${write.store}`);
		if (write.op === "delete" || write.op === "cursor-delete") rows.delete(write.key);
		else if (write.op === "clear") rows.clear();
		else rows.set(write.key, String(write.digest));
	}
	return next;
}

/** Every difference between two states (every store, every row). */
export function differences(left: State, right: State, limit = 40): string[] {
	const out: string[] = [];
	for (const name of new Set([...left.keys(), ...right.keys()])) {
		const a = left.get(name),
			b = right.get(name);
		if (a === undefined || b === undefined) {
			out.push(`${a === undefined ? "added" : "removed"} store ${name}`);
			continue;
		}
		for (const [key, digest] of a)
			if (!b.has(key)) out.push(`removed ${name} ${key}`);
			else if (b.get(key) !== digest) out.push(`changed ${name} ${key}`);
		for (const key of b.keys()) if (!a.has(key)) out.push(`added ${name} ${key}`);
	}
	return out.length > limit ? [...out.slice(0, limit), `... ${out.length - limit} more`] : out;
}

export function countDifferences(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>) {
	const out: Record<string, { left: number | undefined; right: number | undefined }> = {};
	for (const name of new Set([...Object.keys(left), ...Object.keys(right)]))
		if (left[name] !== right[name]) out[name] = { left: left[name], right: right[name] };
	return out;
}

export type Fate = "old" | "new" | "neither";

/**
 * Old XOR exact new for one database: OLD is the pre-state plus every write that had
 * committed before the edge; NEW additionally carries every write of the target step.
 */
export function fate(
	pre: DigestDump,
	recovered: DigestDump,
	committedBefore: readonly Write[],
	target: readonly Write[]
): { fate: Fate; old: string[]; new: string[] } {
	const old = applyWrites(stateOf(pre), committedBefore);
	const next = applyWrites(old, target);
	const actual = stateOf(recovered);
	const oldDiff = differences(old, actual);
	const newDiff = differences(next, actual);
	return {
		fate: oldDiff.length === 0 ? "old" : newDiff.length === 0 ? "new" : "neither",
		old: oldDiff,
		new: newDiff,
	};
}
