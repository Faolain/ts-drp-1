import { computeMainThreadOracle, computeRepeatedMainThreadOracle } from "./real-workload-page.js";

Reflect.set(
	globalThis,
	"phase2hBMainThreadOracle",
	Object.freeze({ computeMainThreadOracle, computeRepeatedMainThreadOracle })
);

export {};
