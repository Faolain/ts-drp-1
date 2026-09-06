/* eslint-disable jsdoc/require-jsdoc */
export const CUSTODY_SCHEMA = "ts-drp/worker-host-handshake-custody/v1";
export const REQUIRED_SCENARIOS = ["never-ready", "ready-ordering"] as const;

export type HandshakeCustody = Readonly<{
	schema: typeof CUSTODY_SCHEMA;
	engine: "firefox" | "webkit";
	build: string;
	os: string;
	scenario: (typeof REQUIRED_SCENARIOS)[number];
	readySentAtMs: number | null;
	requestReceivedAtMs: number | null;
	chunks: number;
	bytes: number;
	verdict: "pass";
}>;

export function validateCustody(value: unknown): asserts value is HandshakeCustody {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("custody:not-object");
	const record = value as Record<string, unknown>;
	const exact = [
		"build",
		"bytes",
		"chunks",
		"engine",
		"os",
		"readySentAtMs",
		"requestReceivedAtMs",
		"scenario",
		"schema",
		"verdict",
	];
	if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(exact)) throw new Error("custody:fields");
	if (record.schema !== CUSTODY_SCHEMA) throw new Error("custody:schema");
	if (record.engine !== "firefox" && record.engine !== "webkit") throw new Error("custody:engine");
	if (typeof record.build !== "string" || record.build.length === 0) throw new Error("custody:build");
	if (typeof record.os !== "string" || record.os.length === 0) throw new Error("custody:os");
	if (!REQUIRED_SCENARIOS.includes(record.scenario as never)) throw new Error("custody:scenario");
	if (record.verdict !== "pass") throw new Error("custody:verdict");
	if (!Number.isSafeInteger(record.chunks) || (record.chunks as number) < 0) throw new Error("custody:chunks");
	if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) throw new Error("custody:bytes");
	for (const name of ["readySentAtMs", "requestReceivedAtMs"] as const) {
		const timestamp = record[name];
		if (timestamp !== null && (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0)) {
			throw new Error(`custody:${name}`);
		}
	}
}
