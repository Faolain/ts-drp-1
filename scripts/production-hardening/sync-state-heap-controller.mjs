/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this profiling tooling directly. */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, type as osType, release, totalmem } from "node:os";
import { join } from "node:path";

import { analyze } from "./sync-state-heap-analyzer.mjs";
import { buildJobs, parseArguments, requiredArgument, sha256Hex } from "./sync-state-heap-common.mjs";

const PINNED_RUNTIME = Object.freeze({
	arch: "arm64",
	baseImageConfigDigest: "sha256:4a2f28cd195e7b99ea839a344269e93883c6c531a05b6f5ecf6b824c8dd8272d",
	baseImageIndexDigest: "sha256:557e52a0fcb928ee113df7e1fb5d4f60c1341dbda53f55e3d815ca10807efdce",
	baseImagePlatformManifestDigest: "sha256:71ecda08bfca53d2b72a727056be374eea4a0ba53cf0de1a947ec8068f4e0918",
	modules: "127",
	node: "v22.15.0",
	platform: "linux",
	v8: "12.4.254.21-node.24",
});

function command(commandName, args, options = {}) {
	const result = spawnSync(commandName, args, {
		cwd: new URL("../../", import.meta.url),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			`Command failed (${commandName} ${args.join(" ")}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	return result.stdout.trim();
}

function assertDigest(value, name) {
	if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} must be a sha256 digest`);
}

function assertAuthoritativeRuntime(argumentsMap) {
	const runtimeImageManifestDigest = requiredArgument(argumentsMap, "runtime-image-manifest-digest");
	const runtimeImageConfigDigest = requiredArgument(argumentsMap, "runtime-image-config-digest");
	const sourceRevision = requiredArgument(argumentsMap, "source-revision");
	assertDigest(runtimeImageManifestDigest, "--runtime-image-manifest-digest");
	assertDigest(runtimeImageConfigDigest, "--runtime-image-config-digest");
	if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) throw new Error("--source-revision must be a full Git commit ID");
	if (process.env.TS_DRP_PROFILE_SOURCE_REVISION !== sourceRevision) {
		throw new Error("Source revision argument does not match the immutable image provenance");
	}
	const observed = {
		arch: process.arch,
		baseImageConfigDigest: requiredArgument(argumentsMap, "base-image-config-digest"),
		baseImageIndexDigest: requiredArgument(argumentsMap, "base-image-index-digest"),
		baseImagePlatformManifestDigest: requiredArgument(argumentsMap, "base-image-platform-manifest-digest"),
		modules: process.versions.modules,
		node: process.version,
		platform: process.platform,
		v8: process.versions.v8,
	};
	for (const [key, expected] of Object.entries(PINNED_RUNTIME)) {
		if (observed[key] !== expected)
			throw new Error(`Authoritative runtime ${key}=${observed[key]}; expected ${expected}`);
	}
	if (process.env.NODE_V8_COVERAGE !== undefined || process.env.NODE_OPTIONS !== undefined) {
		throw new Error("Coverage and NODE_OPTIONS must be unset for authoritative characterization");
	}
	return { ...observed, runtimeImageConfigDigest, runtimeImageManifestDigest, sourceRevision };
}

async function fileSha256(path) {
	return sha256Hex(await readFile(path));
}

async function freshBuild(repositoryRoot) {
	const startedAt = new Date().toISOString();
	command("pnpm", ["--dir", "packages/node", "run", "prebuild"]);
	command("pnpm", ["--dir", "packages/node", "exec", "tsc", "-b", "tsconfig.build.json", "--force"]);
	command(process.execPath, ["build.mjs"], { cwd: join(repositoryRoot, "packages/node") });
	const sourcePath = join(repositoryRoot, "packages/node/src/sync-state.ts");
	const builtPath = join(repositoryRoot, "packages/node/dist/src/sync-state.js");
	const builtStat = await stat(builtPath);
	return {
		builtAt: new Date(builtStat.mtimeMs).toISOString(),
		builtSha256: await fileSha256(builtPath),
		command:
			"pnpm --dir packages/node run prebuild && pnpm --dir packages/node exec tsc -b tsconfig.build.json --force && node packages/node/build.mjs",
		sourceSha256: await fileSha256(sourcePath),
		startedAt,
	};
}

async function main() {
	const argumentsMap = parseArguments(process.argv.slice(2));
	const smoke = argumentsMap.get("smoke") === true;
	const outputDirectory = requiredArgument(argumentsMap, "output");
	const runSeed =
		typeof argumentsMap.get("run-seed") === "string" ? argumentsMap.get("run-seed") : randomBytes(32).toString("hex");
	const repositoryRoot = new URL("../../", import.meta.url).pathname;
	const runtimeImage = smoke
		? { kind: "non-authoritative-host-smoke" }
		: { kind: "pinned-oci", ...assertAuthoritativeRuntime(argumentsMap) };
	const revision = smoke ? undefined : runtimeImage.sourceRevision;
	await mkdir(outputDirectory, { recursive: false });
	const build = await freshBuild(repositoryRoot);
	const lockfilePath = join(repositoryRoot, "pnpm-lock.yaml");
	const { jobs, selected } = buildJobs(runSeed, smoke);
	const metadata = {
		acceptanceEligible: selected.acceptanceEligible,
		build,
		createdAt: new Date().toISOString(),
		host: {
			cpuCount: cpus().length,
			cpuModels: [...new Set(cpus().map(({ model }) => model))],
			freeMemoryBytesAtStart: freemem(),
			hostname: hostname(),
			osRelease: release(),
			osType: osType(),
			totalMemoryBytes: totalmem(),
		},
		lockfileSha256: await fileSha256(lockfilePath),
		measurementRuntime: {
			arch: process.arch,
			modules: process.versions.modules,
			node: process.version,
			platform: process.platform,
			v8: process.versions.v8,
			workerExecArgv: ["--expose-gc"],
		},
		processFlags: process.execArgv,
		repositoryRevision: revision,
		runSeed,
		runtimeImage,
		schedule: selected,
	};
	const metadataPath = join(outputDirectory, "metadata.json");
	const rawPath = join(outputDirectory, "raw.jsonl");
	const analysisPath = join(outputDirectory, "analysis.json");
	await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
	await writeFile(rawPath, "", { flag: "wx" });
	const workerPath = new URL("sync-state-heap-worker.mjs", import.meta.url).pathname;
	const childEnvironment = { ...process.env };
	delete childEnvironment.NODE_OPTIONS;
	delete childEnvironment.NODE_V8_COVERAGE;
	delete childEnvironment.VSCODE_INSPECTOR_OPTIONS;
	const samples = [];
	for (let launchOrdinal = 0; launchOrdinal < jobs.length; launchOrdinal++) {
		const job = jobs[launchOrdinal];
		const result = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				workerPath,
				"--shape",
				job.shape,
				"--placement",
				job.placement,
				"--population",
				String(job.population),
				"--sample-seed",
				job.sampleSeed,
			],
			{ cwd: repositoryRoot, encoding: "utf8", env: childEnvironment, maxBuffer: 64 * 1024 * 1024 }
		);
		let sample;
		if (result.status === 0) {
			const lines = result.stdout.trim().split("\n").filter(Boolean);
			if (lines.length !== 1) throw new Error(`Worker emitted ${lines.length} stdout lines; expected one`);
			sample = { ...JSON.parse(lines[0]), ...job, launchOrdinal };
		} else {
			sample = { ...job, error: `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim(), launchOrdinal };
		}
		samples.push(sample);
		await appendFile(rawPath, `${JSON.stringify(sample)}\n`);
		process.stderr.write(
			`${JSON.stringify({ completed: launchOrdinal + 1, population: job.population, shape: job.shape, total: jobs.length })}\n`
		);
		if (sample.error !== undefined) throw new Error(`Worker ${launchOrdinal} failed: ${sample.error}`);
	}
	const report = analyze(samples, metadata);
	await writeFile(analysisPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	process.stdout.write(`${JSON.stringify({ analysisPath, metadataPath, rawPath, ...report.acceptance })}\n`);
	if (metadata.acceptanceEligible && !report.acceptance.accepted) process.exitCode = 1;
}

await main();
