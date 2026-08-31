# D.109c — AHE Generation and Blob Reclamation

Keep the mandatory `AheDurableStore` contract unchanged. Node/browser adapters
add a separate package maintenance capability resolved by object identity only
for their genuine concrete stores. The verified plan supplies exact generation
identities; the store must not sort random generation IDs as chronology. In one
owner transaction it rechecks the expected head/revision, active generation,
exact retained rollback set, selected superseded generations, closures, and
promotion/reference graph.

Only then may it delete selected superseded generation rows and promotions and
garbage-collect blobs with no remaining generation reference. Because blobs
are globally content-addressed across objects and neither backend has a reverse
index, the transaction decodes and scans every remaining generation closure
across every object plus remaining promotion rows before deleting any candidate
blob. This first implementation is explicitly O(total retained generation
metadata); no reverse-index schema is implied, and measured need is required
before adding one. The active generation and at least two distinct usable
rollbacks remain complete. RED
covers changed head, changed closure, shared blobs, duplicate identities,
insufficient rollbacks, every crash edge, reopen, idempotence, and unrelated
objects. Node, browser, memory conformance, request inventory, schema authority,
and recovery tests remain aligned. GREEN returns an immutable AHE receipt.
