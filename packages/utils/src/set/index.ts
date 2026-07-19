/**
 * Set-compatible collection retained for API compatibility.
 *
 * Native Set owns membership and iteration semantics so this type remains
 * substitutable for Set across every supported key type.
 * @template T - The type of the set
 */
export class ObjectSet<T> extends Set<T> {
	/**
	 * @returns The string representation of the Set.
	 */
	override toString(): string {
		return `[object ObjectSet]`;
	}

	/**
	 * @returns The string tag of the Set.
	 */
	get [Symbol.toStringTag](): string {
		return "ObjectSet";
	}
}
