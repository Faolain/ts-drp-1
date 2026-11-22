// Counts, per epoch, the creator's finishing-template compiles and what became of them: a cold
// creator quote with an ordinary source compiles the source's numeric finishing template
// (captureCreatorOrdinaryFinishingCapacityTemplate) unless a matching one is retained. A compile
// runs the original composer under the width compiler, which is the browser's longest task.
// A compile is only worth it when the same source sees that role's cold quote again: the
// assertion below requires every compile to be followed by a warm hit on some program.
//
// Host: TEMPLATE_COMPILES_HOST (browser | node | room, default browser). EPOCHS / MOVES env.
// Observation only: product `__warmProofEvent` diagnostics, no product seam.
import { afterEach, expect, it } from "vitest";

import { closeLongRooms, runLongRoom } from "./fixtures/track-m-apps/app-long-room.js";

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
});

const HOST = (process.env.TEMPLATE_COMPILES_HOST ?? "browser") as "browser" | "node" | "room";
const EPOCHS = Number(process.env.TEMPLATE_COMPILES_EPOCHS ?? 10);
const MOVES = Number(process.env.TEMPLATE_COMPILES_MOVES ?? 8);

type Row = Record<string, number | string>;

it(`finishing template compiles per epoch (${HOST})`, async () => {
	const rows = new Map<number, Row>();
	const sequence: string[] = [];
	let epoch = -1;
	const bump = (key: string) => {
		const row = rows.get(epoch) ?? { epoch };
		row[key] = ((row[key] as number | undefined) ?? 0) + 1;
		rows.set(epoch, row);
	};
	const observe = (e: Record<string, unknown>) => {
		const kind = String(e.kind);
		if (typeof e.epoch === "number" && kind.startsWith("ordinary-") && e.epoch > epoch) epoch = e.epoch;
		switch (kind) {
			case "ordinary-incremental-hit":
			case "ordinary-incremental-fallback":
				bump(`${kind === "ordinary-incremental-hit" ? "incHit" : "incMiss"}:${String(e.phase)}`);
				break;
			case "ordinary-finishing-warm-hit": bump("warmHit"); break;
			case "ordinary-finishing-warm-fallback": bump(`warmMiss:${String(e.reason)}`); break;
			case "ordinary-finishing-template-retained": bump(`retained:${String(e.role)}`); break;
			case "ordinary-finishing-template-compiling":
				bump(`compiling:${String(e.role)}:${String(e.reason)}${e.mismatch === undefined ? "" : `:${String(e.mismatch)}`}`);
				break;
			case "ordinary-finishing-template-refusal":
				bump(`refusal:${String(e.stage)}:${String(e.reason)}${Array.isArray(e.failed) ? `:${e.failed.join("+")}` : ""}`);
				break;
			case "ordinary-finishing-template-compile": bump(`captured:${String(e.ok)}`); break;
			case "ordinary-finishing-template-deferred": bump(`deferred:${String(e.role)}`); break;
			default: return;
		}
		sequence.push(`e${epoch}:${kind}${e.reason === undefined ? "" : `:${String(e.reason)}`}${e.ok === undefined ? "" : `:${String(e.ok)}`}`);
	};
	let current: unknown = Reflect.get(globalThis, "__warmProofEvent");
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__warmProofEvent");
	Object.defineProperty(globalThis, "__warmProofEvent", {
		configurable: true,
		get: () => current,
		set: (value: unknown) => {
			current =
				typeof value === "function"
					? (event: unknown) => {
							if (event !== null && typeof event === "object") observe(event as Record<string, unknown>);
							return (value as (event: unknown) => unknown)(event);
						}
					: value;
		},
	});
	try {
		await runLongRoom({ app: "grid", host: HOST, recipient: "writer", creatorLull: false, epochs: EPOCHS, moves: MOVES });
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, "__warmProofEvent");
		else Object.defineProperty(globalThis, "__warmProofEvent", descriptor);
	}
	const table = [...rows.values()].sort((a, b) => Number(a.epoch) - Number(b.epoch));
	for (const row of table) console.info(`TEMPLATE_COMPILES ${JSON.stringify(row)}`);
	const total = (prefix: string) => table.reduce((sum, row) => sum + Object.entries(row)
		.filter(([key]) => key.startsWith(prefix)).reduce((s, [, v]) => s + Number(v), 0), 0);
	console.info(`TEMPLATE_COMPILES_TOTAL ${JSON.stringify({ compiling: total("compiling:"), capturedTrue: total("captured:true"),
		capturedFalse: total("captured:false"), warmHit: total("warmHit"), retained: total("retained:"), incMiss: total("incMiss:") })}`);
	console.info(`TEMPLATE_COMPILES_SEQUENCE ${JSON.stringify(sequence)}`);
	// A compiled program must be worth its compile: every compile is followed by at least one
	// warm evaluation that admits on it. A source that sees one cold quote of a role and is then
	// replaced at the boundary must not compile for it.
	expect(total("compiling:")).toBeLessThanOrEqual(total("warmHit"));
}, 3_600_000);
