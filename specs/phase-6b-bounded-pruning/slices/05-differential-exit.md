# D.109f — Differential and Phase-6b Exit

Run the full state machine for at least 100 epochs against paired archival and
compacted replicas. Require identical final application state digest, ACL,
frontier semantics, accepted-operation count, restart/recovery result, and
subsequent live writes. Instrument every raw dependency lookup so compacted
execution cannot read deleted payloads accidentally.

Assert exact bounded censuses for all Phase-6b enumerated structures, exact
durable retention, no uncategorized outbox rows, and equal eligible deletion
sets under every browser lock mode. Include Node crash/reopen and Chromium,
Firefox, WebKit takeover coverage. This slice changes no threshold; it proves
the bounds later consumed by Phase 6c’s memory gate.
