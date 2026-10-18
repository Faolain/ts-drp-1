# Slice E5-00: Canonical Co-Signed Intent

## Contract

Every counterparty signs the same canonical durable outcome intent, and altered
or ambiguous proofs fail before product integration.

## API seam

Create `@ts-drp/outcome-commit` with canonical intent preparation, strict
signature verification, and operation construction. Bind object ID, current
anchor/ACL digest, epoch, outcome kind, payload digest, sorted unique
counterparties and `clientOperationId`. Domain-separate the exact canonical
bytes. The outer vertex signature does not count as a counterparty approval.

The first product fixture is a same-zone two-party trade. Cross-object
conservation is out of scope.

## TDD and acceptance

Cover exact two-party success; missing, duplicate, foreign and extra signer;
wrong object/epoch/anchor/ACL/payload; altered ordering; malformed signature;
oversized proof; replay ID; and same ID with a different intent. Target: <15
seconds.

## Human surface

Extend the fabric workbench with a reviewable trade intent and approval status.
No durable application occurs in this slice. Run screenshot critique and the
non-blocking preview window.

## Must stay green

E3/E4, room reconnect, current ACL semantics, and all durable admission owners.

## Feedback that changes this slice

Payload schema and product language may change. Signature scope and canonical
identity may not be weakened.
