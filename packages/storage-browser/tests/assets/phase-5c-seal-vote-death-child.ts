import { chromium } from "@playwright/test";

interface DeathInput {
	readonly checkpoint: string;
	readonly databaseName: string;
	readonly origin: string;
	readonly profileDirectory: string;
}

const input = JSON.parse(process.argv[2] ?? "null") as DeathInput | null;
if (input === null) throw new TypeError("missing Phase 5c death-child input");

async function main(selected: DeathInput): Promise<never> {
	const context = await chromium.launchPersistentContext(selected.profileDirectory, { headless: true });
	const page = context.pages()[0] ?? (await context.newPage());
	page.on("console", (message) => {
		if (message.text().startsWith("PHASE5C_")) {
			process.stdout.write(`${message.text()}\n`);
		}
	});
	// tsx preserves nested function names through this helper when serializing init scripts.
	await page.addInitScript({ content: "globalThis.__name = (target) => target;" });
	await page.addInitScript((checkpoint) => {
		try {
			const voteStores = ["signerState", "storageMeta", "voteOutbox", "voteSlots"];
			let armed = false;
			const arm = (): void => {
				if (armed) return;
				armed = true;
				console.log(`PHASE5C_ARMED:${checkpoint}`);
				for (;;) {
					// The parent kills the persistent browser process group after observing the marker.
				}
			};
			const isVoteTransaction = (stores: DOMStringList): boolean =>
				Array.from(stores).join(",") === voteStores.join(",");
			const originalTransaction = IDBDatabase.prototype.transaction;
			Object.defineProperty(IDBDatabase.prototype, "transaction", {
				configurable: true,
				value: function (
					storeNames: string | string[],
					mode?: IDBTransactionMode,
					options?: IDBTransactionOptions
				): IDBTransaction {
					const names = typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
					if (checkpoint === "before-transaction" && mode === "readwrite" && names.join(",") === voteStores.join(",")) {
						arm();
					}
					const selected = originalTransaction.call(this, storeNames, mode, options);
					if (checkpoint === "after-complete" && isVoteTransaction(selected.objectStoreNames)) {
						selected.addEventListener("complete", arm, { once: true });
					}
					return selected;
				},
				writable: true,
			});
			const attach = (request: IDBRequest, selectedCheckpoint: string): IDBRequest => {
				if (checkpoint === selectedCheckpoint) request.addEventListener("success", arm, { once: true });
				return request;
			};
			const originalGet = IDBObjectStore.prototype.get;
			Object.defineProperty(IDBObjectStore.prototype, "get", {
				configurable: true,
				value: function (query: IDBValidKey | IDBKeyRange): IDBRequest {
					const selectedCheckpoint =
						this.name === "storageMeta"
							? "after-incarnation-read"
							: this.name === "signerState"
								? "after-state-read"
								: this.name === "voteSlots"
									? "after-slot-read"
									: "";
					return attach(originalGet.call(this, query), selectedCheckpoint);
				},
				writable: true,
			});
			const originalAdd = IDBObjectStore.prototype.add;
			Object.defineProperty(IDBObjectStore.prototype, "add", {
				configurable: true,
				value: function (value: unknown, key?: IDBValidKey): IDBRequest {
					const selectedCheckpoint =
						this.name === "voteSlots" ? "after-slot-add" : this.name === "voteOutbox" ? "after-outbox-add" : "";
					return attach(
						key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key),
						selectedCheckpoint
					);
				},
				writable: true,
			});
			const originalPut = IDBObjectStore.prototype.put;
			Object.defineProperty(IDBObjectStore.prototype, "put", {
				configurable: true,
				value: function (value: unknown, key?: IDBValidKey): IDBRequest {
					return attach(
						key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key),
						this.name === "signerState" ? "after-state-put" : ""
					);
				},
				writable: true,
			});
		} catch (error) {
			console.log(`PHASE5C_INSTRUMENT_ERROR:${error instanceof Error ? error.message : String(error)}`);
		}
	}, selected.checkpoint);
	await page.goto(selected.origin);
	await page.evaluate(
		([databaseName, checkpoint]) => window.phase5cSealVote.runDeathCheckpoint(databaseName, checkpoint),
		[selected.databaseName, selected.checkpoint] as const
	);
	throw new Error("death checkpoint unexpectedly returned");
}

void main(input).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
