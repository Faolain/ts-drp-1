import { encodeCanonical } from "@ts-drp/canonical";

// Keep complete operation/input bounds distinct from output/retained-state bounds.
export const SHIPPING_CHAT_OPERATION_LIMITS = Object.freeze({ maxBytes: 65_536, maxDepth: 16, maxItems: 16_384 });
export const SHIPPING_CHAT_STATE_LIMITS = Object.freeze({ maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });

export interface ShippingChatMessage {
	readonly author: string;
	readonly clientOperationId: string;
	readonly displayTimeMs: number;
	readonly text: string;
}
export interface ShippingChatMessageOperation {
	readonly action: "message";
	readonly clientOperationId: string;
	readonly displayTimeMs: number;
	readonly text: string;
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("shipping chat record is invalid");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError("shipping chat record is invalid");
	const actual = Reflect.ownKeys(value);
	if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)))
		throw new TypeError("shipping chat record is invalid");
	const captured: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
			throw new TypeError("shipping chat record is invalid");
		captured[key] = descriptor.value;
	}
	return captured;
}
function authorId(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
		throw new TypeError("shipping chat author is invalid");
	return value;
}
function captureMessage(value: unknown): ShippingChatMessage {
	const row = closedRecord(value, ["author", "clientOperationId", "displayTimeMs", "text"]);
	const author = authorId(row.author);
	if (
		typeof row.clientOperationId !== "string" ||
		!/^[A-Za-z0-9._:-]{1,128}$/u.test(row.clientOperationId) ||
		typeof row.displayTimeMs !== "number" ||
		!Number.isSafeInteger(row.displayTimeMs) ||
		row.displayTimeMs < 0 ||
		typeof row.text !== "string" ||
		row.text.length === 0
	)
		throw new TypeError("shipping chat message is invalid");
	const message = Object.freeze({
		author,
		clientOperationId: row.clientOperationId,
		displayTimeMs: row.displayTimeMs === 0 ? 0 : row.displayTimeMs,
		text: row.text,
	});
	// Complete UTF-8/framing/metadata charge, including retained collection framing.
	encodeCanonical([message], SHIPPING_CHAT_STATE_LIMITS);
	return message;
}

/**
 * Captures one immutable send; the caller reuses this value for a retry.
 * @param value - Untrusted command fields.
 * @param authenticatedAuthor - Native owner's authenticated command author.
 * @returns Detached signed-command fields without a caller-supplied sender.
 */
export function captureShippingChatOperation(
	value: unknown,
	authenticatedAuthor: string
): ShippingChatMessageOperation {
	const row = closedRecord(value, ["action", "clientOperationId", "displayTimeMs", "text"]);
	if (row.action !== "message") throw new TypeError("shipping chat action is invalid");
	const message = captureMessage({
		author: authenticatedAuthor,
		clientOperationId: row.clientOperationId,
		displayTimeMs: row.displayTimeMs,
		text: row.text,
	});
	const operation = Object.freeze({
		action: "message" as const,
		clientOperationId: message.clientOperationId,
		displayTimeMs: message.displayTimeMs,
		text: message.text,
	});
	encodeCanonical(operation, SHIPPING_CHAT_OPERATION_LIMITS);
	return operation;
}
