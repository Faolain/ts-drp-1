import { SetDRP } from "@ts-drp/blueprints";
import { writeFile } from "fs/promises";
import * as pprof from "pprof";

import { createACL, DRPObject } from "../src/index.js";

type DRPManipulationStrategy = (drp: SetDRP<number>, value: number) => void;

const createWithStrategy = (
	peerId: string,
	admins: string[],
	verticesPerDRP: number,
	strategy: DRPManipulationStrategy
): DRPObject<SetDRP<number>> => {
	const obj = new DRPObject({
		peerId,
		acl: createACL({ admins }),
		drp: new SetDRP<number>(),
	});

	if (!obj.drp) throw new Error("DRP is undefined");

	for (let i = 0; i < verticesPerDRP; i++) {
		strategy(obj.drp, i);
	}

	return obj;
};
const manipulationStrategies: DRPManipulationStrategy[] = [
	(drp, value): void => drp.add(value),
	(drp, value): void => {
		drp.delete(value);
		drp.add(value);
	},
	(drp, value): void => {
		drp.add(value);
		drp.delete(value);
	},
];

function createDRPObjects(numDRPs: number, verticesPerDRP: number): DRPObject<SetDRP<number>>[] {
	const admins = Array.from({ length: numDRPs }, (_, peerIndex) => `peer1_${peerIndex}`);
	return admins.map((peerId, peerIndex) =>
		createWithStrategy(peerId, admins, verticesPerDRP, manipulationStrategies[peerIndex % 3])
	);
}

async function mergeObjects(objects: DRPObject<SetDRP<number>>[]): Promise<void> {
	for (const [sourceIndex, sourceObject] of objects.entries()) {
		for (const [targetIndex, targetObject] of objects.entries()) {
			if (sourceIndex !== targetIndex) {
				await sourceObject.merge(targetObject.vertices);
			}
		}
	}
}

async function flamegraphForSetDRP(
	numDRPs: number,
	verticesPerDRP: number,
	mergeFn: boolean,
	outputPath: string
): Promise<void> {
	console.log("start to profile >>>");
	const stopFn = pprof.time.start();
	const objects = createDRPObjects(numDRPs, verticesPerDRP);

	if (mergeFn) {
		await mergeObjects(objects);
	}

	const profile = stopFn();
	const buf = await pprof.encode(profile);
	await writeFile(outputPath, buf);
	console.log(`<<< finished profiling ${numDRPs} DRP object(s) × ${verticesPerDRP} vertices to ${outputPath}`);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (Number.isNaN(parsed)) return fallback;
	if (parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

const profileArgs = process.argv.slice(2);
if (profileArgs[0] === "--") profileArgs.shift();
const [numDRPsArg, verticesPerDRPArg, mergeArg, outputPath = "flamegraph.pprof"] = profileArgs;
const numDRPs = positiveInteger(numDRPsArg, 1, "numDRPs");
const verticesPerDRP = positiveInteger(verticesPerDRPArg, 1000, "verticesPerDRP");
const mergeFn = mergeArg === undefined ? false : mergeArg === "true";

if (mergeArg !== undefined && mergeArg !== "true" && mergeArg !== "false") {
	throw new Error("merge must be either true or false");
}

flamegraphForSetDRP(numDRPs, verticesPerDRP, mergeFn, outputPath).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
