import { probe } from "./probe.js";

const result = await probe();
console.log(JSON.stringify(result));
process.exitCode =
	result.encoderControl && result.results.every((item) => Object.values(item.checks).every(Boolean)) ? 0 : 1;
