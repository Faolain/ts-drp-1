/* eslint-disable jsdoc/require-jsdoc -- Finite storage-only native contract oracle. */
import {
	assertNativeSelectedRead,
	check,
	type Environment,
	id,
	type Image,
	LIMITS,
	must,
	OBJECT,
	OTHER,
	payload,
	ref,
	type Result,
	stable,
	stage,
	type Trace,
} from "./contract.js";
import { encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationRecord,
	type GenerationRef,
} from "../../../packages/storage/dist/src/index.js";

// This test-owned shape permits strict fixture compilation while the separate
// uncompensated API contract imports the actual required product declarations.
interface RoleReader {
	readonly head: ExpectedHead;
	readonly generations: readonly GenerationRecord[];
	readonly blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
	checkCurrency(): Promise<Result<{ kind: "current" }>>;
	release(): Promise<void>;
}
export const ROLE_CASES = Object.freeze([
	"whole-view",
	"no-head-capture",
	"invalid-capture",
	"capture-close",
	"currency-current",
	"currency-add",
	"currency-remove",
	"currency-staged-state",
	"currency-candidate-state",
	"currency-refs",
	"currency-metadata",
	"currency-head-advance",
	"currency-head-remove",
	"currency-promotion-missing",
	"currency-blob-missing",
	"currency-blob-corrupt",
	"currency-budget",
	"promotion-missing",
	"blob-missing",
	"blob-wrong-bytes",
	"blob-wrong-length",
	"shared-length-conflict",
	"noncandidate-malformed",
	"duplicate-adopted",
	"head-mismatch",
	"baseline-altered",
	"baseline-detached",
	"baseline-terminal",
	"baseline-late-idb",
	"bounds-positive",
	"G+1",
	"H+1",
	"R+1",
	"noncandidate-F+1",
	"declared-B+1",
	"actual-B+1",
	"U+1",
	"head-depth",
	"head-items",
	"generation-depth",
	"generation-items",
	"key-invalid",
	"key-sentinel",
	"sqlite-key-oversized",
	"sqlite-key-blob",
	"idb-key-nested",
	"coalesced",
	"release-before-admission",
	"release-start",
	"release-terminal",
	"release-independent",
	"close-before",
	"close-start",
	"close-queued-idb",
	"native-failure",
	"corruption-release",
	"no-certificate",
	"preserve-certificate",
] as const);
export type RoleCase = (typeof ROLE_CASES)[number];
export function supported(name: RoleCase, backend: Environment["backend"]): boolean {
	return !(name.includes("idb") && backend !== "idb") && !(name.includes("sqlite") && backend !== "sqlite");
}
const input = (): { objectId: typeof OBJECT; limits: typeof LIMITS } => ({ objectId: OBJECT, limits: LIMITS });
function records(image: Image): GenerationRecord[] {
	return image.generations
		.filter((g) => g.objectId === OBJECT)
		.map((g) => must(decodeGenerationRecordV1(g.record)))
		.sort((a, b) => a.generationId.localeCompare(b.generationId));
}
function nativeHead(image: Image): ExpectedHead {
	const row = image.heads.find((h) => h.objectId === OBJECT);
	return row?.record == null ? { kind: "none", objectId: OBJECT } : must(decodeHeadRecordV1(row.record));
}
function generation(image: Image, n: number): GenerationRecord {
	const value = records(image).find((g) => g.generationId === id(n));
	check(value, "exact native generation exists");
	return value;
}
async function change(env: Environment, n: number, fields: Partial<GenerationRecord>): Promise<void> {
	await env.edit({
		kind: "generation",
		generationId: id(n),
		record: encodeGenerationRecordV1({ ...generation(await env.image(), n), ...fields }),
	});
}
function reason(result: Result<unknown>, expected: string): void {
	check(!result.ok && result.reason === expected, "exact typed " + expected + ": " + stable(result));
}
function readOnly(trace: Trace, started?: number): void {
	check(trace.writes === 0, "zero actual native DML/readwrite");
	check(
		trace.modes.every((m) => m === "readonly" || /^\s*BEGIN\s*$/iu.test(m)),
		"plain readonly native snapshots"
	);
	check(trace.terminals === trace.modes.length, "one real joined terminal per started snapshot");
	if (started !== undefined) check(trace.modes.length === started, "exact native admission count");
}
const candidate = (g: GenerationRecord): boolean => ["Complete", "Adopted", "Superseded"].includes(g.state);
function actualBlobGets(trace: Trace): Trace["reads"] {
	return trace.reads.filter(
		(r) =>
			r.table === "blobs" &&
			r.operation === "get" &&
			(trace.transactionStores !== undefined || typeof r.query !== "string" || /\bAS bytes\b/iu.test(r.query))
	);
}
function metadataGets(trace: Trace): Trace["reads"] {
	return trace.reads.filter((r) => r.table === "generations" && r.operation === "get");
}
function isGenerationScan(read: Trace["reads"][number]): boolean {
	return read.table === "generations" && ["getAll", "openCursor", "all"].includes(read.operation);
}
function assertWhole(reader: RoleReader, image: Image, trace: Trace): void {
	const head = nativeHead(image),
		all = records(image),
		selected = all.filter(candidate);
	check(stable(reader.head) === stable(head), "whole native head including absent head");
	check(stable(reader.generations) === stable(all), "all physical canonical rows in physical-key order");
	if (head.kind === "present") {
		check(reader.head.kind === "present", "returned present head");
		assertNativeSelectedRead(
			{ head: reader.head, blobs: reader.blobs, generations: selected },
			head,
			selected,
			image,
			trace
		);
	} else {
		const union = new Map(selected.flatMap((g) => g.closure.map((r) => [r.digest, r] as const)));
		check(reader.blobs.length === union.size, "no-head exact candidate union");
		for (const blob of reader.blobs) {
			check(stable(blob.ref) === stable(union.get(blob.ref.digest)), "no-head exact immutable ref");
			check(
				stable(blob.bytes) === stable(image.blobs.find((b) => b.digest === blob.ref.digest)?.bytes),
				"no-head actual bytes"
			);
		}
	}
	assertRecapture(image, trace);
	check(
		Object.isFrozen(reader) &&
			Object.isFrozen(reader.head) &&
			Object.isFrozen(reader.generations) &&
			Object.isFrozen(reader.blobs),
		"frozen outer structures"
	);
	check(
		reader.generations.every(
			(g) =>
				Object.isFrozen(g) &&
				Object.isFrozen(g.baseExpectedHead) &&
				Object.isFrozen(g.closure) &&
				g.closure.every(Object.isFrozen)
		),
		"frozen detached metadata structures"
	);
	check(
		reader.blobs.every(
			(b) => Object.isFrozen(b) && Object.isFrozen(b.ref) && must(digestBlob(b.bytes)) === b.ref.digest
		),
		"frozen refs and authentic borrowed bytes"
	);
}
function assertRecapture(image: Image, trace: Trace): void {
	readOnly(trace, 1);
	const all = records(image),
		selected = all.filter(candidate),
		union = new Set(selected.flatMap((g) => g.closure.map((r) => r.digest)));
	for (const g of selected)
		for (const reference of g.closure)
			check(
				trace.reads.some((read) => {
					const key = read.parameters ?? (Array.isArray(read.query) ? read.query : []);
					return (
						read.table === "promotions" &&
						key.includes(g.objectId) &&
						key.includes(g.generationId) &&
						key.includes(reference.digest)
					);
				}),
				"every candidate own promotion required even without head"
			);
	check(actualBlobGets(trace).length === union.size, "one native actual get per distinct candidate digest");
	const events = trace.materialEvents ?? [];
	check(
		events.length === 2 * union.size &&
			events.every((event, i) =>
				i % 2 === 0 ? event.startsWith("request:") : event === events[i - 1]?.replace("request:", "success:")
			),
		"native material requests complete serially before next get"
	);
	check(metadataGets(trace).length === all.length, "every physical metadata value classified exactly once");
	if (trace.transactionStores)
		check(
			trace.transactionStores.every(
				(tables) => stable([...tables].sort()) === stable(["blobs", "generations", "objects", "promotions"])
			),
			"whole role view all-authority transaction scope"
		);
}

export async function roleSetup(name: RoleCase, env: Environment): Promise<Record<string, unknown>> {
	const store = await env.open();
	let head: ExpectedHead = { kind: "none", objectId: OBJECT };
	const large = ["bounds-positive", "U+1"].includes(name);
	try {
		if (name === "no-head-capture") {
			await stage(store, 1, head, [payload(1)], false);
			must(await store.completeGeneration({ objectId: OBJECT, generationId: id(1) }));
			must(
				await store.beginGeneration({
					objectId: OBJECT,
					generationId: id(2),
					baseExpectedHead: head,
					closure: [ref(payload(2))],
				})
			);
		} else {
			for (let n = 1; n <= 3; n++)
				head = await stage(store, n, head, large ? [payload(10, 65536)] : [payload(n), payload(90)]);
			for (let n = 4; n <= 5; n++) {
				const bytes = large
					? n === 4
						? [payload(11, 65536), payload(12, 65536)]
						: [payload(13, 65536)]
					: [payload(n), payload(90)];
				await stage(store, n, head, bytes, false);
				must(await store.completeGeneration({ objectId: OBJECT, generationId: id(n) }));
			}
			for (let n = 6; n <= (name === "currency-add" ? 6 : 7); n++) {
				const refs = (
					large && n === 6 ? Array.from({ length: 7 }, (_, j) => ref(payload(30 + j))) : [ref(payload(n))]
				).sort((a, b) => a.digest.localeCompare(b.digest));
				must(
					await store.beginGeneration({ objectId: OBJECT, generationId: id(n), baseExpectedHead: head, closure: refs })
				);
				if (n === 7) must(await store.discardGeneration({ objectId: OBJECT, generationId: id(n) }));
			}
			if (name === "G+1" || name === "key-sentinel")
				must(
					await store.beginGeneration({
						objectId: OBJECT,
						generationId: id(8),
						baseExpectedHead: head,
						closure: [ref(payload(8))],
					})
				);
			if (name === "U+1") {
				// Replace noncandidate 7 with a genuine Complete candidate. The active
				// union is only B; the full union is exactly four B plus one byte.
				await stage(store, 8, head, [payload(14, 1)], false);
				must(await store.completeGeneration({ objectId: OBJECT, generationId: id(8) }));
			}
		}
	} finally {
		await store.close();
	}
	if (name === "U+1") await env.edit({ kind: "delete-generation", generationId: id(7) });
	const image = await env.image(),
		fifth = name === "no-head-capture" ? generation(image, 1) : generation(image, 5),
		target = fifth.closure.find((r) => r.digest !== ref(payload(90)).digest) ?? fifth.closure[0];
	check(target, "nonactive candidate target");
	if (name === "promotion-missing") await env.edit({ kind: "promotion", generationId: id(5), digest: target.digest });
	if (name === "blob-missing") await env.edit({ kind: "blob", digest: target.digest, bytes: null });
	if (name === "blob-wrong-bytes")
		await env.edit({ kind: "blob", digest: target.digest, bytes: payload(88, target.byteLength) });
	if (name === "blob-wrong-length")
		await env.edit({ kind: "blob", digest: target.digest, bytes: payload(5, target.byteLength + 1) });
	if (name === "actual-B+1") await env.edit({ kind: "blob", digest: target.digest, bytes: payload(5, 65537) });
	if (name === "declared-B+1" || name === "shared-length-conflict") {
		const closure = fifth.closure.map((r) =>
			r.digest === (name === "shared-length-conflict" ? ref(payload(90)).digest : target.digest)
				? { ...r, byteLength: name === "declared-B+1" ? 65537 : r.byteLength + 1 }
				: r
		);
		await change(env, 5, { closure, closureDigest: must(digestClosure(closure)) });
	}
	if (name === "noncandidate-F+1") {
		const closure = Array.from({ length: 8 }, (_, j) => ref(payload(40 + j))).sort((a, b) =>
			a.digest.localeCompare(b.digest)
		);
		await change(env, 6, { closure, closureDigest: must(digestClosure(closure)) });
	}
	if (name === "noncandidate-malformed")
		await env.edit({ kind: "generation", generationId: id(6), record: Uint8Array.of(255) });
	if (name === "duplicate-adopted") await change(env, 5, { state: "Adopted" });
	if (name === "head-mismatch") {
		check(head.kind === "present", "present setup head");
		await env.edit({ kind: "head", record: encodeHeadRecordV1({ ...head, closureDigest: fifth.closureDigest }) });
	}
	if (name === "H+1") await env.edit({ kind: "head", record: new Uint8Array(3327).fill(255) });
	if (name === "R+1")
		await env.edit({ kind: "generation", generationId: id(5), record: new Uint8Array(7308).fill(255) });
	if (name === "head-depth" || name === "head-items")
		await env.edit({
			kind: "head",
			record: encodeCanonical(name === "head-depth" ? { a: { b: { c: 1 } } } : Array(34).fill(0)),
		});
	if (name === "generation-depth" || name === "generation-items")
		await env.edit({
			kind: "generation",
			generationId: id(5),
			record: encodeCanonical(name === "generation-depth" ? { a: { b: { c: { d: { e: 1 } } } } } : Array(128).fill(0)),
		});
	if (["key-invalid", "key-sentinel", "sqlite-key-oversized", "sqlite-key-blob", "idb-key-nested"].includes(name)) {
		const n = name === "key-sentinel" ? 8 : 6,
			source = image.generations.find((g) => g.generationId === id(n));
		check(source, "native key source");
		await env.edit({
			kind: "generation",
			generationId: id(n),
			record: source.record,
			replaceId:
				name === "sqlite-key-oversized"
					? "z".repeat(131072)
					: name === "sqlite-key-blob"
						? new Uint8Array(64).fill(97)
						: name === "idb-key-nested"
							? ["outside"]
							: "z".repeat(64),
		});
	}
	return rolePrecondition(name, env);
}

export async function rolePrecondition(name: RoleCase, env: Environment): Promise<Record<string, unknown>> {
	const image = await env.image(),
		rows = image.generations.filter((g) => g.objectId === OBJECT),
		decoded = rows.flatMap((g) => {
			const r = decodeGenerationRecordV1(g.record);
			return r.ok ? [r.value] : [];
		});
	check(rows.length >= 2, "independent physical fixture census");
	if (name === "whole-view")
		check(
			stable(decoded.map((g) => g.state)) ===
				stable(["Superseded", "Superseded", "Adopted", "Complete", "Complete", "Staged", "Discarded"]),
			"actual mixed seven-state mechanical candidates"
		);
	if (name === "no-head-capture")
		check(
			nativeHead(image).kind === "none" &&
				decoded.some((g) => g.state === "Complete") &&
				decoded.some((g) => g.state === "Staged"),
			"no-head Complete plus missing staged debt"
		);
	if (name === "bounds-positive" || name === "U+1") {
		const union = new Map(decoded.filter(candidate).flatMap((g) => g.closure.map((r) => [r.digest, r] as const)));
		check(
			[...union.values()].reduce((n, r) => n + r.byteLength, 0) === 262144 + (name === "U+1" ? 1 : 0),
			"actual candidate-only exact U/U+1 union"
		);
		check(
			decoded.find((g) => g.state === "Adopted")?.closure.reduce((n, r) => n + r.byteLength, 0) === 65536,
			"active alone fits B/U"
		);
		check(rows.length === 7 && decoded.find((g) => g.generationId === id(6))?.closure.length === 7, "positive G7/F7");
	}
	if (name === "G+1" || name === "key-sentinel") check(rows.length === 8, "actual eighth physical key/sentinel");
	if (name === "H+1")
		check(image.heads.find((h) => h.objectId === OBJECT)?.record?.byteLength === 3327, "actual H3327");
	if (name === "R+1")
		check(
			rows.some((g) => g.generationId === id(5) && g.record.byteLength === 7308),
			"actual nonactive R7308"
		);
	if (name === "noncandidate-F+1")
		check(
			decoded.some((g) => g.state === "Staged" && g.closure.length === 8),
			"actual noncandidate F8"
		);
	if (name === "declared-B+1")
		check(
			decoded.some((g) => g.state === "Complete" && g.closure.some((r) => r.byteLength === 65537)),
			"actual nonactive declared B65537"
		);
	if (name === "actual-B+1")
		check(
			image.blobs.some((b) => b.bytes.byteLength === 65537),
			"actual B65537 bytes"
		);
	if (name === "promotion-missing") {
		const g = generation(image, 5);
		check(
			g.closure.some((r) => !image.promotions.some((p) => p.generationId === id(5) && p.digest === r.digest)),
			"actual missing Complete own promotion"
		);
	}
	if (name === "blob-missing")
		check(
			generation(image, 5).closure.some((r) => !image.blobs.some((b) => b.digest === r.digest)),
			"actual missing candidate bytes"
		);
	if (name.startsWith("blob-wrong"))
		check(
			generation(image, 5).closure.some((r) => {
				const b = image.blobs.find((b) => b.digest === r.digest);
				return b && (b.bytes.byteLength !== r.byteLength || must(digestBlob(b.bytes)) !== r.digest);
			}),
			"actual persisted bytes/length corruption"
		);
	if (name === "noncandidate-malformed")
		check(
			rows.some((g) => g.generationId === id(6) && !decodeGenerationRecordV1(g.record).ok),
			"actual malformed noncandidate"
		);
	if (name === "duplicate-adopted")
		check(decoded.filter((g) => g.state === "Adopted").length === 2, "actual two Adopted");
	if (name === "head-mismatch") {
		const h = nativeHead(image);
		check(
			h.kind === "present" && generation(image, 3).closureDigest !== h.closureDigest,
			"actual head/adopted closure mismatch"
		);
	}
	return {
		case: name,
		backend: env.backend,
		rows: rows.length,
		states: decoded.map((g) => g.state),
		head: nativeHeadSafe(image),
		producerClosed: true,
	};
}
function nativeHeadSafe(image: Image): string {
	const r = image.heads.find((h) => h.objectId === OBJECT)?.record;
	return r == null ? "none" : decodeHeadRecordV1(r).ok ? "present" : "malformed";
}

export async function roleRun(name: RoleCase, env: Environment): Promise<Record<string, unknown>> {
	const proof = await rolePrecondition(name, env),
		before = stable(await env.image()),
		store = await env.open();
	const readers = new Set<RoleReader>(),
		traces: Trace[] = [],
		custody: string[] = [];
	let ownerClosed = false;
	const close = (): Promise<void> => {
		ownerClosed = true;
		return store.close();
	};
	const method: unknown = Reflect.get(store, "acquireBoundedRecoveryRoleRead");
	try {
		if (typeof method !== "function")
			return {
				case: name,
				passed: false,
				failure: "WIRING_RED:acquireBoundedRecoveryRoleRead absent",
				downstreamExecuted: false,
				proof,
				unchanged: stable(await env.image()) === before,
			};
		const acquire = (value: unknown = input()): Promise<Result<RoleReader>> =>
			Reflect.apply(method as (v: unknown) => Promise<Result<RoleReader>>, store, [value]);
		const observe = async <T>(
			action: () => Promise<T>,
			boundary?: Parameters<Environment["observe"]>[1],
			hook?: Parameters<Environment["observe"]>[2]
		): Promise<{ value: T; evidence: Trace }> => {
			const image = stable(await env.image()),
				calls: string[] = [],
				restorers: (() => void)[] = [];
			for (const name of [
				"beginGeneration",
				"putCachedBlob",
				"promoteReference",
				"completeGeneration",
				"swapHead",
				"discardGeneration",
				"recoverActiveGeneration",
			]) {
				const original: unknown = Reflect.get(store, name),
					descriptor = Object.getOwnPropertyDescriptor(store, name);
				if (typeof original !== "function") continue;
				Object.defineProperty(store, name, {
					configurable: true,
					value: function (this: unknown, ...args: unknown[]): unknown {
						calls.push(name);
						return Reflect.apply(original, this, args);
					},
				});
				restorers.push(() => {
					if (descriptor) Object.defineProperty(store, name, descriptor);
					else Reflect.deleteProperty(store, name);
				});
			}
			let result: Awaited<ReturnType<Environment["observe"]>>;
			try {
				result = await env.observe(action, boundary, hook);
			} finally {
				for (const restore of restorers) restore();
			}
			check(calls.length === 0, "readonly role observer calls no mutation/recovery/certification API");
			readOnly(result.evidence);
			check(stable(await env.image()) === image, "full logical image unchanged within product observation");
			traces.push(result.evidence);
			return result as { value: T; evidence: Trace };
		};
		const take = async (): Promise<RoleReader> => {
			const result = await observe(() => acquire());
			const reader = must(result.value);
			readers.add(reader);
			assertWhole(reader, await env.image(), result.evidence);
			return reader;
		};
		const accessorGuard = async (mode: "mutate" | "release"): Promise<void> => {
			const outcomes: Record<string, unknown>[] = [];
			proof.accessorGuards = outcomes;
			for (const property of ["byteLength", "buffer"] as const) {
				const fresh = await take(),
					first = fresh.blobs[0],
					last = fresh.blobs.at(-1),
					image = await env.image(),
					prefix = "accessor-" + mode + "-" + property + "-";
				check(first && last && first.bytes !== last.bytes, "distinct actual mixed-union accessor carriers");
				const firstSafe = new Uint8Array(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength),
					lastBacking = last.bytes.buffer,
					lastLength = last.bytes.byteLength,
					lastSafe = new Uint8Array(lastBacking, last.bytes.byteOffset, lastLength),
					original = stable(firstSafe),
					originalByte = firstSafe[0] ?? 0,
					originalDigest = must(digestBlob(firstSafe));
				check(firstSafe.buffer !== lastBacking && firstSafe.length > 0, "distinct saved genuine backing and length");
				check(
					stable(records(image).map((g) => g.state)) ===
						stable(["Superseded", "Superseded", "Adopted", "Complete", "Complete", "Staged", "Discarded"]),
					"fresh actual mixed union for causal accessor guard"
				);
				let calls = 0,
					terminal = false,
					installed = false,
					releaseJoin: Promise<void> | undefined;
				const install = (): void => {
					Object.defineProperty(last.bytes, property, {
						configurable: true,
						get(): number | ArrayBufferLike {
							calls++;
							custody.push(prefix + "caller-getter");
							if (mode === "mutate") firstSafe[0] = originalByte ^ 1;
							else releaseJoin ??= fresh.release();
							return property === "byteLength" ? lastLength : lastBacking;
						},
					});
					installed = true;
					custody.push(prefix + "installed");
				};
				try {
					const result = await observe(
						async () => {
							const job = fresh.checkCurrency();
							if (env.backend === "sqlite") {
								check(terminal, "real synchronous COMMIT before ordinary caller accessor installation");
								custody.push(prefix + "native-return");
								install();
							}
							const value = await job;
							custody.push(prefix + "verdict");
							return value;
						},
						(edge) => {
							custody.push(prefix + "native-" + edge);
							if (edge === "terminal") {
								terminal = true;
								if (env.backend === "idb") install();
							}
						}
					);
					const actualDigest = must(digestBlob(firstSafe)),
						intact = stable(firstSafe) === original && actualDigest === originalDigest,
						lastIntact = lastSafe.byteLength === lastLength && must(digestBlob(lastSafe)) === last.ref.digest;
					outcomes.push({
						property,
						calls,
						verdict: result.value,
						intact,
						lastIntact,
						actualDigest,
						originalDigest,
						releasedByGetter: !!releaseJoin,
					});
					assertRecapture(image, result.evidence);
					check(
						installed &&
							terminal &&
							stable(result.evidence.terminalKinds) === stable([env.backend === "sqlite" ? "COMMIT" : "complete"]) &&
							custody.indexOf(prefix + "native-terminal") < custody.indexOf(prefix + "installed") &&
							custody.indexOf(prefix + "installed") < custody.indexOf(prefix + "verdict"),
						"accessor installed after genuine all-comparisons terminal before public verdict"
					);
					await releaseJoin;
					await fresh.release();
					custody.push(prefix + "explicit-release-joined");
					const refused = await observe(() => fresh.checkCurrency());
					reason(refused.value, "READ_RELEASED");
					readOnly(refused.evidence, 0);
					check(refused.evidence.reads.length === 0, "joined accessor reader refusal performs zero native I/O");
					check((await store.readHead(OTHER)).ok, "accessor caller reentry never poisons owner");
					await take();
				} finally {
					await fresh.release();
				}
			}
			check(
				outcomes.every(
					(outcome) =>
						outcome.calls === 0 &&
						outcome.intact &&
						outcome.lastIntact &&
						!outcome.releasedByGetter &&
						stable(outcome.verdict) === stable({ ok: true, value: { kind: "current" } })
				),
				"RED_P1: callback-free " +
					mode +
					" accessor guard, current with actual borrowed bytes intact: " +
					stable(outcomes)
			);
		};
		const corruption: Partial<Record<RoleCase, string>> = {
			"promotion-missing": "ADOPTED_BLOB_UNPROMOTED",
			"blob-missing": "ADOPTED_BLOB_MISSING",
			"blob-wrong-bytes": "ADOPTED_BLOB_CORRUPT",
			"blob-wrong-length": "ADOPTED_BLOB_CORRUPT",
			"shared-length-conflict": "BLOB_CORRUPT",
			"noncandidate-malformed": "NON_CANONICAL_RECORD",
			"duplicate-adopted": "ILLEGAL_TRANSITION",
			"head-mismatch": "HEAD_CONFLICT",
			"key-invalid": "NON_CANONICAL_RECORD",
			"key-sentinel": "NON_CANONICAL_RECORD",
			"sqlite-key-oversized": "NON_CANONICAL_RECORD",
			"sqlite-key-blob": "NON_CANONICAL_RECORD",
			"idb-key-nested": "NON_CANONICAL_RECORD",
		};
		const budgets = [
			"G+1",
			"H+1",
			"R+1",
			"noncandidate-F+1",
			"declared-B+1",
			"actual-B+1",
			"U+1",
			"head-depth",
			"head-items",
			"generation-depth",
			"generation-items",
		];
		if (corruption[name] || budgets.includes(name)) {
			const result = await observe(() => acquire());
			reason(result.value, corruption[name] ?? "READ_BUDGET_EXCEEDED");
			if (corruption[name]) reason(await store.readHead(OTHER), "STORE_POISONED");
			else check((await store.readHead(OTHER)).ok, "resource refusal nonpoisoning");
			if (["U+1", "declared-B+1"].includes(name))
				check(
					!result.evidence.reads.some((r) => ["promotions", "blobs"].includes(r.table)),
					"declared overflow before any material request"
				);
			if (name.includes("key") && name !== "key-sentinel")
				check(metadataGets(result.evidence).length === 0, "invalid key before any metadata values");
			if (
				env.backend === "sqlite" &&
				["H+1", "R+1", "actual-B+1", "sqlite-key-oversized", "sqlite-key-blob"].includes(name)
			)
				check(
					!result.evidence.reads.some((r) =>
						r.fields?.some(
							(f) =>
								f.type === "bytes" &&
								(f.bytes ?? 0) >
									(f.name === "head_record" ? 3326 : f.name === "record" ? 7307 : f.name === "bytes" ? 65536 : 64)
						)
					),
					"actual SQLite scalar/type gate before oversized value projection"
				);
		} else if (name === "invalid-capture" || name === "capture-close") {
			if (name === "invalid-capture") {
				const getter = Object.defineProperty(input(), "objectId", { get: () => OBJECT });
				for (const value of [
					null,
					{ ...input(), objectId: "" },
					{ ...input(), extra: true },
					{ ...input(), ancestorCount: 0 },
					{ ...input(), [Symbol("extra")]: 1 },
					getter,
					{ ...input(), limits: { ...LIMITS, maxUnionBytes: 262145 } },
					{ ...input(), limits: { ...LIMITS, extra: 1 } },
					new Proxy(input(), {
						ownKeys(): never {
							throw new Error("capture trap");
						},
					}),
				]) {
					const result = await observe(() => acquire(value));
					reason(result.value, "INVALID_ARGUMENT");
					readOnly(result.evidence, 0);
				}
			} else {
				let closing: Promise<void> | undefined;
				const proxy = new Proxy(input(), {
					ownKeys(target): (string | symbol)[] {
						closing ??= close();
						return Reflect.ownKeys(target);
					},
				});
				const result = await observe(() => acquire(proxy));
				reason(result.value, "STORE_CLOSED");
				readOnly(result.evidence, 0);
				await closing;
				check(ownerClosed, "capture actually closed owner");
			}
		} else {
			const mutable = { objectId: OBJECT, limits: { ...LIMITS } };
			const acquired = await observe(async () => {
				const job = acquire(mutable);
				mutable.objectId = OTHER;
				mutable.limits.maxUnionBytes = 262145 as 262144;
				return job;
			});
			const reader = must(acquired.value);
			readers.add(reader);
			assertWhole(reader, await env.image(), acquired.evidence);
			if (name === "whole-view" || name === "no-head-capture") {
				for (const ancestorCount of [0, 2] as const) {
					if (name === "no-head-capture" && ancestorCount === 2) continue;
					const old = await observe(() => store.acquireBoundedActiveRead({ ...input(), ancestorCount }));
					if (name === "no-head-capture")
						check(old.value.ok && old.value.value.kind === "empty", "old no-head remains empty");
					else {
						const a = must(old.value);
						check(a.kind === "present", "old present control");
						check(
							stable(a.reader.generations.map((g) => g.generationId)) ===
								stable(ancestorCount === 0 ? [id(3)] : [id(3), id(2), id(1)]),
							"old exact 0/2 lineage unchanged"
						);
						check(
							!a.reader.blobs.some((b) => [ref(payload(4)).digest, ref(payload(5)).digest].includes(b.ref.digest)),
							"old never gets Complete-only blobs"
						);
						await a.reader.release();
					}
				}
			}
			if (name.startsWith("currency-")) {
				const originalHead = stable(reader.head);
				const old = must(await store.acquireBoundedActiveRead({ ...input(), ancestorCount: 0 }));
				check(old.kind === "present", "old pre-mutation reader");
				if (name === "currency-add") {
					const g = generation(await env.image(), 6);
					await env.edit({
						kind: "generation",
						generationId: id(7),
						record: encodeGenerationRecordV1({ ...g, generationId: id(7) }),
						insert: true,
					});
				}
				if (name === "currency-remove") await env.edit({ kind: "delete-generation", generationId: id(5) });
				if (name === "currency-staged-state") await change(env, 6, { state: "Discarded" });
				if (name === "currency-candidate-state") await change(env, 5, { state: "Discarded" });
				if (name === "currency-metadata")
					await change(env, 6, { baseExpectedHead: { kind: "none", objectId: OBJECT } });
				if (name === "currency-refs") {
					const bytes = payload(66),
						reference = ref(bytes),
						closure = [reference];
					await env.edit({ kind: "blob", digest: reference.digest, bytes, insert: true });
					await env.edit({ kind: "promotion", generationId: id(5), digest: reference.digest, add: true });
					await change(env, 5, { closure, closureDigest: must(digestClosure(closure)) });
				}
				if (name === "currency-head-advance") {
					const g = generation(await env.image(), 5);
					check(reader.head.kind === "present", "head advance baseline");
					await change(env, 3, { state: "Superseded" });
					await change(env, 5, { state: "Adopted" });
					await env.edit({
						kind: "head",
						record: encodeHeadRecordV1({
							...reader.head,
							generationId: id(5),
							closureDigest: g.closureDigest,
							revision: (reader.head.revision + 1) as typeof reader.head.revision,
						}),
					});
				}
				if (name === "currency-head-remove") {
					await change(env, 3, { state: "Superseded" });
					await env.edit({ kind: "head", record: null });
				}
				const currencyFailures: Partial<Record<RoleCase, string>> = {
					"currency-promotion-missing": "ADOPTED_BLOB_UNPROMOTED",
					"currency-blob-missing": "ADOPTED_BLOB_MISSING",
					"currency-blob-corrupt": "ADOPTED_BLOB_CORRUPT",
					"currency-budget": "READ_BUDGET_EXCEEDED",
				};
				if (currencyFailures[name]) {
					// Also change valid early metadata. A stale-by-first-difference shortcut
					// must not mask the later genuine integrity/resource result.
					await change(env, 6, { state: "Discarded" });
					const g = generation(await env.image(), 5),
						reference = g.closure.find((r) => r.digest !== ref(payload(90)).digest);
					check(reference, "actual nonactive failure target");
					if (name === "currency-promotion-missing")
						await env.edit({ kind: "promotion", generationId: id(5), digest: reference.digest });
					if (name === "currency-blob-missing") await env.edit({ kind: "blob", digest: reference.digest, bytes: null });
					if (name === "currency-blob-corrupt")
						await env.edit({ kind: "blob", digest: reference.digest, bytes: payload(77, reference.byteLength) });
					if (name === "currency-budget") {
						const source = generation(await env.image(), 7);
						await env.edit({
							kind: "generation",
							generationId: id(8),
							record: encodeGenerationRecordV1({ ...source, generationId: id(8) }),
							insert: true,
						});
					}
				}
				if (!["currency-head-advance", "currency-head-remove"].includes(name))
					check(stable(nativeHead(await env.image())) === originalHead, "genuine same-head valid mutation");
				const freshImage = await env.image(),
					result = await observe(() => reader.checkCurrency());
				const expectedFailure = currencyFailures[name];
				if (expectedFailure) {
					reason(result.value, expectedFailure);
					if (name === "currency-budget")
						check((await store.readHead(OTHER)).ok, "currency resource refusal nonpoisoning");
					else reason(await store.readHead(OTHER), "STORE_POISONED");
				} else if (name === "currency-current") {
					check(result.value.ok && result.value.value.kind === "current", "full unchanged currency current");
					assertWhole(reader, freshImage, result.evidence);
				} else {
					reason(result.value, "READ_STALE_ROLE_VIEW");
					assertRecapture(freshImage, result.evidence);
					await take();
					check((await store.readHead(OTHER)).ok, "valid stale nonpoisoning");
				}
				if (!currencyFailures[name] && !["currency-head-advance", "currency-head-remove"].includes(name)) {
					const checked = await observe(() => old.reader.checkCurrent());
					check(
						checked.value.ok && checked.evidence.reads.every((r) => ["objects", "other"].includes(r.table)),
						"held old reader stays current and head-only after same-head mutation"
					);
				}
				await old.reader.release();
			}
			if (name.startsWith("baseline-")) {
				let blob = reader.blobs[0];
				check(blob, "baseline blob present");
				let mutated = false,
					seen = 0;
				const mutate = (): void => {
					blob.bytes.fill(255);
					mutated = true;
				};
				if (name === "baseline-altered") mutate();
				if (name === "baseline-detached") {
					structuredClone(blob.bytes.buffer, { transfer: [blob.bytes.buffer as ArrayBuffer] });
					mutated = true;
					check(blob.bytes.byteLength === 0, "genuine transferred detached carrier");
				}
				const result = await observe(
					() => reader.checkCurrency(),
					(edge) => {
						if (name === "baseline-terminal" && edge === "terminal") mutate();
					},
					(edge, table, operation, _interrupt, key) => {
						if (name === "baseline-late-idb" && edge === "success" && table === "blobs" && operation === "get") {
							seen++;
							if (seen === 1) {
								const found = reader.blobs.find((entry) => entry.ref.digest === key);
								check(found, "first genuine native comparison bound to matching borrowed baseline");
								blob = found;
							}
							if (seen === 2) {
								check(key !== blob.ref.digest, "later genuine request after first baseline comparison");
								mutate();
							}
						}
					}
				);
				check(mutated, "actual synchronous borrowed mutation edge reached");
				reason(result.value, "READ_STALE_ROLE_VIEW");
				check((await store.readHead(OTHER)).ok, "caller baseline corruption never poisons");
				await take();
				if (name === "baseline-terminal") await accessorGuard("mutate");
			}
			if (
				[
					"coalesced",
					"release-before-admission",
					"release-start",
					"release-terminal",
					"close-start",
					"close-queued-idb",
					"native-failure",
					"corruption-release",
				].includes(name)
			) {
				let join: Promise<void> | undefined,
					concurrent: Promise<Result<{ kind: "current" }>> | undefined,
					newAfterRelease: Promise<Result<{ kind: "current" }>> | undefined,
					interrupted = false;
				if (name === "corruption-release") {
					const target = generation(await env.image(), 5).closure[0];
					check(target, "actual required candidate promotion");
					await env.edit({
						kind: "promotion",
						generationId: id(5),
						digest: target.digest,
					});
				}
				const second =
					name === "close-queued-idb" || (name === "release-before-admission" && env.backend === "idb")
						? await take()
						: undefined;
				const lifecycle = await observe(
					async () => {
						const blocker = name === "release-before-admission" && second ? second.checkCurrency() : undefined;
						if (name === "release-before-admission" && env.backend === "sqlite") join = reader.release();
						const first = reader.checkCurrency();
						if (name === "coalesced") concurrent ??= reader.checkCurrency();
						if (name === "release-before-admission") {
							custody.push("release-request");
							join = reader.release().then(() => {
								custody.push("join-settled");
							});
						}
						if (second && name === "close-queued-idb") concurrent = second.checkCurrency();
						const result = await first;
						custody.push("verdict");
						const later = concurrent ? await concurrent : undefined;
						const blocked = await blocker;
						await join;
						return { result, later, blocked };
					},
					(edge) => {
						custody.push("native-" + edge);
						if (edge === "start" && name === "coalesced" && env.backend === "sqlite")
							concurrent ??= reader.checkCurrency();
						if (
							(edge === "start" && ["release-start", "close-start"].includes(name)) ||
							(edge === "terminal" && ["release-terminal", "native-failure", "corruption-release"].includes(name))
						) {
							join ??= (name === "close-start" ? close() : reader.release()).then(() => {
								custody.push("join-settled");
							});
							if (name.startsWith("release-")) newAfterRelease ??= reader.checkCurrency();
						}
					},
					(edge, table, operation, interrupt, key) => {
						const actualSql =
							env.backend !== "sqlite" ||
							(key !== null && typeof key === "object" && /\bAS bytes\b/iu.test(String(Reflect.get(key, "sql"))));
						if (
							edge === "request" &&
							table === "blobs" &&
							operation === "get" &&
							actualSql &&
							name === "native-failure" &&
							!interrupted
						) {
							interrupted = true;
							custody.push("real-native-interrupt");
							interrupt();
						}
						if (edge === "success" && table === "objects" && name === "close-queued-idb")
							join ??= close().then(() => {
								custody.push("join-settled");
							});
					}
				);
				if (name === "coalesced") {
					check(lifecycle.value.result.ok && lifecycle.value.later?.ok, "coalesced current outcomes");
					readOnly(lifecycle.evidence, 1);
					check(actualBlobGets(lifecycle.evidence).length === reader.blobs.length, "one full recapture not two unions");
					const later = await observe(() => reader.checkCurrency());
					check(later.value.ok, "subsequent check reobserves");
					readOnly(later.evidence, 1);
				} else if (name === "native-failure") {
					check(interrupted, "actual native request edge interrupted");
					reason(lifecycle.value.result, "SUBSTRATE_FAILURE");
					check(
						!lifecycle.value.result.ok && lifecycle.value.result.cause !== undefined,
						"real native cause retained after release"
					);
					check(
						stable(lifecycle.evidence.terminalKinds) === stable([env.backend === "sqlite" ? "ROLLBACK" : "abort"]),
						"actual SQL exception ROLLBACK / IDB abort terminal"
					);
				} else if (name === "corruption-release") reason(lifecycle.value.result, "ADOPTED_BLOB_UNPROMOTED");
				else if (name === "close-start" || name === "close-queued-idb") {
					check(lifecycle.value.result.ok, "genuinely executing close drains under native law");
					if (second) {
						check(lifecycle.value.later, "queued second reader outcome");
						reason(lifecycle.value.later, "STORE_CLOSED");
						readOnly(lifecycle.evidence, 1);
					}
				} else {
					reason(lifecycle.value.result, "READ_RELEASED");
					if (name === "release-before-admission") {
						readOnly(lifecycle.evidence, env.backend === "idb" ? 1 : 0);
						if (env.backend === "idb")
							check(
								lifecycle.value.blocked?.ok && actualBlobGets(lifecycle.evidence).length === reader.blobs.length,
								"real other-reader turn drains; released queued target starts zero new work"
							);
					}
				}
				if (join && lifecycle.evidence.modes.length)
					check(
						custody.indexOf("join-settled") > custody.lastIndexOf("native-terminal"),
						"release/close joined actual terminal"
					);
				if (newAfterRelease) reason(await newAfterRelease, "READ_RELEASED");
				if (name.startsWith("release-")) {
					const refused = await observe(() => reader.checkCurrency());
					reason(refused.value, "READ_RELEASED");
					readOnly(refused.evidence, 0);
				}
				if (name === "release-terminal" && env.backend === "sqlite") {
					const fresh = await take();
					const immediate = await observe(
						async () => {
							const job = fresh.checkCurrency();
							const join = fresh.release();
							custody.push("immediate-release-request");
							const joined = join.then(() => {
								custody.push("immediate-join-settled");
							});
							const result = await job;
							custody.push("immediate-verdict");
							await joined;
							return result;
						},
						(edge) => {
							custody.push("immediate-native-" + edge);
						}
					);
					reason(immediate.value, "READ_RELEASED");
					assertRecapture(await env.image(), immediate.evidence);
					check(
						stable(immediate.evidence.terminalKinds) === stable(["COMMIT"]),
						"immediate real native success terminal"
					);
					check(
						custody.indexOf("immediate-native-terminal") < custody.indexOf("immediate-release-request") &&
							custody.indexOf("immediate-release-request") < custody.indexOf("immediate-verdict") &&
							custody.indexOf("immediate-join-settled") > custody.indexOf("immediate-native-terminal"),
						"immediate caller release after synchronous native return joins terminal before public verdict"
					);
					const refused = await observe(() => fresh.checkCurrency());
					reason(refused.value, "READ_RELEASED");
					readOnly(refused.evidence, 0);
				}
			}
			if (name === "release-terminal") await accessorGuard("release");
			if (name === "release-independent") {
				const second = await take();
				await reader.release();
				await reader.release();
				const result = await observe(() => reader.checkCurrency());
				reason(result.value, "READ_RELEASED");
				readOnly(result.evidence, 0);
				check(
					(await second.checkCurrency()).ok && (await store.readHead(OBJECT)).ok,
					"independent reader and borrowed owner survive release"
				);
			}
			if (name === "close-before") {
				await close();
				const result = await observe(() => reader.checkCurrency());
				reason(result.value, "STORE_CLOSED");
				readOnly(result.evidence, 0);
				const next = await observe(() => acquire());
				reason(next.value, "STORE_CLOSED");
				readOnly(next.evidence, 0);
			}
			if (name === "no-certificate") {
				const result = await env.observe(() => store.completeGeneration({ objectId: OBJECT, generationId: id(3) }));
				proof.certificateMutationProbe = result;
				check(
					result.evidence.reads.some(isGenerationScan),
					"readonly role acquisition installs no mutation certificate"
				);
			}
			if (name === "preserve-certificate") {
				must(await store.recoverActiveGeneration(OBJECT));
				await change(env, 6, { state: "Discarded" });
				reason((await observe(() => reader.checkCurrency())).value, "READ_STALE_ROLE_VIEW");
				const producer = await env.open();
				try {
					await stage(producer, 8, reader.head, [payload(8)], false);
				} finally {
					await producer.close();
				}
				reason((await observe(() => acquire())).value, "READ_BUDGET_EXCEEDED");
				const result = await env.observe(() => store.completeGeneration({ objectId: OBJECT, generationId: id(3) }));
				proof.certificateMutationProbe = result;
				check(
					!result.evidence.reads.some(isGenerationScan),
					"valid stale/resource refusal clears no existing certificate"
				);
			}
		}
		return { case: name, passed: true, downstreamExecuted: true, proof, traces, custody };
	} catch (error) {
		return {
			case: name,
			passed: false,
			downstreamExecuted: true,
			proof,
			traces,
			custody,
			failure: error instanceof Error ? error.stack : String(error),
		};
	} finally {
		for (const reader of readers) await reader.release();
		await store.close();
	}
}
