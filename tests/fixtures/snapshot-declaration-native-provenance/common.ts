import type { NativeHooks } from "./hooks.js";
import { encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";
import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import {
	decodeSnapshotManifest,
	encodeSnapshotTransfer,
} from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";
import type {
	SnapshotQuarantineScopeKey,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/src/snapshot-transfer.js";

export interface NativeEnvironment {
	backend: "sqlite" | "indexeddb";
	identity: string;
	open(): Promise<SnapshotRecoveryStore<SnapshotVerificationReceipt>>;
	image(): Promise<unknown>;
	row(key: SnapshotQuarantineScopeKey): Promise<Record<string, unknown>>;
	put(row: Record<string, unknown>): Promise<void>;
}

export const NATIVE_DATA_CASES = [
	"carrier",
	"utf8",
	"unsafe-total",
	"digest",
	"binding",
	"incarnation-byte-bound",
] as const;
export const SQLITE_DATA_CASES = ["json-syntax", "json-whitespace", "json-reordered", "json-nonstring"] as const;
const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
/**
 * Creates a genuine encoded declaration for native provenance controls.
 * @returns The encoded transfer and its matching declaration.
 */
export function fixture(): {
	encoded: ReturnType<typeof encodeSnapshotTransfer>;
	declaration: {
		scope: SnapshotQuarantineScopeKey;
		exactCanonicalManifestBytes: Uint8Array;
		chunks: ReturnType<typeof decodeSnapshotManifest>["chunks"];
		totalBytes: number;
	};
} {
	const encoded = encodeSnapshotTransfer({
		objectId: "native-provenance-valid",
		epoch: 1,
		schemaVersion: 1,
		anchor: "a".repeat(64),
		aclDigest: "b".repeat(64),
		stateDigest: "c".repeat(64),
		exactCanonicalPayloadBytes: encodeCanonical({ ready: true }),
		profile,
	});
	const decoded = decodeSnapshotManifest({
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		expectedManifestDigest: encoded.manifestDigest,
		profile,
	});
	return {
		encoded,
		declaration: {
			scope: {
				objectId: "native-provenance-valid",
				epoch: 1,
				anchor: "a".repeat(64),
				manifestDigest: encoded.manifestDigest,
			},
			exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
			chunks: decoded.chunks,
			totalBytes: encoded.chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0),
		},
	};
}
function fingerprint(bytes: Uint8Array): string {
	return Array.from(hashDomain("native-provenance-test-image", bytes), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

/**
 * Stable full-content durable image, including binary bytes and large integers.
 * @param value - Detached native read result.
 * @returns Comparable text.
 */
export function stable(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (typeof input === "bigint") return { bigint: input.toString() };
		if (input instanceof Uint8Array) return { bytes: Array.from(input) };
		if (input instanceof ArrayBuffer) return { bytes: Array.from(new Uint8Array(input)) };
		if (Array.isArray(input)) return input.map(normalize);
		if (input !== null && typeof input === "object")
			return Object.fromEntries(
				Object.keys(input)
					.sort()
					.map((key) => [key, normalize(Reflect.get(input, key))])
			);
		return input;
	};
	return JSON.stringify(normalize(value));
}

/**
 * Assert test-control predicates before returning any causal RED observation.
 * @param condition - Expected true predicate.
 * @param message - Failure context.
 */
export function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

/**
 * Follow actual causes without using them to remap a product failure.
 * @param error - Actual thrown value.
 * @param sentinel - Exact test sentinel identity.
 * @returns Finite diagnostic cause chain.
 */
export function chain(
	error: unknown,
	sentinel: unknown
): { code: string | null; message: string | null; isSentinel: boolean; name: string | null }[] {
	const result = [];
	for (let index = 0; index < 10 && error !== undefined; index++) {
		const object = error !== null && typeof error === "object" ? error : undefined;
		const field = (key: string): string | null =>
			object !== undefined && typeof Reflect.get(object, key) === "string"
				? (Reflect.get(object, key) as string)
				: null;
		result.push({
			code: field("code"),
			message: field("message"),
			name: field("name"),
			isSentinel: error === sentinel,
		});
		error = object === undefined ? undefined : Reflect.get(object, "cause");
	}
	return result;
}

/**
 * Run one actual native discovery call around a selected dependency failure.
 * @param env - Genuine native store and durable metadata access.
 * @param hooks - Pre-import test-only native processing controller.
 * @param historical - Exercise the existing one-argument retention closure instead of discovery failure mapping.
 * @returns Actual outcome plus reached-call and unchanged durable-image evidence.
 */
export async function runNativeFault(env: NativeEnvironment, hooks: NativeHooks, historical = false): Promise<unknown> {
	hooks.phase("setup");
	const { encoded, declaration } = fixture();
	const store = await env.open();
	try {
		check(
			typeof store.lookupRecoveryDeclaration === "function",
			"held source owner must expose real discovery; old dist absence is not RED"
		);
		const handle = await store.openScope(declaration);
		if (historical) {
			// Genuine receipt production is unarmed fixture setup only; no stream
			// failure or downstream fallback is being tested here.
			const stream = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: declaration.scope.manifestDigest,
				expectedScope: declaration.scope,
				profile,
				quarantine: handle.verificationQuarantine,
				source: {
					read: (descriptor) => {
						const bytes = encoded.chunks[descriptor.index];
						if (bytes === undefined) return Promise.reject(new Error("fixture chunk absent"));
						return Promise.resolve(bytes);
					},
				},
			});
			const receipt = await stream.receipt;
			await stream.completion;
			await handle.complete(receipt);
		}
		const row = await env.row(declaration.scope);
		hooks.metadata(row.incarnation, row.descriptors);
		hooks.phase("control");
		const control = await store.lookupRecoveryDeclaration(declaration.scope);
		check(control.kind === "present", "real no-fault discovery must return present");
		if (control.kind !== "present") throw new Error("missing no-fault declaration");
		check(stable(control.declaration) === stable(declaration), "real no-fault declaration bytes/descriptors match");
		if (historical) {
			hooks.phase("historical-control");
			await handle.retainForRecovery();
			check(
				hooks.events.some((event) => event.phase === "historical-control"),
				"actual one-argument native retention closure reached"
			);
		}
		check(
			hooks.events.some((event) => event.phase === "control"),
			"intended processing boundary reached in valid control"
		);
		hooks.phase("inspection");
		const image = stable(await env.image());
		const status = stable(await store.recoveryStatus());
		hooks.phase("fault", true);
		let failure: unknown;
		try {
			if (historical) await handle.retainForRecovery();
			else await store.lookupRecoveryDeclaration(declaration.scope);
		} catch (error) {
			failure = error;
		}
		hooks.phase("inspection");
		check(hooks.injections() === 1, "exactly one selected processing exception");
		check(stable(await env.image()) === image, "durable metadata/chunks/owner image unchanged after fault");
		check(stable(await store.recoveryStatus()) === status, "owner status unchanged after fault");
		hooks.phase("recovery");
		if (historical) {
			await handle.retainForRecovery();
			const retried = await store.lookupRecoveryDeclaration(declaration.scope);
			check(
				retried.kind === "present" && retried.retention === "recovery",
				"unarmed retry retains genuine verified recovery closure"
			);
		} else
			check(
				stable(await store.lookupRecoveryDeclaration(declaration.scope)) === stable(control),
				"unarmed native retry returns exact prior present result"
			);
		hooks.phase("inspection");
		check(stable(await env.image()) === image, "retry leaves durable image unchanged");
		const causes = chain(failure, hooks.sentinel);
		return {
			backend: env.backend,
			identity: env.identity,
			boundary: hooks.boundary,
			historical,
			controls: {
				present: true,
				exactDeclaration: true,
				durableUnchanged: true,
				statusUnchanged: true,
				retryPresent: true,
			},
			injections: hooks.injections(),
			events: hooks.events,
			observed: { code: causes[0]?.code ?? null, sentinelRetained: causes.some((cause) => cause.isSentinel), causes },
			imageFingerprint: fingerprint(new TextEncoder().encode(image)),
		};
	} finally {
		hooks.phase("setup");
		await store.close();
	}
}

/**
 * Preserve ordinary invalid-data and native JSON acceptance on durable rows.
 * @param env - Genuine native environment.
 * @param hooks - Unarmed native observer.
 * @param name - Exact deterministic metadata variant.
 * @returns Native classification and unchanged durable-record evidence.
 */
export async function runNativeData(env: NativeEnvironment, hooks: NativeHooks, name: string): Promise<unknown> {
	hooks.phase("setup");
	const { declaration } = fixture();
	const store = await env.open();
	try {
		await store.openScope(declaration);
		const initial = await store.lookupRecoveryDeclaration(declaration.scope);
		check(initial.kind === "present", "deterministic setup starts from genuine present row");
		const row = await env.row(declaration.scope);
		let key = declaration.scope;
		let expected = "poisoned";
		if (name === "carrier")
			row.exactCanonicalManifestBytes = env.backend === "sqlite" ? "not a blob" : new ArrayBuffer(2);
		else if (name === "utf8") {
			const bytes = Uint8Array.of(5, 1, 255);
			row.exactCanonicalManifestBytes = bytes;
			row.manifestDigest = Array.from(hashDomain("ts-drp/snapshot-manifest/v3", bytes), (byte) =>
				byte.toString(16).padStart(2, "0")
			).join("");
			key = { ...key, manifestDigest: row.manifestDigest as string };
		} else if (name === "unsafe-total") row.totalBytes = Number.MAX_SAFE_INTEGER + 1;
		else if (name === "digest") {
			const bytes = new Uint8Array(declaration.exactCanonicalManifestBytes);
			bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
			row.exactCanonicalManifestBytes = bytes;
		} else if (name === "binding") row.totalBytes = declaration.totalBytes + 1;
		else if (name === "incarnation-byte-bound") row.incarnation = "é".repeat(36);
		else if (name === "json-syntax") row.descriptors = "[";
		else if (name === "json-nonstring") row.descriptors = Uint8Array.of(91, 93);
		else if (name === "json-whitespace") {
			row.descriptors = " \n" + JSON.stringify(JSON.parse(row.descriptors as string), null, 2) + "\n ";
			expected = "present";
		} else if (name === "json-reordered") {
			row.descriptors = JSON.stringify(
				declaration.chunks.map((chunk) => ({ index: chunk.index, digest: chunk.digest, byteLength: chunk.byteLength }))
			);
			expected = "present";
		} else throw new Error("unknown deterministic native case");
		await env.put(row);
		hooks.metadata(row.incarnation, row.descriptors);
		const image = stable(await env.image());
		hooks.phase("deterministic:" + name);
		let failure: unknown;
		let returned: Awaited<ReturnType<typeof store.lookupRecoveryDeclaration>> | undefined;
		try {
			returned = await store.lookupRecoveryDeclaration(key);
		} catch (error) {
			failure = error;
		}
		hooks.phase("inspection");
		check(hooks.injections() === 0, "deterministic controls never throw synthetic values");
		check(stable(await env.image()) === image, "deterministic discovery leaves durable records unchanged");
		const causes = chain(failure, hooks.sentinel);
		if (returned?.kind === "present")
			check(
				stable(returned.declaration) === stable(declaration),
				"equivalent native JSON reconstructs exact original declaration"
			);
		if (name === "json-syntax")
			check(
				hooks.events.some(
					(event) => event.nativeSyntaxError === true && event.inputType === "string" && event.argumentCount === 1
				),
				"real native primitive-string/no-reviver JSON SyntaxError reached"
			);
		if (name === "json-nonstring")
			check(
				hooks.events.length === 0,
				"SQLite preflight rejects nontext before native JSON.parse; this does not exercise a JS string gate"
			);
		if (name === "utf8")
			check(
				causes.some((cause) => cause.message === "invalid UTF-8 string"),
				"digest-correct durable bad UTF8 reached actual canonical rejection"
			);
		return {
			backend: env.backend,
			identity: env.identity,
			deterministic: name,
			expected,
			observed: { code: returned?.kind ?? causes[0]?.code ?? null, causes },
			events: hooks.events,
			injections: 0,
			controls: { initialPresent: true, durableUnchanged: true, syntheticFaultsAbsent: true },
			imageFingerprint: fingerprint(new TextEncoder().encode(image)),
			...(name === "json-nonstring"
				? {
						limitation:
							"Genuine SQLite preflight prevents this stored nontext row reaching JSON.parse. JS primitive-string guard coverage remains a distinct reachability gap; no native bridge result is substituted.",
					}
				: {}),
		};
	} finally {
		hooks.phase("setup");
		await store.close();
	}
}
