import assert from "node:assert/strict";

export type TraceTree = (number | TraceTree)[];
export interface AllocationSnapshot {
	snapshot: {
		meta: {
			trace_function_info_fields: string[];
			trace_node_fields: string[];
			node_fields: string[];
			node_types: (string | string[])[];
		};
	};
	trace_function_infos: number[];
	trace_tree: TraceTree;
	strings: string[];
	nodes: number[];
}
export interface AllocationFrame {
	functionName: string;
	scriptName: string;
	scriptId: number;
	line: number;
	column: number;
}
export interface TracedInstance {
	id: number;
	shallowBytes: number;
	traceId: number;
	stack: AllocationFrame[] | null;
}
function numeric(values: readonly (number | TraceTree)[], index: number): number {
	const value = values[index];
	assert.ok(typeof value === "number" && Number.isSafeInteger(value), "invalid numeric snapshot field");
	return value;
}
function stringAt(values: readonly string[], index: number): string {
	const value = values[index];
	assert.ok(typeof value === "string", "invalid snapshot string index");
	return value;
}

/** Decode only recorded allocation frames; snapshot IDs and trace IDs are different namespaces. */
export function allocationTraces(
	snapshot: AllocationSnapshot,
	wantedTraceIds?: ReadonlySet<number>
): Map<number, AllocationFrame[]> {
	const meta = snapshot.snapshot.meta,
		fields = meta.trace_function_info_fields,
		treeFields = meta.trace_node_fields;
	const index = (name: string): number => {
		const i = fields.indexOf(name);
		assert.ok(i >= 0, `missing trace field ${name}`);
		return i;
	};
	const ti = (name: string): number => {
		const i = treeFields.indexOf(name);
		assert.ok(i >= 0, `missing trace tree field ${name}`);
		return i;
	};
	const functionIndex = ti("function_info_index"),
		traceIndex = ti("id"),
		childrenIndex = ti("children");
	const functions = snapshot.trace_function_infos;
	assert.equal(functions.length % fields.length, 0);
	const traces = new Map<number, AllocationFrame[]>();
	const seen = new Set<number>();
	function walk(nodes: TraceTree, parent: AllocationFrame[]): void {
		assert.equal(nodes.length % treeFields.length, 0);
		for (let n = 0; n < nodes.length; n += treeFields.length) {
			const offset = numeric(nodes, n + functionIndex) * fields.length;
			assert.ok(offset >= 0 && offset + fields.length <= functions.length);
			const frame = {
				functionName: stringAt(snapshot.strings, numeric(functions, offset + index("name"))),
				scriptName: stringAt(snapshot.strings, numeric(functions, offset + index("script_name"))),
				scriptId: numeric(functions, offset + index("script_id")),
				line: numeric(functions, offset + index("line")),
				column: numeric(functions, offset + index("column")),
			};
			const id = numeric(nodes, n + traceIndex);
			assert.ok(!seen.has(id), "duplicate trace id");
			seen.add(id);
			parent.push(frame);
			if (!wantedTraceIds || wantedTraceIds.has(id)) traces.set(id, [...parent]);
			const children = nodes[n + childrenIndex];
			assert.ok(Array.isArray(children), "invalid trace children");
			walk(children, parent);
			parent.pop();
		}
	}
	walk(snapshot.trace_tree, []);
	return traces;
}

/** Offline control selector; metadata count/size fields are not surviving object bytes. */
export function tracedInstances(snapshot: AllocationSnapshot, constructorName: string): TracedInstance[] {
	const fields = snapshot.snapshot.meta.node_fields,
		types = snapshot.snapshot.meta.node_types[0],
		traces = allocationTraces(snapshot);
	assert.ok(Array.isArray(types), "invalid snapshot node types");
	const field = (name: string): number => {
		const i = fields.indexOf(name);
		assert.ok(i >= 0);
		return i;
	};
	const type = field("type"),
		name = field("name"),
		id = field("id"),
		trace = fields.indexOf("trace_node_id"),
		size = field("self_size"),
		rows: TracedInstance[] = [];
	assert.ok(trace >= 0 || traces.size === 0, "allocation traces require a node trace field");
	for (let n = 0; n < snapshot.nodes.length; n += fields.length) {
		if (
			types[numeric(snapshot.nodes, n + type)] !== "object" ||
			stringAt(snapshot.strings, numeric(snapshot.nodes, n + name)) !== constructorName
		)
			continue;
		const traceId = trace < 0 ? 0 : numeric(snapshot.nodes, n + trace);
		rows.push({
			id: numeric(snapshot.nodes, n + id),
			shallowBytes: numeric(snapshot.nodes, n + size),
			traceId,
			stack: traces.get(traceId) ?? null,
		});
	}
	return rows;
}
