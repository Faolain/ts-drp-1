/* eslint-disable @typescript-eslint/no-explicit-any */
import { deserializeValue, serializeValue } from "@ts-drp/utils/serialization";
import Benchmark from "benchmark";

function createNestedObject(depth: number, breadth: number): any {
	if (depth <= 0) {
		return {
			num: 42.5,
			str: "test",
			date: new Date(),
			set: new Set([1, 2, 3]),
			map: new Map([
				["a", 1],
				["b", 2],
			]),
			array: new Uint8Array([1, 2, 3, 4]),
			float: new Float32Array([1.1, 2.2, 3.3]),
		};
	}
	const obj: any = {};
	for (let i = 0; i < breadth; i++) {
		obj[`child${i}`] = createNestedObject(depth - 1, breadth);
	}
	return obj;
}

const suite = new Benchmark.Suite();
function benchmarkSerializeValue(depth: number, breadth: number): Benchmark.Suite {
	const deepObject = createNestedObject(depth, breadth);
	for (let i = 0; i < 3; i++) {
		serializeValue(deepObject);
	}

	return suite.add(`Serialize ${depth} depth ${breadth} breadth`, () => {
		// A depth-5, breadth-5 object contains 5^5 = 3,125 leaf nodes.
		const iterations = 100;
		for (let i = 0; i < iterations; i++) {
			serializeValue(deepObject);
		}
	});
}

benchmarkSerializeValue(5, 5);

function benchmarkDeserializeValue(depth: number, breadth: number): Benchmark.Suite {
	const deepObject = createNestedObject(depth, breadth);
	const serialized = serializeValue(deepObject);
	for (let i = 0; i < 3; i++) {
		deserializeValue(serialized);
	}

	return suite.add(`Deserialize ${depth} depth ${breadth} breadth`, () => {
		const iterations = 100;
		for (let i = 0; i < iterations; i++) {
			deserializeValue(serialized);
		}
	});
}

benchmarkDeserializeValue(5, 5);

suite
	.on("cycle", (event: Benchmark.Event) => {
		console.log(String(event.target));
	})
	.on("complete", function (this: Benchmark.Suite) {
		console.log(`Fastest is ${this.filter("fastest").map("name")}`);
	})
	.run({ async: true });
