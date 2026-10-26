/* eslint-disable @typescript-eslint/explicit-function-return-type -- Measurement fixture over native prototypes. */
import { DatabaseSync, StatementSync } from "node:sqlite";

/** One host turn: everything the event loop ran between two check phases. */
export type NativeHostTurn = {
	/** Native SQLite statements from selected database files inside this one turn. */
	readonly statements: number;
	/** Longest single native statement, which exposes a busy-timeout wait. */
	readonly maxStatementMs: number;
	readonly wallMs: number;
	readonly cpuMs: number;
};

const statementMethods = ["run", "get", "all", "iterate"] as const;
const statementOwners = new WeakMap<object, string>();
let ownersInstalled = false;
let active: ((location: string, elapsedMs: number) => void) | undefined;

function locationOf(database: DatabaseSync): string {
	try {
		return database.location() ?? ":memory:";
	} catch {
		return ":closed:";
	}
}

/**
 * Routes every native statement through one counter. Statements prepared before
 * this runs have no recorded owner, so install it before opening any store.
 * The wrappers call the original methods unchanged.
 */
export function installNativeStatementOwners(): void {
	if (ownersInstalled) return;
	ownersInstalled = true;
	const prepare = Reflect.get(DatabaseSync.prototype, "prepare") as (...args: unknown[]) => object;
	Reflect.set(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, ...args: unknown[]) {
		const statement = Reflect.apply(prepare, this, args);
		statementOwners.set(statement, locationOf(this));
		return statement;
	});
	for (const name of statementMethods) {
		const original = Reflect.get(StatementSync.prototype, name) as (...args: unknown[]) => unknown;
		Reflect.set(StatementSync.prototype, name, function (this: StatementSync, ...args: unknown[]) {
			if (active === undefined) return Reflect.apply(original, this, args);
			const started = performance.now();
			try {
				return Reflect.apply(original, this, args);
			} finally {
				active?.(statementOwners.get(this) ?? ":unknown:", performance.now() - started);
			}
		});
	}
	const exec = Reflect.get(DatabaseSync.prototype, "exec") as (...args: unknown[]) => unknown;
	Reflect.set(DatabaseSync.prototype, "exec", function (this: DatabaseSync, ...args: unknown[]) {
		if (active === undefined) return Reflect.apply(exec, this, args);
		const started = performance.now();
		try {
			return Reflect.apply(exec, this, args);
		} finally {
			active?.(locationOf(this), performance.now() - started);
		}
	});
}

/**
 * Counts selected native statements per host turn. A turn ends whenever the
 * event loop reaches its check phase, so each timer or I/O boundary taken by
 * production work separates two turns. Statement counts depend only on the
 * scenario and the source, unlike wall time on a loaded host.
 * @param options - Optional measurement scope.
 * @param options.select - Counts only statements on database files it accepts.
 * @param options.onTurn - Runs at each turn boundary, where test work may join.
 * @returns A meter whose stop() ends the measurement.
 */
export function startNativeTurnMeter(
	options: {
		select?(location: string): boolean;
		onTurn?(turn: number): void;
	} = {}
) {
	if (!ownersInstalled) throw new Error("NATIVE_STATEMENT_OWNERS_NOT_INSTALLED");
	if (active !== undefined) throw new Error("NATIVE_TURN_METER_BUSY");
	let statements = 0,
		maxStatementMs = 0,
		stopped = false,
		wall = performance.now(),
		cpu = process.cpuUsage();
	const turns: NativeHostTurn[] = [];
	active = (location, elapsedMs) => {
		if (options.select !== undefined && !options.select(location)) return;
		statements++;
		maxStatementMs = Math.max(maxStatementMs, elapsedMs);
	};
	const close = () => {
		const at = performance.now(),
			used = process.cpuUsage(cpu);
		turns.push({ statements, maxStatementMs, wallMs: at - wall, cpuMs: (used.user + used.system) / 1000 });
		statements = 0;
		maxStatementMs = 0;
		wall = at;
		cpu = process.cpuUsage();
	};
	const tick = () => {
		if (stopped) return;
		close();
		options.onTurn?.(turns.length);
		setImmediate(tick);
	};
	setImmediate(tick);
	return {
		stop(): readonly NativeHostTurn[] {
			if (!stopped) {
				close();
				stopped = true;
				active = undefined;
			}
			return turns;
		},
	};
}

/**
 * Summarizes a measurement.
 * @param turns - Turns returned by a stopped meter.
 * @returns Busy turns, the native work in the largest one, and the longest statement.
 */
export function summarizeNativeTurns(turns: readonly NativeHostTurn[]) {
	const busy = turns.filter((turn) => turn.statements > 0);
	return {
		busyTurns: busy.length,
		statements: busy.reduce((sum, turn) => sum + turn.statements, 0),
		maxStatements: Math.max(0, ...busy.map((turn) => turn.statements)),
		maxStatementMs: Math.max(0, ...turns.map((turn) => turn.maxStatementMs)),
		maxCpuMs: Math.max(0, ...turns.map((turn) => turn.cpuMs)),
	};
}
