/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this profiling tooling directly. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { parseArguments, requiredArgument } from "./sync-state-heap-common.mjs";

const BASE_IMAGE_CONFIG = "sha256:4a2f28cd195e7b99ea839a344269e93883c6c531a05b6f5ecf6b824c8dd8272d";
const BASE_IMAGE_INDEX = "sha256:557e52a0fcb928ee113df7e1fb5d4f60c1341dbda53f55e3d815ca10807efdce";
const BASE_IMAGE_PLATFORM = "sha256:71ecda08bfca53d2b72a727056be374eea4a0ba53cf0de1a947ec8068f4e0918";
const BASE_IMAGE_REFERENCE = `node:22.15.0-bookworm-slim@${BASE_IMAGE_INDEX}`;

function command(commandName, args, options = {}) {
	const result = spawnSync(commandName, args, {
		cwd: options.cwd,
		encoding: options.binary ? null : "utf8",
		input: options.input,
		maxBuffer: 512 * 1024 * 1024,
		stdio: options.capture || options.binary ? "pipe" : "inherit",
	});
	if (result.status !== 0) {
		throw new Error(
			`${commandName} ${args.join(" ")} failed with status ${result.status}: ${result.stderr?.toString() ?? ""}`
		);
	}
	return options.binary ? result.stdout : (result.stdout?.trim() ?? "");
}

function assertDigest(value, name) {
	if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is not a sha256 digest: ${value}`);
}

function sha256Digest(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rawBuildxManifest(reference) {
	return command("docker", ["buildx", "imagetools", "inspect", "--raw", reference], {
		binary: true,
		capture: true,
	});
}

function verifyPinnedBaseChain() {
	const indexRaw = rawBuildxManifest(BASE_IMAGE_REFERENCE);
	if (sha256Digest(indexRaw) !== BASE_IMAGE_INDEX) {
		throw new Error(`Pinned base index bytes do not hash to ${BASE_IMAGE_INDEX}`);
	}
	const index = JSON.parse(indexRaw.toString("utf8"));
	const arm64 = index.manifests?.filter(
		(manifest) => manifest.platform?.os === "linux" && manifest.platform?.architecture === "arm64"
	);
	if (arm64?.length !== 1 || arm64[0].digest !== BASE_IMAGE_PLATFORM) {
		throw new Error(`Pinned base index arm64 manifest mismatch: ${JSON.stringify(arm64)}`);
	}
	const platformRaw = rawBuildxManifest(`node:22.15.0-bookworm-slim@${BASE_IMAGE_PLATFORM}`);
	if (sha256Digest(platformRaw) !== BASE_IMAGE_PLATFORM) {
		throw new Error(`Pinned base platform bytes do not hash to ${BASE_IMAGE_PLATFORM}`);
	}
	const platformManifest = JSON.parse(platformRaw.toString("utf8"));
	if (platformManifest.config?.digest !== BASE_IMAGE_CONFIG) {
		throw new Error(`Pinned base platform config ${platformManifest.config?.digest}; expected ${BASE_IMAGE_CONFIG}`);
	}
	return {
		configDigest: BASE_IMAGE_CONFIG,
		indexDigest: BASE_IMAGE_INDEX,
		platformManifestDigest: BASE_IMAGE_PLATFORM,
	};
}

async function readOciBlob(layout, digest, name) {
	assertDigest(digest, name);
	const bytes = await readFile(join(layout, "blobs", "sha256", digest.slice("sha256:".length)));
	if (sha256Digest(bytes) !== digest) throw new Error(`${name} bytes do not hash to ${digest}`);
	return bytes;
}

async function verifyOciArchive(archive, extractionRoot, sourceRevision) {
	const layout = join(extractionRoot, "oci-layout");
	await mkdir(layout);
	command("tar", ["-xf", archive, "-C", layout], { capture: true });
	const layoutMarker = JSON.parse(await readFile(join(layout, "oci-layout"), "utf8"));
	if (layoutMarker.imageLayoutVersion !== "1.0.0") {
		throw new Error(`Unexpected OCI image layout version: ${layoutMarker.imageLayoutVersion}`);
	}
	const index = JSON.parse(await readFile(join(layout, "index.json"), "utf8"));
	if (index.schemaVersion !== 2 || index.manifests?.length !== 1) {
		throw new Error(`OCI archive must contain exactly one image manifest: ${JSON.stringify(index.manifests)}`);
	}
	const descriptor = index.manifests[0];
	if (
		descriptor.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
		(descriptor.platform !== undefined &&
			(descriptor.platform.os !== "linux" || descriptor.platform.architecture !== "arm64"))
	) {
		throw new Error(`Unexpected OCI output manifest descriptor: ${JSON.stringify(descriptor)}`);
	}
	const manifestBytes = await readOciBlob(layout, descriptor.digest, "OCI output manifest digest");
	if (descriptor.size !== manifestBytes.length) {
		throw new Error(`OCI output manifest size ${manifestBytes.length}; expected ${descriptor.size}`);
	}
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	if (
		manifest.schemaVersion !== 2 ||
		manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
		manifest.config?.mediaType !== "application/vnd.oci.image.config.v1+json"
	) {
		throw new Error(`Unexpected OCI output manifest: ${JSON.stringify(manifest)}`);
	}
	const configBytes = await readOciBlob(layout, manifest.config.digest, "OCI output config digest");
	if (manifest.config.size !== configBytes.length) {
		throw new Error(`OCI output config size ${configBytes.length}; expected ${manifest.config.size}`);
	}
	const config = JSON.parse(configBytes.toString("utf8"));
	if (
		config.architecture !== "arm64" ||
		config.os !== "linux" ||
		config.config?.Labels?.["org.opencontainers.image.revision"] !== sourceRevision
	) {
		throw new Error(`OCI output config platform/source mismatch: ${JSON.stringify(config)}`);
	}
	return { configDigest: manifest.config.digest, manifestDigest: descriptor.digest };
}

const argumentsMap = parseArguments(process.argv.slice(2));
const output = resolve(requiredArgument(argumentsMap, "output"));
const outputParent = dirname(output);
const outputName = basename(output);
const tag = typeof argumentsMap.get("tag") === "string" ? argumentsMap.get("tag") : "ts-drp-sync-state-heap:phase-1o-f";
const runSeed = argumentsMap.get("run-seed");
const smoke = argumentsMap.get("smoke") === true;
const repositoryRoot = command("git", ["rev-parse", "--show-toplevel"], { capture: true });
const sourceRevision = command("git", ["rev-parse", "HEAD"], { capture: true, cwd: repositoryRoot });
if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) throw new Error(`Unexpected source revision: ${sourceRevision}`);
if (
	command("git", ["status", "--porcelain=v1", "--untracked-files=no"], { capture: true, cwd: repositoryRoot }) !== ""
) {
	throw new Error("Authoritative OCI build requires a clean tracked worktree");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "ts-drp-sync-state-heap-"));
try {
	const context = join(temporaryRoot, "context");
	const ociArchivePath = join(temporaryRoot, "profiler-image.oci.tar");
	const imageIdPath = join(temporaryRoot, "profiler-image.id");
	await mkdir(context);
	const archive = command("git", ["archive", "--format=tar", sourceRevision], {
		binary: true,
		capture: true,
		cwd: repositoryRoot,
	});
	command("tar", ["-xf", "-", "-C", context], { capture: true, input: archive });
	const baseChain = verifyPinnedBaseChain();
	await mkdir(outputParent, { recursive: true });
	command("docker", [
		"buildx",
		"build",
		"--no-cache",
		"--platform",
		"linux/arm64",
		"--file",
		join(context, "scripts/production-hardening/Dockerfile.sync-state-heap"),
		"--build-arg",
		`SOURCE_REVISION=${sourceRevision}`,
		"--provenance=false",
		"--iidfile",
		imageIdPath,
		"--tag",
		tag,
		"--load",
		context,
	]);
	const builtConfigDigest = (await readFile(imageIdPath, "utf8")).trim();
	assertDigest(builtConfigDigest, "BuildKit output config digest");
	command("docker", ["image", "save", "--platform", "linux/arm64", "--output", ociArchivePath, builtConfigDigest]);
	const outputDigests = await verifyOciArchive(ociArchivePath, temporaryRoot, sourceRevision);
	if (outputDigests.configDigest !== builtConfigDigest) {
		throw new Error(`OCI archive config ${outputDigests.configDigest}; expected built config ${builtConfigDigest}`);
	}
	command("docker", ["load", "--input", ociArchivePath]);
	const inspection = JSON.parse(
		command("docker", ["image", "inspect", outputDigests.configDigest], { capture: true })
	)[0];
	if (
		inspection?.Id !== outputDigests.configDigest ||
		inspection?.Architecture !== "arm64" ||
		inspection?.Os !== "linux" ||
		inspection?.Config?.Labels?.["org.opencontainers.image.revision"] !== sourceRevision
	) {
		throw new Error(`Built profiler image identity/platform/source mismatch: ${JSON.stringify(inspection)}`);
	}
	const controllerArguments = [
		"--output",
		`/artifact/${outputName}`,
		"--source-revision",
		sourceRevision,
		"--runtime-image-manifest-digest",
		outputDigests.manifestDigest,
		"--runtime-image-config-digest",
		outputDigests.configDigest,
		"--base-image-index-digest",
		baseChain.indexDigest,
		"--base-image-platform-manifest-digest",
		baseChain.platformManifestDigest,
		"--base-image-config-digest",
		baseChain.configDigest,
	];
	if (typeof runSeed === "string") controllerArguments.push("--run-seed", runSeed);
	if (smoke) controllerArguments.push("--smoke");
	command("docker", [
		"run",
		"--rm",
		"--network",
		"none",
		"--platform",
		"linux/arm64",
		"--mount",
		`type=bind,src=${outputParent},dst=/artifact`,
		outputDigests.configDigest,
		...controllerArguments,
	]);
} finally {
	await rm(temporaryRoot, { force: true, recursive: true });
}
