Baseline per-op breakdown (pa-diag1-r1, creator spans, p50 ms, pooled live+issue):
q-acquire-proof 66.3 | q-reserve-capacity 22.9 | q-seal-runtime 0.2
 acq: ahe/journal holds 2.6, issuer hold 0.2, floor hold 1.2, snapshot protections 1.4,
      bounded-role-read 10.9, journal-image 0.5, snapshot-image 2.6, ahe-image 1.9, floor-image 0.6, inventory 2.8,
      native-issuance-correspondence 6.2, journal-correspondence-material 3.1, check-current-journal 0.3,
      anchor-reads 0.0, signing-deps 15.25, charges 0.5, check 9.0
 cap: check-1 8.95, derive-charge 3.3, check-2 10.0
 check (n=416): points-before 2.4 (owned holds 1.7, currency/head/readiness 0.6), snapshot image+inventory 5.2,
      points-after 1.3 (floor 0.6, journal 0.2, issuance 0.5)
 => 4 full check() per op (acq, cap-1, cap-2, begin) ~ 36 ms; serial independent reads in acquisition ~ 40 ms.
