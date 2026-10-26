import { encodeCanonical } from "@ts-drp/canonical";
import type { V3RoomAcceptedVertex, V3RoomRolloverBudget } from "@ts-drp/example-v3-room";

import { shippingChatSharesAllowanceBytes } from "./v3-chat-shares.js";

/**
 * When the shipped Chat's creator rolls its room over (the shared scheduling is
 * `createV3RoomRolloverPolicy` in examples/v3-room). Tests import this so they follow the
 * shipped choice.
 *
 * In the membership-aware format (v5) the shipped Chat signs into new rooms, Chat's own rule binds
 * long before the native one: each share holder may add its allowance (about 1,950 canonical
 * message bytes, sized for 16 holders) per checkpoint, which is 14 one-word messages and 4 of 280
 * characters (measured: the 15th one-word message is refused at admission). The native ceiling of
 * 40 own moves per epoch stays as a backstop count. The budget is half of each: the creator rolls
 * over once any author, itself or a Writer, has used half its allowance in the current epoch, so a
 * Writer that keeps typing while the rollover runs still has room. Messages are human-paced and a
 * new Writer can post only from the checkpoint after the admin's share update, so an epoch is
 * also closed 15 s after the last message.
 */
export const SHIPPING_CHAT_ROLLOVER_MOVES = 20;
export const SHIPPING_CHAT_ROLLOVER_IDLE_MS = 15_000;

const recordBytes = (author: string, operation: unknown): number => {
	if (operation === null || typeof operation !== "object") return 0;
	if (Reflect.get(operation, "action") !== "message") return 0;
	return encodeCanonical({
		author,
		clientOperationId: Reflect.get(operation, "clientOperationId") as string,
		displayTimeMs: Reflect.get(operation, "displayTimeMs") as number,
		text: Reflect.get(operation, "text") as string,
	}).byteLength;
};

/**
 * The bytes Chat's allowance charges for one accepted vertex: the canonical record of each message
 * it carries (a batch carries up to 16), nothing for a share update.
 * @param vertex - An accepted vertex.
 * @returns Its charge in canonical message bytes.
 */
export function shippingChatVertexCharge(vertex: Pick<V3RoomAcceptedVertex, "author" | "operation">): number {
	const operation = vertex.operation;
	if (operation.action !== "applicationBatch") return recordBytes(vertex.author, operation);
	const entries = Reflect.get(Reflect.get(operation, "batch") as object, "entries") as readonly unknown[];
	return entries.reduce<number>(
		(sum, entry) => sum + recordBytes(vertex.author, Reflect.get(entry as object, "operation")),
		0
	);
}

/**
 * The shipped Chat's rollover budget for one room.
 * @param input - The room's object id, and whether its genesis signed the shares format (v5).
 * Earlier formats have no per-checkpoint allowance and keep the move count only.
 * @returns The budget.
 */
export function shippingChatRolloverBudget(
	input: Readonly<{ objectId: string; shares: boolean }>
): V3RoomRolloverBudget {
	return Object.freeze({
		movesPerAuthor: SHIPPING_CHAT_ROLLOVER_MOVES,
		idleMs: SHIPPING_CHAT_ROLLOVER_IDLE_MS,
		...(input.shares
			? {
					weight: Object.freeze({
						perAuthor: Math.floor(shippingChatSharesAllowanceBytes(input.objectId) / 2),
						of: shippingChatVertexCharge,
					}),
				}
			: {}),
	});
}

/**
 * Chat's admission refuses a message over its author's allowance before issuance; a later
 * checkpoint renews the allowance, so the same message is offered again after a rollover. The
 * native refusal carries no reason, so every admission refusal counts: a page-built message is
 * otherwise valid, and the policy offers a move a bounded number of times before it surfaces.
 * @param error - The refusal.
 * @returns Whether a rollover clears it.
 */
export function shippingChatRefusalClearedByRollover(error: unknown): boolean {
	return error instanceof Error && error.message.includes("admission-rejected");
}
