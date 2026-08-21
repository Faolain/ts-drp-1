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

## TDD and acceptance

After the role exists, cover current referee success; revoked, foreign-epoch,
foreign-object and malformed referee proof rejection; no writer/finality/admin
widening; local/remote/recovery parity; replay idempotence; and one durable
outcome after reconnect.

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
