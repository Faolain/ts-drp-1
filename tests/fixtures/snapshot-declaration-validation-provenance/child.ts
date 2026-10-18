import { probe, type Sentinel, SENTINELS, type Stage, STAGES } from "./probe.js";
const stage = process.argv[2] as Stage,
	sentinel = process.argv[3] as Sentinel;
if (!STAGES.includes(stage) || !SENTINELS.includes(sentinel)) throw new Error("invalid validation case");
console.log(JSON.stringify(await probe(stage, sentinel)));
