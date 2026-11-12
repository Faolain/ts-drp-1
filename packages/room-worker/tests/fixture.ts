import { call, defineRoomWorkerContract, errorCodec, latest, type RoomWorkerPort, send } from "@ts-drp/room-worker";
import { createRoomWorkerClient, type RoomWorkerClientOptions } from "@ts-drp/room-worker/page";
import { createRoomWorkerServer, defineRoomWorkerApp, type RoomWorkerContext } from "@ts-drp/room-worker/worker";

/**
 *
 */
export class FieldError extends Error {
	/**
	 *
	 * @param epoch
	 */
	constructor(readonly epoch: number) {
		super(`field error at ${epoch}`);
		this.name = "FieldError";
	}
}

export const codecs = [errorCodec("FieldError", FieldError)];

export const contract = defineRoomWorkerContract({
	name: "test-room",
	version: 1,
	commands: {
		"echo": call(),
		"fail": call(),
		"emitThenReturn": call(),
		"hold": call(),
		"useHook": call(),
		"abortHook": call(),
		"storage": call(),
		"nested.ping": call(),
		"move": send((dx: unknown, dy: unknown) => {
			if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new TypeError("move is not an integer step");
		}),
		"refuse": send(),
	},
	streams: { projection: latest(), transient: latest() },
	hooks: ["authority", "approve"],
});

export interface TestCommands {
	echo(value: unknown): Promise<unknown>;
	fail(epoch: number): Promise<never>;
	emitThenReturn(value: number): Promise<number>;
	hold(): Promise<string>;
	useHook(): Promise<unknown>;
	abortHook(): Promise<unknown>;
	storage(key: string, value: string): Promise<string | null>;
	"nested.ping"(): Promise<string>;
	move(dx: number, dy: number): void;
	refuse(epoch: number): void;
	[name: string]: (...args: never[]) => unknown;
}

export interface Harness {
	readonly client: ReturnType<typeof createRoomWorkerClient<TestCommands>>;
	readonly log: unknown[];
	readonly frames: (() => void)[];
	flushFrames(): void;
	releaseHold(value: string): void;
	readonly closed: { count: number };
	readonly page: MessagePort;
	readonly worker: MessagePort;
	context(): RoomWorkerContext;
	pageAbortSignals: AbortSignal[];
}

function asPort(port: MessagePort): RoomWorkerPort {
	port.start();
	return port as unknown as RoomWorkerPort;
}

/**
 * A page client and a worker server joined by a MessageChannel, around a scripted app.
 * @param options
 * @param serverOptions
 * @param serverOptions.version
 */
export function harness(
	options: Partial<RoomWorkerClientOptions<TestCommands>> = {},
	serverOptions: { version?: number } = {}
): Harness {
	const channel = new MessageChannel();
	const log: unknown[] = [];
	const frames: (() => void)[] = [];
	const closed = { count: 0 };
	let release: ((value: string) => void) | undefined;
	let captured: RoomWorkerContext | undefined;
	const pageAbortSignals: AbortSignal[] = [];
	const app = defineRoomWorkerApp({
		contract: serverOptions.version === undefined ? contract : { ...contract, version: serverOptions.version },
		open(context) {
			captured = context;
			log.push(["open", context.init]);
			return {
				info: { opened: true },
				commands: {
					"echo": (value: unknown): unknown => value,
					"fail": (epoch: number): never => {
						throw new FieldError(epoch);
					},
					"emitThenReturn": (value: number): number => {
						for (let index = 1; index <= value; index++) context.emit("projection", { value: index });
						return value;
					},
					"hold": (): Promise<string> =>
						new Promise<string>((resolve) => {
							release = resolve;
						}),
					"useHook": async (): Promise<unknown> => {
						const authority = context.hook("authority");
						if (authority === undefined) return "no hook";
						const handle = (await authority({ objectId: "o1" })) as {
							scope: string;
							bytes: Uint8Array;
							read(n: number): Promise<number>;
						};
						const doubled = await handle.read(21);
						let refused: unknown;
						try {
							await (handle as unknown as { secret(): Promise<unknown> }).secret?.();
							refused = "secret absent";
						} catch (error) {
							refused = error;
						}
						return { scope: handle.scope, bytes: Array.from(handle.bytes), doubled, refused: String(refused) };
					},
					"abortHook": async (): Promise<string> => {
						const approve = context.hook("approve");
						if (approve === undefined) throw new Error("no approve hook");
						const controller = new AbortController();
						const pending = approve({ digest: new Uint8Array([9]), cancellationSignal: controller.signal });
						controller.abort(new Error("cancelled by the room"));
						try {
							await pending;
							return "settled";
						} catch (error) {
							return (error as Error).message;
						}
					},
					"storage": (key: string, value: string): string | null => {
						const before = context.storage.getItem(key);
						context.storage.setItem(`${key}-written`, value);
						return before;
					},
					"nested.ping": (): string => "pong",
					"move": (dx: number, dy: number): void => {
						log.push(["move", dx, dy]);
					},
					"refuse": (epoch: number): never => {
						throw new FieldError(epoch);
					},
				},
				close: (): Promise<void> => {
					closed.count++;
					log.push(["close"]);
					return Promise.resolve();
				},
			};
		},
	});
	createRoomWorkerServer({ port: asPort(channel.port2), app, errors: codecs });
	const client = createRoomWorkerClient<TestCommands>({
		contract,
		port: asPort(channel.port1),
		init: { room: "r1" },
		errors: codecs,
		frame: (callback) => {
			frames.push(callback);
		},
		hooks: {
			authority: (context: unknown): Promise<unknown> =>
				Promise.resolve({
					scope: `scope:${(context as { objectId: string }).objectId}`,
					bytes: new Uint8Array([1, 2, 3]),
					read: (n: number): Promise<number> => Promise.resolve(n * 2),
				}),
			approve: (request: unknown): Promise<never> => {
				pageAbortSignals.push((request as { cancellationSignal: AbortSignal }).cancellationSignal);
				return new Promise(() => undefined);
			},
		},
		...options,
	});
	return {
		client,
		log,
		frames,
		flushFrames: (): void => {
			for (const callback of frames.splice(0)) callback();
		},
		releaseHold: (value) => release?.(value),
		closed,
		page: channel.port1,
		worker: channel.port2,
		context: (): RoomWorkerContext => {
			if (captured === undefined) throw new Error("not open");
			return captured;
		},
		pageAbortSignals,
	};
}

/**
 *
 * @param turns
 */
export const settle = async (turns = 8): Promise<void> => {
	for (let index = 0; index < turns; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};
