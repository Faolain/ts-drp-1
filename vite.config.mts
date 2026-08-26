import path from "node:path";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [tsconfigPaths()],
	resolve: {
		alias: {
			"@ts-drp/keychain/finality": path.resolve(__dirname, "packages/keychain/src/finality.ts"),
			"@ts-drp/seal/creator": path.resolve(__dirname, "packages/seal/src/creator.ts"),
			"@ts-drp/seal/internal/creator-close-intent": path.resolve(
				__dirname,
				"packages/seal/src/internal/creator-close-intent.ts"
			),
			"@ts-drp/storage-browser/seal-evidence": path.resolve(__dirname, "packages/storage-browser/src/seal-evidence.ts"),
			"@ts-drp/protocol-v3/internal/creator-anchor-signing-request": path.resolve(
				__dirname,
				"packages/protocol-v3/src/internal/creator-anchor-signing-request.ts"
			),
			"@ts-drp/protocol-v3/internal/seal-signing-request": path.resolve(
				__dirname,
				"packages/protocol-v3/src/internal/seal-signing-request.ts"
			),
			"@ts-drp/protocol-v3/internal/seal-authority-identity": path.resolve(
				__dirname,
				"packages/protocol-v3/src/internal/seal-authority-identity.ts"
			),
			"@ts-drp/protocol-v3/creator-close": path.resolve(__dirname, "packages/protocol-v3/src/creator-close.ts"),
			"@ts-drp/protocol-v3/seal": path.resolve(__dirname, "packages/protocol-v3/src/seal.ts"),
			"@ts-drp/storage-browser/seal-vote": path.resolve(__dirname, "packages/storage-browser/src/seal-vote.ts"),
			"@ts-drp/seal/internal/storage-port": path.resolve(__dirname, "packages/seal/src/storage-port.ts"),
			"@ts-drp/seal/pacemaker": path.resolve(__dirname, "packages/seal/src/pacemaker.ts"),
			"@ts-drp/seal": path.resolve(__dirname, "packages/seal/src/index.ts"),
			"@ts-drp/test-utils/shadow-comparison": path.resolve(__dirname, "packages/test-utils/src/shadow-comparison.ts"),
			"@ts-drp/test-utils/shadow-runner": path.resolve(__dirname, "packages/test-utils/src/shadow-runner.ts"),
			"@ts-drp/test-utils/shadow-telemetry": path.resolve(__dirname, "packages/test-utils/src/shadow-telemetry.ts"),
			"@ts-drp/canonical/domain-hash-stream": path.resolve(__dirname, "packages/canonical/src/domain-hash-stream.ts"),
			"@ts-drp/compaction/blueprint-fold": path.resolve(__dirname, "packages/compaction/src/blueprint-fold.ts"),
			"@ts-drp/compaction/blueprint-snapshot": path.resolve(__dirname, "packages/compaction/src/blueprint-snapshot.ts"),
			"@ts-drp/compaction/snapshot-stream": path.resolve(__dirname, "packages/compaction/src/snapshot-stream.ts"),
			"@ts-drp/protocol-v3/author-authorization": path.resolve(
				__dirname,
				"packages/protocol-v3/src/author-authorization.ts"
			),
			"@ts-drp/protocol-v3/blueprint-application": path.resolve(
				__dirname,
				"packages/protocol-v3/src/blueprint-application.ts"
			),
			"@ts-drp/protocol-v3/latched-acl": path.resolve(__dirname, "packages/protocol-v3/src/latched-acl.ts"),
			"@ts-drp/protocol-v3/snapshot-transfer": path.resolve(__dirname, "packages/protocol-v3/src/snapshot-transfer.ts"),
			"@ts-drp/protocol-v3/registry/registry-v1.json": path.resolve(
				__dirname,
				"packages/protocol-v3/registry/registry-v1.json"
			),
			"@ts-drp/protocol-v3": path.resolve(__dirname, "packages/protocol-v3/src/public.ts"),
			"@ts-drp/routing-node/constants": path.resolve(__dirname, "packages/routing-node/src/constants.ts"),
			"@ts-drp/control-plane": path.resolve(__dirname, "packages/control-plane/src/index.ts"),
			"@ts-drp/errors": path.resolve(__dirname, "packages/errors/src/index.ts"),
			"@ts-drp/membership": path.resolve(__dirname, "packages/membership/src/index.ts"),
			"@ts-drp/network": path.resolve(__dirname, "packages/network/src/index.ts"),
			// prettier-ignore
			"@ts-drp/object/internal/authenticated-commit": path.resolve(__dirname, "packages/object/src/authenticated-commit.ts"),
			"@ts-drp/object": path.resolve(__dirname, "packages/object/src/index.ts"),
			"@ts-drp/relay-policy": path.resolve(__dirname, "packages/relay-policy/src/index.ts"),
			"@ts-drp/rendezvous": path.resolve(__dirname, "packages/rendezvous/src/index.ts"),
			"@ts-drp/routing-browser": path.resolve(__dirname, "packages/routing-browser/src/index.ts"),
			"@ts-drp/routing-node": path.resolve(__dirname, "packages/routing-node/src/index.ts"),
			"@ts-drp/test-utils": path.resolve(__dirname, "packages/test-utils/src/index.ts"),
			"@ts-drp/utils/serialization/equality": path.resolve(__dirname, "packages/utils/src/serialization/equality.ts"),
			"@ts-drp/utils/serialization": path.resolve(__dirname, "packages/utils/src/serialization/index.ts"),
			"@ts-drp/validation/message": path.resolve(__dirname, "packages/validation/src/schemas/message.ts"),
			"@ts-drp/validation/errors": path.resolve(__dirname, "packages/validation/src/errors.ts"),
			"@ts-drp/validation": path.resolve(__dirname, "packages/validation/src/index.ts"),
		},
	},
	test: {
		// `docs/` carries vendored review bundles that ship their own `node:test`
		// suites. Vitest cannot run them, and globbing them turns the repo suite red
		// for reasons unrelated to `packages/`.
		exclude: [
			"**/node_modules",
			"**/.logs/**",
			"**/e2e",
			"**/dist",
			"**/conformance/**",
			"**/.stryker-tmp/**",
			"docs/**",
			"tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts",
		],
		coverage: {
			enabled: true,
			reporter: ["text", "lcov", "json-summary", "json"],
			include: ["packages/**/*.{ts,tsx}"],
			exclude: ["**/node_modules/**", "**/__tests__/**", "**/tests/**", "**/proto/**", "**/dist/**", "**/version.ts"],
			thresholds: { lines: 70 },
		},
		testTimeout: 10000,
	},
});
