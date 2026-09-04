# D.110c-0c1f5b0 design checkpoint audit

## Anchor, amendment and scope

- Base/source-audit commit and upstream before this checkpoint:
  `00a860ab3c2ed64b236713fc63b7ae2b073f9f27`.
- Branch: `codex/phase3a1b-p6-golden-path`.
- This checkpoint changes only the canonical production-hardening plan and
  this design evidence root. It runs no product test, RED, campaign, preflight
  or long workload and changes no production source.
- The first signed/pushed design checkpoint is
  `fc4b8fc78148e5211b09dc32e3f27f32756653ec`. Its governing review completed
  with a nonempty P0/P1 union. `review.md` preserves the exact reviewer
  terminals, raw-session hashes, union and dispositions. The first amendment
  closed bounded carrier/lifecycle defects and isolated the removed-author
  identity problem as blocking prerequisite D.110c-0c1f5b0p. The follow-on
  source/design root at `.logs/d110c-0c1f5b0p-design-e6a67013/` selects the
  missing registry/profile boundary and amends this design; it does not
  authorize RED.

## Deterministic checks

1. `git diff --check` — status 0.
2. `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec prettier --check
docs/production-hardening/production-hardening-tdd-plan-v2.md
.logs/d110c-0c1f5b0-design-00a860ab/design.md` — status 0; both files match
   Prettier style. The increased formatter heap is required by the existing
   approximately 100,000-line plan and changes no product/test limit.
3. Exact amended token counts in `design.md` are revalidated at this follow-on
   checkpoint. The prior token list is historical evidence for the first
   amendment; removed runtime-migration identifiers are not acceptance
   contracts for the combined design:
   `$drp.author-settlement.v1` 3;
   `drp-creator-author-settlement-state` 2;
   `ts-drp/creator-author-settlement/v1` 1;
   `settleRebaseSources` 2;
   `authorSettlementVersion` 0;
   `hasDisplacedOperation` 1;
   `source-dispositions` 1;
   `author-baseline` 1 (deletion rationale only);
   `zero-intent` 6;
   `pruneAuthenticatedSettledPrefix` 1; and
   `D.110c-0c1f5b0p` 1 as the selected design prerequisite; and
   `creator-trusted-settlement-v1` 4.
4. Exact fixed-string source searches prove both new production identifiers
   are absent under `packages/` and `examples/`. This is a design-only
   checkpoint, not an already-implemented claim.
5. Current-source seam checks found blueprint-only operation admission at
   `packages/protocol-v3/src/index.ts:3414,4693`; the proposed-v1 aggregate
   aggregate requirement at
   `packages/node/src/internal/creator-transition-advance.ts:398` and the
   separately required retirement pair at line 327; issuance
   publication ownership at `packages/issuance-store/src/types.ts:85`; and the
   current `completeRebaseSource()` owner/callers in `v3-live.ts` and the room.
   The review corrected the original aggregate citation to the
   `proposedMatches.length !== 1` check. The settlement-profile branch must
   deliberately own both that check and the distinct retirement check at line
   327; neither may be dropped implicitly.
6. Source SHA-256 values exactly match the preceding audit:
   - creator close:
     `770add5766018e6db251602f7a479df5e310b8d2176fdbba67b67107cc943bb2`;
   - v3 live:
     `9797d496e5a8db3bdd17b2223367ff0be2ae633c45d3170b885f2d10c92ad02e`;
   - transition advance:
     `196c4cd9e814250ce8c130f232a00c96812516cb0ce82de2430fe85b766834ff`;
   - closed-epoch cleanup:
     `72b78915f65ee60b4b1f38be4edcebf662731dcf24f8f9edd91db931912c39fe`;
   - v1 author-frontier codec:
     `bf3f07f3a918cbf85d239c66327d950c8ffce72fbd0439fc2f56efca48962d12`;
   - registry v1:
     `2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9`;
   - issuance-store types:
     `405ad160cf0bdb2ef6fb33dda81910f0435450fb7bb7ed85362ccd8605cdbf12`;
   - room:
     `d63a8ab6be34bc6aca85293726982e106d5198c234abf2271aa1195c54d93bd0`.
7. Protected untracked `.agents`, `.claude` and `.pnpm-store` are present and
   untouched. Stash count is 27. Fixed ports 4174, 4175, 51000 and 51002 are
   clear. The corrected process predicate found only its own shell/`rg`
   command and no ts-drp reviewer, test or profiler.
8. `commit.gpgsign=true`, signing key `A81C6289`; HEAD equalled upstream before
   staging.
9. The amended maximum-shape operation was encoded directly with
   `packages/canonical/src/index.ts` through the workspace `tsx` binary. Eight
   application sources, eight transform intents and eight references into
   sixteen-entry batches, using maximum-safe ordinals and full 64-character
   digests, encode to exactly 6,003 bytes. The unchanged 8,192-byte ceiling
   therefore has 2,189 bytes of margin. The previous 16/16/16 claim is
   rejected and not retained as an acceptance contract.

## Corrected diagnostic

The first custody-tail command used `path` as a zsh loop variable. `path` is a
special zsh array tied to `PATH`, so the loop made later `git`, `wc` and `tr`
lookups fail. All preceding source/format checks had completed successfully.
The check was corrected by using `protected_item`; the corrected protected
path, stash, port, process, branch/upstream and signing checks above passed.
This was a read-only diagnostic error and was not treated as a code failure.

The first post-review process predicate also matched the Codex
`SkyComputerUseClient` turn-completion notification because that process's
serialized conversation text contained historical `playwright`, `vitest`, and
reviewer command strings. The corrected predicate first restricts the
executable class to Node/pnpm/npx/Kimi/Claude/Python and only then matches this
workspace plus the active test/reviewer terms. It returned
`relevant-process-clear`. This was another read-only predicate false positive,
not an active ts-drp process or code failure.

## Review result and next gate

The exact first review is preserved under
`.logs/d110c-0c1f5b0-plan-review-fc4b8fc7/`. Grok and Opus rejected RED; Kimi
approved with P2 only. The union therefore blocks. D.110c-0c1f5b0p now selects
a creator-authenticated Merkle AVL retired-author dictionary and genesis-bound
`creator-trusted-settlement-v1` profile. Direct canonical measurements give
792 bytes for a maximum-shaped node and 7,064 bytes for the signed maximum
64-frontier checkpoint, under unchanged 1,024/8,192-byte ceilings. The one
material Grok/Kimi/Opus confirmation reviews the combined amendment. Only an
empty P0/P1 union can authorize f5b0p-a or f5b0a RED. Fable and collaboration
subagents remain prohibited unless the user expressly authorizes a future
invocation.
