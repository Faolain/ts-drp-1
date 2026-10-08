import type { ReadCase } from "./cases.js";
import { snapshotQuarantineContract } from "../../../packages/storage/src/snapshot-transfer.js";
import type {
	SnapshotChunkDescriptor,
	SnapshotQuarantineDeclaration,
	SnapshotRetention,
} from "../../../packages/storage/src/snapshot-transfer.js";
import {
	createSnapshotQuarantineFixture,
	type SnapshotQuarantineFixture,
} from "../phase-4c-v3/snapshot-quarantine-contract.js";
import type { SnapshotRecoveryDeclarationReader } from "../phase-4c-v3/snapshot-quarantine-types.js";
import { check, type DiscoveryEnvironment, type Observation } from "../snapshot-declaration-discovery/contract.js";
import { outcome, receiptFor, type RecoveryStore, stable } from "../snapshot-recovery-owner/contract.js";

export interface ExpectedReader {
	read(
		descriptor: SnapshotChunkDescriptor,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<Uint8Array | undefined>;
	release(): Promise<void>;
}
export type ExpectedAcquisition =
	| Readonly<{ kind: "missing" }>
	| Readonly<{
			kind: "present";
			declaration: SnapshotQuarantineDeclaration;
			state: "open" | "verified";
			retention: SnapshotRetention;
			expiresAt: number;
			reader: ExpectedReader;
	  }>;
export interface ExpectedStore extends RecoveryStore, SnapshotRecoveryDeclarationReader {
	acquireRecoveryRead(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<ExpectedAcquisition>;
}
export interface ReadObservation extends Observation {
	starts: string[];
	terminals: string[];
}
export type Boundary = "start" | "chunk" | "terminal";
export interface ReadEnvironment extends DiscoveryEnvironment {
	observeReader(
		action: () => Promise<unknown>,
		boundary?: (event: Boundary) => void
	): Promise<{ value: unknown; evidence: ReadObservation }>;
	readonlyControl(declaration: SnapshotQuarantineDeclaration, lengthGuard?: boolean): Promise<ReadObservation>;
	oversize(declaration: SnapshotQuarantineDeclaration, byteLength: number): Promise<void>;
}
export interface ReadReport {
	case: ReadCase;
	preconditions: Record<string, unknown>;
	observations: ReadObservation[];
	passed: boolean;
	observed: { code: string; detail?: string };
	mask?: string;
}

function at<Value>(values: readonly Value[], index: number): Value {
	const value = values[index];
	if (value === undefined) throw new Error("exact fixture item absent");
	return value;
}

/** Exact fixture expectations, not a second storage or authentication owner. */
export function selected(name: ReadCase, variant = "target"): SnapshotQuarantineFixture {
	return createSnapshotQuarantineFixture({
		objectId: `reader-${name}`,
		epoch: variant === "neighbor" ? 5 : variant === "expired" ? 6 : 4,
		chunks: [variant === "different" ? Uint8Array.of(21, 34, 55, 89) : Uint8Array.of(3, 5, 8, 13)],
	});
}

/** Seed only through an existing genuine transfer/receipt owner, then close it. */
export async function setup(name: ReadCase, env: ReadEnvironment): Promise<unknown> {
	const target = selected(name);
	const legacy = name.startsWith("legacy-");
	const store = legacy ? await env.legacy() : await env.open();
	try {
		const scope = await store.openScope(target.declaration);
		if (name === "open-temporary" || name === "legacy-open") {
			const port = scope.verificationQuarantine.open(new AbortController().signal);
			await port.write(at(target.declaration.chunks, 0), at(target.chunks, 0));
			await port.discard();
		} else {
			await scope.complete(await receiptFor(scope, target));
			if (!legacy && name !== "verified-temporary" && name !== "sweep-after" && name !== "promotion-after") {
				await (scope as Awaited<ReturnType<RecoveryStore["openScope"]>>).retainForRecovery();
			}
		}
		await scope.release();
		const neighbor = selected(name, "neighbor");
		const neighboring = await store.openScope(neighbor.declaration);
		await neighboring.complete(await receiptFor(neighboring, neighbor));
		if (!legacy) await (neighboring as Awaited<ReturnType<RecoveryStore["openScope"]>>).retainForRecovery();
		await neighboring.release();
		if (!legacy) {
			const expired = selected(name, "expired");
			const temporary = await store.openScope(expired.declaration);
			const port = temporary.verificationQuarantine.open(new AbortController().signal);
			await port.write(at(expired.declaration.chunks, 0), at(expired.chunks, 0));
			await port.discard();
			await temporary.release();
		}
	} finally {
		await store.close();
	}
	// Legacy admission is explicitly separated from the reader readonly boundary.
	if (legacy) await (await env.open()).close();
	if (!legacy) {
		const expired = selected(name, "expired");
		await env.put({ ...(await env.row(expired.declaration.scope)), expiresAt: 1 });
	}
	if (name === "missing-exact" || name === "occupied-other-manifest") await env.remove(target.declaration.scope);
	if (name === "occupied-other-manifest" || name === "exact-precedence") {
		const row = await env.row(selected(name, "neighbor").declaration.scope);
		await env.put({
			...row,
			...target.declaration.scope,
			manifestDigest: "f".repeat(64),
			incarnation: crypto.randomUUID(),
			// Deliberately malformed occupancy: exact miss still conflicts, exact hit wins.
			exactCanonicalManifestBytes: Uint8Array.of(255),
		});
	}
	if (["malformed-present", "poisoned-acquisition", "recovery-open-invalid"].includes(name)) {
		const row = await env.row(target.declaration.scope);
		await env.put({
			...row,
			...(name === "malformed-present"
				? { descriptors: "not-json" }
				: name === "poisoned-acquisition"
					? { state: "poisoned", retention: "temporary" }
					: { state: "open" }),
		});
	}
	if (name === "missing-chunk") await env.chunks(target.declaration.scope, "delete");
	if (name === "corrupt-chunk") await env.chunks(target.declaration.scope, "corrupt");
	if (name === "oversized-chunk")
		await env.oversize(target.declaration, snapshotQuarantineContract.limits.snapshotChunkBytes + 1);
	if (name === "corrupt-descriptor") await env.chunks(target.declaration.scope, "descriptor");
	let replacementControl: unknown;
	if (name === "replacement-before" || name === "replacement-identical-after") {
		const beforeRow = await env.row(target.declaration.scope);
		const beforeChunks = stable(nativeChunks(await env.image(), target.declaration));
		await env.put({ ...beforeRow, incarnation: crypto.randomUUID() });
		const afterRow = await env.row(target.declaration.scope);
		check(
			afterRow.incarnation === beforeRow.incarnation,
			false,
			"genuine setup replacement changes private incarnation"
		);
		check(
			{ ...afterRow, incarnation: beforeRow.incarnation },
			beforeRow,
			"replacement retains exact declaration and metadata"
		);
		check(
			stable(nativeChunks(await env.image(), target.declaration)),
			beforeChunks,
			"replacement retains actual exact native chunk bytes"
		);
		replacementControl = {
			beforeRow: stable(beforeRow),
			afterRow: stable(afterRow),
			beforeChunks,
			afterChunks: stable(nativeChunks(await env.image(), target.declaration)),
		};
	}
	return { case: name, closed: true, image: stable(await env.image()), replacementControl };
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object") throw new Error("native image record absent");
	return value as Record<string, unknown>;
}

function nativeChunks(image: unknown, declaration: SnapshotQuarantineDeclaration): Record<string, unknown>[] {
	const chunks = record(image).chunks;
	if (!Array.isArray(chunks)) throw new Error("native chunks census absent");
	return chunks
		.map(record)
		.filter(
			(row) =>
				(row.objectId ?? row.object_id) === declaration.scope.objectId &&
				row.epoch === declaration.scope.epoch &&
				row.anchor === declaration.scope.anchor &&
				(row.manifestDigest ?? row.manifest_digest) === declaration.scope.manifestDigest
		);
}

function boundedChunkMaterialization(evidence: ReadObservation): void {
	check(
		evidence.materialized
			?.flatMap((row) => row.fields)
			.some(
				(field) => field.type === "bytes" && (field.bytes ?? 0) > snapshotQuarantineContract.limits.snapshotChunkBytes
			),
		false,
		"SQLite rejects oversized persisted chunk before its BLOB crosses native-to-JS boundary"
	);
}

/** Independently reach actual native metadata/content controls before the missing API mask. */
export async function preconditions(name: ReadCase, env: ReadEnvironment): Promise<Record<string, unknown>> {
	const target = selected(name);
	const before = stable(await env.image());
	const owner = await env.open();
	try {
		const lookup = Reflect.get(owner, "lookupRecoveryDeclaration") as (
			scope: SnapshotQuarantineDeclaration["scope"]
		) => Promise<unknown>;
		const neighbor = await lookup.call(owner, selected(name, "neighbor").declaration.scope);
		check(record(neighbor).kind, "present", "genuine readable neighboring epoch");
		const observed = await outcome(() => lookup.call(owner, target.declaration.scope));
		const expected =
			name === "occupied-other-manifest"
				? "conflict"
				: name === "malformed-present" || name === "recovery-open-invalid"
					? "poisoned"
					: "none";
		check(observed.code, expected, "independent existing metadata validation");
		if (expected === "none")
			check(
				record(observed.value).kind,
				name === "missing-exact" ? "missing" : "present",
				"exact native row occupancy"
			);
		const image = record(await env.image());
		const chunks = nativeChunks(image, target.declaration);
		if (!name.startsWith("legacy-")) {
			const expired = selected(name, "expired");
			const expiredChunks = nativeChunks(image, expired.declaration);
			check(expiredChunks.length, 1, "unrelated expired temporary scope remains genuinely byte-bearing");
			check(
				at(expiredChunks, 0).exactBytes ?? at(expiredChunks, 0).exact_bytes,
				at(expired.chunks, 0),
				"unrelated expired scope exact persisted bytes"
			);
			check((await env.row(expired.declaration.scope)).expiresAt, 1, "unrelated scope genuinely expired before reader");
		}
		const content = chunks.map((row) => ({
			bytes: row.exactBytes ?? row.exact_bytes,
			descriptor: {
				index: row.index ?? row.chunk_index,
				digest: row.digest ?? row.chunk_digest,
				byteLength: row.byteLength ?? row.byte_length,
			},
		}));
		if (["missing-exact", "occupied-other-manifest", "missing-chunk"].includes(name))
			check(content.length, 0, "actual native chunk absence");
		else {
			check(content.length, 1, "actual persisted chunk count");
			const closure = await outcome(() =>
				snapshotQuarantineContract.validateRecoveryChunk(
					target.declaration,
					at(content, 0).descriptor as SnapshotChunkDescriptor,
					at(content, 0).bytes as Uint8Array
				)
			);
			check(
				closure.code,
				name === "corrupt-chunk" || name === "corrupt-descriptor" || name === "oversized-chunk" ? "poisoned" : "none",
				"actual native bytes shared closure law"
			);
		}
		const native = await env.readonlyControl(selected(name, "neighbor").declaration);
		check(native.writes, 0, "independent readonly observer has no writes");
		check(native.transactions, 1, "independent actual readonly transaction");
		check(native.modes, [env.backend === "sqlite" ? "BEGIN" : "readonly"], "independent actual readonly mode observed");
		check(native.terminal, true, "independent actual native terminal outcome");
		let oversizedControl: unknown;
		if (name === "oversized-chunk") {
			const bytes = at(content, 0).bytes as Uint8Array;
			check(
				bytes.byteLength,
				snapshotQuarantineContract.limits.snapshotChunkBytes + 1,
				"genuine persisted oversized native bytes, not an oversized descriptor alone"
			);
			const guarded = await env.readonlyControl(target.declaration, true);
			if (env.backend === "sqlite") {
				boundedChunkMaterialization(guarded);
				const unsafe = await env.readonlyControl(target.declaration);
				check(
					(await outcome(() => boundedChunkMaterialization(unsafe))).code,
					"unclassified-error",
					"real unguarded native BLOB control kills naive full-copy then validate"
				);
				oversizedControl = { guarded, unsafe, unavoidableNativeClone: false };
			} else
				oversizedControl = {
					guarded,
					unavoidableNativeClone: true,
					avoidableCopyAndHash: "source review required; no heap instrumentation claim",
				};
		}
		check(stable(await env.image()), before, "precondition controls do not repair or mutate case stores");
		return {
			metadataCode: observed.code,
			chunkCount: content.length,
			neighborPresent: true,
			native,
			oversizedControl,
			unchanged: true,
		};
	} finally {
		await owner.close();
	}
}

function required(owner: RecoveryStore): ExpectedStore {
	if (typeof Reflect.get(owner, "acquireRecoveryRead") !== "function") {
		throw Object.assign(new Error("MASKED_BY_ABSENT_ACQUIRE_RECOVERY_READ; deeper reader assertions not reached"), {
			code: "reader-method-missing",
		});
	}
	return owner as ExpectedStore;
}

function present(value: ExpectedAcquisition): Extract<ExpectedAcquisition, { kind: "present" }> {
	if (value.kind !== "present") throw new Error("exact reader acquisition must be present");
	return value;
}

function copyDeclaration(value: SnapshotQuarantineDeclaration): SnapshotQuarantineDeclaration {
	return {
		scope: { ...value.scope },
		chunks: value.chunks.map((descriptor) => ({ ...descriptor })),
		totalBytes: value.totalBytes,
		exactCanonicalManifestBytes: new Uint8Array(value.exactCanonicalManifestBytes),
	};
}

/** Normative actual reader assertions. The original owner currently masks these at its absent required method. */
export async function run(name: ReadCase, env: ReadEnvironment): Promise<ReadReport> {
	const controls = await preconditions(name, env);
	const owner = await env.open();
	const report: ReadReport = {
		case: name,
		preconditions: controls,
		observations: [],
		passed: false,
		observed: { code: "none" },
	};
	const sessions: ExpectedReader[] = [];
	try {
		const observed = await outcome(async () => {
			const api = required(owner);
			const target = selected(name);
			const descriptor = at(target.declaration.chunks, 0);
			const before = stable(await env.image());
			const measured = async (
				action: () => Promise<unknown>,
				boundary?: (event: Boundary) => void
			): Promise<unknown> => {
				const result = await env.observeReader(action, boundary);
				report.observations.push(result.evidence);
				check(result.evidence.writes, 0, "reader operation cannot write durable content");
				if (name === "oversized-chunk" && env.backend === "sqlite") boundedChunkMaterialization(result.evidence);
				check(
					result.evidence.modes.every((mode) => mode === (env.backend === "sqlite" ? "BEGIN" : "readonly")),
					true,
					"reader must use actual readonly native transaction, never intentional writer reservation"
				);
				if (result.evidence.transactions > 0)
					check(result.evidence.terminal, true, "reader native work settled before public result");
				return result.value;
			};
			const reached = (chunk: boolean): void => {
				const evidence = at(report.observations, report.observations.length - 1);
				check(evidence.transactions, 1, "each admitted reader operation owns one actual native transaction");
				check(
					evidence.reads.some((read) => read.table === "scopes"),
					true,
					"actual current metadata reached in reader transaction"
				);
				if (chunk)
					check(
						evidence.reads.some((read) => read.table === "chunks"),
						true,
						"actual chunk lookup reached in the same reader transaction"
					);
			};
			const notStarted = (): void => {
				check(
					at(report.observations, report.observations.length - 1).transactions,
					0,
					"early refusal/cancellation starts no native transaction"
				);
			};
			const acquire = async (
				declaration = target.declaration
			): Promise<Extract<ExpectedAcquisition, { kind: "present" }>> => {
				const image = stable(await env.image());
				const metadata = await env.row(target.declaration.scope);
				const acquired = present((await measured(() => api.acquireRecoveryRead(declaration))) as ExpectedAcquisition);
				reached(false);
				sessions.push(acquired.reader);
				check(
					Object.keys(acquired).sort(),
					["declaration", "expiresAt", "kind", "reader", "retention", "state"],
					"acquisition exposes only the declared observation, never private incarnation"
				);
				check(acquired.declaration, target.declaration, "detached exact declaration observation");
				check(
					[acquired.state, acquired.retention, acquired.expiresAt],
					[metadata.state, metadata.retention, metadata.expiresAt],
					"actual current eligibility/retention/expiry observation"
				);
				check(
					stable(await env.image()),
					image,
					"acquisition leaves every durable row including unrelated expired transfers untouched"
				);
				return acquired;
			};
			if (
				[
					"missing-exact",
					"occupied-other-manifest",
					"malformed-present",
					"poisoned-acquisition",
					"recovery-open-invalid",
					"pre-abort",
					"queued-acquisition-abort",
					"queued-acquisition-close",
					"executing-acquisition-close",
					"declaration-invalid-carrier",
					"declaration-malformed",
					"declaration-manifest-mismatch",
				].includes(name)
			) {
				const controller = new AbortController();
				if (name === "pre-abort") controller.abort();
				const declaration = copyDeclaration(target.declaration);
				if (name === "declaration-invalid-carrier")
					Reflect.set(
						declaration,
						"exactCanonicalManifestBytes",
						new Uint8Array(declaration.exactCanonicalManifestBytes.buffer, 1)
					);
				if (name === "declaration-malformed") Reflect.set(declaration.scope, "epoch", -1);
				if (name === "declaration-manifest-mismatch") declaration.exactCanonicalManifestBytes.fill(0);
				let close: Promise<void> | undefined;
				const result = await measured(
					async () => {
						const pending = api.acquireRecoveryRead(declaration, { signal: controller.signal });
						if (name === "queued-acquisition-abort") controller.abort();
						if (name === "queued-acquisition-close") close = api.close();
						return outcome(() => pending);
					},
					(event) => {
						if (name === "executing-acquisition-close" && event === "start") close = api.close();
					}
				);
				const expected =
					name === "occupied-other-manifest"
						? "conflict"
						: name === "malformed-present" ||
							  name === "poisoned-acquisition" ||
							  name === "recovery-open-invalid" ||
							  name === "declaration-manifest-mismatch"
							? "poisoned"
							: name === "declaration-invalid-carrier"
								? "invalid-carrier"
								: name === "declaration-malformed"
									? "malformed-input"
									: name.includes("abort")
										? "aborted"
										: name === "queued-acquisition-close"
											? "closed"
											: "none";
				check(record(result).code, expected, "exact acquisition refusal/scheduling outcome");
				if (name === "pre-abort" || name.startsWith("queued-") || name.startsWith("declaration-")) notStarted();
				else reached(false);
				if (expected === "none") {
					const value = record(result).value as ExpectedAcquisition;
					check(value.kind, name === "missing-exact" ? "missing" : "present", "no creation or fallback");
					if (value.kind === "present") {
						sessions.push(value.reader);
						check(
							(await outcome(() => value.reader.read(descriptor))).code,
							"closed",
							"closed owner prevents later calls"
						);
					}
				}
				await close;
				check(stable(await env.image()), before, "acquisition refusal/close creates no durable mutation");
				return;
			}
			if (name === "replacement-before") {
				const row = await env.row(target.declaration.scope);
				const chunks = stable(nativeChunks(await env.image(), target.declaration));
				await env.put({ ...row, incarnation: crypto.randomUUID() });
				check(
					(await env.row(target.declaration.scope)).incarnation === row.incarnation,
					false,
					"actual pre-acquisition replacement incarnation"
				);
				check(
					stable(nativeChunks(await env.image(), target.declaration)),
					chunks,
					"pre-acquisition replacement preserves actual bytes"
				);
			}
			let acquired: Extract<ExpectedAcquisition, { kind: "present" }>;
			if (name === "input-observation-result-mutation") {
				const input = copyDeclaration(target.declaration);
				const options = { signal: new AbortController().signal };
				const replacementSignal = AbortSignal.abort();
				acquired = present(
					(await measured(async () => {
						const pending = api.acquireRecoveryRead(input, options);
						options.signal = replacementSignal;
						input.exactCanonicalManifestBytes.fill(0);
						Reflect.set(input.scope, "objectId", "redirected");
						Reflect.set(at(input.chunks, 0), "digest", "f".repeat(64));
						return pending;
					})) as ExpectedAcquisition
				);
				reached(false);
				sessions.push(acquired.reader);
				check(acquired.declaration, target.declaration, "synchronous detached declaration capture");
				acquired.declaration.exactCanonicalManifestBytes.fill(0);
				Reflect.set(acquired.declaration.scope, "epoch", 999);
				Reflect.set(at(acquired.declaration.chunks, 0), "digest", "f".repeat(64));
			} else acquired = await acquire();
			const reader = acquired.reader;
			const rowBefore = await env.row(target.declaration.scope);
			let expectedRead = "none";
			if (
				(name.startsWith("replacement-") && name !== "replacement-before" && name !== "replacement-malformed-after") ||
				name === "same-incarnation-mismatch"
			) {
				if (name === "replacement-identical-after") {
					const chunks = stable(nativeChunks(await env.image(), target.declaration));
					await env.put({ ...rowBefore, incarnation: crypto.randomUUID() });
					check(
						stable(nativeChunks(await env.image(), target.declaration)),
						chunks,
						"post-acquisition identical replacement preserves actual bytes"
					);
				} else {
					const different = selected(name, "different");
					await env.remove(target.declaration.scope);
					await env.put({
						...rowBefore,
						...different.declaration.scope,
						exactCanonicalManifestBytes: different.declaration.exactCanonicalManifestBytes,
						descriptors: JSON.stringify(different.declaration.chunks),
						incarnation: name === "same-incarnation-mismatch" ? rowBefore.incarnation : crypto.randomUUID(),
					});
				}
				expectedRead = name === "same-incarnation-mismatch" ? "conflict" : "stale-scope";
			} else if (
				name === "same-incarnation-malformed" ||
				name === "poisoned-after" ||
				name === "replacement-malformed-after"
			) {
				await env.put({
					...rowBefore,
					...(name === "poisoned-after" ? { state: "poisoned", retention: "temporary" } : { descriptors: "not-json" }),
					...(name === "replacement-malformed-after" ? { incarnation: crypto.randomUUID() } : {}),
				});
				expectedRead = "poisoned";
			} else if (name === "delete-after") await env.remove(target.declaration.scope);
			else if (name === "sweep-after") {
				await env.put({ ...rowBefore, expiresAt: 1 });
				await api.sweepExpired();
				check(
					(await outcome(() => env.row(target.declaration.scope))).code,
					"unclassified-error",
					"authorized sweep actually deleted target"
				);
			} else if (name === "promotion-after") {
				const scope = await api.openScope(target.declaration);
				await scope.retainForRecovery();
				await scope.release();
			}
			const readBefore = stable(await env.image());
			if (name === "corrupt-chunk" || name === "corrupt-descriptor" || name === "oversized-chunk")
				expectedRead = "poisoned";
			if (name === "foreign-descriptor") expectedRead = "malformed-input";
			if (name === "storage-failed") {
				check(
					record(await env.failStorage(() => outcome(() => reader.read(descriptor)))).code,
					"storage-failed",
					"actual native failure mapped"
				);
			} else if (
				name.includes("abort") ||
				name.includes("release") ||
				name.includes("close") ||
				name === "independent-readers"
			) {
				const controller = new AbortController();
				let drain: Promise<void> | undefined;
				let admitted = false;
				const settlementOrder: string[] = [];
				const event = (edge: Boundary): void => {
					if (edge === "start") admitted = true;
					if ((name === "executing-abort" && edge === "start") || (name === "terminal-abort" && edge === "terminal"))
						controller.abort();
					if (edge === "start" && name === "executing-release")
						drain = reader.release().then(() => {
							settlementOrder.push("drain-settled");
						});
					if (edge === "start" && name === "executing-read-close")
						drain = api.close().then(() => {
							settlementOrder.push("drain-settled");
						});
				};
				const readResult = await measured(async () => {
					const pending = reader.read(descriptor, { signal: controller.signal });
					void pending.then(
						() => {
							settlementOrder.push("read-settled");
						},
						() => {
							settlementOrder.push("read-settled");
						}
					);
					if (name === "queued-read-abort") controller.abort();
					if (name === "queued-release") drain = reader.release();
					if (name === "queued-read-close") drain = api.close();
					const result = await outcome(() => pending);
					return result;
				}, event);
				check(
					record(readResult).code,
					name === "queued-read-abort" || name === "executing-abort"
						? "aborted"
						: name === "queued-release" || name === "queued-read-close"
							? "closed"
							: "none",
					"reader-local queued versus executing outcome"
				);
				if (name.startsWith("queued-")) check(admitted, false, "cancelled queued read never starts native work");
				else check(admitted, true, "executing/terminal control actually reached native transaction");
				if (name.startsWith("queued-")) notStarted();
				else if (name === "executing-abort")
					check(
						at(report.observations, report.observations.length - 1).transactions,
						1,
						"executing abort reached native transaction boundary"
					);
				else reached(true);
				if (
					name !== "queued-read-abort" &&
					name !== "executing-abort" &&
					name !== "queued-release" &&
					name !== "queued-read-close"
				)
					check(record(readResult).value, at(target.chunks, 0), "executing/terminal reader returns actual exact bytes");
				await drain;
				if (name === "executing-release" || name === "executing-read-close")
					check(
						settlementOrder,
						["read-settled", "drain-settled"],
						"release/close settles only after already executing read"
					);
				if (name.includes("release")) {
					await reader.release();
					check((await outcome(() => reader.read(descriptor))).code, "closed", "released reader rejects new calls");
				}
				if (name === "independent-readers") {
					const independent = await acquire();
					await reader.release();
					check(
						await measured(() => independent.reader.read(descriptor)),
						target.chunks[0],
						"releasing one session leaves the independent reader alive"
					);
					reached(true);
				}
			} else {
				const input = { ...descriptor };
				if (name === "foreign-descriptor") input.digest = "f".repeat(64);
				const readResult = await measured(async () => {
					const options = { signal: new AbortController().signal };
					const pending = reader.read(input, options);
					if (name === "input-observation-result-mutation") {
						input.index = 100;
						options.signal = AbortSignal.abort();
					}
					return outcome(() => pending);
				});
				check(record(readResult).code, expectedRead, "exact reader stale/conflict/corruption/descriptor outcome");
				if (name === "foreign-descriptor") notStarted();
				else
					reached(
						(expectedRead === "none" && name !== "delete-after" && name !== "sweep-after") ||
							name === "corrupt-chunk" ||
							name === "corrupt-descriptor" ||
							name === "oversized-chunk"
					);
				if (expectedRead === "none") {
					const missing = ["missing-chunk", "delete-after", "sweep-after"].includes(name);
					check(
						record(readResult).value,
						missing ? undefined : target.chunks[0],
						"actual exact manifest-described bytes or absence"
					);
					if (!missing) {
						(record(readResult).value as Uint8Array).fill(255);
						check(
							await measured(() => reader.read(descriptor)),
							target.chunks[0],
							"returned bytes detached and repeated native read remains exact"
						);
						reached(true);
					}
				}
			}
			check(
				stable(await env.image()),
				readBefore,
				"reader read creates no sweep, repair, completion, pin or metadata change"
			);
			await reader.release();
			await reader.release();
			check(stable(await env.image()), readBefore, "idempotent session-only release does not mutate owner or expiry");
		});
		report.observed = { code: observed.code, ...(observed.detail === undefined ? {} : { detail: observed.detail }) };
		report.passed = observed.code === "none";
		if (observed.code === "reader-method-missing")
			report.mask = "WIRING_RED_ONLY; native preconditions reached, deeper reader assertions await GREEN";
		return report;
	} finally {
		await Promise.allSettled(sessions.map((reader) => reader.release()));
		await owner.close();
	}
}
