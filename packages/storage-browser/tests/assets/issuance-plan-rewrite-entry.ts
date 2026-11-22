import { createBrowserDurableIssuanceStore, createBrowserRoomDurableIssuanceStore } from "../../src/issuance.js";
import { prepareBrowserRoomDatabase } from "../../src/internal/schema-idb.js";
import { openRoomRetirementSession } from "../../src/internal/native-read-reservation.js";
import { acquireBrowserRoomIssuanceRetirement, browserRoomIssuanceRetentionSection } from "../../src/internal/browser-issuance-store.js";
import { closeIssuanceRetirementProtectedRecords, durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS, issuanceRetirementPreparationWithPlanRewrite } from "@ts-drp/issuance-store/maintenance";
import { createRoomRetentionProofBook, type RoomRetentionSelection } from "@ts-drp/storage/room-head";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import { d109bIssue, d109bPruningInput } from "../../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Native IndexedDB mechanism evidence; synthetic signatures do not establish protocol eligibility.
Reflect.set(globalThis, "runIssuanceRewrite", async (mode: string) => {
	const databaseName = `rewrite-${mode}-${crypto.randomUUID()}`, scope = {objectId: "rewrite-room", author: "writer"};
	if (mode !== "legacy") await prepareBrowserRoomDatabase({databaseName});
	const open = () => mode === "legacy" ? createBrowserDurableIssuanceStore({primaryDatabaseName: databaseName}) :
		createBrowserRoomDurableIssuanceStore({databaseName});
	let store = await open();
	try {
		const commits: DurableIssueCommit[] = [];
		for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch));
		await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan: {scope, revision: 0,
			fenceSequence: 4, entries: [0, 1, 2].map(sequence => ({sourceSequence: sequence,
				sourceDigest: commits[sequence]!.envelope.digest, disposition: "rebase", replacementSequence: sequence + 1}))}});
		const owner = durableIssuancePruningMaintenanceForStore(store)!;
		// A completed entry whose source the store still holds is custody; the rewrite
		// drops the entries whose sources the authenticated prefix pruner removed.
		await owner.pruneAuthenticatedSettledPrefix(d109bPruningInput(await owner.inspectPruningState(scope), 3, 2));
		const read = await owner.acquireRetirementControl!({objectId: scope.objectId});
		const source = await owner.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		const holes = closeIssuanceRetirementProtectedRecords({control: read.control, rows: source.rows, throughEpoch: 3, protectedRecords: []});
		const labels = {throughEpoch: 3, decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64)};
		const p = issuanceRetirementPreparationWithPlanRewrite(read.control, {...labels, protectedRecords: holes}, source.rows);
		await read.release();
		let writes = 0, charged = 0, budgetRefused = false, chargeBeforeWrites = true;
		if (mode === "legacy") {
			const prepare = await owner.acquireRetirementControl!({objectId: scope.objectId});
			await prepare.prepareFence(p); await prepare.release();
			const commit = await owner.acquireRetirementControl!({objectId: scope.objectId});
			await commit.commitPrepared(); await commit.release();
		} else if (mode === "room-owner") {
			const session = await openRoomRetirementSession({databaseName});
			try {
				const prepare = await acquireBrowserRoomIssuanceRetirement(session, {objectId: scope.objectId});
				await prepare.prepareFence(p); await prepare.release();
				const commit = await acquireBrowserRoomIssuanceRetirement(session, {objectId: scope.objectId});
				await commit.commitPrepared(); await commit.release(); await session.commit();
			} catch (error) {await session.abort(); throw error;}
		} else {
			// This focused owner test supplies only the fields that issuance owns; the full
			// signed selection and cross-owner decision are tested by the room integration gate.
			const selection = {objectId: scope.objectId, throughEpoch: 3, issuance: {protectedRecords: holes}} as RoomRetentionSelection;
			const section = browserRoomIssuanceRetentionSection(databaseName, store);
			const session = await openRoomRetirementSession({databaseName});
			const book = createRoomRetentionProofBook();
			try {
				const draft = await section.prepare({session, selection, book, context: {}});
				const target = await draft.compose(labels);
				charged = book.charged();
				if (draft.rewrites.length !== 1) throw new Error("missing planned rewrite");
				if (mode === "room-budget") await session.abort();
				else {
					await draft.write(target, book);
					const trace = book.trace(); writes = trace.filter(event => event.kind !== "charge").length;
					const firstWrite = trace.findIndex(event => event.kind !== "charge");
					chargeBeforeWrites = trace.slice(firstWrite).every(event => event.kind !== "charge");
					if (mode === "room-abort") await session.abort(); else await session.commit();
				}
			} catch (error) {await session.abort(); throw error;}
			if (mode === "room-budget") {
				const bounded = await openRoomRetirementSession({databaseName}), small = createRoomRetentionProofBook(charged - 1);
				try {
					const draft = await section.prepare({session: bounded, selection, book: small, context: {}});
					await draft.compose(labels);
				} catch (error) {budgetRefused = String(error).includes("RETENTION_BUDGET");}
				finally {await bounded.abort();}
				writes = small.trace().filter(event => event.kind !== "charge").length;
			}
		}
		await store.close(); store = await open();
		const reopened = durableIssuancePruningMaintenanceForStore(store)!;
		const observed = await reopened.acquireRetirementControl!({objectId: scope.objectId});
		const census = await reopened.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		await observed.release();
		return {image: census.image.imageDigest, sourceImage: source.image.imageDigest, targetImage: p.planRewrite!.targetImageDigest,
			planRevision: census.rows.plans[0]!.revision, sources: census.rows.plans[0]!.entries.map(entry => entry.sourceSequence),
			controlRevision: observed.control.revision, active: observed.control.active, completed: observed.control.completed !== null,
			writes, charged, budgetRefused, chargeBeforeWrites};
	} finally {await store.close();}
});
