/* eslint-disable jsdoc/require-jsdoc -- Bounded measurement and independent test oracle. */
import { appendFileSync } from "node:fs";

export interface GridBlock {
	readonly id: string;
	readonly kind: string;
	readonly x: number;
	readonly y: number;
}

// Each author owns sixteen slots. Concurrent completions cannot reorder writes
// to the same key, and x changes on every write including periodic repair probes.
export class GridLastValueOracle {
	readonly #next = [0, 0];
	readonly #latest = new Map<string, GridBlock>();
	accepted = 0;

	propose(peer: number): GridBlock {
		if (peer !== 0 && peer !== 1) throw new Error("GRID_ORACLE_PEER");
		const sequence = this.#next[peer] ?? 0;
		this.#next[peer] = sequence + 1;
		return Object.freeze({ id: `slot-${peer}-${sequence % 16}`, kind: "stone", x: sequence, y: peer });
	}

	accept(block: GridBlock): void {
		const previous = this.#latest.get(block.id);
		if (previous !== undefined && previous.x >= block.x) throw new Error("GRID_ORACLE_WRITER_ORDER");
		this.#latest.set(block.id, block);
		this.accepted++;
	}

	state(): GridBlock[] {
		return [...this.#latest.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	matches(blocks: readonly GridBlock[]): boolean {
		return (
			JSON.stringify([...blocks].sort((left, right) => left.id.localeCompare(right.id))) ===
			JSON.stringify(this.state())
		);
	}
}

export class BoundedObservationLog {
	readonly #filename: string;
	readonly #limit: number;
	readonly #buffer: Readonly<Record<string, unknown>>[] = [];
	rows = 0;
	flushes = 0;
	highWater = 0;

	constructor(filename: string, limit = 512) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("OBSERVATION_LIMIT");
		this.#filename = filename;
		this.#limit = limit;
	}

	add(row: Readonly<Record<string, unknown>>): void {
		this.#buffer.push(row);
		this.rows++;
		this.highWater = Math.max(this.highWater, this.#buffer.length);
		if (this.#buffer.length >= this.#limit) this.flush();
	}

	flush(): void {
		if (this.#buffer.length === 0) return;
		appendFileSync(this.#filename, this.#buffer.map((row) => JSON.stringify(row)).join("\n") + "\n");
		this.#buffer.length = 0;
		this.flushes++;
	}

	get retained(): number {
		return this.#buffer.length;
	}
}
