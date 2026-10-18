/* eslint-disable @typescript-eslint/explicit-function-return-type -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
// A distinct precreated realm owns exact names independently of test-body timeout.
Object.assign(globalThis, {
	rollbackDelete: async (names: string[]) => {
		const before = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => n !== undefined);
		const results = [];
		for (const name of names) {
			await new Promise<void>((resolve, reject) => {
				const r = indexedDB.deleteDatabase(name);
				r.onsuccess = () => resolve();
				r.onerror = () => reject(r.error);
				r.onblocked = () => reject(new Error("exact owned database deletion blocked:" + name));
			});
			results.push({ name, terminal: "success", existed: before.includes(name) });
		}
		const after = (await indexedDB.databases()).map((d) => d.name);
		if (after.length !== 0) throw new Error("owned exact cleanup left databases:" + JSON.stringify(after));
		return { before, results, after };
	},
});
