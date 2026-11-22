#!/usr/bin/env bash
# Track J runner for settlement-replacement-retirement.qnt (the spec), -instances.qnt (simulator and test
# instances), -proofs.qnt (Apalache proof instances), -exhaustive.qnt (TLC instances) and the mutations in
# this directory.
#   track-j.sh formal          typecheck, every deterministic test, the simulations of the decided rules and of
#                              Track X's completion contract (every invariant must hold), and one simulation per
#                              mutation (each must violate its invariant). Parallel (TRACK_J_JOBS, default 2).
#   track-j.sh verify [part]   quint verify, strictly sequential. part: proofs (Apalache 0.56.1: the inductive
#                              proofs and their non-vacuity checks; TRACK_J_SLOW=1 adds the contract's three
#                              action families that take hours), exhaustive (TLC through Apalache's TLA+
#                              translation: every reachable state of the decided and contract instances, every
#                              mutation; TRACK_J_TLC_WORKERS default 2), mutations (Apalache: one bounded check
#                              per decided-rule mutation, each must report a violation), or all (default).
#                              Hours, not minutes: see RESULT.md.
# A mutation that does not fail fails the run. Wall times are in
# docs/realtime-latency/tracks/38-track-j-late-arrival-retirement-model/RESULT.md.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../../../.."
F=packages/protocol-v3/formal
SPEC=$F/settlement-replacement-retirement.qnt
INST=$F/settlement-replacement-retirement-instances.qnt
PROOFS=$F/settlement-replacement-retirement-proofs.qnt
EXH=$F/settlement-replacement-retirement-exhaustive.qnt
MUT=$F/settlement-replacement-retirement-mutations
WATCHDOG="$MUT/run-check.mjs"
q() {
  if [ -x node_modules/.bin/quint ]; then node "$WATCHDOG" node_modules/.bin/quint "$@"
  else node "$WATCHDOG" pnpm exec quint "$@"; fi
}
INVS="safety g1Count g1NoLeak planSound noPlanRefusal noCensusRefusal withinMaxScopes noProtectedHole"
CINVS="safety g1Count g1NoLeak planSound noPlanRefusal noCensusRefusal withinMaxScopes tMonotone proofHeld iNoLeak noIntentLoss"
CSAFE="safety planSound noPlanRefusal noCensusRefusal tMonotone proofHeld iNoLeak noIntentLoss"
SIMR="--step step --backend typescript --max-steps=30 --seed=7 --verbosity=1"

# One job of `formal`: kind file module [samples [args...]]. Logs to $TRACK_J_LOGS; prints one status line.
job() {
  local kind=$1 file=$2 main=$3; shift 3
  local log t0=$SECONDS
  log="$TRACK_J_LOGS/$kind-$main-$RANDOM$RANDOM.log"
  case $kind in
    tc) if q typecheck "$file" > "$log" 2>&1; then echo "ok   typecheck $file ($((SECONDS - t0)) s)"; return 0; fi ;;
    test) if q test "$file" --main "$main" --match 'Test$' --backend typescript --max-samples=1 > "$log" 2>&1 && grep -Eq "[1-9][0-9]* passing" "$log"; then
        echo "ok   tests $main ($((SECONDS - t0)) s)"; return 0; fi ;;
    sim) local n=$1; shift
      if q run "$file" --main "$main" $SIMR --max-samples="$n" "$@" > "$log" 2>&1 && grep -q "^\[ok\]" "$log" &&
        node "$MUT/check-witnesses.mjs" "$log" "$@"; then
        echo "ok   simulation $main ($n samples): every invariant holds ($((SECONDS - t0)) s)"; return 0; fi ;;
    mut) local n=$1 inv=$2 rc=0
      q run "$file" --main "$main" $SIMR --max-samples="$n" --invariants "$inv" > "$log" 2>&1 || rc=$?
      if [ "$rc" = 1 ] && grep -q '^\[violation\]' "$log"; then echo "ok   mutation $main violates $inv ($((SECONDS - t0)) s)"; return 0; fi
      echo "FAIL mutation $main: $inv not violated" ;;
  esac
  echo "FAIL $kind $main ($file); log follows"; tail -40 "$log"; return 1
}

formal() {
  TRACK_J_LOGS=${TRACK_J_LOGS:-$(mktemp -d)}; mkdir -p "$TRACK_J_LOGS"; export TRACK_J_LOGS
  local jobs=("test $PROOFS proofContractSafetyReducedA" "test $PROOFS proofContractSafetyAnyDelayExpireA"
    "test $PROOFS proofContractSafetyAnyDelayReviewA")
  jobs+=("tc $SPEC -" "tc $PROOFS -" "tc $EXH -")
  # The decided rules (rows 61-66), R7, W1 and (B); Track X's completion contract (contract* instances).
  for m in decidedW1A decidedW1AB decidedW1Mismatch todayPlanDropBA contractA contractSameReplicaA contractGuardedDropA \
    contractReviewA contractExpireA contractPreserveA; do jobs+=("test $INST $m"); done
  # Mutations, limits, remedies and controls: their deterministic tests assert each violation (or its absence).
  local t=(
    "no-r7 mutationNoR7" "fence-in-cut-control controlFenceInCut" "pre-r5 mutationPreR5" "r5-without-r5b mutationR5WithoutR5b"
    "r5-without-chain mutationR5WithoutChain" "a2-instead-of-b2 mutationA2InsteadOfB2" "r6-absent mutationR6Absent"
    "carrier-without-minus-own mutationCarrierWithoutMinusOwn" "today-window mutationTodayWindow"
    "w1-misses-beyond-max-scopes limitW1MissesBeyondMaxScopes"
    "fence-runs-beyond-max-scopes limitR7NoPacing" "fence-runs-beyond-max-scopes limitPacingBeyondMaxScopes"
    "fence-runs-beyond-max-scopes remedyPacing" "fence-runs-beyond-max-scopes remedyFrontierNoPacing"
    "fence-runs-beyond-max-scopes remedyReceiptNoPacing" "fence-runs-beyond-max-scopes remedyReceiptR7Truth"
    "a1-partial-cut-receipt mutationPartialReceiptToday" "a1-partial-cut-receipt mutationPartialReceiptW1"
    "a1-partial-cut-receipt candidateCarrierProof" "a2-expired-outside mutationExpiredOutsideToday"
    "a2-expired-outside mutationExpiredOutsideW1" "a2-expired-outside candidateExpireDone"
    "contract-without-f1 mutationContractWithoutF1" "contract-without-expire-settled mutationContractWithoutExpireSettled"
    "contract-volatile-authority mutationContractVolatileAuthority" "contract-volatile-authority mutationW1VolatileAuthority"
    "contract-under-decided-truth contractUnderDecidedTruth"
    "contract-fence-runs-beyond-max-scopes limitContractNoPacing" "contract-fence-runs-beyond-max-scopes limitContractPaceAtMaxScopes"
    "contract-either-drop-review contractEitherDropLeak" "contract-either-drop-review candidateSourceDrop"
    "contract-t-without-settled mutationContractTWithoutSettled" "contract-settled-without-t mutationContractSettledWithoutT"
    "contract-early-plan-drop mutationContractEarlyPlanDrop"
    "contract-no-old-incarnation mutationContractNoOldIncarnation" "contract-no-old-incarnation controlNoOldIncFreshReplica"
    "contract-seq-identity mutationContractSeqIdentity" "contract-seq-identity controlSeqIdentityDigest"
    "contract-proof-handoff mutationContractProofWithScope" "contract-proof-handoff controlProofConsumers"
    "contract-proof-handoff controlProofHandoff"
    "contract-cross-store-crash mutationContractRetireFirst" "contract-cross-store-crash mutationContractPlanFirst"
    "contract-cross-store-crash controlAtomicCommit" "contract-readmit-abandon mutationReadmitAbandon"
    "contract-guard-one-pass mutationGuardOnePass" "contract-guard-one-pass controlGuardFixpoint"
  )
  local e
  for e in "${t[@]}"; do set -- $e; jobs+=("test $MUT/$1.qnt $2"); done
  # Simulations: every invariant holds, with the witnesses reached (30 steps, seed 7).
  jobs+=("sim $INST decidedW1A 300 --invariants $INVS --witnesses reachedLateMove reachedDoubleMiss reachedTripleMiss reachedWholeInstallMiss reachedCrashThenCleanup reachedFenceDoubleMiss reachedFenceAndChain reachedOfflineAcrossWindow")
  jobs+=("sim $INST decidedW1AB 100 --invariants $INVS --witnesses reachedTwoWritersLate")
  jobs+=("sim $INST decidedW1PlanDropBA 300 --invariants $INVS --witnesses reachedTripleMiss")
  jobs+=("sim $INST decidedW1PlanDropBAB 100 --invariants $INVS --witnesses reachedTwoWritersLate")
  jobs+=("sim $MUT/fence-in-cut-control.qnt controlFenceInCut 200 --invariants $INVS")
  jobs+=("sim $MUT/fence-runs-beyond-max-scopes.qnt remedyReceiptNoPacing 200 --invariants $INVS --witnesses reachedLongFenceRun")
  jobs+=("sim $INST contractA 3000 --invariants $CINVS --witnesses reachedQuadMissCollected reachedCollectedBeforeLanding reachedPartialCollected reachedCrashThenCleanup reachedReadmitCollected reachedOldWorkExpired reachedJGoneIPresent reachedSeqCollision")
  jobs+=("sim $INST contractPreserveA 200 --invariants $CINVS --witnesses reachedExposedResolved")
  jobs+=("sim $INST contractReviewA 200 --invariants $CINVS --witnesses reachedReviewCollected")
  jobs+=("sim $INST contractExpireA 200 --invariants $CINVS --witnesses reachedExpiredCollected")
  jobs+=("sim $INST contractAB 100 --invariants $CINVS --witnesses reachedTwoWritersLate")
  jobs+=("sim $INST contractMismatchA 200 --invariants $CSAFE g1NoLeak withinMaxScopes")
  jobs+=("sim $INST contractGuardedDropA 200 --invariants $CSAFE --witnesses reachedReviewCollected")
  jobs+=("sim $INST contractSameReplicaA 200 --invariants $CINVS")
  jobs+=("sim $PROOFS proofContractSafetyAnyDelayA 200 --invariants indContract")
  jobs+=("sim $PROOFS proofContractSafetyAnyDelayReviewA 200 --invariants indContract")
  jobs+=("sim $MUT/contract-no-old-incarnation.qnt controlNoOldIncFreshReplica 200 --invariants $CSAFE")
  jobs+=("sim $MUT/contract-seq-identity.qnt controlSeqIdentityDigest 200 --invariants $CSAFE")
  jobs+=("sim $MUT/contract-proof-handoff.qnt controlProofHandoff 200 --invariants $CSAFE g1NoLeak withinMaxScopes")
  # Every mutation the simulator reaches violates its invariant (2000 samples; it stops at the first).
  local m=(
    "no-r7 mutationNoR7 g1NoLeak" "no-r7 mutationNoR7 noProtectedHole" "no-r7 mutationNoR7 noPlanRefusal"
    "no-r7 mutationNoR7 withinMaxScopes" "pre-r5 mutationPreR5 g1NoLeak" "r5-without-r5b mutationR5WithoutR5b g1NoLeak"
    "r5-without-chain mutationR5WithoutChain g1NoLeak" "a2-instead-of-b2 mutationA2InsteadOfB2 g1NoLeak"
    "r6-absent mutationR6Absent noCensusRefusal" "carrier-without-minus-own mutationCarrierWithoutMinusOwn g1NoLeak"
    "today-window mutationTodayWindow g1NoLeak" "today-window mutationTodayWindow noPlanRefusal"
    "w1-misses-beyond-max-scopes limitW1MissesBeyondMaxScopes withinMaxScopes"
    "fence-runs-beyond-max-scopes limitR7NoPacing withinMaxScopes"
    "fence-runs-beyond-max-scopes limitPacingBeyondMaxScopes withinMaxScopes"
    "fence-runs-beyond-max-scopes remedyFrontierNoPacing withinMaxScopes"
    "fence-runs-beyond-max-scopes remedyReceiptR7Truth safety"
    "a1-partial-cut-receipt mutationPartialReceiptToday g1NoLeak" "a1-partial-cut-receipt mutationPartialReceiptW1 withinMaxScopes"
    "a2-expired-outside mutationExpiredOutsideToday noCensusRefusal" "a2-expired-outside mutationExpiredOutsideW1 noCensusRefusal"
    "contract-without-f1 mutationContractWithoutF1 g1NoLeak"
    "contract-without-expire-settled mutationContractWithoutExpireSettled noCensusRefusal"
    "contract-volatile-authority mutationContractVolatileAuthority g1NoLeak"
    "contract-under-decided-truth contractUnderDecidedTruth safety"
    "contract-fence-runs-beyond-max-scopes limitContractNoPacing withinMaxScopes"
    "contract-t-without-settled mutationContractTWithoutSettled safety"
    "contract-settled-without-t mutationContractSettledWithoutT safety"
    "contract-early-plan-drop mutationContractEarlyPlanDrop noCensusRefusal"
    "contract-no-old-incarnation mutationContractNoOldIncarnation tMonotone"
    "contract-seq-identity mutationContractSeqIdentity safety"
    "contract-proof-handoff mutationContractProofWithScope proofHeld"
    "contract-proof-handoff mutationContractProofWithScope iNoLeak"
    "contract-cross-store-crash mutationContractRetireFirst noPlanRefusal"
    "contract-cross-store-crash mutationContractPlanFirst iNoLeak"
    "contract-readmit-abandon mutationReadmitAbandon noIntentLoss"
  )
  for e in "${m[@]}"; do set -- $e; jobs+=("mut $MUT/$1.qnt $2 2000 $3"); done
  echo "track-j formal: ${#jobs[@]} jobs, ${TRACK_J_JOBS:-2} in parallel; logs in $TRACK_J_LOGS"
  local start=$SECONDS
  if printf '%s\n' "${jobs[@]}" | xargs -P "${TRACK_J_JOBS:-2}" -L 1 bash "$SELF" job; then
    echo "track-j formal: every job passed ($((SECONDS - start)) s)"
  else
    echo "track-j formal: FAILED ($((SECONDS - start)) s)"; exit 1
  fi
}

# One Apalache run; expect "ok" (no violation) or "violation".
ap() {
  local expect=$1 label=$2; shift 2
  local log; log=$(mktemp "$TRACK_J_LOGS/verify.XXXXXX")
  local start=$SECONDS rc=0
  q verify "$@" > "$log" 2>&1 || rc=$?
  local got=none
  if [ "$rc" = 0 ] && grep -q '^\[ok\]' "$log"; then got=ok; fi
  if [ "$rc" = 1 ] && grep -q '^\[violation\]' "$log"; then got=violation; fi
  if [ "$got" != "$expect" ]; then
    tail -40 "$log"; echo "FAIL: $label: expected $expect, got $got"; exit 1
  fi
  echo "ok: $label: $got ($((SECONDS - start)) s); log: $log"
}

verify() {
  local part=${1:-all}
  case "$part" in proofs|exhaustive|mutations|all) ;; *) echo "unknown verify part: $part" >&2; exit 2 ;; esac
  TRACK_J_LOGS=${TRACK_J_LOGS:-$(mktemp -d)}; mkdir -p "$TRACK_J_LOGS"; export TRACK_J_LOGS
  echo "track-j verify: $part; logs: $TRACK_J_LOGS; per-check timeout: ${TRACK_J_TIMEOUT_SECONDS:-3600}s"
  export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
  export PATH="$JAVA_HOME/bin:$PATH"
  # Apalache's default heap (4 GB) runs out on the contract's inductive step.
  export JVM_ARGS="${JVM_ARGS:--Xmx16g}"
  local out; out=$(mktemp -d)
  printf '{"common":{"out-dir":"%s"}}\n' "$out" > "$out/apalache.json"
  local a="--backend apalache --apalache-version=${APALACHE_VERSION:-0.56.1} --apalache-config $out/apalache.json"
  if [ "$part" = all ] || [ "$part" = proofs ]; then
    # The decided rules + R7 + W1 (and (B)): every invariant, inductively (indInv = invariants + L0-L13).
    for m in proofSmallA proofSmallBA; do
      ap ok "$m base" "$PROOFS" --main "$m" $a --init init --step step --max-steps=0 --invariants indInv
      ap ok "$m step" "$PROOFS" --main "$m" $a --init indInit --step step --max-steps=1 --invariants indInv
    done
    ap violation "indInv admits rich states (non-vacuity)" \
      "$PROOFS" --main proofSmallA $a --init indInit --step step --max-steps=0 --invariants indRichStateAbsent
    # Safety under any delay (no delivery bound, partial cut receipt, mismatches): lemmas L0-L6 only.
    ap ok "proofSafetyAnyDelayA base" "$PROOFS" --main proofSafetyAnyDelayA $a --init init --step step --max-steps=0 --invariants indSafety
    ap ok "proofSafetyAnyDelayA step" "$PROOFS" --main proofSafetyAnyDelayA $a --init indInitSafety --step step --max-steps=1 --invariants indSafety
    # The completion contract (eitherGuarded + H2 consumers + H5 atomic, fresh replica on re-admission): its
    # safety class (indContract = indSafety + L8 + C1-C8 + planSound, noPlanRefusal, noCensusRefusal, I5,
    # proofHeld, iNoLeak, I3, g1NoLeak), inductively, with no delivery lemma, on the reduced instance (epochs
    # 0-3, sequences 0-4). One action family per run (their union is `step`); no enabledness query. The base
    # case and the move and seal families take minutes. The other three families take hours each on the
    # reduced instance and did not finish in the time measured (RESULT.md 7.3): TRACK_J_SLOW=1 runs them. TLC
    # (the exhaustive part) is the complete check of these instances.
    printf '{"common":{"out-dir":"%s"},"checker":{"discard-disabled":false}}\n' "$out" > "$out/nodiscard.json"
    local r=proofContractSafetyReducedA f fams="stepMove stepSeal"
    if [ "${TRACK_J_SLOW:-0}" = 1 ]; then fams="$fams stepOther stepRejoin stepInstall"; fi
    ap ok "$r base" "$PROOFS" --main $r $a --init init --step step --max-steps=0 --invariants indContract
    for f in $fams; do
      ap ok "$r step ($f)" "$PROOFS" --main $r --backend apalache --apalache-version="${APALACHE_VERSION:-0.56.1}" \
        --apalache-config "$out/nodiscard.json" --init indInitContract --step $f --max-steps=1 --invariants indContract
    done
    ap violation "indContract admits rich states (non-vacuity)" \
      "$PROOFS" --main $r $a --init indInitContract --step step --max-steps=0 --invariants indRichStateAbsent3
  fi
  if [ "$part" = all ] || [ "$part" = exhaustive ]; then
    # TLC (Apalache translates the spec to TLA+; TLC explores every reachable state): every run of any length
    # at each instance's bounds. The decided rules (every invariant and the proof hypothesis), the contract's
    # safety class with no delivery bound, its progress under the stated delivery assumptions, and every
    # mutation (each must be violated; breadth-first, so the reported trace is a shortest one).
    local tc; tc="$out/tlc.json"
    printf '{"workers":%s,"maxHeap":"-Xmx%s"}\n' "${TRACK_J_TLC_WORKERS:-2}" "${TRACK_J_TLC_HEAP:-8G}" > "$tc"
    export TMPDIR="$out"
    local t="--backend tlc --apalache-version=${APALACHE_VERSION:-0.56.1} --tlc-config $tc --init init --step step"
    local c="safety planSound noPlanRefusal noCensusRefusal tMonotone proofHeld iNoLeak noIntentLoss g1NoLeak"
    for m in proofSmallA proofSmallBA; do
      ap ok "$m (TLC, every invariant and indInv)" "$PROOFS" --main "$m" $t --invariants indInv $INVS
    done
    ap ok "proofSafetyAnyDelayA (TLC, indSafety)" "$PROOFS" --main proofSafetyAnyDelayA $t --invariants indSafety
    for m in proofContractSafetyAnyDelayA proofContractSafetyAnyDelayReviewA proofContractSafetyAnyDelayExpireA \
      proofContractSafetyReducedA; do
      ap ok "$m (TLC, indContract)" "$PROOFS" --main "$m" $t --invariants indContract
    done
    ap ok "proofContractSmallA (TLC, every invariant)" "$PROOFS" --main proofContractSmallA $t \
      --invariants allInvariants contractInvariants indContract
    ap ok "exhContractSafetyA5 (TLC, indContract)" "$EXH" --main exhContractSafetyA5 $t --invariants indContract
    ap ok "exhContractProgressA5 (TLC, every invariant)" "$EXH" --main exhContractProgressA5 $t \
      --invariants allInvariants contractInvariants indContract
    # This larger two-Writer graph did not finish after 12 hours. It is exploratory, not a completed
    # default gate; the bounded two-Writer simulations and mutation checks still run by default.
    if [ "${TRACK_J_LARGE:-0}" = 1 ]; then
      ap ok "exhContractSafetyAB (TLC, safety class)" "$EXH" --main exhContractSafetyAB $t --invariants $c
    fi
    ap violation "indContract admits rich states (TLC reaches one)" "$PROOFS" --main proofContractSafetyAnyDelayA $t \
      --invariants indRichStateAbsent
    local e m=(
      "no-r7 mutationNoR7Apalache g1NoLeak" "pre-r5 mutationPreR5Apalache g1NoLeak"
      "r6-absent mutationR6AbsentApalache noCensusRefusal"
      "carrier-without-minus-own mutationCarrierWithoutMinusOwnApalache g1NoLeak"
      "r5-without-chain mutationR5WithoutChainApalache g1NoLeak" "r5-without-r5b mutationR5WithoutR5bApalache g1NoLeak"
      "a2-instead-of-b2 mutationA2InsteadOfB2Apalache g1NoLeak" "today-window mutationTodayWindowApalache g1NoLeak"
      "w1-misses-beyond-max-scopes limitW1MissesBeyondMaxScopesApalache withinMaxScopes"
      "fence-runs-beyond-max-scopes limitR7NoPacingApalache withinMaxScopes"
      "a1-partial-cut-receipt mutationPartialReceiptTodayApalache g1NoLeak"
      "a2-expired-outside mutationExpiredOutsideTodayApalache noCensusRefusal"
      "contract-without-f1 mutationContractWithoutF1Apalache g1NoLeak"
      "contract-volatile-authority mutationContractVolatileAuthorityApalache g1NoLeak"
      "contract-without-expire-settled mutationContractWithoutExpireSettledApalache noCensusRefusal"
      "contract-under-decided-truth contractUnderDecidedTruthApalache safety"
      "contract-fence-runs-beyond-max-scopes limitContractNoPacingApalache withinMaxScopes"
      "contract-fence-runs-beyond-max-scopes limitContractPaceAtMaxScopesApalache withinMaxScopes"
      "contract-t-without-settled mutationContractTWithoutSettledApalache safety"
      "contract-settled-without-t mutationContractSettledWithoutTApalache safety"
      "contract-early-plan-drop mutationContractEarlyPlanDropApalache noCensusRefusal"
      "contract-no-old-incarnation mutationContractNoOldIncarnationApalache tMonotone"
      "contract-seq-identity mutationContractSeqIdentityApalache safety"
      "contract-proof-handoff mutationContractProofWithScopeApalache proofHeld"
      "contract-cross-store-crash mutationContractRetireFirstApalache noPlanRefusal"
      "contract-cross-store-crash mutationContractPlanFirstApalache iNoLeak"
      "contract-readmit-abandon mutationReadmitAbandonApalache noIntentLoss"
      "contract-either-drop-review contractEitherDropLeakSmall g1NoLeak"
      "contract-either-drop-review candidateSourceDropSmall noPlanRefusal"
      "contract-guard-one-pass mutationGuardOnePassSmall iNoLeak"
    )
    for e in "${m[@]}"; do
      set -- $e
      ap violation "$2 $3 (TLC)" "$MUT/$1.qnt" --main "$2" $t --invariants "$3"
    done
  fi
  if [ "$part" = all ] || [ "$part" = mutations ]; then
    # Apalache's bounded check of each decided-rule mutation (one seal and install per step). The contract's
    # mutations are checked by TLC (above): Apalache's bounded search on the contract's spec did not finish
    # depth 2 in 86 minutes (RESULT.md 7.5).
    local s="--init init --step stepMacro" e
    local m=(
      "no-r7 mutationNoR7Apalache 4 g1NoLeak" "pre-r5 mutationPreR5Apalache 5 g1NoLeak"
      "r6-absent mutationR6AbsentApalache 4 noCensusRefusal"
      "carrier-without-minus-own mutationCarrierWithoutMinusOwnApalache 5 g1NoLeak"
      "r5-without-chain mutationR5WithoutChainApalache 5 g1NoLeak" "r5-without-r5b mutationR5WithoutR5bApalache 6 g1NoLeak"
      "a2-instead-of-b2 mutationA2InsteadOfB2Apalache 7 g1NoLeak" "today-window mutationTodayWindowApalache 6 g1NoLeak"
      "w1-misses-beyond-max-scopes limitW1MissesBeyondMaxScopesApalache 6 withinMaxScopes"
      "fence-runs-beyond-max-scopes limitR7NoPacingApalache 5 withinMaxScopes"
      "a1-partial-cut-receipt mutationPartialReceiptTodayApalache 3 g1NoLeak"
      "a2-expired-outside mutationExpiredOutsideTodayApalache 5 noCensusRefusal"
    )
    for e in "${m[@]}"; do
      set -- $e
      ap violation "$2 $4 (depth <= $3)" "$MUT/$1.qnt" --main "$2" $a $s --max-steps="$3" --invariants "$4"
    done
  fi
}

case "${1:-}" in
  formal) formal ;;
  verify) shift; if [ "${1:-}" = "--" ]; then shift; fi; verify "${1:-all}" ;;
  job) shift; job "$@" ;;
  *) echo "usage: track-j.sh formal | verify [proofs|exhaustive|mutations|all]"; exit 2 ;;
esac
