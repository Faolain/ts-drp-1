/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { issuanceRetirementAllows } from "../packages/issuance-store/src/retirement.js";
import { LIVE_JOURNAL_RETIREMENT_LIMITS } from "../packages/live-journal/src/retirement.js";

// MEASUREMENT: a silent Chat Writer (its
// network publishes nowhere, so nothing it issues ever settles) runs for EPOCHS creator epochs while the
// creator keeps sealing and adopting. Each epoch the Writer sends a message, offers every handed-back
// move again (as the shipped rollover policy does), and installs the creator's successor. Both peers
// close and reopen over the same stores at REOPENS. At every epoch it records the Writer's settlement
// plan entries (cap maxEpochVertices), the completed entries kept only because their retired source row
// is still held (custody), held outbox rows (cap 3 x maxEpochVertices), retained issued rows, and the
// Writer's journal scopes (cap LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes).
// Every sample must stay under those caps. When the Writer stops sending new messages
// (_NEW_EPOCHS < _EPOCHS), no count may grow once its last new move has left the window: the
// later half of those epochs peaks no higher than the earlier half (the live moves rotate through
// the window, so a count can alternate by one). A reopen epoch is left out: its install does not
// prune, and the next one catches up.
// Run with SILENT_WRITER_CAPACITY_MEASURE=1 (_EPOCHS, _PER_EPOCH, _NEW_EPOCHS, _OUT=<file.json>).
const MEASURE = process.env.SILENT_WRITER_CAPACITY_MEASURE === "1";
const EPOCHS = Number(process.env.SILENT_WRITER_CAPACITY_EPOCHS ?? 32);
const REOPENS = new Set([Math.floor(EPOCHS / 3), Math.floor((2 * EPOCHS) / 3)]);
const OUT = process.env.SILENT_WRITER_CAPACITY_OUT;
// New messages per epoch, sent only in the first NEW_EPOCHS epochs (default: every epoch); handed-back
// moves are always offered again.
const PER_EPOCH = Number(process.env.SILENT_WRITER_CAPACITY_PER_EPOCH ?? 1);
const NEW_EPOCHS = Number(process.env.SILENT_WRITER_CAPACITY_NEW_EPOCHS ?? EPOCHS);
const MAX_EPOCH_VERTICES = 8192;
const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const journalFiles = (root: string): string[] =>
	readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		if (statSync(path).isDirectory()) return journalFiles(path);
		return name.endsWith(".drp-live-journal-v1.sqlite") ? [path] : [];
	});

const journalCensus = (directory: string) => {
	const files: Record<string, { scopes: number; entries: number; epochs: number[] }> = {};
	for (const file of journalFiles(directory)) {
		const database = new DatabaseSync(file, { readOnly: true });
		try {
			const scopes = database
				.prepare("SELECT epoch FROM scopes ORDER BY epoch")
				.all()
				.map((row) => Number(row.epoch));
			const entries = Number((database.prepare("SELECT COUNT(*) AS n FROM accepted_entries").get() as { n: number }).n);
			files[file.includes("local-sessions") ? "writer" : "creator"] = {
				scopes: scopes.length,
				entries,
				epochs: scopes,
			};
		} finally {
			database.close();
		}
	}
	return files;
};

it.skipIf(!MEASURE)(
	"a silent Chat Writer's settlement plan, custody, outbox, issued rows and journal scopes per creator epoch",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-chat-silent-capacity-"));
		directories.push(directory);
		const samples: Record<string, unknown>[] = [];
		const fixture = (localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
			chatSharesRoomFixture({
				directory,
				members: ["genesis"],
				format: "window",
				localMembers: [1],
				...(localSelectors === undefined ? {} : { localSelectors }),
				genesisStateBytes: createShippingChatWindowGenesisStateBytes,
			});
		type Fixture = Awaited<ReturnType<typeof fixture>>;
		const image = async (f: Fixture) => {
			const author = required(f.identities[1]).author,
				scope = { objectId: f.objectId, author };
			return f.withIssuance(1, async (store) => {
				const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
				const read = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
				const control = read.control;
				await read.release();
				const held: { sequence: number; retired: boolean; publishState: string; action: unknown }[] = [];
				for (let afterKey: readonly [string, string, number] | null = null; ; ) {
					const page = await store.readOutboxPage({ scope, afterKey, limit: 128 });
					for (const row of page)
						held.push({
							sequence: row.commit.authorSequence,
							retired: !issuanceRetirementAllows(
								control,
								scope,
								row.commit.authorSequence,
								row.commit.envelope.canonicalPreimageBytes,
								row.commit.envelope.digest
							),
							publishState: row.publishState,
							action: (
								decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action?: unknown } }
							).operation.action,
						});
					if (page.length < 128) break;
					afterKey = [f.objectId, author, required(page.at(-1)).commit.authorSequence];
				}
				const plan = await store.readSettlementPlan(scope);
				const lineage = await store.readLineage(scope);
				const prunedThrough = (await maintenance.inspectPruningState(scope)).prunedThroughAuthorSequence;
				const retiredHeld = new Set(held.filter((row) => row.retired).map((row) => row.sequence));
				const entries = plan?.entries ?? [];
				return {
					planEntries: entries.length,
					custodyEntries: entries.filter((entry) => retiredHeld.has(entry.sourceSequence)).length,
					handBacks: plan?.handBacks?.length ?? 0,
					outboxRows: held.length,
					retiredHeldRows: retiredHeld.size,
					issuedRows: lineage.next - (prunedThrough === null ? 0 : prunedThrough + 1),
					lineageNext: lineage.next,
					prunedThrough,
					retiredThroughEpoch: control?.completed?.throughEpoch ?? null,
					heldSequences: held.map((row) => row.sequence),
				};
			});
		};
		const caps = {
			planEntries: MAX_EPOCH_VERTICES,
			outboxRows: 3 * MAX_EPOCH_VERTICES,
			journalScopes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes,
		};
		let selectors: Readonly<Record<number, { slot: number; incarnation: number }>> | undefined;
		let refused: unknown;
		const offered = new Set<string>();
		let epoch = 0;
		const segments = [0, ...[...REOPENS].sort((a, b) => a - b), EPOCHS];
		try {
			for (let segment = 0; segment + 1 < segments.length && refused === undefined; segment++) {
				const f = await fixture(selectors);
				try {
					const reopen = segment > 0;
					const creator = await f.open(0, reopen ? { reopen: true } : {}),
						member = await f.open(1, reopen ? { reopen: true } : {});
					for (; epoch < required(segments[segment + 1]) && refused === undefined; epoch++) {
						let issued = 0,
							reoffered = 0;
						for (let index = 0; epoch < NEW_EPOCHS && index < PER_EPOCH; index++)
							await member.room
								.issue(message(`writer-${epoch}-${index}`))
								.then(() => issued++)
								.catch(() => undefined);
						for (const given of member.room.settlementStatus?.().undelivered ?? []) {
							const key = `${given.handBack.sourceSequence}:${given.handBack.intent}`;
							if (offered.has(key)) continue;
							offered.add(key);
							for (const operation of given.operations)
								await member.room
									.issue(operation, { handBack: given.handBack })
									.then(() => reoffered++)
									.catch(() => undefined);
						}
						expect((await creator.room.sealEpoch()).ok).toBe(true);
						await creator.room.adoptCreatorSuccessor();
						try {
							await f.install(member);
						} catch (error) {
							refused = error;
						}
						const settlement = member.room.settlementStatus?.();
						const journal = journalCensus(directory);
						const sample = {
							epoch: epoch + 1,
							reopened: reopen && epoch === segments[segment],
							issued,
							reoffered,
							unsettledEpochs: settlement?.unsettledEpochs ?? null,
							window: settlement?.window ?? null,
							undelivered: settlement?.undelivered.length ?? null,
							...(await image(f)),
							journalScopes: journal.writer?.scopes ?? null,
							journalEntries: journal.writer?.entries ?? null,
							journalEpochs: journal.writer?.epochs ?? null,
							creatorJournalScopes: journal.creator?.scopes ?? null,
						};
						samples.push(sample);
						const { heldSequences: _held, journalEpochs: _epochs, ...line } = sample;
						process.stdout.write(`SILENT_CAPACITY ${JSON.stringify(line)}\n`);
					}
					selectors = f.localSelectors;
				} finally {
					expect(await closeChatSharesRooms()).toEqual([]);
				}
			}
		} finally {
			const causes: string[] = [];
			for (let value: unknown = refused; value instanceof Error && causes.length < 10; value = value.cause)
				causes.push(String(value.message));
			const knobs = { EPOCHS, PER_EPOCH, NEW_EPOCHS, REOPENS: [...REOPENS] };
			process.stdout.write(`SILENT_CAPACITY_END ${JSON.stringify({ epochs: samples.length, knobs, caps, causes })}\n`);
			if (OUT !== undefined) writeFileSync(OUT, JSON.stringify({ knobs, caps, causes, samples }, null, 1));
		}
		expect(refused).toBeUndefined();
		expect(samples).toHaveLength(EPOCHS);
		type Sample = {
			planEntries: number;
			outboxRows: number;
			journalScopes: number | null;
			reopened: boolean;
			epoch: number;
		};
		for (const sample of samples as unknown as Sample[]) {
			expect(sample.planEntries).toBeLessThanOrEqual(caps.planEntries);
			expect(sample.outboxRows).toBeLessThanOrEqual(caps.outboxRows);
			// The scopes table also holds the current epoch's scope beside the protected ones.
			expect(required(sample.journalScopes)).toBeLessThanOrEqual(caps.journalScopes + 1);
		}
		if (NEW_EPOCHS < EPOCHS) {
			const steady = (samples as unknown as Sample[])
				.filter((sample) => sample.epoch > NEW_EPOCHS + 4 + 3 && !sample.reopened)
				.map(({ planEntries, outboxRows, journalScopes }) => ({ planEntries, outboxRows, journalScopes }));
			expect(steady.length).toBeGreaterThanOrEqual(4);
			const half = Math.floor(steady.length / 2);
			const peak = (part: typeof steady) => ({
				planEntries: Math.max(...part.map((sample) => sample.planEntries)),
				outboxRows: Math.max(...part.map((sample) => sample.outboxRows)),
				journalScopes: Math.max(...part.map((sample) => required(sample.journalScopes))),
			});
			const [earlier, later] = [peak(steady.slice(0, half)), peak(steady.slice(half))];
			expect(later.planEntries).toBeLessThanOrEqual(earlier.planEntries);
			expect(later.outboxRows).toBeLessThanOrEqual(earlier.outboxRows);
			expect(later.journalScopes).toBeLessThanOrEqual(earlier.journalScopes);
		}
	},
	3_600_000
);
