const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");

export const DRP_ERROR_CODES = Object.freeze(["PROBE_ERROR"] as const);

export class DRPError extends Error {
	readonly [DRP_ERROR_BRAND] = true;

	constructor(readonly code: (typeof DRP_ERROR_CODES)[number]) {
		super(code);
	}
}

export function isDRPError(value: unknown): value is DRPError {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		return Reflect.get(value, DRP_ERROR_BRAND) === true;
	} catch {
		return false;
	}
}
