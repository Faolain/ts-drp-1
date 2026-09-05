# D.110c-b high-risk plan-review ledger

Reviewed signed/pushed plan commit:
`aa002e78463b3a56377fd26b7bdaa04ecc587396`.

All substantive reviewers inspected the same prompt and the same clean detached
checkout at `/tmp/ts-drp-d110cb-plan.LIzGhl/repository`. No test, product edit,
campaign, profile, D.110a invocation, Fable run, or collaboration subagent ran.
The initial Kimi launcher combined incompatible `--prompt` and `--plan` flags
and exited before a session or model call; the corrected standard direct Kimi
K3 invocation is the sole substantive Kimi review.

## Terminal results

- Grok 4.6/high reached its 32-turn bound after 720.224 seconds and ended
  `cancelled` immediately before its promised verdict. Exact session
  `01a062cd-c811-7c31-a0ed-5ff24e31a304` was resumed, not restarted, and
  completed normally in one turn with `APPROVED`, P0=0/P1=0/P2=4.
- Standard direct Kimi K3 session
  `session_a6727230-b5d4-4bfa-abe9-5083c4078160`, with
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, returned `CHANGES_REQUIRED`,
  P0=0/P1=2/P2=3.
- Opus xhigh session `4d183b83-9927-4431-a3ef-872c5bfe18d2`
  completed normally with `CHANGES_REQUIRED`, P0=0/P1=3/P2=4.

## Blocking union and one-batch correction

The blocking union is nonempty at the first review and is corrected only in
the signed plan checkpoint that follows this ledger:

1. The plan no longer claims a usable predecessor survives after v3-live topic
   reuse. Pre-transfer refusals retain it; post-transfer terminalization,
   alias, or cleanup failure is an exact stalled/unavailable state with no
   false active entry and no v3-live restore owner.
2. The active-owner design now marks replacement in flight before its first
   await, defers lock release, and performs an exact owner-token compare-and-
   swap immediately before map replacement. Mid-flight shutdown either settles
   after the swap or forces teardown/fail-closed; it cannot install an unlocked
   successor.
3. Product duplicate adoption is now keyed to the exact current close lifecycle
   and authenticated active tuple. `successor-pending-adoption` always
   proceeds; only an `active` new close with exact authority/floor/plane
   agreement is a no-op. `sealed` or stale `successor-adopted` custody fails.
4. Retained D.108d2 epoch-1 authority oracles remain exact. D.110c-b adds a
   separate expected-epoch tests-only predicate and raw-authority derivation;
   it does not weaken the retained epoch-1 proof.
5. The referenced audit, source-shape ledger, and self-excluding manifest are
   force-added to the signed correction so their pinned hashes are reviewable.

The nonblocking findings are dispositioned in the same plan correction without
another prose review: browser-lock proof moves from Node to Chromium; the new
serial browser title uses a fourth server/realm and distinct database/channel;
same-head idempotence uses the existing `active-new` capability producer rather
than replay; close rebinding occurs only after retained predecessor-deactivation
semantics and never uses `throwAfterReplacementCleanup` on bind failure; cold
literal `creator-adoption.ts:1030` is assigned to 0b1/c; and the Phase-5e
tests-only owner is named accurately as an anonymous result declaration.

Because the correction changes lifecycle acceptance and executable failure
semantics, the one permitted Grok/Kimi/Opus confirmation is required after the
correction is signed and pushed. RED and production edits remain blocked until
that confirmation has an empty P0/P1 union.

## Raw evidence hashes

- `prompt.md`:
  `5fc29cc0335756084c200f06c837600dd6cd86455483a529c68b53b0a65bda19`
- initial `grok/events.jsonl`:
  `df52b817c15bfcb8d130e5bc783370a65d3148fa6ce93851ff3fe407fb87307b`
- initial `grok/status.json`:
  `43aa5d21767777a70b265b890d3399b71f29f86c13284b393d66de50ef379577`
- `grok-resume.events.jsonl`:
  `d549d90bb1bff60dd0599039f619ad176b075b7e3007bcc24c032182eca700f2`
- `grok-resume.terminal.json`:
  `05ac0d768be39fc7d9010ccfbe88d8f5dcb3d488bf2335631b3f09eae6b9cc6f`
- `kimi.stream.jsonl`:
  `5fd660c78b0809649a17dfd4fa1b1138bb0d9e640d9261ca5d05c48566a712b5`
- `kimi.terminal.json`:
  `51fef22ea3988b04f4f519f70e8a31ff63c53f4b94d0f4a84bca41dbc3645bb1`
- `opus.json`:
  `106c0d7b0b3141ef128db9beded50cad7a8d2aa67cabccee24d7c1d9304d9aac`
- `opus.terminal.json`:
  `7fef21fa6be320e18f75fe8d1169cc64c127fe0ca487d1713498c907e41f56f3`
