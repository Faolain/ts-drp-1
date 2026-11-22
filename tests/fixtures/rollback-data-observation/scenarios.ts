import { type Fault, POSITIVES } from "./types.js";
export const negatives: { name: Fault; config: (typeof POSITIVES)[number] }[] = [
	...(
		[
			"older-missing-chunk",
			"older-corrupt-chunk",
			"older-replaced",
			"older-missing-manifest",
			"temporary",
			"open",
			"legacy",
			"not-ready",
			"abort-first",
			"abort-second",
			"close-first",
			"release-failed",
			"head-stale",
			"floor-stale",
			"floor-pending",
		] as const
	).map((name) => ({ name, config: POSITIVES[2] })),
	...(
		[
			"forged-old-acl",
			"wrong-retirement-anchor",
			"old-qc-length",
			"missing-anchor",
			"anchor-neighbor",
			"anchor-cap",
		] as const
	).map((name) => ({ name, config: POSITIVES[5] })),
	...(["capture-accessor", "already-aborted"] as const).map((name) => ({ name, config: POSITIVES[0] })),
	{ name: "bad-aggregate-link", config: POSITIVES[2] },
	{ name: "bad-settlement-frontier", config: POSITIVES[3] },
];
