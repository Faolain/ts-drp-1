import "fake-indexeddb/auto";

import { type AheDurableStore, createMemoryAheDurableStore } from "@ts-drp/storage";
import { IDBDatabase as FakeDatabase } from "fake-indexeddb";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { D109C_OBJECT, d109cInput } from "./fixtures/phase-6b/ahe-reclamation-contract.js";
import * as maintenanceNamespace from "../packages/storage/src/maintenance.js";
import { createBrowserAheDurableStore } from "../packages/storage-browser/src/index.js";
import { registerBrowserAheReclamationMaintenance } from "../packages/storage-browser/src/internal/ahe-reclamation.js";
import { resolveBrowserAheReclamationMaintenance } from "../packages/storage-browser/src/maintenance.js";
import { createSqliteAheDurableStore } from "../packages/storage-node/src/index.js";
import { registerNodeAheReclamationMaintenance } from "../packages/storage-node/src/internal/ahe-reclamation.js";
import { resolveNodeAheReclamationMaintenance } from "../packages/storage-node/src/maintenance.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = resolve(ROOT, "tests/fixtures/phase-6b-d110c-0c1f5b0z");
const DISCOVERY_REQUIRED = "F5B0Z_NEUTRAL_MAINTENANCE_DISCOVERY_REQUIRED";
const REFUSAL_REQUIRED = "F5B0Z_INCOMPATIBLE_REGISTRY_REFUSAL_REQUIRED";
const REGISTRY_KEY = Symbol.for("@ts-drp/storage/ahe-reclamation-maintenance-v1");
type Backend = "browser" | "sqlite";
type AheReclamationMaintenance = NonNullable<ReturnType<typeof resolveNodeAheReclamationMaintenance>>;
type Neutral = {
	bindAheReclamationMaintenance(store: AheDurableStore, maintenance: AheReclamationMaintenance): boolean;
	aheReclamationMaintenanceForStore(store: AheDurableStore): AheReclamationMaintenance | undefined;
};
// The existing namespace imports successfully in RED. This optional observation
// is not a backend-resolver fallback and never calls an absent function.
// Source and built package declarations have distinct nominal storage brands.
// This test observation uses the genuine backend resolver's type, not a cast
// that fabricates a positive capability or substitutes backend discovery.
const neutral = maintenanceNamespace as unknown as Partial<Neutral>;
type Opened = {
	backend: Backend;
	store: AheDurableStore;
	identity: string;
	legacy: AheReclamationMaintenance;
};

async function opened(backend: Backend): Promise<Opened> {
	const identity =
		backend === "browser"
			? `f5b0z-${randomUUID()}`
			: join(mkdtempSync(join(tmpdir(), "f5b0z-sqlite-")), "store.sqlite");
	const store =
		backend === "browser"
			? await createBrowserAheDurableStore({ databaseName: identity })
			: createSqliteAheDurableStore({ filename: identity });
	try {
		const legacy =
			backend === "browser"
				? resolveBrowserAheReclamationMaintenance(store)
				: resolveNodeAheReclamationMaintenance(store);
		expect(legacy).toBeDefined();
		if (legacy === undefined) throw new Error("GENUINE_BACKEND_PREMISE_MISSING");
		expect(await store.readHead(D109C_OBJECT)).toEqual({ ok: true, value: { kind: "none", objectId: D109C_OBJECT } });
		return { backend, store, identity, legacy };
	} catch (error) {
		await store.close();
		throw error;
	}
}

function discovered(owner: Opened): AheReclamationMaintenance {
	const capability = neutral.aheReclamationMaintenanceForStore?.(owner.store);
	if (capability !== owner.legacy) throw new Error(DISCOVERY_REQUIRED);
	return capability;
}

function binder(): Neutral["bindAheReclamationMaintenance"] {
	const bind = neutral.bindAheReclamationMaintenance;
	if (bind === undefined) throw new Error("F5B0Z_BINDER_CONTINUATION_MISSING");
	return bind;
}

async function withBoth(action: (browser: Opened, sqlite: Opened) => Promise<void> | void): Promise<void> {
	const browser = await opened("browser");
	try {
		const sqlite = await opened("sqlite");
		try {
			await action(browser, sqlite);
		} finally {
			await sqlite.store.close();
		}
	} finally {
		await browser.store.close();
	}
}

function expectDuplicate(action: () => void): void {
	let rejection: unknown;
	try {
		action();
	} catch (error) {
		rejection = error;
	}
	expect(rejection).toBeInstanceOf(TypeError);
	expect(Object.getPrototypeOf(rejection)).toBe(TypeError.prototype);
	expect((rejection as TypeError).message).toBe("AHE maintenance facade is already registered");
}

function child(mode: string): void {
	const before = Object.getOwnPropertyDescriptor(globalThis, REGISTRY_KEY);
	const result = spawnSync(process.execPath, [resolve(FIXTURES, "native-registry-child.mjs"), mode], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 8000,
	});
	expect(Object.getOwnPropertyDescriptor(globalThis, REGISTRY_KEY)).toEqual(before);
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).toBe(0);
	const report = JSON.parse(result.stdout) as { token: string | null; completed: boolean; evidence: unknown };
	console.info("F5B0Z_NATIVE_CHILD", JSON.stringify({ mode, stderr: result.stderr, ...report }));
	if (report.token !== null) {
		expect(report.token).toBe(mode === "duplicate" ? DISCOVERY_REQUIRED : REFUSAL_REQUIRED);
		throw new Error(report.token);
	}
	expect(report.completed).toBe(true);
}

function source(file: string): ts.SourceFile {
	return ts.createSourceFile(file, readFileSync(resolve(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
}

function statementName(node: ts.Statement, file: ts.SourceFile): string | undefined {
	if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText(file);
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isInterfaceDeclaration(node)
	)
		return node.name?.text;
	return undefined;
}

function registrationCallSurface(requireBinding: boolean): void {
	for (const [backend, className, registerName] of [
		["browser", "BrowserAheReclamationMaintenance", "registerBrowserAheReclamationMaintenance"],
		["node", "NodeAheReclamationMaintenance", "registerNodeAheReclamationMaintenance"],
	] as const) {
		const file = source(`packages/storage-${backend}/src/internal/ahe-reclamation.ts`);
		const registration = file.statements.find(
			(node) => ts.isFunctionDeclaration(node) && node.name?.text === registerName
		);
		expect(registration).toBeDefined();
		if (registration === undefined) throw new Error("REGISTRATION_SOURCE_PREMISE_MISSING");
		const calls: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node.expression.getText(file));
			ts.forEachChild(node, visit);
		};
		visit(registration);
		expect(calls.filter((name) => name === className)).toHaveLength(1);
		expect(calls.filter((name) => name === "maintenanceByStore.set")).toHaveLength(1);
		expect(
			calls.filter(
				(name) => ![className, "maintenanceByStore.set", "bindAheReclamationMaintenance", "TypeError"].includes(name)
			)
		).toEqual([]);
		if (requireBinding) expect(calls.filter((name) => name === "bindAheReclamationMaintenance")).toHaveLength(1);
	}
}

async function corruptHead(owner: Opened): Promise<void> {
	if (owner.backend === "sqlite") {
		const connection = new DatabaseSync(owner.identity);
		try {
			connection
				.prepare("INSERT INTO objects (object_id, head_record) VALUES (?, ?)")
				.run(D109C_OBJECT, Uint8Array.of(255));
		} finally {
			connection.close();
		}
		return;
	}
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(owner.identity);
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction("objects", "readwrite");
			transaction.oncomplete = (): void => resolve();
			transaction.onabort = (): void => reject(transaction.error);
			transaction.onerror = (): void => reject(transaction.error);
			transaction.objectStore("objects").put({ objectId: D109C_OBJECT, record: Uint8Array.of(255) });
		});
	} finally {
		database.close();
	}
}

async function lifecycle(backend: Backend, state: "closed" | "poisoned"): Promise<void> {
	const owner = await opened(backend);
	try {
		const capability = discovered(owner);
		// This is a bounded storage-substrate fixture, not a product room epoch.
		const input = maintenanceNamespace.captureAheReclamationInput(d109cInput());
		if (state === "closed") {
			await owner.store.close();
		} else {
			await corruptHead(owner);
			await expect(capability.reclaimClosedEpoch(input)).rejects.toMatchObject({ code: "AHE_RECLAMATION_CORRUPT" });
			expect(await owner.store.readHead(D109C_OBJECT)).toEqual({ ok: false, reason: "STORE_POISONED" });
		}
		expect(neutral.aheReclamationMaintenanceForStore?.(owner.store)).toBe(capability);
		await expect(capability.reclaimClosedEpoch(input)).rejects.toMatchObject({
			code: state === "closed" ? "AHE_RECLAMATION_STORE_CLOSED" : "AHE_RECLAMATION_STORE_POISONED",
		});
	} finally {
		await owner.store.close();
	}
}

describe("D.110c-0c1f5b0z backend-neutral AHE maintenance discovery", () => {
	it("01 real browser facade resolves the exact existing backend capability", async () => {
		const owner = await opened("browser");
		try {
			expect(discovered(owner)).toBe(owner.legacy);
		} finally {
			await owner.store.close();
		}
	});
	it("02 real SQLite facade resolves the exact existing backend capability", async () => {
		const owner = await opened("sqlite");
		try {
			expect(discovered(owner)).toBe(owner.legacy);
		} finally {
			await owner.store.close();
		}
	});
	it("03 memory copied proxy and foreign facades do not inherit discovery", async () => {
		await withBoth(async (browser, sqlite) => {
			discovered(browser);
			discovered(sqlite);
			const memory = createMemoryAheDurableStore();
			try {
				for (const candidate of [
					memory,
					{ ...browser.store },
					{ ...sqlite.store },
					new Proxy(browser.store, {}),
					new Proxy(sqlite.store, {}),
					{},
				] as AheDurableStore[])
					expect(neutral.aheReclamationMaintenanceForStore?.(candidate)).toBeUndefined();
			} finally {
				await memory.close();
			}
		});
	});
	it("04 first bind wins through both backends and refuses same and different second capabilities", async () => {
		await withBoth(async (browser, sqlite) => {
			const capabilities = [discovered(browser), discovered(sqlite)];
			const bind = binder();
			for (const owner of [browser, sqlite]) {
				// Isolated trusted-plumbing identity control only: this artificial
				// memory binding claims no backend ownership/authentication, and the
				// foreign capability is never invoked through it. Case 03 has its own
				// unregistered memory facade. Real backend bindings are checked below.
				const facade = createMemoryAheDurableStore();
				try {
					expect(neutral.aheReclamationMaintenanceForStore?.(facade)).toBeUndefined();
					expect(bind(facade, owner.legacy)).toBe(true);
					for (const capability of capabilities) expect(bind(facade, capability)).toBe(false);
					expect(neutral.aheReclamationMaintenanceForStore?.(facade)).toBe(owner.legacy);
					for (const capability of capabilities) expect(bind(owner.store, capability)).toBe(false);
					expect(discovered(owner)).toBe(owner.legacy);
				} finally {
					await facade.close();
				}
			}
		});
	});
	it("05 duplicate internal backend registration preserves both first resolver identities", async () => {
		// Dedicated real facades; discovery must precede any duplicate registration.
		await withBoth((browser, sqlite) => {
			discovered(browser);
			discovered(sqlite);
			const fail = (): never => {
				throw new Error("DUPLICATE_REGISTRATION_INVOKED_LIFECYCLE");
			};
			expectDuplicate(() =>
				registerBrowserAheReclamationMaintenance(
					browser.store,
					{
						acquireRecoveryTurn: fail,
						finishOperation: fail,
						isClosed: fail,
						isPoisoned: fail,
						latchPoison: fail,
						startOperation: fail,
					},
					browser.identity
				)
			);
			const connection = new DatabaseSync(sqlite.identity);
			try {
				expectDuplicate(() =>
					registerNodeAheReclamationMaintenance(sqlite.store, connection, {
						isClosed: fail,
						isPoisoned: fail,
						latchPoison: fail,
					})
				);
			} finally {
				connection.close();
			}
			expect(resolveBrowserAheReclamationMaintenance(browser.store)).toBe(browser.legacy);
			expect(resolveNodeAheReclamationMaintenance(sqlite.store)).toBe(sqlite.legacy);
			expect(discovered(browser)).toBe(browser.legacy);
			expect(discovered(sqlite)).toBe(sqlite.legacy);
		});
	});
	it("06 fresh native ESM instances share exact bindings in one global", () => {
		child("duplicate");
	});
	it("07 incompatible preoccupied registry value fails closed", () => {
		child("value");
	});
	it("08 preoccupied accessor is not invoked and import fails closed", () => {
		child("accessor");
	});
	it("09 mutable configurable preoccupied descriptor fails closed", () => {
		child("descriptor");
	});
	it("10 discovered browser maintenance preserves closed refusal", async () => {
		await lifecycle("browser", "closed");
	});
	it("11 discovered browser maintenance preserves poisoned refusal", async () => {
		await lifecycle("browser", "poisoned");
	});
	it("12 discovered SQLite maintenance preserves closed refusal", async () => {
		await lifecycle("sqlite", "closed");
	});
	it("13 discovered SQLite maintenance preserves poisoned refusal", async () => {
		await lifecycle("sqlite", "poisoned");
	});
	it("14 registration and discovery preserve facade keys without additional store IO", async () => {
		await withBoth(async (browser, sqlite) => {
			discovered(browser);
			discovered(sqlite);
			const bind = binder();
			const keys = [Reflect.ownKeys(browser.store), Reflect.ownKeys(sqlite.store)];
			// Exact preexisting own-field shapes, derived from the custodied classes
			// and parameter-property constructors, also cover initial registration.
			expect(new Set(keys[0])).toEqual(new Set(["lifecycle", "capabilities", "recoveryCertificates"]));
			expect(new Set(keys[1])).toEqual(
				new Set(["connection", "fault", "crashObserver", "capabilities", "closed", "poisoned", "recoveryCertificates"])
			);
			const plumbingFacade = createMemoryAheDurableStore();
			const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
			const exec = vi.spyOn(DatabaseSync.prototype, "exec");
			const transaction = vi.spyOn(FakeDatabase.prototype, "transaction");
			try {
				// First-bind branch observation only; no capability invocation or
				// backend-ownership claim through this artificial plumbing facade.
				expect(bind(plumbingFacade, browser.legacy)).toBe(true);
				expect(neutral.aheReclamationMaintenanceForStore?.(plumbingFacade)).toBe(browser.legacy);
				for (const owner of [browser, sqlite]) {
					expect(bind(owner.store, owner.legacy)).toBe(false);
					expect(discovered(owner)).toBe(owner.legacy);
				}
				expect([Reflect.ownKeys(browser.store), Reflect.ownKeys(sqlite.store)]).toEqual(keys);
				expect(prepare).not.toHaveBeenCalled();
				expect(exec).not.toHaveBeenCalled();
				expect(transaction).not.toHaveBeenCalled();
			} finally {
				prepare.mockRestore();
				exec.mockRestore();
				transaction.mockRestore();
				await plumbingFacade.close();
			}
			registrationCallSurface(true);
		});
	});
	it("15 legacy backend resolvers stay backend specific and reject foreign identities", async () => {
		await withBoth(async (browser, sqlite) => {
			expect(resolveBrowserAheReclamationMaintenance(browser.store)).toBe(browser.legacy);
			expect(resolveNodeAheReclamationMaintenance(sqlite.store)).toBe(sqlite.legacy);
			expect(resolveBrowserAheReclamationMaintenance(sqlite.store)).toBeUndefined();
			expect(resolveNodeAheReclamationMaintenance(browser.store)).toBeUndefined();
			const memory = createMemoryAheDurableStore();
			try {
				for (const candidate of [
					memory,
					{ ...browser.store },
					{ ...sqlite.store },
					new Proxy(browser.store, {}),
					new Proxy(sqlite.store, {}),
					{},
				] as AheDurableStore[]) {
					expect(resolveBrowserAheReclamationMaintenance(candidate)).toBeUndefined();
					expect(resolveNodeAheReclamationMaintenance(candidate)).toBeUndefined();
				}
			} finally {
				await memory.close();
			}
		});
	});
	it("16 compatibility custody preserves interfaces roots manifests constructors and mutation bodies", () => {
		const custody = JSON.parse(readFileSync(resolve(FIXTURES, "source-custody.json"), "utf8")) as {
			whole: Record<string, string>;
			spans: Record<string, { name: string; sha256: string }[]>;
		};
		const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
		for (const [file, expected] of Object.entries(custody.whole))
			expect(hash(readFileSync(resolve(ROOT, file))), file).toBe(expected);
		for (const [filename, spans] of Object.entries(custody.spans)) {
			const file = source(filename);
			for (const span of spans) {
				const matches = file.statements.filter((node) => statementName(node, file) === span.name);
				expect(matches, `${filename}:${span.name}`).toHaveLength(1);
				expect(hash(matches[0]?.getText(file) ?? ""), `${filename}:${span.name}`).toBe(span.sha256);
			}
		}
		registrationCallSurface(false);
		const browser = readFileSync(resolve(ROOT, "packages/storage-browser/src/internal/ahe-reclamation.ts"), "utf8");
		const captureIndex = browser.indexOf("captureAheReclamationInput(input)");
		const dispatchIndex = browser.indexOf("runInternalPrimaryDispatch", captureIndex);
		const classifyIndex = browser.indexOf("classifyAheReclamation", dispatchIndex);
		expect(captureIndex).toBeGreaterThan(browser.indexOf("class BrowserAheReclamationMaintenance"));
		expect(dispatchIndex).toBeGreaterThan(captureIndex);
		expect(classifyIndex).toBeGreaterThan(dispatchIndex);
	});
});
