# Slice E5-02: Genuine Referee Arm

## Contract

A currently authorized referee may approve one canonical outcome instead of
all counterparties, without receiving writer, admin or finality authority.

## Blocker and governance seam

The current latched ACL groups are exactly `admin`, `finality` and `writer`.
There is no genuine referee role. Do not relabel another role or accept an
application-projected string.

Before implementation, use the normal bounded protocol-v3 successor process to
add a real `referee` role to the authenticated ACL carrier and every exact-group
consumer. Begin that process only after E5-01's two-party product evidence shows
the referee arm is needed.

The successor is a new latched-ACL carrier version, not a reinterpretation of
version 1. Version 1 continues to accept exactly `admin`, `finality` and
`writer`. Version 2 adds `referee` to the canonical group order. Both versions
retain the same anchor-bound ACL digest domain, so the signed carrier version is
the semantic discriminator.

An authenticated version-2 referee is an envelope member but not an application
writer, administrator or finality signer. Only an administrator may grant or
revoke the role. Staging preserves the carrier version; no operation upgrades a
version-1 ACL in place. The ordinary writer predicate and signer derivation stay
unchanged.

Land this role successor as its own tests-only RED and production GREEN. The RED
must preserve version-1 bytes and behavior while proving version-2 parsing,
canonical ordering, grant/revoke authorization, envelope membership, denied
application writes and exclusion from the finality signer set. Update exact
runtime/type consumers without adding a second ACL parser or role oracle.

Only after that GREEN lands may the outcome proof gain a referee branch. A
referee signs the same canonical, current-context outcome intent; an authorized
writer still issues the durable commit. The pre-journal outcome policy derives
the current referee set from authenticated ACL custody and accepts either the
existing complete counterparty approval set or one current referee decision.
It never trusts an application-projected role string.

## TDD and acceptance

After the role exists, cover current referee success; revoked, foreign-epoch,
foreign-object and malformed referee proof rejection; no writer/finality/admin
widening; local/remote/recovery parity; replay idempotence; and one durable
outcome after reconnect.

Use a real three-client zone. Transition the third member from writer to
referee before exercising the referee arm, then prove the writer permission is
absent. Revocation must take effect at the authenticated next ACL epoch; an old
decision cannot cross that boundary.

## Human surface

Add a third referee client to the existing workbench, showing its exact current
role and signed decision. Run screenshot critique, compare with E5-01, and use
the non-blocking preview window.

## Must stay green

All-counterparty E5 path, E2 writer authority, protocol-v3 authorization,
shared room recovery, and E3/E4.

## Feedback that changes this slice

A product decision to omit referees may remove the slice. It may not justify
borrowing another ACL role.
