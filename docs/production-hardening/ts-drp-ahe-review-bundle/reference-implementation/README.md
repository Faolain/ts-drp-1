# Attested Hard Epochs: executable reference

This directory is an independent, browser-first reference model for the compaction design recommended in the accompanying review of `Faolain/ts-drp-1` at commit `bf7d3516f6ed4be97a755698b4fb3a404e04dc0f`.

It is not a drop-in replacement for the repository packages. It exists to make the proposed invariants executable before the protocol is integrated behind a new protocol-major version.

## What it implements

- deterministic, domain-separated vertex/cut/anchor hashes;
- a strict canonical JavaScript value profile suitable for browser snapshots;
- hard epoch envelopes: every vertex commits to object, protocol version, epoch, and epoch anchor;
- objective stale-history admission without a lifetime covered-hash database;
- bounded non-semantic pending queues;
- deterministic min-hash Kahn linearization and antichain dependency checks;
- staged application/ACL folds with authority latched at the epoch anchor;
- content-addressed snapshot chunks and manifests;
- content-addressed chat/archive segments plus a Merkle index for demand-loaded history;
- RFC 9162-style Merkle inclusion and consistency proofs, and an O(log N) compact accumulator;
- value-bound prepare/commit quorum certificates, durable vote-slot semantics, monotone rounds, and lock checks;
- an IndexedDB staging journal, immutable vote slots, and one-pointer epoch adoption;
- cooperative scheduling and a Web Worker/IndexedDB browser harness.

## Validation commands

```bash
npm test
npm run model
npm run bench
npm run browser
```

`npm run browser` serves the module harness on localhost and drives Chromium through Playwright. The supplied execution environment has an enterprise `URLBlocklist=*` policy, so that one run is recorded as `blocked`, not `pass` or `fail`. The same harness is ready for a normal secure browser profile.

## Current evidence

At packaging time:

- 22/22 Node tests pass;
- the core source has approximately 91% line coverage (the browser-only IndexedDB adapter is exercised by the separate browser harness rather than the Node suite);
- 5,231 admissible dependency-antichain DAGs through seven vertices are exhaustively checked;
- 10,000 randomized epochs and 20,000 hostile delivery schedules converge;
- 11,612 quorum-pair intersections and 8,547 same-round QC pairs are checked;
- a concrete legacy DFS/synthetic-root contraction counterexample is reproduced;
- a Bloom/cuckoo/XOR-filter false-positive divergence is reproduced;
- a static browser audit finds no Node built-ins, CommonJS, synchronous XHR, `eval`, web-storage dependency, wall-clock semantic decision, random semantic decision, or `JSON.stringify` hashing in the protocol core.

All generated evidence is under `../results/` in the review bundle.

## Important boundaries

This reference demonstrates safety-critical data structures and transition rules, but it is not a production consensus implementation. Production integration still requires:

1. a formally modeled pacemaker/round-change protocol (TLA+, Quint, or equivalent);
2. repository-specific wire codecs, signature adapters, networking, migration, and observability;
3. crash/fault injection against real IndexedDB implementations;
4. Chrome, Firefox, Safari, Android, and iOS browser matrix testing;
5. a security review of canonical encoding, signature handling, authorization, and data-availability policy.

The recommended production codec is a frozen deterministic CBOR profile. The bespoke codec in this reference is intentionally small and adversarially tested, but should be treated as executable specification material rather than a new ecosystem codec.

## Module map

| Module | Purpose |
|---|---|
| `src/protocol.js` | vertex, cut, anchor, signer-set, and parameter commitments |
| `src/admission.js` | objective accept/pending/terminal classification and bounded pending |
| `src/linearize.js` | deterministic Kahn order, causality index, conflict policies |
| `src/state.js` | deterministic state machine, safe clone/replace, digest |
| `src/fold.js` | staged application/ACL fold and atomic adoption boundary |
| `src/snapshot.js` | snapshot payload, chunks, manifest, and verification |
| `src/archive.js` | immutable historical segments and Merkle-index proofs |
| `src/ct-merkle.js` | RFC 9162-style Merkle operations and compact accumulator |
| `src/seal.js` | value-bound votes, QCs, lock and monotone-round safety core |
| `src/indexeddb-store.js` | vote CAS, snapshot journal, and epoch pointer adoption |
| `src/runtime.js` | cooperative browser work slicing |
| `browser/` | WebCrypto, Worker responsiveness, IndexedDB race/commit harness |
| `model/` | independent Python models and storage/browser audits |

## Suggested repository integration boundary

Create a new protocol-major package rather than modifying legacy hashes in place:

```text
packages/
  protocol-v2/          canonical envelopes, descriptors, QCs
  compaction/           close/fold/snapshot/history commitments
  storage-browser/      IndexedDB journal and archive cache
  sync-v2/              snapshot/chunk/tail reconciliation
```

Legacy rooms should remain on the old topic/hash namespace. A migration record must be explicitly signed by the legacy creator/current authority and create a new v2 genesis anchor; silently accepting both preimages in one object would make identity and admission ambiguous.
