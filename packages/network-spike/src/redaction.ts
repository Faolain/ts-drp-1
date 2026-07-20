import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

const RAW_PEER_ID =
	/\b(?:(?:12D3Koo|16Uiu2H|Qm)[1-9A-HJ-NP-Za-km-z]{20,}|k51qzi5uqu5[a-z0-9]{20,}|bafz[a-z2-7]{20,})\b/u;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u;
const MULTIADDRESS = /\/(?:ip4|ip6|dns4|dns6)\/[^/\s]+/iu;
const TOKEN = /\b(?:bearer\s+|token[=:]\s*|api[_-]?key[=:]\s*)[a-zA-Z0-9._~+/-]{8,}\b/iu;
const RAW_OPERATOR = /\bAS\d{1,10}\b/iu;
const SHA256 = /\b[a-f0-9]{64}\b/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const RAW_SENSITIVE_KEY =
	/^(?:peerId|rawPeerId|ip|ipAddress|multiaddr|multiaddress|namespace|token|secret|credential|salt|asn|operator|operatorGroup|provider)$/iu;
const CHECKSUM_KEY = /(?:checksum|digest|fingerprint)$/iu;

export interface RedactionAssessment {
	safe: boolean;
	issues: string[];
}

export interface RedactionOptions {
	sensitiveValueDigests?: string[];
}

/**
 * Produces the one-way marker used to recognize a run-specific sensitive value.
 * @param value - Exact raw value that must not appear in durable evidence.
 * @returns A lowercase SHA-256 digest.
 */
export function sensitiveValueDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Rejects identifiers and secrets that must never enter durable evidence.
 * @param value - Candidate durable evidence.
 * @param options - Digests of run-specific sensitive values that cannot be recognized by syntax.
 * @returns Redaction safety and any detected leaks.
 */
export function assessRedaction(value: unknown, options: RedactionOptions = {}): RedactionAssessment {
	const issues: string[] = [];
	visit(value, "$", "", issues, new Set(options.sensitiveValueDigests ?? []));
	return { safe: issues.length === 0, issues };
}

/**
 * Validates that a raw-output path is contained by the ignored run directory.
 * @param rawPath - Candidate repository-relative raw-output path.
 * @param runId - Current experiment run identifier.
 * @returns The normalized contained path.
 */
export function assertRawOutputPath(rawPath: string, runId: string): string {
	const portablePath = rawPath.replaceAll("\\", "/");
	const rawSegments = portablePath.split("/");
	const normalized = path.posix.normalize(portablePath);
	const root = `.network-spike-raw/${runId}`;
	if (
		path.posix.isAbsolute(normalized) ||
		rawSegments.some((segment) => segment === "." || segment === "..") ||
		normalized.includes("../") ||
		(normalized !== root && !normalized.startsWith(`${root}/`))
	) {
		throw new Error(`raw output path must remain beneath ${root}`);
	}
	return normalized;
}

/**
 * Uses Git's own ignore engine to prove a raw artifact cannot become trackable.
 * @param repoRoot - Repository root passed to Git.
 * @param rawPath - Candidate repository-relative raw artifact.
 * @returns Whether Git classifies the path as ignored.
 */
export function isRawOutputIgnored(repoRoot: string, rawPath: string): boolean {
	try {
		execFileSync("git", ["check-ignore", "--quiet", "--no-index", rawPath], {
			cwd: repoRoot,
			stdio: "ignore",
		});
		try {
			execFileSync("git", ["ls-files", "--error-unmatch", "--", rawPath], {
				cwd: repoRoot,
				stdio: "ignore",
			});
			return false;
		} catch {
			// Ignored and absent from the index is the required durable state.
		}
		return true;
	} catch {
		return false;
	}
}

function visit(
	value: unknown,
	pathName: string,
	key: string,
	issues: string[],
	sensitiveValueDigests: Set<string>
): void {
	if (typeof value === "string") {
		if (RAW_SENSITIVE_KEY.test(key)) {
			issues.push(`${pathName} uses forbidden raw-sensitive field ${key}`);
		}
		if (RAW_PEER_ID.test(value)) {
			issues.push(`${pathName} contains a raw Peer ID`);
		}
		if (!ISO_TIMESTAMP.test(value) && (IPV4.test(value) || MULTIADDRESS.test(value) || containsIpLiteral(value))) {
			issues.push(`${pathName} contains an IP address`);
		}
		if (TOKEN.test(value)) {
			issues.push(`${pathName} contains a credential-like token`);
		}
		if (RAW_OPERATOR.test(value)) {
			issues.push(`${pathName} contains raw operator or ASN data`);
		}
		if (sensitiveValueDigests.has(sensitiveValueDigest(value))) {
			issues.push(`${pathName} contains a run-specific sensitive value`);
		}
		if (SHA256.test(value) && !CHECKSUM_KEY.test(key) && !/(?:checksum|digest|fingerprint)/iu.test(pathName)) {
			issues.push(`${pathName} contains a stable hash outside an evidence-checksum field`);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => visit(item, `${pathName}[${index}]`, key, issues, sensitiveValueDigests));
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [childKey, child] of Object.entries(value)) {
			visit(child, `${pathName}.${childKey}`, childKey, issues, sensitiveValueDigests);
		}
	}
}

function containsIpLiteral(value: string): boolean {
	const candidates = value.match(/[a-fA-F0-9:.]+/gu) ?? [];
	return candidates.some((candidate) => candidate.includes(":") && isIP(candidate.replace(/^\.+|\.+$/gu, "")) !== 0);
}
