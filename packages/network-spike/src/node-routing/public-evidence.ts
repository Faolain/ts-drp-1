import type { ReachabilityObservation, RoutingMeasurement } from "@ts-drp/routing-node";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { fingerprint, parseExperimentManifest } from "../evidence.js";
import { createFixtureManifest } from "../fixture.js";
import { assessRedaction, sensitiveValueDigest } from "../redaction.js";
import { EVIDENCE_SCHEMA_VERSION, type ExperimentManifest } from "../schemas.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SANITIZED_EVIDENCE_ROOT = "specs/done/public-network-spike/evidence";
const EVIDENCE_FILENAME = "node-routing-evidence.json";
const MANIFEST_FILENAME = "manifest.json";

const ReachabilityObservationSchema = z
	.object({
		atMs: z.number().int().nonnegative(),
		autonat: z.enum(["available", "unavailable"]),
		basis: z.literal("verified-address-set"),
		dialable: z.boolean(),
		observedAddressScopes: z
			.array(z.enum(["public", "private", "loopback", "link-local", "multicast", "reserved", "unresolved", "unknown"]))
			.max(16),
		source: z.enum(["initial", "self-peer-update"]),
		status: z.enum(["private", "public", "unknown"]),
	})
	.strict();

const RoutingMeasurementSchema = z
	.object({
		connectionCount: z.number().int().nonnegative(),
		cpuSystemMicros: z.number().int().nonnegative(),
		cpuUserMicros: z.number().int().nonnegative(),
		durationMs: z.number().nonnegative(),
		logicalReceivedBytes: z.number().int().nonnegative(),
		logicalSentBytes: z.number().int().nonnegative(),
		networkRequestsConsumed: z.number().int().nonnegative(),
		operation: z.enum([
			"bootstrap",
			"cancelReprovide",
			"connect",
			"findPeer",
			"findProviders",
			"getClosestPeers",
			"provide",
			"refresh",
		]),
		rssAfterBytes: z.number().int().nonnegative(),
		rssBeforeBytes: z.number().int().nonnegative(),
		transportBytes: z
			.object({
				reason: z.literal("not-exposed-by-libp2p-public-api"),
				status: z.literal("unavailable"),
			})
			.strict(),
	})
	.strict();

export const PublicNodeRoutingEvidenceSchema = z
	.object({
		addressScopes: z
			.array(z.enum(["public", "private", "loopback", "link-local", "multicast", "reserved", "unresolved", "unknown"]))
			.max(16),
		closestPeerCount: z.number().int().nonnegative().max(16),
		dhtRequestBudget: z.number().int().positive().max(8),
		dialable: z.boolean(),
		durationMs: z.number().int().nonnegative().max(30_000),
		evidencePhase: z.literal("phase-02"),
		finishedAt: z.string().datetime({ offset: true }),
		measurements: z.array(RoutingMeasurementSchema).max(4),
		namespacePseudonym: z.string().regex(/^ns_[a-f0-9]{12}$/u),
		networkRequestsConsumed: z.number().int().nonnegative().max(8),
		peerPseudonyms: z.array(z.string().regex(/^peer_[a-f0-9]{12}$/u)).max(16),
		reachabilityObservations: z.array(ReachabilityObservationSchema).max(16),
		routingTableSize: z.number().int().nonnegative(),
		runId: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
		schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
		startedAt: z.string().datetime({ offset: true }),
	})
	.strict()
	.superRefine((evidence, context) => {
		const elapsed = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
		if (evidence.durationMs !== elapsed) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `durationMs must equal the timestamp delta (${elapsed}ms)`,
				path: ["durationMs"],
			});
		}
		if (evidence.networkRequestsConsumed > evidence.dhtRequestBudget) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "network requests exceed the pre-authorized DHT request budget",
				path: ["networkRequestsConsumed"],
			});
		}
	});

export type PublicNodeRoutingEvidence = z.infer<typeof PublicNodeRoutingEvidenceSchema>;

export interface PublicCanaryArtifactInput {
	addressScopes: PublicNodeRoutingEvidence["addressScopes"];
	closestPeerIds: string[];
	dhtRequestBudget: number;
	dialable: boolean;
	finishedAt: string;
	measurements: RoutingMeasurement[];
	namespace: string;
	reachabilityObservations: ReachabilityObservation[];
	routingTableSize: number;
	runId: string;
	salt: Uint8Array;
	startedAt: string;
}

export interface PublicCanaryArtifacts {
	evidence: PublicNodeRoutingEvidence;
	manifest: ExperimentManifest;
}

/**
 * Builds and validates the redacted Phase 02 public-canary artifacts.
 * @param input - Raw in-memory canary results and per-run redaction salt
 * @returns Phase 00 manifest plus Phase 02 sanitized evidence
 */
export async function createPublicCanaryArtifacts(input: PublicCanaryArtifactInput): Promise<PublicCanaryArtifacts> {
	const durationMs = Date.parse(input.finishedAt) - Date.parse(input.startedAt);
	const lastMeasurement = input.measurements.at(-1);
	if (lastMeasurement === undefined) throw new Error("public canary has no routing measurement");
	const evidence = PublicNodeRoutingEvidenceSchema.parse({
		addressScopes: input.addressScopes,
		closestPeerCount: input.closestPeerIds.length,
		dhtRequestBudget: input.dhtRequestBudget,
		dialable: input.dialable,
		durationMs,
		evidencePhase: "phase-02",
		finishedAt: input.finishedAt,
		measurements: input.measurements,
		namespacePseudonym: pseudonym("ns", input.namespace, input.salt),
		networkRequestsConsumed: lastMeasurement.networkRequestsConsumed,
		peerPseudonyms: input.closestPeerIds.map((peerId) => pseudonym("peer", peerId, input.salt)),
		reachabilityObservations: input.reachabilityObservations,
		routingTableSize: input.routingTableSize,
		runId: input.runId,
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		startedAt: input.startedAt,
	});
	const environment = await readEnvironment();
	const base = createFixtureManifest();
	const manifest = parseExperimentManifest({
		...base,
		endpointClasses: ["public-dht"],
		evidenceChecksums: {
			[EVIDENCE_FILENAME]: fingerprint(evidence),
		},
		git: environment.git,
		networkCondition: "operator-authorized-public-canary",
		redaction: {
			...base.redaction,
			rawOutputDirectory: `.network-spike-raw/${input.runId}`,
			saltId: `salt_${createHash("sha256").update(input.salt).digest("hex").slice(0, 12)}`,
			sensitiveValueDigests: [sensitiveValueDigest(input.namespace)],
		},
		runId: input.runId,
		startedAt: input.startedAt,
		target: "node",
		transportProfile: "balanced-matrix",
		versions: {
			...base.versions,
			node: process.version,
			os: `${platform()}-${arch()}`,
			packages: {
				"@libp2p/kad-dht": "16.3.4",
				"@libp2p/tcp": "11.0.23",
				"libp2p": "3.3.5",
			},
			pnpm: environment.pnpm,
		},
	});
	for (const artifact of [manifest, evidence]) {
		const assessment = assessRedaction(artifact, {
			sensitiveValueDigests: manifest.redaction.sensitiveValueDigests,
		});
		if (!assessment.safe) throw new Error(assessment.issues.join("\n"));
	}
	return { evidence, manifest };
}

/**
 * Writes validated sanitized artifacts atomically beneath the durable spec
 * evidence root. Raw captures are never written by this command.
 * @param outputRoot - Repository-relative durable evidence root
 * @param artifacts - Validated manifest and evidence payload
 * @returns Repository-relative artifact paths
 */
export async function writePublicCanaryArtifacts(
	outputRoot: string,
	artifacts: PublicCanaryArtifacts
): Promise<{ evidencePath: string; manifestPath: string }> {
	const requestedRoot = assertSanitizedEvidenceOutputRoot(outputRoot);
	const finalDirectory = path.join(requestedRoot, artifacts.evidence.runId);
	const temporaryDirectory = `${finalDirectory}.tmp`;
	await rm(temporaryDirectory, { force: true, recursive: true });
	await mkdir(temporaryDirectory, { recursive: true });
	try {
		await Promise.all([
			writeFile(path.join(temporaryDirectory, EVIDENCE_FILENAME), `${JSON.stringify(artifacts.evidence, null, 2)}\n`, {
				flag: "wx",
			}),
			writeFile(path.join(temporaryDirectory, MANIFEST_FILENAME), `${JSON.stringify(artifacts.manifest, null, 2)}\n`, {
				flag: "wx",
			}),
		]);
		await rename(temporaryDirectory, finalDirectory);
	} catch (error) {
		await rm(temporaryDirectory, { force: true, recursive: true });
		throw error;
	}
	return {
		evidencePath: path.relative(REPOSITORY_ROOT, path.join(finalDirectory, EVIDENCE_FILENAME)),
		manifestPath: path.relative(REPOSITORY_ROOT, path.join(finalDirectory, MANIFEST_FILENAME)),
	};
}

/**
 * Validates the durable sanitized output root before any public traffic starts.
 * @param outputRoot - Repository-relative requested root
 * @returns Absolute validated root
 */
export function assertSanitizedEvidenceOutputRoot(outputRoot: string): string {
	const allowedRoot = path.resolve(REPOSITORY_ROOT, SANITIZED_EVIDENCE_ROOT);
	const requestedRoot = path.resolve(REPOSITORY_ROOT, outputRoot);
	if (
		(requestedRoot !== allowedRoot && !requestedRoot.startsWith(`${allowedRoot}${path.sep}`)) ||
		path.isAbsolute(outputRoot) ||
		outputRoot.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")
	) {
		throw new Error(`sanitized output must remain beneath ${SANITIZED_EVIDENCE_ROOT}`);
	}
	return requestedRoot;
}

function pseudonym(prefix: "ns" | "peer", value: string, salt: Uint8Array): string {
	return `${prefix}_${createHash("sha256").update(salt).update(value).digest("hex").slice(0, 12)}`;
}

async function readEnvironment(): Promise<{
	git: ExperimentManifest["git"];
	pnpm: string;
}> {
	const lockfile = await readFile(path.join(REPOSITORY_ROOT, "pnpm-lock.yaml"));
	const rootPackage = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
		packageManager?: string;
	};
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
	}).trim();
	const dirty =
		execFileSync("git", ["status", "--porcelain"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		}).trim().length > 0;
	return {
		git: {
			dirty,
			lockfileDigest: createHash("sha256").update(lockfile).digest("hex"),
			sha,
		},
		pnpm: rootPackage.packageManager?.replace(/^pnpm@/u, "") ?? "unknown",
	};
}
