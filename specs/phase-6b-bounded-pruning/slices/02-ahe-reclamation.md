# D.109c — AHE Generation and Blob Reclamation

Keep the mandatory `AheDurableStore` contract unchanged. Node/browser adapters
add a separate package maintenance capability resolved by object identity only
for their genuine concrete stores. The verified plan supplies exact generation
identities; the store must not sort random generation IDs as chronology. The
retained rollback set is exactly the two rows reached by following
`baseExpectedHead` twice from the active adopted generation, and both complete
closures must remain readable. Two other countable superseded generations do
not satisfy the contract. In one owner transaction it rechecks the expected
head/revision, active generation, that exact ancestor pair, selected superseded
generations, closures, and promotion/reference graph.

Only then may it delete selected superseded generation rows and promotions and
garbage-collect blobs with no remaining generation reference. Because blobs
are globally content-addressed across objects and neither backend has a reverse
index, the transaction decodes and scans every remaining generation closure
across every object plus remaining promotion rows before deleting any candidate
blob. This first implementation is explicitly O(total retained generation
metadata); no reverse-index schema is implied, and measured need is required
before adding one. The active generation and its two immediate rollback
ancestors remain complete. RED covers changed head, changed closure, shared
blobs, duplicate identities, insufficient rollbacks, a wrong-but-countable
non-ancestor pair, every crash edge, reopen, idempotence, and unrelated objects.
Node, browser, memory conformance, request inventory, schema authority, and
recovery tests remain aligned. GREEN returns an immutable AHE receipt.
