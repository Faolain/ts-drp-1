import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const ARTIFACT_HASHES = Object.freeze({
	"bucket-clear-control.json": "2b7be12a9ab4cbf8eca0f4c6b293a83b0ce29a24a9fb9df54dfc2ee21f435786",
	"phase-2d-storage-substrate-decision-link-v1.json":
		"40f0175e5d7a0c4aa9855e61324639b71045ffbcf197c12caf788824c2d8e19c",
	"storage-substrate-decision-v1.json": "fc14fcde6aa4032fcb883a967a63b4af0ac522fb9030f120b49d14374c7ea901",
	"storage-substrate-decision-v1.md": "f6d33fa230978ef9a6b6dd793262285ee1b0f15099ca8d7411e887f1f7606c4d",
	"strict-idb-capability.json": "7f76bb252a3d3f7347c02ea49f418c10a5e26c56dad3f6f510d526b71f21e80f",
	"substrate-measurement.json": "68a9a5d91d277ec909ebe1171a3a87c3b4975ee12566c86689f6cae1ed7aff85",
});

function sha256(bytes: string | Buffer): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("Phase 2e1 historical spike API port", () => {
	it("ports only the source consumer while retaining the exact recorded decision basis", () => {
		const worker = fs.readFileSync(new URL("./assets/substrate-bench-worker.ts", import.meta.url), "utf8");
		expect(worker).toContain('{ kind: "readHead", objectId: OBJECT_ID }');
		expect(worker).toContain('{ kind: "readGenerationPage", objectId: OBJECT_ID, limit: 128 }');
		expect(worker).not.toContain('{ kind: "readObjectState", objectId: OBJECT_ID }');
		expect(worker).toContain('oracleId: "phase-2e1-split-read-api-port-v1"');
		expect(worker).toContain(
			'PHASE_2E1_API_PORT_COMMAND_DIGEST = "498c129b7cc5bc34056e9c4cce1ff7cd5096e221ea13f300c88079007537e368"'
		);

		for (const [name, expected] of Object.entries(ARTIFACT_HASHES)) {
			const bytes = fs.readFileSync(new URL(`./artifacts/${name}`, import.meta.url));
			expect.soft(sha256(bytes), name).toBe(expected);
		}
		const historical = JSON.parse(
			fs.readFileSync(new URL("./artifacts/substrate-measurement.json", import.meta.url), "utf8")
		) as Record<string, unknown>;
		expect(historical).toMatchObject({
			commandScriptDigest: "bb674f57a45918f926c90fd19c61c6b0b9ed7df25736c228d395c05e81d01f00",
			opsExecuted: 24,
			oracleId: "phase-2a-read-object-state-v1",
		});
	});
});
