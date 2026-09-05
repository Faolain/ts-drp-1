# D.109f tests-only correction confirmation

Act as an independent senior correctness reviewer. Work strictly read-only in
`/Users/aristotle/Documents/Projects/ts-drp-1`. Do not edit, create, delete,
format, stage, commit, stash, install, build, test, invoke another model or
subagent, access the network, or inspect another reviewer's output. You may use
read-only file/source search and read-only Git inspection.

Review the complete signed D.109f history:

- corrected plan: `9935d7102daedc240218979dd659c2cd223fde9f`;
- causal RED: `26193e9b065b63d9931342008c283148c1c42a03`;
- first GREEN: `a24d3b204ad33617259e18fb1613a214fd3ad749`;
- tests-only final-review correction:
  `ca25ea23df36d571beef4d01afe533437520ed79`.

Read completely:

- `specs/phase-6b-bounded-pruning/slices/05-differential-exit.md`;
- the final D.109f section of
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- `.logs/phase-6b-d109f-final-review/README.md` and
  `grok-resumed-terminal.md`;
- `.logs/phase-6b-d109f-green-correction/correction-summary.md` and its
  self-excluding manifest;
- all six tests/fixtures changed by correction `ca25ea23`; and
- the three original GREEN production owners when needed to confirm scope and
  unchanged behavior.

The initial blocking union was:

1. missing census/raw-dependency 128-step proof;
2. tautological golden-path projections; and
3. fresh-process omission of the genuine close/adopt lifecycle.

Confirm whether the signed correction closes those findings without changing
production behavior or weakening the accepted plan/RED/GREEN contract. In
particular verify:

1. the proof-kind registry is sorted, duplicate-free, complete for the frozen
   durable/stable/lifecycle roster, and tied exactly to all 22 D.109d census
   keys rather than merely restating one observed value;
2. native AHE/issuance censuses and all 128 genuine AHE receipts are owner-
   observed, while durable point-read identities are classified before the
   backend lookup so deleted-missing reads cannot evade exact
   `D109F_RAW_DEPENDENCY_READ` failure;
3. the hot and cold golden-path controls derive from the actual accepted
   operation, exact canonical preimage, owner sink, issued digest, and durable
   journal digests after genuine close/adopt/reclaim, rather than hard-coded
   planner projections;
4. the child is a genuinely fresh Node process, selects exactly one real
   close/adopt/reclaim/next-live lifecycle test, inherits no fixture object or
   weak handle, and disables only irrelevant global coverage accounting;
5. AHE factory and maintenance identities both resolve from the same freshly
   built `packages/storage-node/dist/src` tree; no proxy or source/dist mixing
   is introduced;
6. the tests-only hooks preserve original callbacks and stay inert when unset;
   no public API or production source changed;
7. reporter counts/hashes, the self-excluding manifest, exact changed paths,
   builds/typechecks/lint/format/diff, protected state, signed commit, pushed
   ref, and no-campaign claim support closure; and
8. no schema, dependency, threshold, timeout, workload, wire/digest/QC/
   activation/availability/identity contract, browser scheduler, snapshot
   format, or legacy behavior changed.

Only a concrete P0/P1 correctness, causal-proof, scope, or evidence-integrity
defect blocks. P2 observations must include a disposition and do not create
another review round. Do not demand unavailable product APIs or an unsupported
128-cycle creator-close capability.

Return a concise terminal review with exact evidence for every blocking
finding. End with exactly:

VERDICT: APPROVED|CHANGES_REQUIRED
P0_P1_UNION: none|<comma-separated blocking findings>
PHASE6B_READY: yes|no
