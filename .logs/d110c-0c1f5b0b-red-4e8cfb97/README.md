# D.110c-0c1f5b0b final identity-corrected tests-only RED

Signed tests-only commit `4e8cfb972c983914b17aa72c09030b050c269123`
corrects the demonstrated source-identity mistake without changing production.
The same-store sequence-zero source row has no pinned-genesis or activation
identity, so settlement enumeration now asserts that ordinary row first and
the intended sequence-one row next. The sequence-one published, causalJoin,
join, ACL, and settlement-control semantics remain asserted.

The fixture adds one bounded `rebaseReadLimit` test option (1 through 16) and
otherwise preserves its default one-read behavior. Legacy pending-only
behavior is unchanged. The former same-store activation control is replaced by
the existing genuine cross-object activation scenario, which passed while
proving that the authenticated activation digest is excluded and both later
source rows are surfaced.

The single authorized combined RED selected 39 tests: 25 passed, 14 failed
causally, and 0 were skipped. There were no import, setup, fixture,
source-shape, or top-level failures. The Node experimental-SQLite warning was
the only stderr diagnostic.

`prior-green-32-of-39.json` preserves the requested 32/39 diagnostic from the
pending corrective GREEN state. It is diagnostic only and does not substitute
for this accepted RED.
