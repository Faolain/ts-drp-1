export interface Observation {
	phase: string;
	kind: "raw" | "gate" | "copy" | "owned-allocation";
	bytes: number;
	directRaw: boolean;
	fromRaw: boolean;
	stack: string;
}
export interface Observer {
	instrument: boolean;
	events: Observation[];
	begin(phase: string, raw?: Uint8Array): void;
	raw(value: unknown): void;
	restore(): void;
}

/**
 * Observe native intrinsic delegation without replacing product functions/results.
 * @param instrument - Install isolated hooks, or keep globals entirely unchanged.
 * @returns Phase-scoped raw identity, real getter/copy observations and restoration.
 */
export function observe(instrument: boolean): Observer {
	const apply = Reflect.apply;
	const NativeBytes = Uint8Array;
	const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(NativeBytes.prototype), "byteLength")?.get;
	const set = NativeBytes.prototype.set;
	const idbGet = typeof IDBObjectStore === "undefined" ? undefined : IDBObjectStore.prototype.get;
	const events: Observation[] = [];
	let phase = "setup",
		raw: Uint8Array | undefined;
	let lineage = new WeakMap<object, Uint8Array>();
	const active = (): boolean => /^(?:direct|native)-/.test(phase);
	const sourceRoot = (value: unknown): Uint8Array | undefined =>
		value === raw ? raw : value !== null && typeof value === "object" ? lineage.get(value) : undefined;
	const recordRaw = (value: unknown): void => {
		if (instrument && active() && value instanceof NativeBytes) {
			raw = value;
			events.push({
				phase,
				kind: "raw",
				bytes: value.byteLength,
				directRaw: true,
				fromRaw: true,
				stack: new Error("actual native raw carrier").stack ?? "",
			});
		}
	};
	if (instrument) {
		if (!byteLength) throw new Error("native typed-array getter unavailable");
		Reflect.apply = new Proxy(apply, {
			apply(nativeApply, callReceiver, callArgs): unknown {
				const result: unknown = apply(nativeApply, callReceiver, callArgs);
				const [target, receiver, args] = callArgs as [Parameters<typeof apply>[0], unknown, ArrayLike<unknown>];
				if (active() && (target === byteLength || target === set)) {
					const stack = new Error("delegated native manifest operation").stack ?? "";
					if (target === set) {
						const source = args[0],
							root = sourceRoot(source);
						if (root && receiver !== null && typeof receiver === "object") lineage.set(receiver, root);
						if (/copyExactCarrier|exactBytes|captureDeclaration/.test(stack))
							events.push({
								phase,
								kind: "copy",
								bytes: source instanceof NativeBytes ? source.byteLength : -1,
								directRaw: source === raw,
								fromRaw: root !== undefined && root === raw,
								stack,
							});
					} else if (/decodeSnapshotManifest/.test(stack) && !/copyExactCarrier|decodeCanonical/.test(stack)) {
						events.push({
							phase,
							kind: "gate",
							bytes: result as number,
							directRaw: receiver === raw,
							fromRaw: sourceRoot(receiver) !== undefined && sourceRoot(receiver) === raw,
							stack,
						});
					}
				}
				return result;
			},
		});
		globalThis.Uint8Array = new Proxy(NativeBytes, {
			construct(target, args, newTarget): Uint8Array {
				if (active() && typeof args[0] === "number") {
					const stack = new Error("protocol owned allocation").stack ?? "";
					if (/copyExactCarrier/.test(stack))
						events.push({ phase, kind: "owned-allocation", bytes: args[0], directRaw: false, fromRaw: false, stack });
				}
				return Reflect.construct(target, args, newTarget) as Uint8Array;
			},
		});
		if (idbGet)
			IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
				const request = apply(idbGet, this, [query]) as IDBRequest;
				request.addEventListener(
					"success",
					() => {
						const result = request.result as unknown;
						if (result !== null && typeof result === "object")
							recordRaw(Reflect.get(result, "exactCanonicalManifestBytes"));
					},
					{ once: true }
				);
				return request;
			};
	}
	return {
		instrument,
		events,
		begin: (next, value): void => {
			phase = next;
			raw = value;
			lineage = new WeakMap();
		},
		raw: recordRaw,
		restore: (): void => {
			if (instrument) {
				Reflect.apply = apply;
				globalThis.Uint8Array = NativeBytes;
				if (idbGet) IDBObjectStore.prototype.get = idbGet;
			}
		},
	};
}
