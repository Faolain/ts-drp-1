/**
 * Endurance conservation: how a Writer's move whose first copy the scripted wire dropped reached the
 * creator. It is carried when the creator admitted the exact source, or when the Writer's durable
 * settlement plan replaced it and every replacement chunk is carried in turn.
 *
 * The chain is followed to its end: a replacement the creator closed an epoch without (the Writer's
 * rebased moves count toward the next epoch's budget, so the creator can close it while the tail of
 * that batch is in flight) is itself replaced by the Writer's settlement after the next install.
 * Strict: every hop is a plan entry of the Writer's durable settlement plan (the caller asserts none
 * dangles), every leaf is a digest the creator admitted, and a chain that ends anywhere else, cycles
 * or exceeds the hop bound is a lost move.
 */
export interface LostRowReplacement {
	readonly sourceDigest: string;
	readonly replacementDigests: readonly string[];
}

export interface LostRowDisposition {
	readonly carried: boolean;
	/** The digests the creator admitted that carry the move (the source itself, or the chain's admitted leaves). */
	readonly acceptedDigests: readonly string[];
}

/** More replacement hops than this for one move is treated as lost (each hop is one closed epoch). */
const MAX_REPLACEMENT_HOPS = 32;

/**
 * @param sourceDigest - The dropped first copy.
 * @param replacements - The Writer's durable settlement plan entries (source digest to replacement chunk digests).
 * @param accepted - The creator's admission of each digest, in order.
 */
export async function lostRowDisposition(
	sourceDigest: string,
	replacements: readonly LostRowReplacement[],
	accepted: (digests: readonly string[]) => Promise<readonly boolean[]>
): Promise<LostRowDisposition> {
	const bySource = new Map(replacements.map((entry) => [entry.sourceDigest, entry.replacementDigests]));
	const leaves: string[] = [];
	const carried = async (digest: string, path: ReadonlySet<string>): Promise<boolean> => {
		if ((await accepted([digest]))[0] === true) {
			leaves.push(digest);
			return true;
		}
		const next = bySource.get(digest) ?? [];
		if (next.length === 0 || path.size >= MAX_REPLACEMENT_HOPS) return false;
		const extended = new Set(path).add(digest);
		for (const replacement of next) {
			if (extended.has(replacement) || !(await carried(replacement, extended))) return false;
		}
		return true;
	};
	const result = await carried(sourceDigest, new Set());
	return { carried: result, acceptedDigests: result ? leaves : [] };
}

/** A dropped first copy the conservation check must account for, and when it was dropped (ms, the probe's clock). */
export interface DroppedRow {
	readonly digest: string;
	readonly droppedAt: number;
}

/** The peers' state the dropped-row accounting reads. */
export interface DroppedRowProbe {
	/** The author's durable settlement plan entries (re-read on each evaluation). */
	replacements(): Promise<readonly LostRowReplacement[]>;
	/** The receiver's admission of each digest, in order. */
	accepted(digests: readonly string[]): Promise<readonly boolean[]>;
	/** When the receiver admitted each digest (same clock as `droppedAt`), or null; optional. */
	admittedAt?(digests: readonly string[]): Promise<readonly (number | null)[]>;
	/** Whether the author holds a durable hand-back record for one of these digests, and whether it was re-offered and admitted. */
	handBack(digests: ReadonlySet<string>): Promise<"none" | "pending" | "reoffered-admitted">;
	/** How many adoptions the receiver has made so far. */
	adoptions(): Promise<number>;
	/** Drives delivery between evaluations (flush, re-offer, install published offers). */
	progress(): Promise<void>;
	/** The diagnostic dump a failure carries. */
	diag(row: DroppedRow): Promise<Readonly<Record<string, unknown>>>;
}

export interface DroppedRowClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface DroppedRowOptions {
	/** The fixed cap added to the start of the wait, or to the next adoption when one happens during it. */
	readonly capMs: number;
	readonly pollMs: number;
}

export interface DroppedRowAccounted {
	readonly digest: string;
	readonly how: "exact" | "replaced" | "handed-back";
	readonly acceptedDigests: readonly string[];
	/** From the drop to the admission that carries the move. */
	readonly latencyMs: number;
}

/**
 * The digests that carry a move: the source and every replacement reachable from it in the plan.
 * @param sourceDigest - The dropped first copy.
 * @param replacements - The author's durable settlement plan entries.
 * @returns The source and its replacement chain.
 */
function chainDigests(sourceDigest: string, replacements: readonly LostRowReplacement[]): ReadonlySet<string> {
	const bySource = new Map(replacements.map((entry) => [entry.sourceDigest, entry.replacementDigests]));
	const seen = new Set<string>();
	const walk = (digest: string): void => {
		if (seen.has(digest) || seen.size > MAX_REPLACEMENT_HOPS * 8) return;
		seen.add(digest);
		for (const next of bySource.get(digest) ?? []) walk(next);
	};
	walk(sourceDigest);
	return seen;
}

/**
 * Accounts for every dropped first copy at an epoch's conservation check. Each must be admitted exactly,
 * carried by a complete replacement chain (lostRowDisposition), or handed back with a durable hand-back
 * record that was re-offered and admitted. The check waits for the rows themselves, driving delivery
 * between evaluations, until the start of the wait plus `capMs`, extended to the next adoption plus
 * `capMs` when one happens during the wait. A row still unaccounted for then fails the check, loudly,
 * with each row's diagnostic dump: the wait never falls through.
 * @param rows - The dropped first copies of this epoch.
 * @param probe - The peers' state.
 * @param clock - Time source.
 * @param options - Wait bound and poll interval.
 * @returns How each row was carried, and how long after its drop.
 */
export async function accountDroppedRows(
	rows: readonly DroppedRow[],
	probe: DroppedRowProbe,
	clock: DroppedRowClock,
	options: DroppedRowOptions
): Promise<readonly DroppedRowAccounted[]> {
	const accounted: DroppedRowAccounted[] = [];
	const start = clock.now();
	const adoptionsAtStart = await probe.adoptions();
	let adoptedAt: number | undefined;
	let pending = [...rows];
	for (let evaluation = 0; ; evaluation++) {
		if (evaluation > 0) await probe.progress();
		const replacements = await probe.replacements();
		const unaccounted: DroppedRow[] = [];
		for (const row of pending) {
			const disposition = await lostRowDisposition(row.digest, replacements, (digests) => probe.accepted(digests));
			if (disposition.carried) {
				const times = (await probe.admittedAt?.(disposition.acceptedDigests)) ?? [];
				const admitted =
					times.length === disposition.acceptedDigests.length && times.every((time) => time !== null)
						? Math.max(...(times as number[]))
						: clock.now();
				accounted.push({
					digest: row.digest,
					how:
						disposition.acceptedDigests.length === 1 && disposition.acceptedDigests[0] === row.digest
							? "exact"
							: "replaced",
					acceptedDigests: disposition.acceptedDigests,
					latencyMs: Math.max(0, admitted - row.droppedAt),
				});
				continue;
			}
			if ((await probe.handBack(chainDigests(row.digest, replacements))) === "reoffered-admitted") {
				accounted.push({
					digest: row.digest,
					how: "handed-back",
					acceptedDigests: [],
					latencyMs: Math.max(0, clock.now() - row.droppedAt),
				});
				continue;
			}
			unaccounted.push(row);
		}
		pending = unaccounted;
		if (pending.length === 0) return accounted;
		if (adoptedAt === undefined && (await probe.adoptions()) > adoptionsAtStart) adoptedAt = clock.now();
		if (clock.now() >= (adoptedAt ?? start) + options.capMs) {
			const dumps: Readonly<Record<string, unknown>>[] = [];
			for (const row of pending) dumps.push({ digest: row.digest, ...(await probe.diag(row)) });
			throw new Error(
				`dropped source ${pending.map((row) => row.digest).join(", ")} was not admitted exactly, carried by a complete ` +
					`replacement chain, or handed back and re-offered within ${options.capMs} ms of ${adoptedAt === undefined ? "the check" : "the next adoption"} ` +
					`(waited ${Math.round(clock.now() - start)} ms): ${JSON.stringify(dumps)}`
			);
		}
		await clock.sleep(options.pollMs);
	}
}
