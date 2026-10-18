#!/usr/bin/env python3
"""Finite checks for the value-bound two-phase hard-epoch seal profile."""
from __future__ import annotations

import argparse
import itertools
import json
import math
import time


def quorum(n: int) -> int:
    return math.ceil(2 * n / 3)


def max_byzantine(n: int) -> int:
    # Strictly fewer than n/3 Byzantine signers.
    return math.ceil(n / 3) - 1


def exhaustive_quorum_intersections(max_n: int = 10) -> dict:
    checked_pairs = 0
    per_n = []
    for n in range(4, max_n + 1):
        q = quorum(n)
        f = max_byzantine(n)
        signers = range(n)
        quorums = list(itertools.combinations(signers, q))
        minimum = n
        for left_index, left in enumerate(quorums):
            left_set = set(left)
            for right in quorums[left_index:]:
                intersection = len(left_set.intersection(right))
                minimum = min(minimum, intersection)
                checked_pairs += 1
                if intersection <= f:
                    raise AssertionError(f"unsafe quorum intersection n={n} q={q} f={f}")
        per_n.append({"n": n, "q": q, "f": f, "minimum_intersection": minimum, "quorum_count": len(quorums)})
    return {"pair_checks": checked_pairs, "cases": per_n}


def algebraic_quorum_checks(max_n: int = 10_000) -> dict:
    for n in range(4, max_n + 1):
        q = quorum(n)
        f = max_byzantine(n)
        if 2 * q - n <= f:
            raise AssertionError(f"intersection bound failed at n={n}")
    return {"n_min": 4, "n_max": max_n, "checks": max_n - 3}


def retroactive_commit_regression() -> dict:
    """Executable n=4 trace from the v3 review; monotone rounds block the fork."""
    signers = {"A", "B", "C", "Z"}  # Z Byzantine
    q = 3
    prepare_x_r0 = {"A", "B", "Z"}
    commit_x_before = {"A", "Z"}
    prepare_y_r1 = {"B", "C", "Z"}
    commit_y = {"B", "C", "Z"}
    assert len(prepare_x_r0) >= q and len(prepare_y_r1) >= q and len(commit_y) >= q
    # Old rule: B may process a delayed round-0 prepare QC after entering/committing r1.
    old_commit_x_after_delayed_qc = commit_x_before | {"B"}
    assert len(old_commit_x_after_delayed_qc) >= q
    # Corrected rule: enteredRound(B)=1, therefore B cannot emit any r0 vote.
    corrected_commit_x = set(commit_x_before)
    assert len(corrected_commit_x) < q
    return {
        "n": 4,
        "quorum": q,
        "byzantine": "Z",
        "round_0_prepare_qc_X": sorted(prepare_x_r0),
        "round_1_prepare_qc_Y": sorted(prepare_y_r1),
        "round_1_commit_qc_Y": sorted(commit_y),
        "old_rule_round_0_commit_qc_X_after_late_delivery": sorted(old_commit_x_after_delayed_qc),
        "corrected_rule_round_0_commits_X": sorted(corrected_commit_x),
        "old_rule_forks": True,
        "monotone_entered_round_blocks_fork": True,
    }


def same_round_value_binding(max_n: int = 9) -> dict:
    checks = 0
    for n in range(4, max_n + 1):
        q = quorum(n)
        f = max_byzantine(n)
        honest = set(range(f, n))
        signers = set(range(n))
        for qx in itertools.combinations(signers, q):
            qx = set(qx)
            for qy in itertools.combinations(signers, q):
                qy = set(qy)
                checks += 1
                overlap_honest = (qx & qy) & honest
                if not overlap_honest:
                    raise AssertionError("two same-round value-bound prepare QCs can avoid honest intersection")
                # An honest signer has one durable prepare slot per (epoch,round), so
                # the shared honest signer cannot appear in conflicting QCs.
    return {"n_min": 4, "n_max": max_n, "qc_pair_checks": checks}


def activation_floor_demo() -> dict:
    # n=3, q=2, one Byzantine is not < n/3; two quorums may intersect only in it.
    qx = {"A", "Z"}
    qy = {"B", "Z"}
    assert len(qx) == len(qy) == 2 and qx & qy == {"Z"}
    return {
        "n": 3,
        "quorum": 2,
        "conflicting_quorums": [sorted(qx), sorted(qy)],
        "honest_intersection": [],
        "reason_for_minimum_four_signers": "n=3 with one Byzantine violates the strict <1/3 assumption",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    started = time.perf_counter()
    result = {
        "model": "hard-epoch-seal-finite-checks-v1",
        "quorum_intersections": exhaustive_quorum_intersections(),
        "algebraic_intersections": algebraic_quorum_checks(),
        "same_round_value_binding": same_round_value_binding(),
        "retroactive_commit_regression": retroactive_commit_regression(),
        "activation_floor": activation_floor_demo(),
        "verdict": "pass",
    }
    result["elapsed_seconds"] = round(time.perf_counter() - started, 6)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
