import { it } from "vitest";
import { runGridTransitions } from "./fixtures/grid-transition-workload.js";

it.runIf(process.env.TS_DRP_GRID100_DIAGNOSTIC === "1")(
	"diagnostic: 64 active grid writers across 100 genuine same-room transitions",
	() => runGridTransitions(100),
	3_500_000
);
