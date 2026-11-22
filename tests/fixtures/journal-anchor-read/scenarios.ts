import { type AnchorCase, anchorMaterial, readAnchor, summarize } from "./material.js";

export interface NativeAccess {
	open(): Promise<unknown>;
	mutate(
		change:
			| "oversize"
			| "empty"
			| "non-byte"
			| "hash"
			| "scope"
			| "noncanonical"
			| "unrelated-carriers"
			| "replacement"
			| "delete"
	): Promise<void>;
	census(): Promise<unknown>;
	observe(
		call: () => Promise<unknown>,
		mode?: "failure" | "close-executing"
	): Promise<{ readonly result: unknown; readonly trace: readonly unknown[] }>;
}

/**
 * Exercises the same public accessor against real native owners, retaining masks explicitly.
 * @param native - Existing owner and genuine substrate controls.
 * @param id - One independent cause under the accepted seam.
 * @returns Native census, result and observation evidence with wiring masks preserved.
 */
export async function recoverAnchorCase(native: NativeAccess, id: AnchorCase): Promise<Record<string, unknown>> {
	const exact = anchorMaterial(id === "non-genesis" || id === "scope" ? 1 : 0);
	// Scope corruption is digest-consistent and exactly addressed: only the physical epoch disagrees.
	const material = id === "scope" ? { ...exact, scope: { ...exact.scope, epoch: 0 } } : exact;
	if (["oversize", "empty", "non-byte", "hash", "scope", "noncanonical", "unrelated-carriers"].includes(id)) {
		await native.mutate(id as Parameters<NativeAccess["mutate"]>[0]);
	}
	const before = await native.census();
	const owner = await native.open();
	const closer = owner as { close(): Promise<void> };
	const input = { maxBytes: 8192, scope: { ...material.scope } };
	// Results contain captured native observations only; never summarize transport wrappers again.
	let results: unknown[] = [];
	let traces: readonly unknown[] = [];
	let getterReads = 0;
	try {
		if (id === "neighbor-missing") input.scope.anchorDigest = "f".repeat(64);
		if (id === "smaller-budget") input.maxBytes = material.bytes.length - 1;
		if (id === "zero") input.maxBytes = 0;
		if (id === "close") {
			const first = closer.close();
			const second = closer.close();
			await Promise.all([first, second]);
			const hostile = Object.defineProperty({}, "scope", {
				enumerable: true,
				get(): never {
					getterReads++;
					throw new Error("must not capture closed owner");
				},
			});
			results = [summarize(await readAnchor(owner, hostile)), first === second];
		} else if (id === "invalid-input") {
			const accessor = Object.defineProperty({ maxBytes: 8192 }, "scope", {
				enumerable: true,
				get(): unknown {
					getterReads++;
					return material.scope;
				},
			});
			const bad = [-1, 0.5, NaN, Infinity, 8193, Number.MAX_SAFE_INTEGER + 1].map((maxBytes) => ({
				maxBytes,
				scope: material.scope,
			}));
			bad.push({ ...input, extra: true } as typeof input);
			const observed = await native.observe(async () =>
				Promise.all(
					[
						...bad,
						accessor,
						{ ...input, scope: { ...material.scope, epoch: -1 } },
						{ ...input, scope: { ...material.scope, anchorDigest: "A".repeat(64) } },
						{ ...input, [Symbol("extra")]: true },
					].map((value) => readAnchor(owner, value))
				)
			);
			results = (observed.result as unknown[]).map(summarize);
			traces = observed.trace;
		} else if (id === "capture-close") {
			let closeTask: Promise<void> | undefined;
			const sideEffect = new Proxy(input, {
				ownKeys(target): (string | symbol)[] {
					closeTask = closer.close();
					return Reflect.ownKeys(target);
				},
			});
			const observed = await native.observe(() => readAnchor(owner, sideEffect));
			results = [summarize(observed.result)];
			traces = observed.trace;
			await closeTask;
		} else if (id === "poison-close") {
			await native.mutate("hash");
			const poison = summarize(await readAnchor(owner, input));
			await closer.close();
			results = [poison, summarize(await readAnchor(owner, { malformed: true }))];
		} else if (id === "capture") {
			const task = readAnchor(owner, input);
			input.scope.anchorDigest = "f".repeat(64);
			input.maxBytes = 0;
			results = [
				summarize(await task),
				summarize(
					await readAnchor(
						owner,
						Object.assign(Object.create(null) as object, {
							maxBytes: 8192,
							scope: Object.assign(Object.create(null) as object, material.scope),
						})
					)
				),
			];
		} else if (id === "independent-session") {
			const second = await native.open();
			try {
				await closer.close();
				results = [summarize(await readAnchor(owner, input)), summarize(await readAnchor(second, input))];
			} finally {
				await (second as { close(): Promise<void> }).close();
			}
		} else if (id === "executing-close") {
			const task = readAnchor(owner, input);
			const closeTask = closer.close();
			results = [summarize(await task)];
			await closeTask;
			results.push(summarize(await readAnchor(owner, input)));
		} else {
			const observed = await native.observe(
				() => readAnchor(owner, input),
				id === "native-failure" ? "failure" : undefined
			);
			results = [summarize(observed.result)];
			traces = observed.trace;
			if (id === "genesis" || id === "non-genesis") {
				const present = observed.result as { exactCanonicalAnchorPreimageBytes?: Uint8Array };
				const detached = results[0];
				present.exactCanonicalAnchorPreimageBytes?.fill(99);
				results = [detached, summarize(await readAnchor(owner, input))];
			} else if (id === "smaller-budget" || id === "zero" || id === "oversize" || id === "native-failure") {
				results.push(
					summarize(
						await readAnchor(owner, { maxBytes: 0, scope: { ...material.scope, anchorDigest: "f".repeat(64) } })
					)
				);
				if (id !== "oversize")
					results.push(summarize(await readAnchor(owner, { maxBytes: 8192, scope: material.scope })));
			} else if (id === "replace-delete") {
				await native.mutate("delete");
				results.push(summarize(await readAnchor(owner, input)));
				await native.mutate("replacement");
				results.push(summarize(await readAnchor(owner, input)));
			}
		}
	} finally {
		await closer.close();
	}
	return {
		...(id === "scope" ? { requestedInput: { maxBytes: input.maxBytes, scope: { ...input.scope } } } : {}),
		before,
		after: await native.census(),
		expectedBytes: Array.from(material.bytes),
		expectedScope: material.scope,
		getterReads,
		results,
		traces,
	};
}
