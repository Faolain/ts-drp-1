# Source-shape and scope audit

For each of the exact three changed backend owners, a literal count verified:

- one `(authenticatedSettled && decoded.epoch > captured.closedEpoch)`
  predicate;
- one `(!authenticatedSettled && decoded.epoch !== captured.closedEpoch)`
  legacy predicate; and
- no other production path changed in the commit.

The validation loop precedes the deletion loop and watermark mutation in all
three backends. The complete-plan gate also precedes validation and mutation.
Thus a future row returns the existing invalid-argument error before any
deletion, while plan refusal and latched corruption retain their established
error ownership.

The commit contains no public API, schema, wire, authority, dependency,
threshold, workload, recovery-scan, or production reachability change.
