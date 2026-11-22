import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SUPPLEMENT = "packages/protocol-v3/supplements/author-authorization-v1";
const WORKFLOW = ".github/workflows/protocol-v3-author-authorization.yml";
const CHECKER = `${SUPPLEMENT}/check-freeze.mjs`;

function git(root: string, ...args: readonly string[]): ReturnType<typeof spawnSync> {
	return spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function copyGovernance(repositoryRoot: string, target: string): void {
	mkdirSync(resolve(target, SUPPLEMENT), { recursive: true });
	cpSync(resolve(repositoryRoot, SUPPLEMENT), resolve(target, SUPPLEMENT), { recursive: true });
	mkdirSync(resolve(target, ".github/workflows"), { recursive: true });
	cpSync(resolve(repositoryRoot, WORKFLOW), resolve(target, WORKFLOW));
}

function initialize(root: string): void {
	git(root, "init", "-q");
	git(root, "config", "user.email", "p6@example.invalid");
	git(root, "config", "user.name", "p6-freeze-control");
}

function commit(root: string, message: string): string {
	git(root, "add", ".");
	const committed = git(root, "commit", "-q", "-m", message);
	if (committed.status !== 0) throw new Error(`${committed.stdout}\n${committed.stderr}`);
	return String(git(root, "rev-parse", "HEAD").stdout).trim();
}

function sourceStub(root: string): void {
	const path = resolve(root, "packages/protocol-v3/src/index.ts");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		'export const domain = "ts-drp/author-authorization/v3"; export const profile = "creator-author-authorization-v1"; export const kind = "drp-author-authorization"; export const maximum = 8192;\n'
	);
}

function execute(root: string, base: string): Readonly<{ readonly output: string; readonly status: number | null }> {
	const result = spawnSync(process.execPath, [resolve(root, CHECKER), base], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, PROTOCOL_V3_AUTHOR_AUTHORIZATION_REPOSITORY_ROOT: root },
	});
	return { output: `${result.stdout}\n${result.stderr}`, status: result.status };
}

export type FreezeMutation = "drift-schema" | "extra-file" | "extra-policy-exception" | "missing-vector" | "none";

/** Runs the real checker in an isolated Git history with no production authority. */
export function runBootstrapFreezeScenario(
	repositoryRoot: string,
	options: Readonly<{ readonly base: "absent" | "complete" | "partial"; readonly mutation: FreezeMutation }>
): Readonly<{ readonly output: string; readonly status: number | null }> {
	const root = mkdtempSync(join(tmpdir(), "ts-drp-p6-freeze-"));
	try {
		initialize(root);
		sourceStub(root);
		if (options.base === "partial") {
			const checkerTarget = resolve(root, CHECKER);
			mkdirSync(dirname(checkerTarget), { recursive: true });
			cpSync(resolve(repositoryRoot, CHECKER), checkerTarget);
		}
		if (options.base === "complete") copyGovernance(repositoryRoot, root);
		const base = commit(root, "base");
		if (options.base !== "complete") copyGovernance(repositoryRoot, root);
		if (options.mutation === "drift-schema") {
			writeFileSync(
				resolve(root, `${SUPPLEMENT}/schema.json`),
				`${readFileSync(resolve(root, `${SUPPLEMENT}/schema.json`), "utf8")}\n`
			);
		}
		if (options.mutation === "extra-file") writeFileSync(resolve(root, `${SUPPLEMENT}/extra.json`), "{}\n");
		if (options.mutation === "missing-vector") rmSync(resolve(root, `${SUPPLEMENT}/vectors.json`));
		if (options.mutation === "extra-policy-exception") {
			const path = resolve(root, `${SUPPLEMENT}/freeze-policy.json`);
			const policy = JSON.parse(readFileSync(path, "utf8")) as { artifactSha256: Record<string, string> };
			policy.artifactSha256[`${SUPPLEMENT}/freeze-policy.json`] = "0".repeat(64);
			writeFileSync(path, `${JSON.stringify(policy, null, "\t")}\n`);
		}
		return execute(root, base);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
