import { readFileSync } from "node:fs";

const reporter = JSON.parse(
	readFileSync(".logs/d110c-0c-green-diagnostic-59330d85/playwright.json", "utf8")
);
const result = reporter.suites[0].specs[0].tests[0].results[0];
const attachment = result.attachments.find(({ name }) => name === "d110c-0c-causal-evidence-old-ahe");
const row = JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));
const recovery = row.recovered;
const before = recovery.floorBefore.state;
const after = recovery.floorAfter.state;
const v3Live = readFileSync("packages/node/src/v3-live.ts", "utf8");
const fixture = readFileSync(
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
	"utf8"
);
const checks = Object.freeze({
	allThreeEpochsIssueThroughProductPath:
		fixture.includes('await issue("d110c-0c-epoch-zero")') &&
		fixture.includes('await issue("d110c-0c-epoch-one")') &&
		fixture.includes('await issue("d110c-0c-epoch-two")'),
	coldReopenFailureExact:
		recovery.detail ===
		"v3 room successor reopen failed: recovery-rejected: creator predecessor recovery failed: admission-rejected",
	currentFilterIsSuccessorRelative:
		v3Live.includes("const authenticated = authenticateRecoveryVertex(\n\t\t\t\t\tfilterPayload") &&
		v3Live.includes("candidateEpoch > excludedAfterEpoch"),
	floorCommittedEpoch3:
		before.stable.epoch === 2 && before.pending.next.epoch === 3 && after.pending === null && after.stable.epoch === 3,
	genesisHasSeparateFilter:
		v3Live.includes("authenticatedPinnedGenesisOutboxRow(row, issuanceScope, filterPayload, pinnedGenesisAnchorDigest)"),
	pendingRecoverySucceeded:
		recovery.recovery.callCount === 1 &&
		recovery.recovery.resultKind === "active-new" &&
		recovery.recovery.swapHeadCount === 1,
});
if (Object.values(checks).some((value) => value !== true)) {
	throw new TypeError(`D110C_0C diagnosis audit failed: ${JSON.stringify(checks)}`);
}
process.stdout.write(
	`${JSON.stringify(
		{
			checks,
			conclusion:
				"The intended pending authenticator is GREEN through durable commit. The first downstream blocker is epoch-3 predecessor recovery admission. The successor-relative/genesis-only issuance filter is the exact candidate seam; a new causal RED must prove whether an authenticated epoch-1 row is the rejected input before v3-live production edits.",
		},
		null,
		2
	)}\n`
);
