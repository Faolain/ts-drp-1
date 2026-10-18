import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

export interface SnapshotOracleVertex {
	readonly dependencies: readonly string[];
	readonly operation?: Readonly<Record<string, unknown>>;
}

/**
 * Independent test oracle: graph input is signed source material, never fold output.
 * @param vertices - Complete raw graph, including anchor and controls.
 * @param anchor - Authenticated epoch anchor identity.
 * @param frontier - Raw graph tips whose ancestry must cover every vertex.
 * @param priorState - Previously independently verified application bytes.
 * @returns Projected order, exact append-only state, ancestry and dependencies.
 */
export function snapshotStateOracle(
	vertices: ReadonlyMap<string, SnapshotOracleVertex>,
	anchor: string,
	frontier: readonly string[],
	priorState: Uint8Array
): { state: Uint8Array; order: string[]; ancestors: string[]; dependencies: Map<string, string[]> } {
	const lookup = (hash: string): SnapshotOracleVertex => {
		const vertex = vertices.get(hash);
		if (vertex === undefined) throw new Error(`F5B_ORACLE_MISSING_VERTEX:${hash}`);
		return vertex;
	};
	const ancestors = (tips: readonly string[]): Set<string> => {
		const found = new Set<string>();
		const pending = [...tips];
		while (pending.length > 0) {
			const hash = pending.pop() as string;
			if (found.has(hash)) continue;
			found.add(hash);
			pending.push(...lookup(hash).dependencies);
		}
		return found;
	};
	const covered = ancestors(frontier);
	if (!covered.has(anchor) || covered.size !== vertices.size) throw new Error("F5B_ORACLE_INCOMPLETE_FRONTIER");
	if (lookup(anchor).dependencies.length !== 0) throw new Error("F5B_ORACLE_ANCHOR_HAS_DEPENDENCIES");
	const controls = new Set(
		[...vertices]
			.filter(([, vertex]) => ["$drp.author-fence.v1", "join", "causalJoin"].includes(String(vertex.operation?.action)))
			.map(([hash]) => hash)
	);
	const dependencies = new Map<string, string[]>();
	for (const [hash, vertex] of vertices) {
		if (controls.has(hash)) continue;
		const expanded = new Set<string>();
		const visited = new Set<string>();
		const pending = [...vertex.dependencies];
		while (pending.length > 0) {
			const dependency = pending.pop() as string;
			if (visited.has(dependency)) continue;
			visited.add(dependency);
			if (controls.has(dependency)) pending.push(...lookup(dependency).dependencies);
			else {
				lookup(dependency);
				expanded.add(dependency);
			}
		}
		// Remove redundant ancestors only after reconnecting the removed controls.
		dependencies.set(
			hash,
			[...expanded]
				.filter((candidate) => ![...expanded].some((other) => other !== candidate && ancestors([other]).has(candidate)))
				.sort()
		);
	}
	const order: string[] = [];
	const remaining = new Set(dependencies.keys());
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((hash) => (dependencies.get(hash) as string[]).every((dependency) => !remaining.has(dependency)))
			.sort()[0];
		if (next === undefined) throw new Error("F5B_ORACLE_CYCLIC_GRAPH");
		remaining.delete(next);
		order.push(next);
	}
	if (order[0] !== anchor) throw new Error("F5B_ORACLE_DISCONNECTED_ANCHOR");
	const state = decodeCanonical(priorState) as { clientOperationId: string; text: string }[];
	const append = (operation: Readonly<Record<string, unknown>>): void => {
		if (
			operation.action !== "message" ||
			typeof operation.clientOperationId !== "string" ||
			typeof operation.text !== "string"
		)
			throw new Error("F5B_ORACLE_UNEXPECTED_MESSAGE");
		state.push({ clientOperationId: operation.clientOperationId, text: operation.text });
	};
	for (const hash of order) {
		if (hash === anchor) continue;
		const operation = lookup(hash).operation;
		if (operation === undefined) throw new Error("F5B_ORACLE_OPERATION_ABSENT");
		if (operation.action === "acl") continue; // Ordered, but no chat-state effect.
		if (operation.action === "applicationBatch") {
			const batch = operation.batch as {
				version: number;
				entries: { logicalTime: number; operation: Record<string, unknown> }[];
			};
			if (batch.version !== 1 || batch.entries.length < 2) throw new Error("F5B_ORACLE_BAD_BATCH");
			for (const entry of batch.entries) append(entry.operation);
		} else append(operation);
	}
	return { state: encodeCanonical(state), order, ancestors: [...covered].sort(), dependencies };
}
