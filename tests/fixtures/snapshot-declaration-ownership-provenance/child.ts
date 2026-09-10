import { probe } from "./probe.js";

const result = await probe(process.argv[2] !== "control");
console.log(JSON.stringify(result));
process.exitCode = result.results.some((item) => Object.values(item.controls).some((value) => !value))
	? 2
	: result.results.some((item) => item.normative && Object.values(item.normative).some((value) => !value))
		? 1
		: 0;
