import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { auditAuthorAuthorizationSubpathSurface } from "./fixtures/phase-3a1b-p6/author-authorization-source-analyzer.js";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "..");
const FIXTURES = resolve(DIRECTORY, "fixtures/phase-3a1b-p6");
const ROOT_RUNTIME = [
	"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
	"admitReceivedVertex",
	"authenticateCurrentEpochAnchor",
	"createAdmissionBoundTransactionalVertexIssuer",
	"extractAdmittedReceivedVertex",
	"installCertifiedAnchorTrustRoot",
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
	"openCertifiedAnchorTrust",
	"openCurrentAnchorTrust",
	"prepareBlueprintAdmission",
	"prepareBlueprintRuntime",
] as const;
const SUBPATH_RUNTIME = ["openCurrentEpochAuthorAuthorization", "resolveCurrentEpochAuthorizedAuthor"] as const;

function diagnostics(result: ReturnType<typeof spawnSync>): string {
	return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

describe("D.93.35.3 p6 packed public surfaces RED", () => {
	it("consumes exact root-ten, subpath-two and seven types from the real archive", () => {
		const build = spawnSync("pnpm", ["--filter", "@ts-drp/protocol-v3", "build"], {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(build.status, diagnostics(build)).toBe(0);
		const temporary = mkdtempSync(join(tmpdir(), "ts-drp-p6-protocol-pack-"));
		try {
			const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
				cwd: resolve(ROOT, "packages/protocol-v3"),
				encoding: "utf8",
			});
			expect(packed.status, diagnostics(packed)).toBe(0);
			const records = JSON.parse(String(packed.stdout)) as readonly [
				{ readonly filename: string; readonly files: readonly { readonly path: string }[] },
			];
			expect(records[0].files.map(({ path }) => path)).toEqual(
				expect.arrayContaining(["dist/src/author-authorization.d.ts", "dist/src/author-authorization.js"])
			);
			const consumer = join(temporary, "consumer");
			const scope = join(consumer, "node_modules/@ts-drp");
			mkdirSync(scope, { recursive: true });
			const extraction = spawnSync("tar", ["-xzf", join(temporary, records[0].filename), "-C", scope], {
				encoding: "utf8",
			});
			expect(extraction.status, diagnostics(extraction)).toBe(0);
			renameSync(join(scope, "package"), join(scope, "protocol-v3"));
			expect(
				auditAuthorAuthorizationSubpathSurface(
					readFileSync(join(scope, "protocol-v3/dist/src/author-authorization.d.ts"), "utf8")
				)
			).toEqual([]);
			symlinkSync(resolve(ROOT, "packages/canonical"), join(scope, "canonical"), "dir");
			mkdirSync(join(consumer, "node_modules/@noble"), { recursive: true });
			symlinkSync(
				realpathSync(resolve(ROOT, "packages/protocol-v3/node_modules/@noble/curves")),
				join(consumer, "node_modules/@noble/curves"),
				"dir"
			);
			symlinkSync(
				realpathSync(resolve(ROOT, "packages/protocol-v3/node_modules/es-module-lexer")),
				join(consumer, "node_modules/es-module-lexer"),
				"dir"
			);
			cpSync(resolve(FIXTURES, "built-type-audit.ts"), join(consumer, "consumer.ts"));
			writeFileSync(
				join(consumer, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						exactOptionalPropertyTypes: true,
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						strict: true,
					},
					files: ["consumer.ts"],
				})
			);
			const types = spawnSync("pnpm", ["exec", "tsc", "-p", join(consumer, "tsconfig.json")], {
				cwd: ROOT,
				encoding: "utf8",
			});
			expect(types.status, diagnostics(types)).toBe(0);
			writeFileSync(
				join(consumer, "consumer.mjs"),
				'import * as root from "@ts-drp/protocol-v3"; import * as authorization from "@ts-drp/protocol-v3/author-authorization"; process.stdout.write(JSON.stringify({root:Object.keys(root).sort(),authorization:Object.keys(authorization).sort()}));\n'
			);
			const runtime = spawnSync(process.execPath, ["consumer.mjs"], { cwd: consumer, encoding: "utf8" });
			expect(runtime.status, diagnostics(runtime)).toBe(0);
			expect(JSON.parse(String(runtime.stdout))).toEqual({
				authorization: [...SUBPATH_RUNTIME],
				root: [...ROOT_RUNTIME],
			});
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { force: true, recursive: true });
		}
	}, 30_000);
});
