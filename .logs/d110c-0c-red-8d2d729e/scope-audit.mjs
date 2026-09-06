import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const source = readFileSync("packages/node/src/creator-close.ts", "utf8");
const persistCall = source.slice(source.indexOf("persistedSnapshot ??="), source.indexOf("derivedCommitment ??="));
let productSourceUnchanged = true;
try {
	execFileSync("git", [
		"diff",
		"--quiet",
		"8d2d729e146da1fcaa4374d552bb8ef84eed7512",
		"--",
		"packages/node/src/creator-close.ts",
	]);
} catch {
	productSourceUnchanged = false;
}
const checks = Object.freeze({
	closingAnchorOwnsScope: persistCall.includes("anchor: registration.currentTrust.currentAnchorDigest"),
	closingEpochOwnsScope: persistCall.includes("epoch: registration.currentTrust.currentEpoch"),
	productSourceUnchanged,
	snapshotPayloadComesFromRealClose: persistCall.includes(
		"exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes"
	),
});
if (Object.values(checks).some((value) => value !== true)) {
	throw new TypeError(`D.110c-0c snapshot-scope audit failed: ${JSON.stringify(checks)}`);
}
process.stdout.write(`${JSON.stringify({ checks, ok: true }, null, 2)}\n`);
