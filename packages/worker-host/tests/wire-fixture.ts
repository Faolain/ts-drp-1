/* eslint-disable jsdoc/require-jsdoc */
import { expect } from "vitest";

export type Listener = (event: Readonly<{ data?: unknown }>) => void;

/** Already-constructed endpoint double; it deliberately owns no host behavior. */
export class EndpointDouble {
	readonly listeners = new Map<string, Set<Listener>>();
	readonly posted: unknown[] = [];
	readonly transfers: readonly Transferable[][] = [];
	terminateCalls = 0;

	addEventListener(type: string, listener: Listener): void {
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
		this.posted.push(structuredClone(message));
		(this.transfers as Transferable[][]).push([...transfer]);
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	emit(type: "error" | "message" | "messageerror", data?: unknown): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data });
	}
}

export const PROTOCOL = "ts-drp/worker-host";
export const VERSION = 1;

export function ready(accepts: readonly string[] = ["echo"]): Record<string, unknown> {
	return { protocol: PROTOCOL, version: VERSION, kind: "ready", accepts };
}

export function chunk(id: string, sequence: number, payload: Uint8Array): Record<string, unknown> {
	return { protocol: PROTOCOL, version: VERSION, kind: "chunk", id, sequence, payload };
}

export function terminal(
	id: string,
	kind: "cancelled" | "done",
	chunks: number,
	bytes: number
): Record<string, unknown> {
	return { protocol: PROTOCOL, version: VERSION, kind, id, chunks, bytes };
}

export async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of stream) values.push(value);
	return values;
}

export async function rejected(operation: Promise<unknown>, code: string): Promise<unknown> {
	let failure: unknown;
	try {
		await operation;
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ code });
	return failure;
}

export async function turn(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
