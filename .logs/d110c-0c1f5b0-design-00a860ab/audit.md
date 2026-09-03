# D.110c-0c1f5b0 design checkpoint audit

## Anchor and scope

- Base/source-audit commit and upstream before this checkpoint:
  `00a860ab3c2ed64b236713fc63b7ae2b073f9f27`.
- Branch: `codex/phase3a1b-p6-golden-path`.
- This checkpoint changes only the canonical production-hardening plan and
  this design evidence root. It runs no product test, RED, campaign, preflight
  or long workload and changes no production source.

## Deterministic checks

1. `git diff --check` — status 0.
2. `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec prettier --check
docs/production-hardening/production-hardening-tdd-plan-v2.md
.logs/d110c-0c1f5b0-design-00a860ab/design.md` — status 0; both files match
   Prettier style. The increased formatter heap is required by the existing
   approximately 100,000-line plan and changes no product/test limit.
3. Exact token counts in `design.md`:
   `$drp.author-settlement.v1` 2;
   `drp-creator-author-settlement-state` 2;
   `ts-drp/creator-author-settlement/v1` 1;
   `settleRebaseSources` 2;
   `authorSettlementVersion` 1;
   `hasDisplacedOperation` 1;
   `source-dispositions` 1; and `author-baseline` 4.
4. Exact fixed-string source searches prove both new production identifiers
   are absent under `packages/` and `examples/`. This is a design-only
   checkpoint, not an already-implemented claim.
5. Current-source seam checks found blueprint-only operation admission at
   `packages/protocol-v3/src/index.ts:3414,4693`; the proposed-v1 aggregate
   requirement at
   `packages/node/src/internal/creator-transition-advance.ts:327`; issuance
   publication ownership at `packages/issuance-store/src/types.ts:85`; and the
   current `completeRebaseSource()` owner/callers in `v3-live.ts` and the room.
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

## Corrected diagnostic

The first custody-tail command used `path` as a zsh loop variable. `path` is a
special zsh array tied to `PATH`, so the loop made later `git`, `wc` and `tr`
lookups fail. All preceding source/format checks had completed successfully.
The check was corrected by using `protected_item`; the corrected protected
path, stash, port, process, branch/upstream and signing checks above passed.
This was a read-only diagnostic error and was not treated as a code failure.

## Review gate

After this evidence and the plan are signed and pushed, exactly one governing
high-risk plan review will inspect the full design using Grok 4.6/high, direct
Kimi K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh. Only P0/P1
blocks production RED. Fable and collaboration subagents are prohibited unless
the user expressly authorizes a future invocation.
