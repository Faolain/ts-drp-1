import { decodeCanonical } from "@ts-drp/canonical";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// fix/skip-scope-chain-invalid: a received journal scope is authenticated for retirement in two
// ways. The classifier (classifyClosedJournalDetails) accepts the room's recovery trusts (the
// retained successor trusts: genesis and the last few installs) and, outside them, the scope's
// own signed header reopened against the pinned genesis with its kept closed-membership authority
// (fd342d90). The installer (installClosedRetirementSource) re-checks every collectible prefix
// against the recovery trusts only. So a scope with kept authority that is held long enough to
// leave the trust window, then becomes collectible, is selected by the classifier and refused by
// the installer ("chain-invalid"): the member's recovery turnover fails and its session closes.
// In the slow-member runs, scopes held by the member's own unresolved work after skip installs hit
// this at the seventh protected scope.
//
// Here a Writer's move that never reached the creator is unresolved accepted work in scope 1 after
// its revocation; it keeps scope 1 protected while the member installs eight more successors (its
// trust window moves past scope 1), and is then abandoned. The member must keep installing and
// retire scope 1.
const ROUNDS = Number(process.env.HEADER_COVERAGE_ROUNDS ?? 8);

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

type MemberJournal = Readonly<{ scopes: number[]; membership: number[]; protectedScopes: number[] }>;

const message = (clientOperationId: string): Record<string, unknown> => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

/**
 * The member's live journal (its owned local session): scopes, kept memberships, last protected scopes.
 * @param directory - The room directory.
 * @returns The journal's scopes, the scopes holding a closed membership, and the protected scopes.
 */
function memberJournal(directory: string): MemberJournal {
	const files: string[] = [];
	const walk = (path: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.name.endsWith(".drp-live-journal-v1.sqlite")) files.push(child);
		}
	};
	walk(join(directory, "local-sessions"));
	expect(files).toHaveLength(1);
	const db = new DatabaseSync(required(files[0]), { readOnly: true });
	try {
		const scopes = db
			.prepare("SELECT epoch FROM scopes ORDER BY epoch")
			.all()
			.map((row) => Number(row.epoch));
		const membership = db
			.prepare("SELECT epoch FROM scopes WHERE closed_membership_bytes IS NOT NULL ORDER BY epoch")
			.all()
			.map((row) => Number(row.epoch));
		let protectedScopes: number[] = [];
		for (const row of db.prepare("SELECT record FROM retirement_controls").all()) {
			const value = decodeCanonical(row.record as Uint8Array) as {
				completed: { protectedScopes: { epoch: number }[] } | null;
			};
			protectedScopes = value.completed?.protectedScopes.map((scope) => scope.epoch) ?? protectedScopes;
		}
		return { scopes, membership, protectedScopes };
	} finally {
		db.close();
	}
}

it("a scope held past the member's trust window by unresolved work is retired once the work is abandoned", async () => {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		localMembers: [1],
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0),
		member = await f.open(1);
	const history: unknown[] = [];
	const round = async (label: string): Promise<string> => {
		expect((await creator.room.sealEpoch()).ok, label).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const outcome = await f.install(member).then(
			() => "ok",
			(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
		);
		history.push({
			label,
			outcome,
			epoch: member.room.authority()?.epoch ?? null,
			journal: memberJournal(f.directory),
		});
		return outcome;
	};
	// One adjacent epoch first, so the unresolved source is not in the genesis scope.
	expect(await round("first")).toBe("ok");
	// The member's move never reaches the creator (its gossip fails), and the member is revoked:
	// the move is accepted work of unknown commitment in scope 1.
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
	await member.room.issue(message("never-delivered")).catch(() => undefined);
	const author = required(f.identities[1]).author;
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
	expect(await round("revoked")).toBe("ok");
	const unresolved = required((await member.room.unresolvedAcceptedWork())[0]);
	// The member follows the creator while the work stays unresolved.
	for (let index = 0; index < ROUNDS; index++) expect(await round(`held-${index}`), JSON.stringify(history)).toBe("ok");
	// Scope 1 stayed protected for want of the work's resolution, with its closed membership kept.
	const held = memberJournal(f.directory);
	expect(held.protectedScopes, JSON.stringify(held)).toContain(1);
	expect(held.membership, JSON.stringify(held)).toContain(1);
	await member.room.abandonUnresolvedAcceptedWork({
		sourceSequence: unresolved.sourceSequence,
		sourceDigest: unresolved.sourceDigest,
		sourceContextDigest: unresolved.sourceContextDigest,
	});
	// The next installs classify scope 1 collectible by its kept authority; the member keeps
	// installing and retires it.
	const after = [await round("abandoned-0"), await round("abandoned-1")];
	process.stdout.write(`HEADER_COVERAGE ${JSON.stringify(history)}\n`);
	expect(after, JSON.stringify(history.slice(-3))).toEqual(["ok", "ok"]);
	expect(member.room.authority()?.epoch).toBe(ROUNDS + 4);
	const last = memberJournal(f.directory);
	expect(last.protectedScopes, JSON.stringify(last)).not.toContain(1);
}, 600_000);
