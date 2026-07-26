#!/usr/bin/env python3
"""Transparent storage scaling comparison for the reviewed designs."""
from __future__ import annotations

import argparse
import json
import math


def human(value: int) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    amount = float(value)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.2f} {unit}"
        amount /= 1024
    raise AssertionError


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--average-vertex-bytes", type=int, default=512)
    parser.add_argument("--active-tail-vertices", type=int, default=8192)
    parser.add_argument("--snapshot-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--authority-changes", type=int, default=100)
    args = parser.parse_args()

    rows = []
    for vertices in (1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000):
        full = vertices * args.average_vertex_bytes
        aec_v31 = min(vertices, args.active_tail_vertices) * args.average_vertex_bytes + vertices * 32 + args.snapshot_bytes
        # Hard-epoch compact peer retains current state/tail, a Merkle accumulator with
        # at most ceil(log2 N)+1 peaks, two rollback descriptors, and the authority
        # handoff chain (which grows with governance changes, not message volume).
        merkle_peaks = (math.ceil(math.log2(max(vertices, 1))) + 1) * 32
        authority_chain = args.authority_changes * 2048
        hard_epochs = (
            min(vertices, args.active_tail_vertices) * args.average_vertex_bytes
            + args.snapshot_bytes
            + merkle_peaks
            + authority_chain
            + 2 * 16 * 1024
        )
        rows.append({
            "vertices": vertices,
            "full_history_bytes": full,
            "full_history_human": human(full),
            "aec_v3_1_compact_peer_bytes": aec_v31,
            "aec_v3_1_compact_peer_human": human(aec_v31),
            "hard_epoch_compact_peer_bytes": hard_epochs,
            "hard_epoch_compact_peer_human": human(hard_epochs),
            "aec_covered_hash_bytes": vertices * 32,
            "hard_epoch_merkle_peak_bytes": merkle_peaks,
        })
    result = {
        "assumptions": {
            "average_vertex_bytes": args.average_vertex_bytes,
            "active_tail_vertices": args.active_tail_vertices,
            "snapshot_bytes": args.snapshot_bytes,
            "authority_changes_retained": args.authority_changes,
            "authority_handoff_bytes_each": 2048,
            "note": "Wire/index/state-clone overhead is excluded, so full-history numbers are conservative. AEC v3.1 includes its mandatory 32-byte covered-hash oracle. Hard epochs assume compact peers keep only current state/tail, Merkle peaks, rollback artifacts, and governance handoffs; archives/mirrors retain payload history.",
        },
        "rows": rows,
        "verdict": "AEC v3.1 bounds replay but remains O(total vertices); hard-epoch compact-peer storage is independent of message history at fixed state/tail and governance-change counts.",
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
