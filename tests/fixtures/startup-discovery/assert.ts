/**
 * Require a fixture precondition without substituting a runtime value.
 * @param value Actual observed value.
 * @param detail Precondition identity.
 * @returns The unchanged value.
 */
export function requireValue<T>(value: T | null | undefined, detail: string): T {
	if (value === null || value === undefined) throw new Error(detail);
	return value;
}
