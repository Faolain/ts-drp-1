import type { LullFixture, SessionWrap } from "./room-fixture.js";

// Track M, slice 14f: hooks around every room retirement session the node opens on a
// fixture's host (the browser counterpart of `trapRetention` in
// tests/fixtures/track-m/room-retention-probe.ts, plus continuation indexes and a hook
// between step A and step B). Only sessions that call `planRetention` reach the hooks.
// A hook observes, blocks the worker at an edge (process-death cases), or throws (the
// atomicity case); it never changes what the node decides or writes.

export interface RetentionHooks {
	/** Before the node's FIRST planRetention of a session (nothing of it has run yet). */
	beforeFirstPlan?(
		input: Readonly<{ database: string; selection: Readonly<Record<string, unknown>> }>
	): Promise<void> | void;
	/**
	 * Before each planRetention (Track O). It may only throw a refusal the session itself
	 * could give (a lowered per-transaction cap); the node's own planner then splits.
	 */
	beforePlan?(input: Readonly<{ database: string; selection: Readonly<Record<string, unknown>> }>): void;
	/** After each planRetention; `index` is the continuation it plans (applies so far). */
	afterPlan?(
		input: Readonly<{
			database: string;
			index: number;
			planned: Readonly<Record<string, unknown>>;
			selection: Readonly<Record<string, unknown>>;
		}>
	): Promise<void> | void;
	/** After step A (the floor fence) returned, before step B (applyRetention) starts. */
	beforeApply?(
		input: Readonly<{ database: string; index: number; selection: Readonly<Record<string, unknown>> }>
	): Promise<void> | void;
	/** After applyRetention returned (every request issued and answered), before its checkpoint. */
	afterApply?(
		input: Readonly<{
			database: string;
			index: number;
			applied: Readonly<Record<string, unknown>>;
			selection: Readonly<Record<string, unknown>>;
		}>
	): Promise<void> | void;
	/** After each checkpoint or commit committed. */
	afterCommit?(
		input: Readonly<{ database: string; index: number; kind: "checkpoint" | "commit" }>
	): Promise<void> | void;
	/** After an abort of a retention session finished. */
	afterAbort?(input: Readonly<{ database: string; cause: unknown }>): Promise<void> | void;
}

export interface RetentionCounts {
	readonly sessions: number;
	readonly plans: number;
	readonly applies: number;
	readonly checkpoints: number;
}

/** The continuation index (applies so far) of the session currently inside step B, by database. */
export const applying = new Map<string, number>();

export function trapRetention(fixture: LullFixture, hooks: RetentionHooks) {
	const counts = { sessions: 0, plans: 0, applies: 0, checkpoints: 0 };
	const wrap: SessionWrap = (session, _label, database) => {
		let retention = false;
		let applied = 0;
		const call = (name: string) => session[name] as (...args: unknown[]) => Promise<unknown>;
		return Object.freeze({
			...session,
			planRetention: async (...args: unknown[]) => {
				const selection = args[1] as Readonly<Record<string, unknown>>;
				if (!retention) {
					retention = true;
					counts.sessions++;
					await hooks.beforeFirstPlan?.({ database, selection });
				}
				hooks.beforePlan?.({ database, selection });
				counts.plans++;
				const planned = (await call("planRetention")(...args)) as Readonly<Record<string, unknown>>;
				await hooks.afterPlan?.({ database, index: applied, planned, selection });
				return planned;
			},
			applyRetention: async (...args: unknown[]) => {
				const selection = args[1] as Readonly<Record<string, unknown>>;
				await hooks.beforeApply?.({ database, index: applied, selection });
				counts.applies++;
				applying.set(database, applied);
				try {
					const result = (await call("applyRetention")(...args)) as Readonly<Record<string, unknown>>;
					await hooks.afterApply?.({ database, index: applied, applied: result, selection });
					return result;
				} finally {
					applying.delete(database);
				}
			},
			checkpoint: async () => {
				await call("checkpoint")();
				if (retention) {
					counts.checkpoints++;
					const index = applied;
					applied++;
					await hooks.afterCommit?.({ database, index, kind: "checkpoint" });
				}
			},
			commit: async () => {
				await call("commit")();
				if (retention) await hooks.afterCommit?.({ database, index: applied, kind: "commit" });
			},
			abort: async (cause?: unknown) => {
				await call("abort")(cause);
				if (retention) await hooks.afterAbort?.({ database, cause });
			},
		});
	};
	fixture.host.setWrap(wrap);
	return Object.freeze({
		counts: (): RetentionCounts => ({ ...counts }),
		release: () => fixture.host.setWrap(undefined),
	});
}
