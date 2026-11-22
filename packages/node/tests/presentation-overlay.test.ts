import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	attachPresentationIntents,
	createPresentationOverlay,
	type PresentationRow,
	type V3RoomPresentationEvent,
} from "../src/internal/presentation-overlay.js";

// A non-commutative, non-idempotent application: last writer wins per block,
// every row bumps a counter (a doubled row is visible), and x < 0 is refused
// by the pure fold exactly like an application TypeError on the durable path.
interface State {
	readonly blocks: Readonly<Record<string, string>>;
	readonly count: number;
	readonly digests: readonly string[];
}
const EMPTY: State = Object.freeze({ blocks: Object.freeze({}), count: 0, digests: Object.freeze([]) });
function fold(base: State, rows: readonly PresentationRow[]): State {
	const blocks: Record<string, string> = { ...base.blocks };
	let count = base.count;
	const digests = [...base.digests];
	for (const row of rows) {
		const x = row.operation.x as number;
		if (x < 0) throw new TypeError("refused placement");
		blocks[row.operation.id as string] = `${x}:${row.author}`;
		count += 1;
		digests.push(row.vertexDigest);
	}
	return Object.freeze({ blocks: Object.freeze(blocks), count, digests: Object.freeze(digests) });
}
// The durable path's contained fold: drop each vertex the fold refuses.
function containedFold(
	base: State,
	vertices: readonly Vertex[]
): { state: State; accepted: Vertex[]; refused: Vertex[] } {
	const accepted: Vertex[] = [];
	const refused: Vertex[] = [];
	let state = fold(base, []);
	for (const vertex of vertices) {
		try {
			state = fold(
				base,
				[...accepted, vertex].flatMap((row) => row.rows)
			);
			accepted.push(vertex);
		} catch {
			refused.push(vertex);
		}
	}
	return { state, accepted, refused };
}
const op = (id: string, x: number): Readonly<Record<string, unknown>> => Object.freeze({ action: "place", id, x });
interface Vertex {
	readonly digest: string;
	readonly author: string;
	readonly epoch: number;
	readonly logicalTime: number;
	readonly rows: readonly PresentationRow[];
}
let digestCounter = 0;
function vertex(
	author: string,
	logicalTime: number,
	operation: Readonly<Record<string, unknown>>,
	epoch = 0,
	authorSequence = 1
): Vertex {
	const digest = (++digestCounter).toString(16).padStart(64, "0");
	return Object.freeze({
		digest,
		author,
		epoch,
		logicalTime,
		rows: Object.freeze([
			Object.freeze({
				author,
				authorSequence,
				logicalTime,
				operation,
				operationCount: 1,
				operationIndex: 0,
				vertexDigest: digest,
			}),
		]),
	});
}

// Drives the overlay exactly as v3-room does: durable commit first, then the
// atomic confirm; seals install a new authenticated base and change epoch.
function harness(localAuthor = "local", remotePendingTimeoutMilliseconds = 1_000) {
	let base = EMPTY;
	let epoch = 0;
	let durable: Vertex[] = [];
	let projection = fold(base, []);
	let clock = 0;
	const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
	const events: V3RoomPresentationEvent[] = [];
	const views: State[] = [];
	const overlay = createPresentationOverlay<State>({
		localAuthor,
		options: {
			remotePendingTimeoutMilliseconds,
			onPresentationEvent: (event) => events.push(event),
			onSpeculativeProjection: (view) => views.push(view),
		},
		batchableOperationActions: ["place"],
		durable: () => ({ projection, epoch, rows: () => durable.flatMap((row) => row.rows) }),
		project: (rows) => fold(base, rows),
		now: () => clock,
		setTimer: (callback, milliseconds) => {
			const timer = { at: clock + milliseconds, callback, cancelled: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => {
			(handle as { cancelled: boolean }).cancelled = true;
		},
	});
	const h = {
		overlay,
		events,
		views,
		durableProjection: () => projection,
		durableVertices: () => durable,
		base: () => base,
		epoch: () => epoch,
		advance(milliseconds: number): void {
			clock += milliseconds;
			for (const timer of timers.splice(0)) {
				if (timer.cancelled) continue;
				if (timer.at <= clock) timer.callback();
				else timers.push(timer);
			}
		},
		/** Durable admission of `added` in the given authoritative order position (index into durable order). */
		admit(added: readonly Vertex[], at?: number): void {
			const ordered = [...durable];
			ordered.splice(at ?? ordered.length, 0, ...added);
			const result = containedFold(base, ordered);
			durable = result.accepted;
			overlay.durableRefused(result.refused.filter((row) => added.includes(row)).map((row) => row.digest));
			projection = result.state;
			overlay.durableCommitted(
				added.filter((row) => result.accepted.includes(row)).map((row) => ({ identity: row.digest, rows: row.rows }))
			);
		},
		seal(): void {
			base = fold(
				base,
				durable.flatMap((row) => row.rows)
			);
			durable = [];
			epoch += 1;
			overlay.epochChanged(epoch);
			projection = fold(base, []);
			overlay.durableChanged();
		},
	};
	return h;
}

const canonical = (state: State): string =>
	JSON.stringify({ blocks: Object.entries(state.blocks).sort(), count: state.count });

describe("speculative presentation overlay", () => {
	it("shows a local move at once and converges atomically when durable admission accepts it", () => {
		const h = harness();
		const durableCalls: unknown[] = [];
		const id = h.overlay.addLocal(op("b", 1), 3, { durable: (value) => durableCalls.push(value) })!;
		expect(h.overlay.projection().blocks.b).toBe("1:local");
		expect(h.durableProjection().blocks.b).toBeUndefined();
		expect(h.events.map((event) => event.kind)).toEqual(["pending", "visible"]);
		h.overlay.bindLocal(id, 5);
		const issued = vertex("local", 5, op("b", 1), 0, 7);
		h.admit([issued]);
		expect(h.overlay.pending()).toEqual([]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		expect(h.overlay.projection().count).toBe(1);
		expect(durableCalls).toEqual([{ vertexDigest: issued.digest, authorSequence: 7 }]);
		// The view delivered with the durable commit is the converged one.
		expect(h.views.at(-1)).toBe(h.durableProjection());
		h.overlay.settleLocal(id, { ok: true });
		expect(h.events.filter((event) => event.kind === "confirmed")).toHaveLength(1);
	});

	it("does not confirm a local move from an unrelated row at the same logical time", () => {
		const h = harness();
		const id = h.overlay.addLocal(op("b", 1), 3)!;
		h.overlay.bindLocal(id, 5);
		h.admit([vertex("local", 5, Object.freeze({ action: "place", id: "join", x: 0 }))]);
		expect(h.overlay.pending().map((entry) => entry.id)).toEqual([id]);
		expect(h.overlay.projection().blocks.b).toBe("1:local");
	});

	it("rolls back a refused local move with its reason and converges to the durable projection", () => {
		const h = harness();
		const rolled: unknown[] = [];
		const refusal = new TypeError("v3 room new operation is not authorized: authorization-rejected");
		const id = h.overlay.addLocal(op("b", 1), 3, { rolledBack: (reason, error) => rolled.push([reason, error]) })!;
		h.overlay.settleLocal(id, { ok: false, reason: "refused", error: refusal });
		expect(rolled).toEqual([["refused", refusal]]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		const last = h.events.at(-1);
		expect(last?.kind === "rolled-back" && last.reason).toBe("refused");
	});

	it("hides a move the pure fold refuses and never shows it", () => {
		const h = harness();
		const visible: unknown[] = [];
		const id = h.overlay.addLocal(op("bad", -1), 3, { visible: (entry) => visible.push(entry) })!;
		const good = h.overlay.addLocal(op("good", 2), 3)!;
		expect(h.overlay.pending().map((entry) => [entry.id, entry.visible])).toEqual([
			[id, false],
			[good, true],
		]);
		expect(h.overlay.projection().blocks).toEqual({ good: "2:local" });
		expect(visible).toEqual([]);
		h.overlay.settleLocal(id, { ok: false, reason: "projection-refused", error: new TypeError("refused") });
		expect(h.overlay.pending().map((entry) => entry.id)).toEqual([good]);
	});

	it("shows an authenticated remote vertex before durable admission and confirms it by digest", () => {
		const h = harness();
		const remote = vertex("peer", 9, op("p", 4));
		expect(
			h.overlay.addRemoteVertex({
				author: remote.author,
				epoch: 0,
				logicalTime: 9,
				vertexDigest: remote.digest,
				rows: remote.rows,
			})
		).toBe(true);
		expect(
			h.overlay.addRemoteVertex({
				author: remote.author,
				epoch: 0,
				logicalTime: 9,
				vertexDigest: remote.digest,
				rows: remote.rows,
			})
		).toBe(false);
		expect(h.overlay.projection().blocks.p).toBe("4:peer");
		h.admit([remote]);
		expect(h.overlay.pending()).toEqual([]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		expect(h.overlay.projection().count).toBe(1);
	});

	it("rolls back remote moves durable admission refuses, never confirms, or loses to a seal", () => {
		const h = harness("local", 1_000);
		const refused = vertex("peer", 9, op("bad", -5));
		const late = vertex("peer", 11, op("late", 1));
		const sealed = vertex("peer", 13, op("sealed", 1));
		for (const row of [refused, late, sealed])
			h.overlay.addRemoteVertex({
				author: row.author,
				epoch: 0,
				logicalTime: row.logicalTime,
				vertexDigest: row.digest,
				rows: row.rows,
			});
		h.admit([refused]);
		h.advance(500);
		h.seal();
		h.advance(600);
		const reasons = h.events.flatMap((event) =>
			event.kind === "rolled-back" ? [[event.entry.vertexDigest, event.reason]] : []
		);
		expect(reasons).toEqual([
			[refused.digest, "projection-refused"],
			[late.digest, "epoch-changed"],
			[sealed.digest, "epoch-changed"],
		]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		const unconfirmed = harness("local", 1_000);
		unconfirmed.overlay.addRemoteVertex({
			author: late.author,
			epoch: 0,
			logicalTime: 11,
			vertexDigest: late.digest,
			rows: late.rows,
		});
		unconfirmed.advance(999);
		expect(unconfirmed.overlay.pending()).toHaveLength(1);
		unconfirmed.advance(1);
		const last = unconfirmed.events.at(-1);
		expect(last?.kind === "rolled-back" && last.reason).toBe("unconfirmed");
		expect(unconfirmed.overlay.projection()).toBe(unconfirmed.durableProjection());
	});

	it("re-bases on reorder: the overlay may predict a different winner but converges to the durable order", () => {
		const h = harness();
		const id = h.overlay.addLocal(op("x", 1), 10)!;
		const remote = vertex("peer", 12, op("x", 2));
		h.overlay.addRemoteVertex({
			author: "peer",
			epoch: 0,
			logicalTime: 12,
			vertexDigest: remote.digest,
			rows: remote.rows,
		});
		// Predicted order is by logical time: local (10) then peer (12).
		expect(h.overlay.projection().blocks.x).toBe("2:peer");
		h.overlay.bindLocal(id, 10);
		const local = vertex("local", 10, op("x", 1));
		// The authoritative order ranks the peer's vertex first, then ours.
		h.admit([remote]);
		expect(h.overlay.projection().blocks.x).toBe("1:local");
		h.admit([local]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		expect(h.durableProjection().blocks.x).toBe("1:local");
		expect(h.durableProjection().count).toBe(2);
	});

	it("keeps an unsigned local move across an epoch transition and re-bases it on the new authenticated base", () => {
		const h = harness();
		h.admit([vertex("peer", 4, op("old", 1))]);
		const id = h.overlay.addLocal(op("next", 3), 6)!;
		h.seal();
		expect(h.overlay.pending().map((entry) => entry.id)).toEqual([id]);
		expect(h.overlay.projection().blocks).toEqual({ old: "1:peer", next: "3:local" });
		h.overlay.bindLocal(id, 8);
		h.admit([vertex("local", 8, op("next", 3), 1)]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		expect(h.durableProjection().count).toBe(2);
	});

	it("is memory-only: a reopened session starts with no pending moves; close rolls everything back", () => {
		const h = harness();
		const rolled: string[] = [];
		h.overlay.addLocal(op("a", 1), 3, { rolledBack: (reason) => rolled.push(reason) });
		const remote = vertex("peer", 9, op("p", 4));
		h.overlay.addRemoteVertex({
			author: "peer",
			epoch: 0,
			logicalTime: 9,
			vertexDigest: remote.digest,
			rows: remote.rows,
		});
		h.overlay.close();
		expect(rolled).toEqual(["closed"]);
		expect(h.overlay.pending()).toEqual([]);
		expect(h.overlay.addLocal(op("b", 1), 3)).toBeUndefined();
		// Reopen: a fresh overlay over the same durable state has nothing to show.
		const reopened = harness();
		expect(reopened.overlay.pending()).toEqual([]);
		expect(reopened.overlay.projection()).toBe(reopened.durableProjection());
	});

	it("shows a peer intent, yields it to the signed vertex, then confirms durably; withdrawals roll back", () => {
		const h = harness();
		expect(h.overlay.addIntent({ author: "local", intentId: "1", logicalTime: 3, operation: op("self", 1) })).toBe(
			false
		);
		h.overlay.addIntent({ author: "peer", intentId: "1", logicalTime: 3, operation: op("i", 5) });
		h.overlay.addIntent({ author: "peer", intentId: "2", logicalTime: 5, operation: op("j", 6) });
		expect(h.overlay.projection().blocks).toEqual({ i: "5:peer", j: "6:peer" });
		const signed = vertex("peer", 7, op("i", 5));
		h.overlay.addRemoteVertex({
			author: "peer",
			epoch: 0,
			logicalTime: 7,
			vertexDigest: signed.digest,
			rows: signed.rows,
		});
		expect(h.overlay.pending().map((entry) => entry.source)).toEqual(["remote-intent", "remote-signed"]);
		h.overlay.withdrawIntent("peer", "2");
		h.admit([signed]);
		expect(h.overlay.projection()).toBe(h.durableProjection());
		expect(
			h.events.flatMap((event) =>
				event.kind === "confirmed" || event.kind === "rolled-back" ? [`${event.kind}:${event.entry.source}`] : []
			)
		).toEqual(["confirmed:remote-intent", "rolled-back:remote-intent", "confirmed:remote-signed"]);
		// Intents are unordered relative to vertices and withdrawals: a late copy
		// of a durable move, or an intent after its withdrawal, is never shown.
		expect(h.overlay.addIntent({ author: "peer", intentId: "1b", logicalTime: 3, operation: op("i", 5) })).toBe(false);
		h.overlay.withdrawIntent("peer", "3");
		expect(h.overlay.addIntent({ author: "peer", intentId: "3", logicalTime: 9, operation: op("k", 1) })).toBe(false);
		expect(h.overlay.pending()).toEqual([]);
	});

	it("converges to the durable projection under random interleavings (model check)", () => {
		for (let seed = 1; seed <= 200; seed++) {
			let state = seed;
			const random = (bound: number): number => {
				state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
				return state % bound;
			};
			const h = harness("local", 50);
			const locals: { id: string; operation: Readonly<Record<string, unknown>>; bound?: number }[] = [];
			const remotes: Vertex[] = [];
			const hookCalls = new Map<string, { visible: number; durable: number; rolledBack: number }>();
			const admittedLocals = new Set<string>();
			let logical = 3;
			// Every entry: one pending, at most one visible, then exactly one terminal
			// (confirmed or rolled back) and nothing after it.
			const assertLifecycles = (drained: boolean): void => {
				const lifecycles = new Map<string, string[]>();
				for (const event of h.events)
					lifecycles.set(event.entry.id, [...(lifecycles.get(event.entry.id) ?? []), event.kind]);
				for (const [id, kinds] of lifecycles) {
					expect(kinds[0], id).toBe("pending");
					expect(kinds.filter((kind) => kind === "pending").length, id).toBe(1);
					expect(kinds.filter((kind) => kind === "visible").length, id).toBeLessThanOrEqual(1);
					const terminal = kinds.findIndex((kind) => kind === "confirmed" || kind === "rolled-back");
					if (terminal >= 0) expect(kinds.length - 1, id).toBe(terminal);
					else expect(drained, id).toBe(false);
				}
				for (const [id, calls] of hookCalls) {
					expect(calls.visible, id).toBeLessThanOrEqual(1);
					expect(calls.durable + calls.rolledBack, id).toBeLessThanOrEqual(1);
					if (admittedLocals.has(id)) expect([calls.durable, calls.rolledBack], id).toEqual([1, 0]);
				}
			};
			for (let step = 0; step < 40; step++) {
				const action = random(9);
				const operation = op(`k${random(3)}`, random(7) - 1);
				if (action === 0) {
					const calls = { visible: 0, durable: 0, rolledBack: 0 };
					const id = h.overlay.addLocal(operation, logical, {
						visible: () => void calls.visible++,
						durable: () => void calls.durable++,
						rolledBack: () => void calls.rolledBack++,
					});
					if (id !== undefined) {
						locals.push({ id, operation });
						hookCalls.set(id, calls);
					}
				} else if (action === 1 && locals.length > 0) {
					const local = locals[random(locals.length)]!;
					if (local.bound === undefined) {
						local.bound = logical;
						logical += 2;
						h.overlay.bindLocal(local.id, local.bound);
					}
				} else if (action === 2 && locals.some((local) => local.bound !== undefined)) {
					const index = locals.findIndex((local) => local.bound !== undefined);
					const local = locals.splice(index, 1)[0]!;
					const issued = vertex("local", local.bound!, local.operation, h.epoch());
					h.admit([issued], random(h.durableVertices().length + 1));
					const refused = !h.durableVertices().includes(issued);
					// Atomic confirmation: once durable, it is never also pending (no double apply).
					if (!refused) {
						expect(h.overlay.pending().some((entry) => entry.id === local.id)).toBe(false);
						admittedLocals.add(local.id);
					}
					h.overlay.settleLocal(
						local.id,
						refused ? { ok: false, reason: "projection-refused", error: new TypeError("refused") } : { ok: true }
					);
				} else if (action === 3 && locals.length > 0) {
					const local = locals.splice(random(locals.length), 1)[0]!;
					h.overlay.settleLocal(local.id, { ok: false, reason: "refused", error: new TypeError("refused") });
				} else if (action === 4) {
					const remote = vertex(`peer${random(2)}`, logical + random(4), operation, h.epoch());
					logical += 2;
					remotes.push(remote);
					if (random(3) !== 0)
						h.overlay.addRemoteVertex({
							author: remote.author,
							epoch: remote.epoch,
							logicalTime: remote.logicalTime,
							vertexDigest: remote.digest,
							rows: remote.rows,
						});
					if (random(2) === 0)
						h.overlay.addIntent({
							author: remote.author,
							intentId: String(step),
							logicalTime: remote.logicalTime,
							operation,
						});
				} else if (action === 5 && remotes.length > 0) {
					const remote = remotes.splice(random(remotes.length), 1)[0]!;
					if (remote.epoch === h.epoch()) h.admit([remote], random(h.durableVertices().length + 1));
				} else if (action === 6) {
					h.seal();
				} else if (action === 7) {
					h.advance(random(30));
				}
				// Invariant: the view is the pure fold of durable rows followed by the
				// visible pending rows in speculative order; nothing is applied twice.
				const visibleRows = h.overlay.pending().flatMap((entry) =>
					entry.visible
						? [
								{
									author: entry.author,
									authorSequence: -1,
									logicalTime: entry.logicalTime,
									operation: entry.operation,
									operationCount: 1,
									operationIndex: 0,
									vertexDigest: entry.id,
								},
							]
						: []
				);
				const expected = fold(h.base(), [...h.durableVertices().flatMap((row) => row.rows), ...visibleRows]);
				expect(canonical(h.overlay.projection())).toBe(canonical(expected));
				if (h.overlay.pending().length === 0) expect(h.overlay.projection()).toBe(h.durableProjection());
				// Pending moves sit after the admitted log in (logicalTime, author) order.
				const order = h.overlay.pending().map((entry) => [entry.logicalTime, entry.author] as const);
				expect(order).toEqual(
					[...order].sort((left, right) => left[0] - right[0] || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0))
				);
				assertLifecycles(false);
			}
			// Drain: every local issue settles (accepted or refused), remote moves are
			// admitted or time out. The overlay then is exactly the durable projection.
			for (const local of locals.splice(0)) {
				if (local.bound === undefined) {
					local.bound = logical;
					logical += 2;
					h.overlay.bindLocal(local.id, local.bound);
				}
				const issued = vertex("local", local.bound, local.operation, h.epoch());
				h.admit([issued]);
				if (h.durableVertices().includes(issued)) admittedLocals.add(local.id);
				h.overlay.settleLocal(
					local.id,
					h.durableVertices().includes(issued)
						? { ok: true }
						: { ok: false, reason: "projection-refused", error: new TypeError("refused") }
				);
			}
			h.advance(1_000);
			assertLifecycles(true);
			expect(h.overlay.pending()).toEqual([]);
			expect(h.overlay.projection()).toBe(h.durableProjection());
			expect(canonical(h.overlay.projection())).toBe(canonical(h.durableProjection()));
		}
		// 200 seeded interleavings take ~10 s on a loaded machine.
	}, 60_000);
});

describe("presentation isolation", () => {
	it("never writes to the durable snapshot it reads", () => {
		const durableRows = Object.freeze([vertex("peer", 2, op("d", 1)).rows[0]!]);
		const projection = fold(EMPTY, durableRows);
		let reads = 0;
		const overlay = createPresentationOverlay<State>({
			localAuthor: "local",
			options: { onPresentationEvent: () => undefined },
			batchableOperationActions: ["place"],
			durable: () => {
				reads += 1;
				return Object.freeze({ projection, epoch: 0, rows: () => durableRows });
			},
			project: (rows) => fold(EMPTY, rows),
			now: () => 0,
			setTimer: () => 0,
			clearTimer: () => undefined,
		});
		const before = JSON.stringify([durableRows, projection]);
		const id = overlay.addLocal(op("l", 2), 3)!;
		const caller = { action: "place", id: "m", x: 1 };
		overlay.addLocal(caller, 3);
		caller.x = 9; // later caller mutation cannot reach the shown copy
		overlay.addIntent({ author: "peer", intentId: "1", logicalTime: 4, operation: op("i", 3) });
		overlay.bindLocal(id, 5);
		overlay.epochChanged(1);
		overlay.close();
		expect(JSON.stringify([durableRows, projection])).toBe(before);
		expect(reads).toBeGreaterThan(0);
		expect(Object.isFrozen(overlay.pending())).toBe(true);
	});

	it("holds no plane, store, signer or transport capability", () => {
		const source = readFileSync(new URL("../src/internal/presentation-overlay.ts", import.meta.url), "utf8");
		const file = ts.createSourceFile("overlay.ts", source, ts.ScriptTarget.Latest, true);
		const imports = file.statements.filter(ts.isImportDeclaration).map((node) => ({
			from: (node.moduleSpecifier as ts.StringLiteral).text,
			typeOnly: node.importClause?.isTypeOnly === true,
		}));
		expect(imports).toEqual([
			{ from: "@ts-drp/canonical", typeOnly: false },
			{ from: "@ts-drp/ephemeral", typeOnly: true },
		]);
		expect(source).not.toMatch(/indexedDB|issueLocal|signRegisteredVertexDigest|publishPending|globalThis/u);
	});

	it("feeds nothing back from the overlay into the room's durable path", () => {
		// Every reference to the overlay in the room is classified by how its value
		// is used. The only values that leave it are display getters' results, a
		// local entry id kept for later overlay calls, and a dedupe boolean.
		const source = readFileSync(new URL("../src/v3-room.ts", import.meta.url), "utf8");
		const file = ts.createSourceFile("room.ts", source, ts.ScriptTarget.Latest, true);
		const uses = new Set<string>();
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && (node.text === "presentation" || node.text === "overlay")) {
				const parent = node.parent;
				const declaration =
					ts.isParameter(parent) ||
					(ts.isVariableDeclaration(parent) && parent.name === node) ||
					ts.isPropertySignature(parent) ||
					(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
					(ts.isPropertyAssignment(parent) && parent.name === node);
				if (!declaration) {
					if (
						ts.isPropertyAccessExpression(parent) &&
						ts.isCallExpression(parent.parent) &&
						parent.parent.expression === parent
					) {
						const call = parent.parent;
						const consumer = ts.isBinaryExpression(call.parent)
							? `${call.parent.left.getText(file)} ${call.parent.operatorToken.getText(file)}`
							: ts.SyntaxKind[call.parent.kind];
						uses.add(`${node.text}.${parent.name.text}() -> ${consumer}`);
					} else if (ts.isBinaryExpression(parent)) {
						uses.add(parent.getText(file).replace(/\(\{[\s\S]*$/u, "("));
					} else if (ts.isCallExpression(parent)) {
						uses.add(`argument of ${parent.expression.getText(file)}`);
					} else if (ts.isPropertyAssignment(parent)) {
						uses.add(`property ${parent.name.getText(file)}`);
					} else uses.add(`other ${ts.SyntaxKind[parent.kind]}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		// "ArrowFunction" results are returned to presentationHook, which discards them.
		expect([...uses].sort()).toEqual([
			"argument of action",
			"overlay.addLocal() -> presented =",
			"overlay.addRemoteVertex() -> ExpressionStatement",
			"overlay.bindLocal() -> ArrowFunction",
			"overlay.close() -> ArrowFunction",
			"overlay.durableChanged() -> ArrowFunction",
			"overlay.durableCommitted() -> ArrowFunction",
			"overlay.durableRefused() -> ArrowFunction",
			"overlay.epochChanged() -> ArrowFunction",
			"overlay.hasRemoteSigned() -> !speculated.ok ||",
			"overlay.settleLocal() -> ArrowFunction",
			"presentation = createPresentationOverlay<Projection>(",
			"presentation === undefined",
			"presentation.pending() -> presentation?.pending() ??",
			"presentation.projection() -> presentation?.projection() ??",
			"property overlay",
		]);
		// The local id is consumed only by later overlay calls.
		const presented = source.match(/^.*\bpresented\b.*$/gmu) ?? [];
		expect(presented).toHaveLength(9);
		expect(
			presented.every((line) =>
				/let presented|presented = overlay\.addLocal|presented !== undefined|const id = presented|presented move rolled back/u.test(
					line
				)
			)
		).toBe(true);
	});

	it("authenticates a speculative remote vertex without mutating the live registration", () => {
		const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		const file = ts.createSourceFile("live.ts", source, ts.ScriptTarget.Latest, true);
		const declaration = file.statements.find(
			(node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === "speculateV3IngressVertex"
		)!;
		const writes: string[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
				node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
			)
				writes.push(node.getText(file));
			if (
				(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
				[ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
			)
				writes.push(node.getText(file));
			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText(file);
				if (
					/\.(set|add|delete|push|clear|splice)$|retainPendingIngress|handleV3Ingress|enqueue|drainPendingIngress|ingressFailureLog/u.test(
						callee
					)
				)
					writes.push(callee);
			}
			ts.forEachChild(node, visit);
		};
		visit(declaration);
		expect(writes).toEqual([]);
		// Execute the actual body against a registration that refuses every write.
		const js = ts
			.transpileModule(`${declaration.getText(file)}\nreturn speculateV3IngressVertex;`, {
				compilerOptions: { target: ts.ScriptTarget.ES2022 },
			})
			.outputText.replace(/^export /mu, "");
		const guard = <T extends object>(value: T): T =>
			new Proxy(value, {
				set: () => {
					throw new Error("write");
				},
				defineProperty: () => {
					throw new Error("write");
				},
				deleteProperty: () => {
					throw new Error("write");
				},
				get: (target, key, receiver) => {
					const selected = Reflect.get(target, key, receiver);
					return typeof selected === "object" && selected !== null ? guard(selected) : selected;
				},
			});
		const digest = new Uint8Array(32).fill(7);
		const admitted = {
			author: "peer",
			epoch: 0,
			logicalTime: 5,
			operation: { action: "place" },
			digest,
			dependencies: [],
		};
		const registration = guard({
			blueprintClosing: true,
			readinessMaintenanceEntered: true,
			retainedBootstrapHold: false,
			topic: "room",
			networkNode: { gossipTopicFor: () => "room" },
			payload: { trust: { trust: { profileId: "creator-trusted-settlement-v1" } } },
			authorization: { kind: "latched-acl" },
			index: { has: () => false },
		});
		const bindings = {
			ObjectFreeze: Object.freeze,
			v3HandleRegistrations: new Map([["plane", registration]]),
			currentRegistration: () => true,
			MessageType: { MESSAGE_TYPE_V3_ENVELOPE: 9 },
			isInstanceOf: (value: unknown) => value instanceof Uint8Array,
			Uint8ArrayConstructor: Uint8Array,
			copyDetachedBytes: (value: Uint8Array) => new Uint8Array(value),
			V3Envelope: {
				decode: () => ({ canonicalPreimage: Uint8Array.of(1), signature: Uint8Array.of(2) }),
				encode: () => ({ finish: () => Uint8Array.of(3) }),
			},
			sameBytes: () => true,
			extractAuthorizedV3Vertex: () => ({ ok: true, vertex: admitted }),
			resolveV3AuthorizedAuthor: () => ({ bytes: new Uint8Array(32), format: "raw" }),
			lowerHexDigest: () => "07".repeat(32),
			isControlOperation: () => false,
			aclOperation: () => null,
			isV3ApplicationAuthorAuthorized: () => true,
		};
		const speculate = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
		const message = { type: 9, objectId: "room", data: Uint8Array.of(3) };
		const result = speculate({ plane: "plane", message });
		expect(result).toMatchObject({ ok: true, vertexDigest: "07".repeat(32) });
		// A real close (not a maintenance boundary) is not speculated, matching the ingress drop rule.
		const closing = speculate.call(undefined, { plane: "missing", message });
		expect(closing).toEqual({ ok: false, reason: "inactive" });
	});

	it("accepts intents only from mapped peers, as display entries that cannot carry a vertex", async () => {
		const durableRows: readonly PresentationRow[] = Object.freeze([]);
		const projection = fold(EMPTY, durableRows);
		const overlay = createPresentationOverlay<State>({
			localAuthor: "local",
			options: {},
			batchableOperationActions: ["place"],
			durable: () => ({ projection, epoch: 0, rows: () => durableRows }),
			project: (rows) => fold(EMPTY, rows),
			now: () => 0,
			setTimer: () => 0,
			clearTimer: () => undefined,
		});
		const { encodeCanonical } = await import("@ts-drp/canonical");
		let deliver:
			| ((frame: {
					class: "reliable-unordered";
					key: string | null;
					payload: Uint8Array;
					sequence: number;
					sender: string;
			  }) => void)
			| undefined;
		const published: Uint8Array[] = [];
		const detach = attachPresentationIntents({
			overlay,
			channel: {
				publish: async (frame) => {
					expect([frame.class, frame.key]).toEqual(["reliable-unordered", null]);
					published.push(frame.payload);
					return true;
				},
				subscribe: (listener) => {
					deliver = listener as typeof deliver;
					return () => (deliver = undefined);
				},
			},
			key: "intent",
			localAuthor: "local",
			authorForPeer: (peerId) => (peerId === "peer-id" ? "peer" : peerId === "self-id" ? "local" : undefined),
		});
		const frame = (sender: string, payload: unknown, key: string | null = null) => ({
			class: "reliable-unordered" as const,
			key,
			payload: encodeCanonical(payload),
			sequence: 1,
			sender,
		});
		const header = { channel: "intent", version: 1, session: "0123456789abcdef" };
		const intent = { ...header, kind: "intent", id: 1, logicalTime: 4, operation: op("i", 1) };
		deliver!(frame("stranger", intent));
		deliver!(frame("self-id", intent));
		deliver!(frame("peer-id", { ...intent, channel: "other" }));
		deliver!(frame("peer-id", intent, "keyed"));
		deliver!(frame("peer-id", { ...intent, session: "short" }));
		deliver!(frame("peer-id", { ...intent, operation: { action: "acl", kind: "grant" } }));
		deliver!({ ...frame("peer-id", intent), payload: Uint8Array.of(0xff) });
		expect(overlay.pending()).toEqual([]);
		deliver!(frame("peer-id", intent));
		expect(overlay.pending().map((entry) => [entry.source, entry.author, entry.vertexDigest])).toEqual([
			["remote-intent", "peer", undefined],
		]);
		expect(overlay.projection()).not.toBe(projection);
		expect(projection.count).toBe(0);
		deliver!(frame("peer-id", { ...header, kind: "withdraw", id: 1 }));
		expect(overlay.projection()).toBe(projection);
		// Local moves announce an intent and a withdrawal on refusal, keyless and namespaced.
		const id = overlay.addLocal(op("mine", 2), 3)!;
		overlay.settleLocal(id, { ok: false, reason: "refused", error: new TypeError("refused") });
		expect(published).toHaveLength(2);
		const { decodeCanonical } = await import("@ts-drp/canonical");
		expect(published.map((bytes) => (decodeCanonical(bytes) as Record<string, unknown>).kind)).toEqual([
			"intent",
			"withdraw",
		]);
		expect(published.every((bytes) => (decodeCanonical(bytes) as Record<string, unknown>).channel === "intent")).toBe(
			true
		);
		detach();
		expect(deliver).toBeUndefined();
	});
});
