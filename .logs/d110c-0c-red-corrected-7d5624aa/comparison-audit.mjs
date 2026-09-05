import { readFileSync } from "node:fs";

const assetPath = "packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts";
const source = readFileSync(assetPath, "utf8");

function normalize(value) {
	if (value instanceof Uint8Array) {
		return { bytes: Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("") };
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, normalize(entry)])
		);
	}
	return value;
}

function fingerprint(value) {
	return JSON.stringify(normalize(value));
}

const before = {
	generations: [{ closure: [{ active: undefined, epoch: 3, kind: "v3-live-generation-2" }] }],
	name: "room--ahe",
};
const reordered = {
	name: "room--ahe",
	generations: [{ closure: [{ kind: "v3-live-generation-2", epoch: 3, active: undefined }] }],
};
const mutated = {
	generations: [{ closure: [{ active: undefined, epoch: 4, kind: "v3-live-generation-2" }] }],
	name: "room--ahe",
};

const result = Object.freeze({
	aheFingerprintDetectsMutation: fingerprint(before) !== fingerprint(mutated),
	aheFingerprintIgnoresKeyOrder: fingerprint(before) === fingerprint(reordered),
	ahePredicatePresent: source.includes("fingerprint(aheBefore) !== fingerprint(aheAfter)"),
	canonicalFloorPredicatePreserved: source.includes("!sameCanonical(floorBefore, floorAfter)"),
	diagnosticContainsUndefined: before.generations[0].closure[0].active === undefined,
});

if (Object.values(result).some((value) => value !== true)) {
	throw new TypeError(`D110C_0C comparison audit failed: ${JSON.stringify(result)}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
