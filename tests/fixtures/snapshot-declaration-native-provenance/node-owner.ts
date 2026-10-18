import { DatabaseSync, type SQLInputValue, StatementSync } from "node:sqlite";

import { chain, check, fixture, type NativeEnvironment, runNativeData, runNativeFault, stable } from "./common.js";
import type { NativeHooks } from "./hooks.js";
import type { SnapshotQuarantineScopeKey } from "../../../packages/storage/src/snapshot-transfer.js";
import { createNodeSnapshotQuarantineStore } from "../../../packages/storage-node/src/snapshot-transfer.js";

const columns: Record<string, string> = {
	objectId: "object_id",
	epoch: "epoch",
	anchor: "anchor",
	manifestDigest: "manifest_digest",
	exactCanonicalManifestBytes: "exact_manifest_bytes",
	totalBytes: "total_bytes",
	chunkCount: "chunk_count",
	expiresAt: "expires_at",
	state: "state",
	retention: "retention",
	incarnation: "incarnation",
	descriptors: "descriptors",
};

/**
 * Native SQLite setup/read access; no adapter or decoder is replaced.
 * @param primaryFilename - Isolated native database identity.
 * @returns Actual source owner and native durable-image operations.
 */
export function nodeEnvironment(primaryFilename: string): NativeEnvironment {
	const use = <T>(action: (db: DatabaseSync) => T): T => {
		const db = new DatabaseSync(primaryFilename + ".drp-snapshot-quarantine-v1.sqlite");
		try {
			return action(db);
		} finally {
			db.close();
		}
	};
	const parameters = (key: SnapshotQuarantineScopeKey): SQLInputValue[] => [
		key.objectId,
		key.epoch,
		key.anchor,
		key.manifestDigest,
	];
	return {
		backend: "sqlite",
		identity: primaryFilename,
		open: () => Promise.resolve(createNodeSnapshotQuarantineStore({ primaryFilename })),
		image: () =>
			Promise.resolve(
				use((db) => {
					const rows = (sql: string): unknown => {
						const statement = db.prepare(sql);
						statement.setReadBigInts(true);
						return statement.all();
					};
					return {
						schema: rows("SELECT * FROM sqlite_schema ORDER BY name"),
						owner: rows("SELECT * FROM snapshot_owner_v2 ORDER BY id"),
						scopes: rows("SELECT * FROM snapshot_scopes_v2 ORDER BY object_id,epoch,anchor,manifest_digest"),
						chunks: rows(
							"SELECT * FROM snapshot_chunks_v2 ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index"
						),
					};
				})
			),
		row: (key) =>
			Promise.resolve(
				use((db) => {
					const row = db
						.prepare(
							"SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
						)
						.get(...parameters(key));
					if (row === undefined) throw new Error("native exact row absent");
					return Object.fromEntries(Object.entries(columns).map(([field, column]) => [field, row[column]]));
				})
			),
		put: (row): Promise<void> => {
			use((db) =>
				db
					.prepare(
						`INSERT OR REPLACE INTO snapshot_scopes_v2 (${Object.values(columns).join(",")}) VALUES (${Object.keys(
							columns
						)
							.map(() => "?")
							.join(",")})`
					)
					.run(...Object.keys(columns).map((field) => row[field] as SQLInputValue))
			);
			return Promise.resolve();
		},
	};
}

/**
 * Execute one actual SQLite discovery processing case.
 * @param filename - Native database identity.
 * @param hooks - Pre-import processing controller.
 * @param mode - Fault, historical retention, deterministic data or bridge-guard case.
 * @returns Native outcome evidence.
 */
export function run(filename: string, hooks: NativeHooks, mode = "fault"): Promise<unknown> {
	const env = nodeEnvironment(filename);
	return mode === "js-guard"
		? runGuard(env, hooks)
		: mode.startsWith("data:")
			? runNativeData(env, hooks, mode.slice(5))
			: runNativeFault(env, hooks, mode === "historical");
}

async function runGuard(env: NativeEnvironment, hooks: NativeHooks): Promise<unknown> {
	hooks.phase("setup");
	const { declaration } = fixture();
	const store = await env.open();
	const descriptor = Object.getOwnPropertyDescriptor(StatementSync.prototype, "get");
	check(
		descriptor !== undefined && typeof descriptor.value === "function",
		"native StatementSync.get descriptor available"
	);
	if (descriptor === undefined) throw new Error("native get absent");
	try {
		await store.openScope(declaration);
		const row = await env.row(declaration.scope);
		const image = stable(await env.image());
		let replace = false,
			selectedRows = 0,
			preflights = 0,
			substitutions = 0;
		const bridge: { phase: string; descriptorsType: string; substituted: boolean }[] = [];
		const original = descriptor.value as (...args: unknown[]) => Record<string, unknown> | undefined;
		Object.defineProperty(StatementSync.prototype, "get", {
			...descriptor,
			value: function (this: StatementSync, ...args: unknown[]): Record<string, unknown> | undefined {
				const actual = Reflect.apply(original, this, args) as Record<string, unknown> | undefined;
				if (actual !== undefined && Object.keys(actual).length === 1 && actual.valid === 1) preflights++;
				if (
					actual !== undefined &&
					Object.keys(actual).sort().join(",") ===
						"chunk_count,descriptors,exact_manifest_bytes,expires_at,incarnation,retention,state,total_bytes" &&
					actual.incarnation === row.incarnation &&
					actual.descriptors === row.descriptors
				) {
					selectedRows++;
					bridge.push({
						phase: replace ? "controlled-bridge-result" : "native-positive-control",
						descriptorsType: typeof actual.descriptors,
						substituted: replace,
					});
					if (replace) {
						substitutions++;
						return { ...actual, descriptors: 0 };
					}
				}
				return actual;
			},
		});
		hooks.metadata(row.incarnation, row.descriptors);
		hooks.phase("guard-control");
		const control = await store.lookupRecoveryDeclaration(declaration.scope);
		check(
			control.kind === "present" && selectedRows === 1 && preflights === 1,
			"genuine successful preflight/exact-row bridge control"
		);
		replace = true;
		hooks.metadata(row.incarnation, 0);
		hooks.phase("guard-result");
		let failure: unknown;
		try {
			await store.lookupRecoveryDeclaration(declaration.scope);
		} catch (error) {
			failure = error;
		}
		check(
			selectedRows === 2 && preflights === 2 && substitutions === 1,
			"one exact bridge result changed only after real successful preflight"
		);
		Object.defineProperty(StatementSync.prototype, "get", descriptor);
		hooks.phase("inspection");
		check(stable(await env.image()) === image, "bridge-result substitution never changed durable native rows");
		check(
			stable(await store.lookupRecoveryDeclaration(declaration.scope)) === stable(control),
			"restored native bridge retry present"
		);
		check(hooks.injections() === 0, "guard test uses no synthetic exception");
		const causes = chain(failure, hooks.sentinel);
		return {
			backend: env.backend,
			identity: env.identity,
			guard: {
				kind: "controlled bridge-result primitive-string guard",
				originalType: typeof row.descriptors,
				suppliedType: "number",
				substitutions,
				selectedRows,
				preflights,
				bridge,
				parseCalls: hooks.events.filter((event) => event.phase === "guard-result").length,
			},
			observed: { code: causes[0]?.code ?? null, causes },
			controls: {
				present: true,
				exactBridgeRow: true,
				realPreflight: true,
				durableUnchanged: true,
				retryPresent: true,
			},
			events: hooks.events,
			injections: 0,
		};
	} finally {
		Object.defineProperty(StatementSync.prototype, "get", descriptor);
		hooks.phase("setup");
		await store.close();
	}
}
