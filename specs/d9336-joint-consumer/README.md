# D.93.36 Durable Live Composition

Status: design locked; Slice 00 is next.

## Goal

Compose the shipped protocol-v3 authorization, admission, issuance, live-journal,
causality and transport owners into one durable live path. The first checkpoint
proves that a genuine authorized local commit can be recovered, authenticated,
journaled and indexed before any network or application effect.

The product checkpoint is two real clients that join the same room, exchange
visible durable operations, reconnect from their stores and converge again.

## Principles

- `packages/node/src/v3-live.ts` remains the sole composition owner. No parallel
  coordinator or second durable replica store is introduced.
- Authorization comes only from the genuine P6 capability. A caller-provided
  key resolver, creator shortcut or structural authorization object is not an
  authority.
- Retained journal and issuance bytes are carriers. Every recovered vertex is
  re-authenticated through the same admission path used for received vertices.
- Recovery completes before subscription, publication, reducer, sink or other
  observable effects.
- One retained `CausalityIndex` and one serialized apply gate order recovery,
  ingress, future local issue and publication work.
- The journal precedes the index; the index precedes visible effects.
- Published and pending outbox entries are both recovery candidates. Publication
  state controls egress only, never admission.
- Durable low-frequency operations such as chat messages and world edits use
  this path. Ephemeral movement, aim and physics do not.

## Slice graph

- [00 — authorized durable recovery](slices/00-authorized-durable-recovery.md)
- [01 — complete replay and reconciliation](slices/01-replay-and-reconciliation.md)
- [02 — serialized activation and ingress](slices/02-serialized-activation.md)
- [03 — local issue, apply and publish](slices/03-local-issue-apply.md)
- [04 — two-client room exchange](slices/04-two-client-room.md)
- [05 — reconnect and converge](slices/05-reconnect-converge.md)

## Scope firewall

This work does not alter protocol-v3 authorization, freeze policy, registries,
wire codecs, journal or issuance schemas, historical governance, epoch advance,
ACL rotation, archive, compaction, reducer semantics or Phase 3b. The node root
export stays closed until a later slice deliberately adds a narrow product
facade.

The existing legacy chat proves a different plane and is not D.93.36 evidence.
A dedicated v3 artifact will carry the two-client checkpoint.

## Verdict boundary

D.93.36 proves durable accepted-operation recovery and convergence. It does not
yet prove general missed-history synchronization, dynamic writer grants,
application reducer correctness or the broader product.
