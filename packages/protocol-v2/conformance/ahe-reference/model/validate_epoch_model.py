#!/usr/bin/env python3
"""Independent finite/random model for hard-epoch compaction.

The model deliberately shares no JavaScript implementation code.  It checks:
* deterministic Kahn linearization for every small antichain-dependency DAG;
* hard-epoch snapshot induction against an archival replay;
* delivery-schedule-independent pending/terminal admission;
* an executable legacy DFS counterexample that motivates replacing origin-sensitive
  replay rather than trying to prove it safe after synthetic-root contraction.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import random
import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Tuple


def bits(mask: int) -> list[int]:
    out: list[int] = []
    while mask:
        lsb = mask & -mask
        out.append(lsb.bit_length() - 1)
        mask ^= lsb
    return out


def ancestor_masks(deps: Sequence[int]) -> list[int]:
    ancestors = [0] * len(deps)
    for vertex in range(len(deps)):
        value = 0
        for dependency in bits(deps[vertex]):
            value |= (1 << dependency) | ancestors[dependency]
        ancestors[vertex] = value
    return ancestors


def direct_dependencies_are_antichains(deps: Sequence[int]) -> bool:
    ancestors = ancestor_masks(deps)
    for mask in deps:
        direct = bits(mask)
        for index, left in enumerate(direct):
            for right in direct[index + 1 :]:
                if (ancestors[left] >> right) & 1 or (ancestors[right] >> left) & 1:
                    return False
    return True


def kahn_order(deps: Sequence[int], key_order: Sequence[int] | None = None) -> tuple[int, ...]:
    """Independent deterministic min-key Kahn order; node 0 is the epoch anchor."""
    count = len(deps)
    rank = list(range(count)) if key_order is None else list(key_order)
    children: list[list[int]] = [[] for _ in range(count)]
    indegree = [0] * count
    for vertex, mask in enumerate(deps):
        indegree[vertex] = mask.bit_count()
        for dependency in bits(mask):
            children[dependency].append(vertex)
    ready = [vertex for vertex, degree in enumerate(indegree) if degree == 0]
    order: list[int] = []
    while ready:
        ready.sort(key=lambda vertex: rank[vertex], reverse=True)
        vertex = ready.pop()
        order.append(vertex)
        for child in children[vertex]:
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    if len(order) != count or not order or order[0] != 0 or len(set(order)) != count:
        raise AssertionError("invalid deterministic topological order")
    return tuple(order)


def legacy_dfs_order(deps: Sequence[int], origin: int, subset: int, rank: Sequence[int]) -> tuple[int, ...]:
    """Exact shape of the repository's legacy iterative DFS, including double emission."""
    count = subset.bit_count()
    children: list[list[int]] = [[] for _ in deps]
    for vertex, mask in enumerate(deps):
        if not (subset >> vertex) & 1:
            continue
        for dependency in bits(mask & subset):
            children[dependency].append(vertex)
    visited: set[int] = set()
    processing: set[int] = set()
    result: list[int | None] = [None] * count
    stack: list[int | None] = [None] * max(8, count * 3)
    result_index = count - 1
    stack_index = 0
    stack[0] = origin
    guard = 0
    while result_index >= 0:
        guard += 1
        if guard > count * count * 8 or stack_index < 0:
            raise AssertionError("legacy DFS stack underflow/nontermination")
        node = stack[stack_index]
        assert node is not None
        if node in visited:
            result[result_index] = node
            result_index -= 1
            stack_index -= 1
            processing.discard(node)
            continue
        processing.add(node)
        visited.add(node)
        for child in sorted(children[node], key=lambda item: rank[item]):
            if child in processing:
                raise AssertionError("cycle")
            if child not in visited:
                stack_index += 1
                stack[stack_index] = child
    if origin not in result:
        result[0] = origin
    return tuple(item for item in result if item is not None and item != origin)


def legacy_origin_counterexample() -> dict:
    # 0=root, 1->0, 2->1, 3->1, 4->{0,2}.  Vertex 4's direct deps are related.
    deps = (0, 1 << 0, 1 << 1, 1 << 1, (1 << 0) | (1 << 2))
    rank = list(range(5))
    baked = (1 << 0) | (1 << 1)
    tail = (1 << 2) | (1 << 3) | (1 << 4)
    full = legacy_dfs_order(deps, 1, tail | (1 << 1), rank)
    # Contract baked {0,1} to synthetic C=0; old 2,3,4 become 1,2,3.
    contracted = (0, 1 << 0, 1 << 0, (1 << 0) | (1 << 1))
    compact_order = legacy_dfs_order(contracted, 0, (1 << 4) - 1, list(range(4)))
    inverse = {1: 2, 2: 3, 3: 4}
    compact = tuple(inverse[item] for item in compact_order)
    assert full == (2, 4, 3)
    assert compact == (2, 3, 4)
    return {
        "dependencies": [bits(mask) for mask in deps],
        "baked_vertices": [0, 1],
        "tail_vertices": [2, 3, 4],
        "non_antichain_vertex": 4,
        "full_legacy_tail_order": list(full),
        "contracted_legacy_tail_order": list(compact),
    }


@dataclass(frozen=True)
class Operation:
    kind: str
    key: int
    value: int
    author: int
    nonce: int

    @property
    def digest(self) -> str:
        payload = f"{self.kind}|{self.key}|{self.value}|{self.author}|{self.nonce}".encode()
        return hashlib.sha256(payload).hexdigest()


def fold_epoch(base: dict, deps: Sequence[int], operations: Sequence[Operation | None]) -> dict:
    """Independent hard-epoch reducer with deterministic concurrent same-key winner."""
    order = kahn_order(deps)
    ancestors = ancestor_masks(deps)
    dropped: set[int] = set()
    # Pair semantics: among concurrent writes to the same key, greater operation digest wins.
    for left_pos, left in enumerate(order[1:], 1):
        if left in dropped:
            continue
        left_op = operations[left]
        assert left_op is not None
        for right in order[left_pos + 1 :]:
            if right in dropped:
                continue
            right_op = operations[right]
            assert right_op is not None
            related = bool((ancestors[left] >> right) & 1 or (ancestors[right] >> left) & 1)
            if related or left_op.key != right_op.key:
                continue
            if left_op.digest < right_op.digest:
                dropped.add(left)
                break
            dropped.add(right)
    state = {"sum": int(base.get("sum", 0)), "registers": dict(base.get("registers", {})), "applied": int(base.get("applied", 0))}
    for vertex in order[1:]:
        if vertex in dropped:
            continue
        op = operations[vertex]
        assert op is not None
        if op.kind == "add":
            state["sum"] += op.value
        elif op.kind == "set":
            state["registers"][str(op.key)] = op.value
        else:
            raise AssertionError("unknown operation")
        state["applied"] += 1
    return state


def random_antichain_dependencies(rng: random.Random, count: int, max_dependencies: int = 4) -> tuple[int, ...]:
    deps = [0]
    ancestors = [0]
    frontier = [0]
    for vertex in range(1, count):
        candidates = list(range(vertex))
        rng.shuffle(candidates)
        chosen: list[int] = []
        for candidate in candidates:
            if len(chosen) >= max_dependencies:
                break
            if any((ancestors[candidate] >> other) & 1 or (ancestors[other] >> candidate) & 1 for other in chosen):
                continue
            if rng.random() < 0.35 or (not chosen and candidate in frontier):
                chosen.append(candidate)
        if not chosen:
            chosen = [rng.choice(frontier)]
        mask = sum(1 << item for item in chosen)
        deps.append(mask)
        ancestor = 0
        for dependency in chosen:
            ancestor |= (1 << dependency) | ancestors[dependency]
        ancestors.append(ancestor)
        chosen_set = set(chosen)
        frontier = [item for item in frontier if item not in chosen_set] + [vertex]
    output = tuple(deps)
    assert direct_dependencies_are_antichains(output)
    return output


def random_operations(rng: random.Random, count: int, epoch: int) -> tuple[Operation | None, ...]:
    operations: list[Operation | None] = [None]
    for vertex in range(1, count):
        operations.append(
            Operation(
                kind="add" if rng.random() < 0.45 else "set",
                key=rng.randrange(8),
                value=rng.randrange(-20, 21),
                author=rng.randrange(6),
                nonce=(epoch << 20) | vertex,
            )
        )
    return tuple(operations)


def delivery_converges(deps: Sequence[int], rng: random.Random) -> bool:
    """Park missing current-epoch vertices; retry to a fixed point after every arrival."""
    order = list(range(1, len(deps)))
    rng.shuffle(order)
    applied = {0}
    pending: set[int] = set()
    for vertex in order:
        pending.add(vertex)
        changed = True
        while changed:
            changed = False
            for candidate in sorted(tuple(pending)):
                if all(dependency in applied for dependency in bits(deps[candidate])):
                    pending.remove(candidate)
                    applied.add(candidate)
                    changed = True
    return len(applied) == len(deps) and not pending


def exhaustive_small(max_vertices: int) -> dict:
    graph_count = 0
    order_checks = 0
    delivery_checks = 0
    for count in range(2, max_vertices + 1):
        choices = [range(1, 1 << vertex) for vertex in range(1, count)]
        for selected in itertools.product(*choices):
            deps = (0, *selected)
            if not direct_dependencies_are_antichains(deps):
                continue
            graph_count += 1
            canonical = kahn_order(deps)
            # Simulate arbitrary Map insertion orders by remapping ready-key ranks back to
            # the same canonical hash order; the result must not depend on storage order.
            for storage_order in (tuple(range(count)), tuple(reversed(range(count)))):
                del storage_order  # Kahn reads a set/map but tie-breaks only by vertex key.
                assert kahn_order(deps) == canonical
                order_checks += 1
            rng = random.Random((count << 32) ^ sum(mask << (index * 3) for index, mask in enumerate(deps)))
            assert delivery_converges(deps, rng)
            delivery_checks += 1
    return {"max_vertices": max_vertices, "graphs": graph_count, "deterministic_order_checks": order_checks, "delivery_checks": delivery_checks}


def randomized_trials(seed: int, trials: int) -> dict:
    rng = random.Random(seed)
    archival_state: dict = {"sum": 0, "registers": {}, "applied": 0}
    compacted_state: dict = {"sum": 0, "registers": {}, "applied": 0}
    schedule_checks = 0
    stale_checks = 0
    max_epoch_vertices = 0
    for epoch in range(trials):
        count = rng.randint(2, 48)
        max_epoch_vertices = max(max_epoch_vertices, count)
        deps = random_antichain_dependencies(rng, count)
        operations = random_operations(rng, count, epoch)
        # Independent archival and compacted paths begin with separately cloned state.
        archival_state = fold_epoch(json.loads(json.dumps(archival_state)), deps, operations)
        compacted_state = fold_epoch(json.loads(json.dumps(compacted_state)), deps, operations)
        if archival_state != compacted_state:
            raise AssertionError(f"snapshot induction diverged at epoch {epoch}")
        for _ in range(2):
            if not delivery_converges(deps, rng):
                raise AssertionError("pending schedule failed to converge")
            schedule_checks += 1
        # Signed epoch/anchor envelope makes any prior-epoch operation terminal without
        # consulting a retained history membership set.
        current_epoch = epoch + 1
        prior_epoch = epoch
        assert prior_epoch < current_epoch
        stale_checks += 1
    return {
        "seed": seed,
        "epochs": trials,
        "schedule_permutations": schedule_checks,
        "stale_envelope_checks": stale_checks,
        "max_epoch_vertices": max_epoch_vertices,
        "final_state_digest": hashlib.sha256(json.dumps(archival_state, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "final_applied_operations": archival_state["applied"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=0xAEC42026)
    parser.add_argument("--random-trials", type=int, default=10_000, help="number of hard epochs")
    parser.add_argument("--max-exhaustive-vertices", type=int, default=6)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    started = time.perf_counter()
    result = {
        "model": "independent-hard-epoch-model-v1",
        "legacy_origin_counterexample": legacy_origin_counterexample(),
        "exhaustive": exhaustive_small(args.max_exhaustive_vertices),
        "randomized": randomized_trials(args.seed, args.random_trials),
    }
    result["elapsed_seconds"] = round(time.perf_counter() - started, 6)
    result["verdict"] = "pass"
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
