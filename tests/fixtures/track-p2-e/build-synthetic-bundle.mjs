import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decodeCanonical, encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";

const CONTROL_NAMES = [
	"ambientBad",
	"thenable",
	"intrinsicMutation",
	"moduleGlobalDrift",
	"noncanonicalIntermediate",
	"sparseIntermediate",
];
const ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function domainHex(domain, bytes) {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function syntheticReceipt(authoring, packageBytes, artifactBytes, lintBytes) {
	const packageValue = decodeCanonical(packageBytes);
	const conformance = authoring.conformance;
	const selected = [...conformance.prCases, ...conformance.nightlyAdditionalCases];
	const blueprintDigest = domainHex("ts-drp/blueprint-admission/v3", packageBytes);
	const conformanceDigest = domainHex(
		"ts-drp/blueprint-conformance/v1",
		encodeCanonical({ state: conformance.initialState, outputs: selected.map(({ id }) => id) })
	);
	const controlArtifactDigests = Object.fromEntries(
		CONTROL_NAMES.map((name) => [
			name,
			domainHex("ts-drp/blueprint-artifact/v3", Buffer.from(`${packageValue.implementation.artifactId}:${name}\n`)),
		])
	);
	return Buffer.from(
		encodeCanonical({
			schemaVersion: 1,
			kind: "ts-drp-blueprint-conformance-receipt",
			artifactId: packageValue.implementation.artifactId,
			runtimeProfile: packageValue.implementation.runtimeProfile,
			blueprintDigest,
			artifactDigest: domainHex("ts-drp/blueprint-artifact/v3", artifactBytes),
			lintEvidenceDigest: domainHex("ts-drp/blueprint-lint-evidence/v1", lintBytes),
			corpusDigest: domainHex(
				"ts-drp/blueprint-conformance-corpus/v1",
				encodeCanonical({
					schemaVersion: 1,
					corpusVersion: conformance.corpusVersion,
					seed: conformance.seed,
					initialState: conformance.initialState,
					prCases: conformance.prCases,
					nightlyAdditionalCases: conformance.nightlyAdditionalCases,
				})
			),
			executionTier: "nightly",
			result: "passed",
			conformanceDigest,
			corpusVersion: conformance.corpusVersion,
			seed: conformance.seed,
			operationOrder: selected.map(({ action }) => action),
			selectedCaseIds: selected.map(({ id }) => id),
			corpusAccounting: {
				pr: { total: conformance.prCases.length, selected: conformance.prCases.length, dropped: 0 },
				nightly: { total: selected.length, selected: selected.length, dropped: 0 },
			},
			engines: ENGINE_NAMES.map((name) => ({ name, build: `synthetic-offline-p2-e-${name}`, conformanceDigest })),
			controlArtifactDigests,
			controlOutcomes: {
				ambientBad: { lintRejected: true, crossEngineDigestDisagreement: true },
				thenable: { executed: true, rejected: true },
				intrinsicMutation: { detected: true },
				moduleGlobalDrift: { detected: true },
				noncanonicalIntermediate: { executed: true, rejected: true },
				sparseIntermediate: { executed: true, rejected: true },
			},
			runnerSha256: sha256(
				fs.readFileSync(path.join(REPOSITORY_ROOT, "packages/protocol-v3/scripts/run-blueprint-conformance-v1.mjs"))
			),
		})
	);
}

/** Builds the fixture's exact production outputs and synthetic offline receipt. */
export function buildSyntheticBundle(authoringDirectory, outputDirectory) {
	const closedAuthoring = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "track-p2-e-authoring-"));
	try {
		for (const filename of ["blueprint.json", "blueprint.ts"])
			fs.copyFileSync(path.join(authoringDirectory, filename), path.join(closedAuthoring, filename));
		execFileSync(
			process.execPath,
			[
				path.join(REPOSITORY_ROOT, "packages/blueprint-toolchain/bin/drp-blueprint.mjs"),
				"build",
				"--dir",
				closedAuthoring,
				"--out",
				outputDirectory,
				"--tier",
				"pr",
			],
			{ cwd: REPOSITORY_ROOT, stdio: "pipe" }
		);
		return writeSyntheticReceipt(authoringDirectory, outputDirectory);
	} finally {
		fs.rmSync(closedAuthoring, { force: true, recursive: true });
	}
}

/** Replaces only the P2-c-owned receipt with clearly synthetic P2-e evidence. */
export function writeSyntheticReceipt(authoringDirectory, outputDirectory) {
	const authoring = JSON.parse(fs.readFileSync(path.join(authoringDirectory, "blueprint.json"), "utf8"));
	const artifactBytes = fs.readFileSync(path.join(outputDirectory, "artifact.mjs"));
	const packageBytes = fs.readFileSync(path.join(outputDirectory, "package.bin"));
	const lintBytes = fs.readFileSync(path.join(outputDirectory, "lint.bin"));
	const receiptBytes = syntheticReceipt(authoring, packageBytes, artifactBytes, lintBytes);
	fs.writeFileSync(path.join(outputDirectory, "receipt.bin"), receiptBytes);
	return Object.freeze({
		artifactBytes,
		authoring,
		blueprintDigest: domainHex("ts-drp/blueprint-admission/v3", packageBytes),
		directory: outputDirectory,
		lintBytes,
		packageBytes,
		receiptBytes,
	});
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	const [, , authoringDirectory, outputDirectory] = process.argv;
	if (authoringDirectory === undefined || outputDirectory === undefined)
		throw new TypeError("expected authoring and output paths");
	buildSyntheticBundle(path.resolve(authoringDirectory), path.resolve(outputDirectory));
}
