# Combined D.110c-0c1f2/f4 checkpoint and f5 design review

Reviewed signed/pushed commit:
`f3617a8284af6d149441f0531ddec520370a34fe`.

## Terminal results

- Grok 4.6/high: `APPROVED`, P0/P1/P2 `0/0/3`; f24 checkpoint accepted;
  f5 demonstrated but its RED remains unauthorized; selected
  `PER_DISPOSITION_COMMITMENT` and required a new high-risk authority/schema
  prerequisite.
- Kimi K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`: `APPROVED`, `0/0/3`;
  f24 checkpoint accepted; f5 RED deemed authorizable; selected
  `SIMPLER_EXISTING_PRIMITIVES` using authenticated close-set/history material,
  but explicitly left close-set-leaf availability as a product-path design fact
  that must stop and reslice if absent.
- Opus xhigh: `CHANGES_REQUIRED`, `0/2/3`; f24 checkpoint accepted; f5 RED
  unauthorized; selected `BOUNDED_SETTLED_PREFIX` expressed as a new covered-run
  carrier and required the high-risk carrier/schema prerequisite to be reviewed
  separately.

All three set `f24_checkpoint_acceptable`, `f24_red_causal`,
`f24_green_closes_red`, `f5_problem_demonstrated`, and `scope_preserved` true.
Thus f2/f4 is accepted only as its narrow implementation checkpoint. It does
not establish general historical rebase safety, foreign-author close
availability, repeated same-room rollover, D.110c-c/d, Phase-6 exit, or Phase-7
cold join.

## Blocking-union disposition

1. Opus correctly found the cited f2 plan-confirmation and causal-RED evidence
   roots were untracked. Both roots validated byte-for-byte at their recorded
   manifest hashes and were preserved without modification in signed/pushed
   evidence-only commit `1b591cf2be7c6a1cd64b0c58c55753dbae9b3f9b`.
2. Opus correctly found a separate cross-epoch out-of-order trigger. If the
   creator admits author sequence `n+1` before delayed `n` and closes that epoch,
   `n+1` disappears from later close graphs while the old-epoch `n` cannot be
   admitted against the successor anchor. The adjacent-prefix frontier is then
   permanently below both. The f5 causal matrix must include this no-rebase,
   honest network-ordering case.
3. The models did not converge on a safe settlement representation. Grok needs
   an author-signed source/disposition binding; Kimi relies on close-set leaf
   availability not yet proved for the genuine writer restart path; Opus adds a
   versioned covered-run carrier and a new held/refused recovery behavior. No
   one of those materially different contracts may be selected silently.
4. f5 is therefore split prospectively. f5a owns only foreign-author
   close-liveness and exact existing error outcomes. All reviewers agreed that
   anomalies must stall/refuse only the affected author's frontier rather than
   aborting the whole close. Its genuine tests-only RED is authorized after the
   corrected split is signed/pushed because no carrier, wire, API, dependency,
   authority, threshold, or migration boundary changes.
5. f5b owns authenticated historical settlement across rebase and cross-epoch
   ordering. Its RED and production edit remain unauthorized until a bounded
   architecture audit chooses one exact representation, proves its data
   availability and bounded retention, declares its compatibility boundary,
   and passes the one material Grok/Kimi/Opus confirmation.

## P2 disposition

- Keep the cross-object target-derived, currently unconsumed bootstrap-policy
  field untouched until a later change already owns that branch; do not cite it
  as verified f4 behavior.
- f5a GREEN owns the null-boundary diagnostic-code correction and focused
  assertions for every current close-wide refusal.
- Writer-set equality remains explicitly creator-attested, not independently
  transition-rederived.
- Correct the f24 narrative prospectively: remove the unsupported claim that
  re-entry assertions passed. Do not mutate sealed GREEN evidence.
- Add the still-tracked f2 RED unit wrapper and RED Playwright configuration to
  f5a's retained inventory (or delete them only with an explicit preservation
  note). The signed RED evidence remains immutable.
- Align the fixture's expected-frontier comparator with production code-unit
  ordering when f5a next edits that fixture; this is nonblocking and does not
  authorize a standalone rerun.

No production edit or long campaign is authorized by this review result.
