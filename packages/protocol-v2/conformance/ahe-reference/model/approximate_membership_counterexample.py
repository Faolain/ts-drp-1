#!/usr/bin/env python3
"""Minimal counterexample: approximate covered-history membership is not a semantic oracle.

A compact replica that gets a Bloom-filter false positive can permanently reject a valid
current-epoch child.  A full replica (or a compact replica without that false positive)
parks the same child, later receives its parent, and accepts it.  Therefore false positives
are convergence faults, not merely cache misses.
"""
from __future__ import annotations

import argparse
import json


def classify(*, dependency_known: bool, approximate_says_covered: bool) -> str:
    if dependency_known:
        return "accept"
    if approximate_says_covered:
        return "terminal-covered"
    return "pending"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    initial_false_positive = classify(dependency_known=False, approximate_says_covered=True)
    initial_exact = classify(dependency_known=False, approximate_says_covered=False)
    after_parent_false_positive = initial_false_positive  # terminal decisions cannot be undone safely
    after_parent_exact = classify(dependency_known=True, approximate_says_covered=False)
    result = {
        "model": "approximate-covered-membership-counterexample-v1",
        "initial": {
            "compact_replica_with_false_positive": initial_false_positive,
            "replica_without_false_positive": initial_exact,
        },
        "after_valid_parent_arrives": {
            "compact_replica_with_false_positive": after_parent_false_positive,
            "replica_without_false_positive": after_parent_exact,
        },
        "diverges": after_parent_false_positive != after_parent_exact,
        "conclusion": "Bloom/cuckoo/XOR filters cannot replace the exact covered-hash set in an admission rule. Merkle membership works only when a proof is supplied, so it also cannot classify an unknown dependency by itself.",
        "verdict": "counterexample-found",
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
